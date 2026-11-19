/**
 * 生成主链路：模板选择 → 参考图上传 → 报价 → 创建任务 → 轮询 → 产物落盘。
 *
 * 抽成独立模块，让 DSH 工具（lib/aigc/tools.js）与卡片快速生成端点
 * （lib/index.js 的 /api/tongji-aigc/generate）共用同一条逻辑，避免行为分叉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { AigcError } from './client.js'
import { pollTask } from './runner.js'
import { logWarn } from '../log.js'

export const MODE_LABELS = {
  t2i: '文生图',
  i2i: '图生图',
  t2v: '文生视频',
  i2v: '图生视频',
  t23d: '文生 3D',
  i23d: '图生 3D',
  t2a: '文生音乐',
}

const MODE_CATEGORIES = {
  t2i: ['image', 'image_gen', 'img'],
  i2i: ['image', 'image_gen', 'img'],
  t2v: ['video', 'video_gen'],
  i2v: ['video', 'video_gen'],
  t23d: ['3d'],
  i23d: ['3d'],
  t2a: ['music', 'audio'],
}

const IMAGE_PARAM_KEYS = ['image', 'image_url', 'reference_image', 'init_image', 'input_image']

/** 模式 → 落盘产物类别。 */
function outputKind(mode) {
  if (mode === 't2v' || mode === 'i2v') return 'video'
  if (mode.includes('3d')) return '3d'
  if (mode === 't2a') return 'music'
  return 'image'
}

/** 上游模板对象的 code 字段：`template_code` 是入参名，模板自身叫 `code`。 */
export function templateCodeOf(template) {
  if (!template || typeof template !== 'object') return ''
  const code = template.template_code ?? template.code
  return typeof code === 'string' ? code.trim() : ''
}

/** 上游模板对象的展示名。 */
export function templateNameOf(template) {
  if (!template || typeof template !== 'object') return ''
  const name = template.template_name ?? template.name
  return typeof name === 'string' ? name : ''
}

/** 解析模板的 param_schema（上游给的是 JSON 字符串）。 */
export function templateFields(template) {
  let schema = template?.param_schema
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(schema)
    } catch {
      schema = null
    }
  }
  if (Array.isArray(schema)) return schema.filter((field) => field && typeof field === 'object')
  if (schema && typeof schema === 'object') return Object.values(schema).filter((field) => field && typeof field === 'object')
  return []
}

function pickTemplate(templates, mode) {
  const list = Array.isArray(templates) ? templates : []
  const categories = MODE_CATEGORIES[mode] || []
  const match = (template) => {
    // 模板自身用 `type` 标模式（t2i / i2v / t23d…），这是最可靠的判定。
    if (template?.type === mode) return true
    if (template?.generate_type === mode) return true
    if (template?.kind === mode) return true
    if (categories.includes(String(template?.type).toLowerCase())) return true
    if (categories.includes(String(template?.category).toLowerCase())) return true
    return false
  }
  return list.find(match) || null
}

function injectReferenceImage(params, imageUrl) {
  const next = { ...(params || {}) }
  const key = IMAGE_PARAM_KEYS.find((candidate) => typeof next[candidate] !== 'string') || IMAGE_PARAM_KEYS[0]
  next[key] = imageUrl
  return next
}

function extractQuoteToken(estimate) {
  if (!estimate || typeof estimate !== 'object') return null
  return estimate.quote_token || estimate.token || estimate.estimate_token || null
}

/**
 * 组装 estimate 端点的参数。
 *
 * 上游两个计费端点的参数口径不一样（2026-11 实测）：
 *   - `/aigc/estimate` **只认模板 schema 里的数值/选项参数，且不接受 prompt**，
 *     返回 total_points 与 duration 预估——这才是面板要展示的「积分 + 耗时」；
 *   - `/aigc/quote` 接受 prompt，返回创建任务所需的 quote token，但 total_points
 *     对多数模板恒为 0。
 * 所以 estimate 用过滤后的参数，quote 用完整参数，两边各取所需。
 *
 * @param {object[]} fields 模板 param_schema
 * @param {object} params 完整参数（含 prompt）
 * @param {boolean} known 是否解析到了模板 schema（未知模板时无法过滤，原样传）
 * @returns {object}
 */
function estimateParamsOf(fields, params, known) {
  if (!known) {
    const { prompt, ...rest } = params || {}
    return rest
  }
  const allowed = new Set(fields.map((field) => field?.key).filter(Boolean))
  const out = {}
  for (const [key, value] of Object.entries(params || {})) {
    // prompt 不在 estimate 的接受范围内；schema 里没有的键一律不发。
    if (key === 'prompt' || !allowed.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * @param {object} config 归一化配置
 * @returns {{ run: Function }}
 */
export function createTaskDependencies(config) {
  /**
   * 执行一次生成。
   * @param {object} input
   * @param {import('./client.js').AigcClient} input.client
   * @param {string} input.mode
   * @param {string} input.prompt
   * @param {string} [input.template_code]
   * @param {object} [input.params]
   * @param {string} [input.reference_image] 本地图片绝对路径
   * @param {number} [input.count]
   * @param {string} [input.output_path]
   * @param {boolean} [input.estimate_only]
   * @param {boolean} [input.create_only] 只建任务、不轮询（供面板拿到 task_ids 自己轮询）
   * @param {string} [input.cwd] 会话工作目录（缺省时用 config.outputDir 或 process.cwd()）
   * @returns {Promise<object>}
   */
  async function run({ client, mode, prompt, template_code, params, reference_image, count, output_path, estimate_only, create_only, cwd }) {
    if (!MODE_LABELS[mode]) {
      throw new AigcError(`不支持的生成模式：${mode}。可用：${Object.keys(MODE_LABELS).join('、')}。`)
    }
    // 先解析模板（后续要按 schema 判断是否有 prompt 字段）
    const templates = await client.templates()
    const total = Math.max(1, Math.min(config.maxCount, Math.floor(Number(count) || 1)))
    const outputDir = path.resolve(output_path || config.outputDir || cwd || process.cwd())

    // 1) 模板
    let templateCode = template_code
    let templateName
    let templateMeta = null
    if (!templateCode) {
      const picked = pickTemplate(templates, mode)
      const pickedCode = templateCodeOf(picked)
      if (pickedCode === '') {
        throw new AigcError(
          `按 ${mode}（${MODE_LABELS[mode]}）找不到可用模板，请先用 tongji_aigc_templates 查看，并显式传 template_code。`,
        )
      }
      templateCode = pickedCode
      templateName = templateNameOf(picked)
      templateMeta = picked
    } else {
      templateMeta = (Array.isArray(templates) ? templates : []).find((t) => templateCodeOf(t) === templateCode) || null
      if (templateMeta) templateName = templateNameOf(templateMeta)
    }
    // 解析模板 param_schema，判断该模板是否真的有 prompt 字段
    const fields = templateFields(templateMeta)
    const hasPromptField = templateMeta === null
      ? true // 查不到 schema 时按保守处理，保持向后兼容
      : fields.some((field) => field?.key === 'prompt')

    // 模板 schema 有 prompt 字段才要求/注入 prompt（纯图生 3D 和纯音乐 t2a 模型没有）
    const hasPrompt = prompt != null && String(prompt).trim() !== ''
    if (!hasPrompt && hasPromptField) {
      throw new AigcError('缺少提示词 prompt。')
    }
    const safePrompt = hasPrompt ? String(prompt).trim() : ''

    // 2) 参数 + 参考图
    // 顶层 prompt 必须显式写进 params.prompt，否则服务端会用模板自带的默认提示词。
    // 仅在「有 prompt 值且模板 schema 有 prompt 字段」时注入，避免给纯 i23d/纯音乐 t2a 模型塞 prompt 报「未知参数 prompt」。
    let taskParams = (hasPrompt && hasPromptField) ? { prompt: safePrompt, ...(params || {}) } : { ...(params || {}) }
    // 调用方若在 params 里显式传了 prompt，以 params 为准（保持向后兼容）
    if (params?.prompt) taskParams.prompt = String(params.prompt)
    if (mode === 'i2i' || mode === 'i2v' || mode === 'i23d') {
      if (!reference_image) {
        throw new AigcError(`${MODE_LABELS[mode]}需要参考图：请传 reference_image（本地图片绝对路径）。`)
      }
      const abs = path.resolve(String(reference_image))
      if (!fs.existsSync(abs)) throw new AigcError(`参考图不存在：${abs}`)
      const uploaded = await client.uploadImage(fs.readFileSync(abs), path.basename(abs))
      // 上游认可的是 path 字段（2630397/aigc/inputs/in_xxx.png），不是带 ticket 的 url
      const refRef = uploaded?.path || uploaded?.data?.path || uploaded?.url || uploaded?.data?.url
      taskParams = injectReferenceImage(taskParams, refRef)
    }

    // 3) 报价 + 预估
    // estimate 端点只接受与模板 schema 对得上的参数子集，且**从不接受 prompt**
    // （传了必报「未知参数 prompt」）。面板可能带着上一次模板留下的参数切模板，
    // 这里按 schema 过滤，免得一次切换就报错。
    const estimateParams = estimateParamsOf(fields, taskParams, templateMeta !== null)
    let estimate = null
    let quoteToken = null
    try {
      // 模板 schema 无 prompt 字段时 estimate 端点同样会报「未知参数 prompt」，跳过。
      if (hasPromptField && hasPrompt) estimate = await client.estimate({ template_code: templateCode, params: estimateParams, count: total })
    } catch (error) {
      logWarn(`预估失败（estimate）：${error?.message}`)
    }
    if (estimate_only) {
      return {
        task_id: null,
        status: 'estimate',
        type: mode,
        template_code: templateCode,
        template_name: templateName,
        estimate,
        message: '仅报价预估，未创建任务。',
      }
    }
    try {
      const quote = await client.quote({ template_code: templateCode, params: taskParams, count: total })
      quoteToken = extractQuoteToken(quote)
      if (!quoteToken) throw new AigcError('报价未返回 token')
    } catch (error) {
      logWarn(`报价失败（quote）：${error?.message}`)
    }

    // 4) 创建（面板模式只建任务，把轮询交给前端，避免一个 HTTP 请求挂几分钟）
    const created = await client.createTask({
      template_code: templateCode,
      params: taskParams,
      count: total,
      quote_token: quoteToken,
      idempotency_key: randomUUID(),
    })
    const taskIds = Array.isArray(created?.task_ids) ? created.task_ids : []
    if (taskIds.length === 0) {
      throw new AigcError('创建生成任务失败：上游未返回 task_ids。请检查模板 code、参数与配额。')
    }
    if (create_only) {
      return {
        // 上游 task id 是数字；统一成字符串，端点与工具两边口径一致。
        task_id: String(taskIds[0]),
        task_ids: taskIds.map(String),
        status: 'created',
        type: mode,
        template_code: templateCode,
        template_name: templateName,
        estimate,
        output_dir: outputDir,
        message: `已创建 ${taskIds.length} 个任务。`,
      }
    }

    const result = await pollTask(client, {
      taskId: taskIds[0],
      pollIntervalMs: config.pollIntervalMs,
      pollTimeoutMs: config.pollTimeoutMs,
      outputDir,
      type: outputKind(mode),
    })
    return { ...result, estimate }
  }

  /**
   * 只做生成前报价（面板「预估」按钮）：走与 run 完全相同的模板解析与参数过滤，
   * 但不建任务。返回上游 estimate + quote 的原始结构，前端只做展示。
   * @param {object} input 同 run，但忽略 estimate_only / create_only。
   * @returns {Promise<object>}
   */
  async function quoteOnly({ client, mode, prompt, template_code, params, reference_image, count, cwd }) {
    if (!MODE_LABELS[mode]) {
      throw new AigcError(`不支持的生成模式：${mode}。可用：${Object.keys(MODE_LABELS).join('、')}。`)
    }
    const templates = await client.templates()
    const total = Math.max(1, Math.min(config.maxCount, Math.floor(Number(count) || 1)))
    const outputDir = path.resolve(config.outputDir || cwd || process.cwd())

    let templateCode = template_code
    let templateMeta = null
    if (!templateCode) {
      const picked = pickTemplate(templates, mode)
      templateCode = templateCodeOf(picked)
      if (templateCode === '') throw new AigcError(`按 ${mode}（${MODE_LABELS[mode]}）找不到可用模板。`)
      templateMeta = picked
    } else {
      templateMeta = (Array.isArray(templates) ? templates : []).find((t) => templateCodeOf(t) === templateCode) || null
    }

    const fields = templateFields(templateMeta)
    const hasPromptField = templateMeta === null ? true : fields.some((field) => field?.key === 'prompt')
    const hasPrompt = prompt != null && String(prompt).trim() !== ''
    let taskParams = (hasPrompt && hasPromptField) ? { prompt: String(prompt).trim(), ...(params || {}) } : { ...(params || {}) }
    if (params?.prompt) taskParams.prompt = String(params.prompt)

    if ((mode === 'i2i' || mode === 'i2v' || mode === 'i23d') && reference_image) {
      const abs = path.resolve(String(reference_image))
      if (fs.existsSync(abs)) {
        const uploaded = await client.uploadImage(fs.readFileSync(abs), path.basename(abs))
        const refRef = uploaded?.path || uploaded?.data?.path || uploaded?.url || uploaded?.data?.url
        taskParams = injectReferenceImage(taskParams, refRef)
      }
    }

    const estimateParams = estimateParamsOf(fields, taskParams, templateMeta !== null)
    // quote 端点接受 prompt，但仍会拒绝 schema 之外的键（切模板留下的残留参数）。
    const quoteParams = (() => {
      if (templateMeta === null) return taskParams
      const allowed = new Set(fields.map((field) => field?.key).filter(Boolean))
      return Object.fromEntries(Object.entries(taskParams).filter(([key]) => allowed.has(key)))
    })()

    const [estimate, quote] = await Promise.all([
      (hasPromptField && hasPrompt)
        ? client.estimate({ template_code: templateCode, params: estimateParams, count: total }).catch((error) => ({ error: String(error?.message || error) }))
        : Promise.resolve(null),
      client.quote({ template_code: templateCode, params: quoteParams, count: total }).catch((error) => ({ error: String(error?.message || error) })),
    ])
    return {
      mode,
      template_code: templateCode,
      template_name: templateNameOf(templateMeta),
      count: total,
      output_dir: outputDir,
      estimate,
      quote,
    }
  }

  return { run, quoteOnly }
}
