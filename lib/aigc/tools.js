/**
 * 工具定义：把同济 AIGC 能力包装成 DSH 工具。
 *
 * 只用 DSH 支持的 JSON Schema 子集（type / properties / required / enum /
 * additionalProperties / items / description）；范围、默认值一律写进 description，
 * 因为 minimum/maximum/format 这类键会被宿主直接拒绝。
 *
 * 生成主链路在 lib/aigc/generate.js，工具与卡片端点共用同一份逻辑。
 */
import fs from 'node:fs'
import path from 'node:path'

import { createTaskDependencies, MODE_LABELS } from './generate.js'
import { readToken } from '../token.js'
import { noteActivity } from '../activity.js'

/** 从 exec 上下文里解析会话工作目录。 */
export function resolveCwd(exec) {
  try {
    const candidates = [
      exec?.agent?.meta?.cwd,
      exec?.agent?.cwd,
      exec?.agent?.session?.cwd,
      exec?.agent?.session?.meta?.cwd,
      exec?.cwd,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return path.resolve(candidate)
    }
  } catch {
    /* 忽略 */
  }
  return process.cwd()
}

/**
 * 递归去掉 null / undefined 的键。
 *
 * 工具的 output schema 声明了类型，宿主按声明校验返回值：声明成 object 的字段
 * 收到 null 会直接判「invalid output」，把整次调用变成错误。上游很多字段
 * 「没有值」就是 null（例如报价失败、estimate_only 没有 task_id），所以统一
 * 在这里整键省略，而不是让调用方逐个判断。
 */
export function stripNullish(value) {
  if (Array.isArray(value)) return value.map((item) => stripNullish(item))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue
    out[key] = stripNullish(item)
  }
  return out
}

/**
 * 把结果里声明为字符串、但上游给成数字的 id 字段转成字符串。
 *
 * 同济的 task id 是数字（如 473591），而工具 output schema 声明 task_id 为
 * string；宿主严格按声明校验，数字会被判「invalid output」把整次调用变成错误。
 * 这里统一在出口处转换，schema 与上游类型就不必互相迁就。
 *
 * @param {object} value 工具返回值
 * @returns {object} 同一结构，id 类字段已转成字符串
 */
export function normalizeIds(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeIds(item))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'task_id' && (typeof item === 'number' || typeof item === 'bigint')) {
      out[key] = String(item)
      continue
    }
    if (key === 'task_ids' && Array.isArray(item)) {
      out[key] = item.map((id) => (typeof id === 'number' || typeof id === 'bigint' ? String(id) : id))
      continue
    }
    out[key] = normalizeIds(item)
  }
  return out
}

/** 工具出口统一整理：先去 null，再把 id 类字段转成字符串。 */
export function finalizeOutput(value) {
  return normalizeIds(stripNullish(value))
}

/**
 * 「让用户填参数」工具。
 *
 * 这是本插件的**前置步骤**：模型确定这次要用 AIGC 之后先调它，工具会阻塞等待
 * 用户在**当前对话**的卡片里选好模式 / 模板 / 提示词 / 参数并提交，然后把用户
 * 的选择原样返回，模型再拿这些值去调 `tongji_aigc_generate`。
 *
 * 为什么必须是阻塞式：如果只发个信号就返回，模型会带着空参数继续跑，用户的
 * 选择永远追不上已经开始的生成。这里用「工具等用户」而不是「用户等工具」，
 * 与 DSH 里 ask_user_question 的交互模型一致（等待期间不消耗 token）。
 */
function createFormTool(config, getClient) {
  return {
    name: 'tongji_aigc_form',
    description:
      '让用户在卡片里确认 / 填写同济 AIGC 的生成参数（模式、模板、提示词、分辨率等）。' +
      '这是生成前必须的前置步骤：调用后工具会暂停等待用户在当前对话的卡片中选完并提交（等待期间不消耗 token），' +
      '然后把用户的选择返回。拿到返回值后，直接把其中的 mode / template_code / prompt / params / reference_image / count ' +
      '原样传给 tongji_aigc_generate 执行生成。' +
      '如果用户取消或超时，status 会是 cancelled / timeout，此时不要继续生成，改为向用户确认。' +
      '适用于「用户还没说清楚要什么图/视频」或「你想让用户确认参数」的场景。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: '可选。建议的初始生成模式，卡片会预选它：t2i / i2i / t2v / i2v / t23d / i23d / t2a。',
          enum: ['t2i', 'i2i', 't2v', 'i2v', 't23d', 'i23d', 't2a'],
        },
        prompt: {
          type: 'string',
          description: '可选。预填到提示词框的内容，方便用户在此基础上修改。',
        },
        template_code: {
          type: 'string',
          description: '可选。预选的模板 code。',
        },
        note: {
          type: 'string',
          description: '可选。一句话说明为什么需要用户填写，显示在卡片顶部（例如「要生成几张封面图？」）。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          mode: { type: 'string' },
          template_code: { type: 'string' },
          prompt: { type: 'string' },
          params: { type: 'object' },
          reference_image: { type: 'string' },
          count: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['status'],
      },
      render: (_args, value) => {
        if (value?.status === 'submitted') {
          const lines = [
            '用户已填写生成参数：',
            `- 模式：${value.mode ?? '-'}`,
            value.template_code ? `- 模板：${value.template_code}` : '- 模板：（自动选择）',
            value.prompt ? `- 提示词：${value.prompt}` : null,
            value.reference_image ? `- 参考图：${value.reference_image}` : null,
            `- 数量：${value.count ?? 1}`,
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        return [{ type: 'text', text: `用户未提交参数（${value?.status ?? 'unknown'}）：${value?.message ?? ''}` }]
      },
      presentationMeta: () => ({}),
    },
    async execute(args, exec) {
      if (!readToken()) {
        throw new Error('尚未登录同济 AIGC：请到「设置 → 插件 → 同济 AIGC」卡片点「统一身份认证登录」完成登录。')
      }
      // 卡片是「按会话独立」的，所以必须知道调用发生在哪个会话里。
      const sessionId = sessionIdOf(exec)
      if (sessionId === '') {
        throw new Error('无法确定当前会话，交互式参数卡片需要一个会话上下文；可改用 tongji_aigc_generate 直接传参生成。')
      }

      // 通知浏览器侧「这次要用 AIGC 了」，前端据此把卡片切到待填写态。
      noteActivity({
        mode: args?.mode,
        prompt: args?.prompt,
        template_code: args?.template_code,
        count: args?.count,
      }, 'form')

      const { createPendingRequest } = await import('../pending.js')
      const outcome = await createPendingRequest({
        sessionId,
        hints: {
          mode: typeof args?.mode === 'string' ? args.mode : '',
          prompt: typeof args?.prompt === 'string' ? args.prompt : '',
          template_code: typeof args?.template_code === 'string' ? args.template_code : '',
          note: typeof args?.note === 'string' ? args.note : '',
        },
        timeoutMs: config.formTimeoutMs,
        signal: exec?.signal,
      })

      if (outcome.status !== 'submitted') {
        return finalizeOutput({
          status: outcome.status,
          message: outcome.message || '用户未提交参数',
        })
      }
      return finalizeOutput({ status: 'submitted', ...outcome.values })
    },
  }
}

/** 从 exec 里取会话 id（Agent 的 id 就是 SessionId）。 */
export function sessionIdOf(exec) {
  const candidates = [
    exec?.agent?.id,
    exec?.agent?.session?.id,
    exec?.agent?.sessionId,
    exec?.sessionId,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/** 生成工具的核心逻辑，返回工具对象。 */
function createGenerateTool(config, getClient) {
  return {
    name: 'tongji_aigc_generate',
    description:
      '调用同济 AIGC 专区生成图片、视频、3D 或音乐。文生图(t2i)/图生图(i2i)/文生视频(t2v)/图生视频(i2v)/文生3D(t23d)/图生3D(i23d)/文生音乐(t2a)。' +
      '会先校验登录（未登录会提示去设置里登录），然后创建任务、轮询到完成，并把产物下载到会话工作目录，返回绝对路径。' +
      'count 为生成数量，通常 1-4；不指定 template_code 时会自动按 mode 挑选一个可用模板。' +
      '图生图/图生视频需要传 reference_image（本地图片绝对路径），插件会自动上传并作为参考图。' +
      '输出目录默认用会话工作目录，也可用 output_path 指定。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: '生成模式，必须是以下之一：t2i（文生图）、i2i（图生图）、t2v（文生视频）、i2v（图生视频）、t23d（文生3D）、i23d（图生3D）、t2a（文生音乐）。',
          enum: ['t2i', 'i2i', 't2v', 'i2v', 't23d', 'i23d', 't2a'],
        },
        prompt: {
          type: 'string',
          description: '生成提示词。中文或英文都可以，越具体越好。图生图/图生视频也建议给一句对结果的描述。',
        },
        template_code: {
          type: 'string',
          description: '可选。生成模板 code；不填时插件按 mode 自动挑选一个可用模板。可先用 tongji_aigc_templates 查看可用模板。',
        },
        params: {
          type: 'object',
          description: '可选。模板的附加参数对象（键值对）。image 类型的参数值应填参考图 URL，一般不需要手动填。',
          additionalProperties: true,
        },
        reference_image: {
          type: 'string',
          description: '可选。本地图片的绝对路径，用于 i2i（图生图）或 i2v（图生视频）。插件会读取文件并上传为参考图。',
        },
        count: {
          type: 'integer',
          description: '生成数量，通常填 1-4。视频/3D 建议填 1。',
        },
        output_path: {
          type: 'string',
          description: '可选。产物落盘目录的绝对路径；不填则用当前会话工作目录。',
        },
        estimate_only: {
          type: 'boolean',
          description: '可选。只做生成前报价预估，不真正生成，返回积分/费用。',
        },
      },
      required: ['mode', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string' },
          type: { type: 'string' },
          template_code: { type: 'string' },
          template_name: { type: 'string' },
          estimate: { type: 'object' },
          outputs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                name: { type: 'string' },
                url: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          output_dir: { type: 'string' },
          output_count: { type: 'integer' },
          message: { type: 'string' },
        },
        // task_id 只在真正建了任务时才有：estimate_only 走报价分支，没有任务 id。
        required: ['status'],
      },
      render: (_args, value) => {
        const lines = [`**同济 AIGC 任务 ${value?.task_id ?? '-'}**：${value?.status ?? '-'}`]
        if (value?.template_code) lines.push(`模板：${value.template_code}（${value.template_name || '未命名'}）`)
        if (value?.output_count) {
          lines.push(`产物：${value.output_count} 个，目录 ${value.output_dir || '-'}`)
          for (const output of value.outputs || []) {
            lines.push(`  - ${output.name}${output.path ? ` → ${output.path}` : ''}`)
          }
        }
        if (value?.estimate) lines.push(`预估：${JSON.stringify(value.estimate)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (args, value) => {
        const images = []
        const files = []
        for (const output of value?.outputs || []) {
          if (output?.path && fs.existsSync(output.path)) {
            if ((args?.mode === 't2i' || args?.mode === 'i2i') && /\.(png|jpe?g|webp|gif)$/i.test(output.path)) {
              images.push(output.path)
            } else {
              files.push(output.path)
            }
          }
        }
        return { images, files }
      },
    },
    async execute(args, exec) {
      if (!readToken()) {
        throw new Error('尚未登录同济 AIGC：请到「设置 → 插件 → 同济 AIGC 生图 / 生视频」卡片点「统一身份认证登录」完成登录。')
      }
      const mode = String(args?.mode || '').trim()
      const deps = createTaskDependencies(config)
      // 通知浏览器侧「AIGC 被用到了」：面板据此从右侧滑出并回填这次的参数。
      // 放在真正执行之前，报价预览这种轻调用也算一次使用。
      noteActivity({
        mode,
        prompt: args?.prompt,
        template_code: args?.template_code,
        params: args?.params,
        count: args?.count,
      }, 'tool')
      const result = await deps.run({
        client: getClient(config),
        mode,
        prompt: args?.prompt,
        template_code: args?.template_code,
        params: args?.params,
        reference_image: args?.reference_image,
        count: args?.count,
        output_path: args?.output_path,
        estimate_only: args?.estimate_only,
        cwd: resolveCwd(exec),
      })
      // 声明为 object 的字段不能是 null：报价可能失败、任务 id 可能不存在，
      // 这类「没有值」必须整键省略，否则宿主会判定 invalid output。
      // 上游 task id 是数字，而 schema 声明 string，一并在这里归一化。
      return finalizeOutput(result)
    },
  }
}

/** 模板列表工具。 */
function createTemplatesTool(config, getClient) {
  return {
    name: 'tongji_aigc_templates',
    description: '列出同济 AIGC 可用的生成模板（含模板 code、名称、参数 schema）。可按类型筛选（image/video/3d/music 或 t2i/i2v 等模式）。生成前可先调用它确认 template_code。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '可选。按类型筛选模板，可填 image/video/3d/music，或直接填模式 t2i/i2i/t2v/i2v/t23d/i23d/t2a。不填则返回全部。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          templates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                template_code: { type: 'string' },
                template_name: { type: 'string' },
                type: { type: 'string' },
                param_schema: { type: 'array' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `共 ${value?.total ?? 0} 个模板：\n` + (value?.templates || []).map((t) => `- ${t.template_code}（${t.template_name}，类型 ${t.type}）`).join('\n') }],
      presentationMeta: () => ({}),
    },
    async execute(args) {
      if (!readToken()) throw new Error('尚未登录同济 AIGC：请先在「设置 → 插件 → 同济 AIGC」完成登录。')
      const type = args?.type ? String(args.type).trim() : undefined
      const data = await getClient(config).templates(type)
      const templates = Array.isArray(data) ? data : data?.templates || []
      return finalizeOutput({ total: templates.length, templates })
    },
  }
}

/** 单个任务查询/下载工具。 */
function createTaskTool(config, getClient) {
  return {
    name: 'tongji_aigc_task',
    description: '查询同济 AIGC 某个生成任务的状态与详情，可选下载产物到本地。task_id 由 tongji_aigc_generate 返回。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id（必填）。' },
        download: { type: 'boolean', description: '可选。是否把产物下载到本地，默认 true。' },
        output_path: { type: 'string', description: '可选。下载目录绝对路径，默认用会话工作目录。' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          task: { type: 'object' },
          outputs: { type: 'array' },
          output_dir: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `任务 ${value?.task?.id ?? '-'}：${value?.task?.status ?? '-'}\n${JSON.stringify(value?.task, null, 2)}` }],
      presentationMeta: (_args, value) => ({
        images: (value?.outputs || []).filter((o) => o.path && /\.(png|jpe?g|webp|gif)$/i.test(o.path)).map((o) => o.path),
        files: (value?.outputs || []).map((o) => o.path).filter(Boolean),
      }),
    },
    async execute(args, exec) {
      const client = getClient(config)
      const taskId = String(args?.task_id || '').trim()
      if (!taskId) throw new Error('缺少 task_id。')
      const task = await client.getTask(taskId)
      if (args?.download === false) return finalizeOutput({ task, outputs: [], message: '未下载，仅返回任务信息。' })

      const outputDir = path.resolve(args?.output_path || config.outputDir || resolveCwd(exec))
      if (task?.status === 'succeeded' && Array.isArray(task.outputs) && task.outputs.length > 0) {
        const results = []
        let i = 0
        fs.mkdirSync(outputDir, { recursive: true })
        for (const output of task.outputs) {
          const url = typeof output.url === 'string' ? output.url : ''
          if (!url) continue
          i += 1
          const filename = path.basename(new URL(url, 'http://localhost').pathname) || `task_${i}`
          const absPath = path.join(outputDir, filename)
          try {
            fs.writeFileSync(absPath, await client.downloadBuffer(url))
            results.push({ index: i, name: filename, url, path: absPath })
          } catch (error) {
            results.push({ index: i, name: filename, url, path: null, error: String(error?.message || error) })
          }
        }
        return finalizeOutput({ task, outputs: results, output_dir: outputDir, message: `下载 ${results.filter((r) => r.path).length} 个产物到 ${outputDir}` })
      }
      return finalizeOutput({ task, outputs: [], message: `任务当前状态 ${task?.status}，暂无可下载产物。` })
    },
  }
}

/** 任务历史工具。 */
function createTasksTool(config, getClient) {
  return {
    name: 'tongji_aigc_tasks',
    description: '列出同济 AIGC 的历史生成任务（分页）。可按状态筛选（queued/submitted/running/succeeded/failed/canceled）。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，从 1 开始，默认 1。' },
        page_size: { type: 'integer', description: '每页条数，默认 20，建议不超过 50。' },
        status: { type: 'string', description: '可选。按状态筛选：queued/submitted/running/succeeded/failed/canceled。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          tasks: { type: 'array' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `共 ${value?.total ?? 0} 条任务：\n` + (value?.tasks || []).slice(0, 30).map((t) => `- ${t.id} ${t.status} ${t.template_name || t.template_code || ''} ${t.created_at || ''}`).join('\n') }],
      presentationMeta: () => ({}),
    },
    async execute(args) {
      const data = await getClient(config).listTasks({
        page: Math.max(1, Math.floor(Number(args?.page) || 1)),
        pageSize: Math.max(1, Math.min(50, Math.floor(Number(args?.page_size) || 20))),
        status: args?.status ? String(args.status).trim() : undefined,
      })
      const tasks = Array.isArray(data) ? data : data?.tasks || []
      const total = typeof data?.total === 'number' ? data.total : tasks.length
      return finalizeOutput({ total, tasks })
    },
  }
}

/** 报价工具。 */
function createQuoteTool(config, getClient) {
  return {
    name: 'tongji_aigc_quote',
    description: '对同济 AIGC 的一次生成做生成前报价（积分/费用预估），不真正生成。可先用 tongji_aigc_templates 确认模板 code。',
    parameters: {
      type: 'object',
      properties: {
        template_code: { type: 'string', description: '模板 code（必填）。' },
        params: { type: 'object', description: '可选。模板参数对象。', additionalProperties: true },
        count: { type: 'integer', description: '生成数量，默认 1。' },
      },
      required: ['template_code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          estimate: { type: 'object' },
          quote: { type: 'object' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `报价：${JSON.stringify(value?.estimate ?? value?.quote ?? {}, null, 2)}` }],
      presentationMeta: () => ({}),
    },
    async execute(args) {
      const templateCode = String(args?.template_code || '').trim()
      if (!templateCode) throw new Error('缺少 template_code。')
      const count = Math.max(1, Math.floor(Number(args?.count) || 1))
      const payload = { template_code: templateCode, params: args?.params || {}, count }
      const [estimate, quote] = await Promise.all([
        getClient(config).estimate(payload).catch((error) => ({ error: String(error?.message || error) })),
        getClient(config).quote(payload).catch(() => null),
      ])
      // quote 失败时是 null，声明为 object 的字段收到 null 会被宿主判 invalid output。
      return finalizeOutput({ estimate, quote })
    },
  }
}

/** 健康/登录状态工具。 */
function createHealthTool(config, getClient) {
  return {
    name: 'tongji_aigc_health',
    description: '检查同济 AIGC 站点可达性、登录态是否有效、以及当前令牌信息。登录或排障时先调用它。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          base_url: { type: 'string' },
          logged_in: { type: 'boolean' },
          healthy: { type: 'boolean' },
          health: { type: 'object' },
          user: { type: 'object' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `同济 AIGC（${value?.base_url}）：登录=${value?.logged_in}，站点=${value?.healthy}，用户=${JSON.stringify(value?.user || {})}` }],
      presentationMeta: () => ({}),
    },
    async execute() {
      const client = getClient(config)
      // 未取到的字段直接省略：null 会被宿主按声明类型拒绝（object / string）。
      const result = { base_url: config.baseUrl, logged_in: Boolean(readToken()), healthy: false }
      try {
        const health = await client.health().catch(() => null)
        if (health && typeof health === 'object') result.health = health
        result.healthy = true
      } catch (error) {
        result.error = String(error?.message || error)
      }
      if (readToken()) {
        try {
          const user = await client.me()
          if (user && typeof user === 'object') result.user = user
        } catch (error) {
          result.error = result.error || `登录校验失败：${error?.message || error}`
        }
      }
      return finalizeOutput(result)
    },
  }
}

/** 创建全部工具。 */
export function createTools(config, getClient) {
  return [
    createFormTool(config, getClient),
    createGenerateTool(config, getClient),
    createTemplatesTool(config, getClient),
    createTaskTool(config, getClient),
    createTasksTool(config, getClient),
    createQuoteTool(config, getClient),
    createHealthTool(config, getClient),
  ]
}

export { MODE_LABELS }

