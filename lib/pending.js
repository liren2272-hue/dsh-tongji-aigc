/**
 * 待填写请求注册表。
 *
 * 交互范式：模型在「确定这次要用 AIGC」之后调用 `tongji_aigc_form`，工具**阻塞**
 * 在这里等用户在会话卡片里选好模式 / 模板 / 提示词 / 参数并提交，然后才把参数
 * 还给模型，由模型继续后续步骤（预估、生成）。
 *
 * 为什么需要这一层：
 *   - 工具不能只发个信号就返回——那样模型会拿着空参数继续跑，用户的选择永远
 *     追不上已经开始的生成；
 *   - 卡片必须**按会话隔离**：request 上带 sessionId，前端只渲染自己那个会话的
 *     请求，另一个对话的卡片不会串进来；
 *   - 一个会话同时只允许一个待填写请求，避免两张卡片抢同一块界面。
 *
 * 不落盘：这是「某个正在运行的工具调用在等用户」的瞬时状态。宿主重启会中断
 * 工具调用本身，残留请求没有意义。
 */
import { randomUUID } from 'node:crypto'

import { logInfo, logWarn } from './log.js'

/** 等待用户填写的默认上限：足够慢也足够久，避免工具永远挂着。 */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** requestId → 请求（含内部的 resolve / reject，不对外序列化）。 */
const requests = new Map()

/** sessionId → requestId，保证一个会话只有一个待填写请求。 */
const bySession = new Map()

/** 对外的请求形状：去掉句柄，只留前端需要的信息。 */
function publicView(entry) {
  return {
    request_id: entry.requestId,
    session_id: entry.sessionId,
    created_at: new Date(entry.createdAt).toISOString(),
    expires_at: new Date(entry.expiresAt).toISOString(),
    hints: entry.hints,
  }
}

/** 结束一个请求并清理索引。 */
function settle(entry, outcome) {
  if (entry.settled) return false
  entry.settled = true
  requests.delete(entry.requestId)
  if (bySession.get(entry.sessionId) === entry.requestId) bySession.delete(entry.sessionId)
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.onAbort) {
    try {
      entry.signal?.removeEventListener('abort', entry.onAbort)
    } catch { /* 忽略 */ }
  }
  entry.resolve(outcome)
  return true
}

/**
 * 创建一个待填写请求，并返回等待其结果的 Promise。
 *
 * @param {object} options
 * @param {string} options.sessionId 发起调用的会话（卡片按它隔离）
 * @param {object} [options.hints] 给用户的初始提示（mode / prompt / note），可空
 * @param {number} [options.timeoutMs] 等待上限
 * @param {AbortSignal} [options.signal] 工具取消信号；触发时以 cancelled 结束
 * @returns {Promise<{status: 'submitted'|'cancelled'|'timeout'|'aborted', values?: object, message?: string}>}
 */
export function createPendingRequest({ sessionId, hints = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  const requestId = randomUUID()
  const now = Date.now()

  // 同一会话已有待填写请求：先把旧的以 cancelled 结束，避免两张卡片抢界面。
  const stale = bySession.get(sessionId)
  if (stale !== undefined) {
    const previous = requests.get(stale)
    if (previous !== undefined) {
      logWarn(`同一会话已有待填写请求（${stale}），以 cancelled 结束它`)
      settle(previous, { status: 'cancelled', message: '已被新的请求取代' })
    }
  }

  return new Promise((resolve) => {
    const entry = {
      requestId,
      sessionId,
      hints,
      createdAt: now,
      expiresAt: now + timeoutMs,
      settled: false,
      resolve,
      timer: null,
      signal,
      onAbort: null,
    }

    entry.timer = setTimeout(() => {
      logWarn(`待填写请求超时（${requestId}，会话 ${sessionId}）`)
      settle(entry, { status: 'timeout', message: `超过 ${Math.round(timeoutMs / 1000)} 秒未收到填写` })
    }, timeoutMs)
    // 不要让这个定时器把进程吊住。
    if (typeof entry.timer.unref === 'function') entry.timer.unref()

    if (signal !== undefined) {
      entry.onAbort = () => {
        settle(entry, { status: 'aborted', message: '调用被取消' })
      }
      if (signal.aborted) {
        settle(entry, { status: 'aborted', message: '调用被取消' })
        return
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }

    requests.set(requestId, entry)
    bySession.set(sessionId, requestId)
    logInfo(`待填写请求已创建（${requestId}，会话 ${sessionId}）`)
  })
}

/**
 * 读某个会话当前待填写的请求。
 * @param {string} sessionId
 * @returns {object|null} 可直接 JSON 化的请求视图
 */
export function pendingForSession(sessionId) {
  const requestId = bySession.get(String(sessionId ?? ''))
  if (requestId === undefined) return null
  const entry = requests.get(requestId)
  return entry === undefined ? null : publicView(entry)
}

/**
 * 提交用户填写的内容，唤醒阻塞中的工具。
 * @param {string} requestId
 * @param {object} values 用户选定的参数（mode / template_code / prompt / params / reference_image / count）
 * @returns {{ok: boolean, error?: string}}
 */
export function submitPending(requestId, values) {
  const entry = requests.get(String(requestId ?? ''))
  if (entry === undefined) return { ok: false, error: 'not_found' }
  if (entry.settled) return { ok: false, error: 'already_settled' }

  const payload = values && typeof values === 'object' ? values : {}
  const mode = typeof payload.mode === 'string' ? payload.mode.trim() : ''
  if (mode === '') return { ok: false, error: 'missing_mode' }

  const normalized = {
    mode,
    template_code: typeof payload.template_code === 'string' ? payload.template_code : '',
    prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
    params: payload.params && typeof payload.params === 'object' ? payload.params : {},
    count: Number.isFinite(Number(payload.count)) ? Math.max(1, Math.floor(Number(payload.count))) : 1,
  }
  // 参考图可能没有；有就带上，没有就整键省略（工具 schema 声明为 string）。
  if (typeof payload.reference_image === 'string' && payload.reference_image.trim() !== '') {
    normalized.reference_image = payload.reference_image
  }

  logInfo(`待填写请求已提交（${entry.requestId}，模式 ${mode}）`)
  settle(entry, { status: 'submitted', values: normalized })
  return { ok: true }
}

/**
 * 取消一个待填写请求（用户点「取消」）。
 * @param {string} requestId
 * @param {string} [message]
 * @returns {{ok: boolean}}
 */
export function cancelPending(requestId, message = '用户取消了本次填写') {
  const entry = requests.get(String(requestId ?? ''))
  if (entry === undefined) return { ok: false }
  settle(entry, { status: 'cancelled', message })
  return { ok: true }
}

/** 当前待填写请求数量（排障用）。 */
export function pendingCount() {
  return requests.size
}


