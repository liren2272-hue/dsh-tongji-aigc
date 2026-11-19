/**
 * AIGC 使用信号。
 *
 * 面板不是常驻页面：它只在「真的用了同济 AIGC」时从右侧滑出，平时不占任何
 * 位置、不在引导页留入口。所以需要一条极轻的通道，让宿主侧的每一次调用都能
 * 通知到浏览器侧。
 *
 * 做法是一个进程内的单调计数器 + 最近一次调用的参数快照：
 *   - 工具每次执行（tools.js）→ noteActivity() 让 seq 自增；
 *   - 面板端点（index.js）→ GET /api/tongji-aigc/activity?since=N 读取；
 *   - 前端轮询，发现 seq 变大就把面板滑出，并用 last 里的参数回填表单，
 *     这样「刚才让 AI 生成的那张图」能原样出现在面板里，方便微调重跑。
 *
 * 刻意不落盘：这是「本次运行期间发生了什么」的瞬时信号，不是历史记录；
 * 重启后没有未读通知正是期望行为。
 */

/** 计数器与最近一次调用快照。 */
const state = {
  /** 单调递增；每次 noteActivity 加一。 */
  seq: 0,
  /** 最近一次 AIGC 调用的参数快照（供面板回填）。 */
  last: null,
}

/** 快照里只保留面板用得上的字段，避免把整份产物塞进轮询响应。 */
function snapshot(input) {
  if (!input || typeof input !== 'object') return null
  const out = {}
  for (const key of ['mode', 'prompt', 'template_code', 'params', 'count']) {
    if (input[key] !== undefined && input[key] !== null) out[key] = input[key]
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 记一次 AIGC 使用。
 * @param {object} [input] 调用参数（mode / prompt / template_code / params / count）
 * @param {string} [source] 来源标记（tool / panel），仅便于排障
 * @returns {number} 新的 seq
 */
export function noteActivity(input, source = 'tool') {
  state.seq += 1
  const last = snapshot(input)
  if (last !== null) {
    last.source = source
    last.at = new Date().toISOString()
    state.last = last
  }
  return state.seq
}

/**
 * 读取当前信号。
 * @param {number} [since] 调用方上次见过的 seq；小于等于它时 `stale` 为 true
 * @returns {{seq: number, last: object|null, stale: boolean}}
 */
export function readActivity(since) {
  const n = Number(since)
  return {
    seq: state.seq,
    last: state.last,
    stale: Number.isFinite(n) ? n >= state.seq : state.seq === 0,
  }
}
