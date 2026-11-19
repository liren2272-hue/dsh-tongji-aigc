/**
 * dsh-tongji-aigc 宿主侧入口。
 *
 * 职责：
 *   1. 解析配置，构造 AigcClient（令牌从 token.json 现取）；
 *   2. 注册全套 DSH 工具（生图/生视频/3D/音乐、模板、任务、报价、健康）；
 *   3. 注册同源 HTTP 端点，供客户端设置卡片做「登录校验、令牌读写、健康检查、快速生成」。
 *
 * 不声明任何必需服务（`inject = []`）：一律用 scoped `ctx.inject` 等 webServer/tools
 * 就绪，避免服务没就绪时整个插件被推迟装载（Cordis 的 inject 语义是「缺了就不装载」）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from './config.js'
import { AigcClient } from './aigc/client.js'
import { createTools } from './aigc/tools.js'
import { readToken, clearToken, tokenStatus, writeToken, isTokenExpired } from './token.js'
import { logInfo, logWarn } from './log.js'
import { readActivity } from './activity.js'
import { pendingForSession, submitPending, cancelPending } from './pending.js'
import { ensureLoginEnv, startLogin, readLoginToken, cleanupLogin, AutoLoginError, NEED_BROWSER_LOGIN } from './auto-login.js'
import { beginIamLogin, completeIamLogin, fetchIamCaptcha, IamLoginError } from './aigc/iam-login.js'
import { startBrowserLogin, pollBrowserLogin, takeBrowserLoginToken, cleanupBrowserLogin, scheduleDeferredCleanup, BrowserLoginError } from './browser-login.js'

export const name = 'dsh-tongji-aigc'
export const inject = []

/** 插件的 live 状态，供工具/端点读最新配置与令牌。 */
const live = { config: resolveConfig(), client: null, outputDirs: new Set() }

/** 记下本次运行实际写过的产物目录，供 /file 预览做白名单。 */
function rememberOutputDir(dir) {
  try {
    if (typeof dir !== 'string' || dir.trim() === '') return
    const resolved = path.resolve(dir)
    // 过宽的目录（盘符根 / 主目录本身 / 层级过浅）不进白名单：
    // 那会让 /file 变成一个能读整个用户目录的接口。
    if (!isSpecificDir(resolved)) return
    live.outputDirs.add(resolved)
  } catch { /* 忽略非法路径 */ }
}

/** 构造（或复用）客户端。令牌每次现取，改令牌/换登录无需重启。 */
function getClient() {
  if (live.client) return live.client
  live.client = new AigcClient({
    baseUrl: live.config.baseUrl,
    requestTimeoutMs: live.config.requestTimeoutMs,
    getToken: readToken,
  })
  return live.client
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** 把上游可能是字符串/ null 的数值安全转成 number（非法当 0）。 */
function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

/** 统一处理端点里的异常，绝不让一个坏请求把宿主搞挂。 */
function handleError(response, error) {
  const message = error?.hint ? `${error.message}（${error.hint}）` : String(error?.message || error)
  logWarn(`端点出错：${message}`)
  writeJson(response, 500, { error: message })
}

/**
 * 用 /auth/me 校验令牌。成功返回用户信息，失败抛错。
 */
async function validateToken(token) {
  const client = new AigcClient({
    baseUrl: live.config.baseUrl,
    requestTimeoutMs: live.config.requestTimeoutMs,
    getToken: () => token,
  })
  return client.me()
}

export async function apply(ctx, pluginConfig) {
  live.config = resolveConfig(pluginConfig)
  live.client = null
  logInfo(`已装载：baseUrl=${live.config.baseUrl}，poll=${live.config.pollIntervalMs}ms，timeout=${live.config.pollTimeoutMs}ms`)

  // 1) 工具
  ctx.inject(['tools'], (toolCtx) => {
    if (!toolCtx?.tools?.register) {
      logWarn('宿主没有提供 tools.register，本插件工具未注册')
      return
    }
    const disposers = []
    for (const tool of createTools(live.config, getClient)) {
      disposers.push(toolCtx.tools.register(tool))
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          logWarn(`摘除工具失败：${String(error)}`)
        }
      }
    }
  })

  // 2) 同源 HTTP 端点（供客户端卡片使用）
  ctx.inject(['webServer'], (webCtx) => {
    if (!webCtx?.webServer?.register) {
      logWarn('宿主没有提供 webServer.register，本插件卡片端点未注册')
      return
    }
    const disposers = []
    const register = (path, handler) => disposers.push(webCtx.webServer.register({ kind: 'exact', path, handler }))

    /** 状态：令牌是否配置、掩码、是否过期，以及站点/登录校验结果。 */
    register('/api/tongji-aigc/status', async (request, response) => {
      try {
        const status = tokenStatus()
        const body = {
          baseUrl: live.config.baseUrl,
          configured: status.configured,
          hint: status.hint,
          expired: status.expired,
          expiresAt: status.expiresAt,
        }
        if (status.configured) {
          try {
            body.user = await validateToken(readToken())
          } catch (error) {
            body.error = String(error?.message || error)
          }
        }
        writeJson(response, 200, body)
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 额度监控：把「积分钱包」与「套餐图片/视频用量」聚合成卡片能直接画的结构。
     * 三个上游接口各自容错，单个失败不拖垮整张卡；百分比在前端按 used/limit 现算。
     * 上游字段（2026-11 实测）：
     *   GET /billing/overview → data.{total_available,wallet_balance,plan.{plan_name,included_points,period_used,period_remaining,next_reset_at,user_plan_id}}
     *   GET /my-coding-plans/{id}/usage → data.{image_used,image_limit,video_used,video_limit,...}
     */
    register('/api/tongji-aigc/quota', async (request, response) => {
      try {
        const status = tokenStatus()
        if (!status.configured) {
          writeJson(response, 200, { configured: false })
          return
        }
        const client = getClient()
        const result = { configured: true, points: null, image: null, video: null }

        // 1) 积分钱包概览
        let planId = null
        try {
          const ov = await client.billingOverview()
          const d = ov?.data || ov || {}
          const plan = d.plan || {}
          planId = plan.user_plan_id ?? null
          result.points = {
            total: num(d.total_available ?? plan.period_remaining ?? 0),
            wallet: num(d.wallet_balance ?? 0),
            planName: String(plan.plan_name || '套餐'),
            included: num(plan.included_points ?? 0),
            periodUsed: num(plan.period_used ?? 0),
            periodRemaining: num(plan.period_remaining ?? 0),
            nextResetAt: plan.next_reset_at || null,
          }
        } catch (error) {
          result.pointsError = String(error?.message || error)
        }

        // 2) 套餐 id：概览没给就查我的套餐列表
        if (planId == null) {
          try {
            const plans = await client.myCodingPlans()
            const list = plans?.data?.list || plans?.list || plans?.data || []
            const arr = Array.isArray(list) ? list : []
            const active = arr.find((p) => p.status === 'active') || arr[0]
            planId = active?.id ?? null
          } catch (error) {
            result.planError = String(error?.message || error)
          }
        }

        // 3) 套餐用量（图片「张」/ 视频「秒」）
        if (planId != null) {
          try {
            const usage = await client.planUsage(planId)
            const u = usage?.data || usage || {}
            result.image = {
              used: num(u.image_used),
              limit: num(u.image_limit),
              unit: '张',
            }
            result.video = {
              used: num(u.video_used),
              limit: num(u.video_limit),
              unit: '秒',
            }
          } catch (error) {
            result.usageError = String(error?.message || error)
          }
        }

        writeJson(response, 200, result)
      } catch (error) {
        handleError(response, error)
      }
    })

/** 保存令牌：先校验，通过才落盘；校验失败回 401。 */
    register('/api/tongji-aigc/token', async (request, response) => {
      try {
        if (request.method === 'GET') {
          writeJson(response, 200, tokenStatus())
          return
        }
        if (request.method === 'DELETE') {
          clearToken()
          live.client = null
          writeJson(response, 200, { configured: false })
          return
        }
        if (request.method !== 'POST' && request.method !== 'PUT') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
        const token = String(body.token ?? '').trim()
        if (token === '') {
          writeJson(response, 400, { error: 'empty_token' })
          return
        }
        try {
          await validateToken(token)
        } catch (error) {
          writeJson(response, 401, { error: 'invalid_token', detail: String(error?.message || error) })
          return
        }
        writeToken(token)
        live.client = null
        writeJson(response, 200, { configured: true, hint: tokenStatus().hint, expired: isTokenExpired(token) })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 临时扩展回传令牌的落地端点（GET，顶层导航方式）：
     *   - 临时扩展从 HTTPS 的 agi.tongji.edu.cn 页用 `location.replace(origin + '/api/tongji-aigc/relay?token=...')`
     *     跳过来（顶层导航不受混合内容拦截，可绕过 HTTPS→HTTP 限制）。
     *   - 读取 query 中的 token，校验通过则落盘，并返回一段「登录成功，可关闭窗口」的提示页；
     *     校验失败也返回提示页（不要 401 成空页面，让用户知道发生了什么）。
     */
    register('/api/tongji-aigc/relay', async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost')
        const traceMsg = String(url.searchParams.get('__trace__') || '').trim()
        if (traceMsg !== '') {
          // 诊断信标（Image beacon）：把扩展 content script 的注入/读取/导航轨迹追加到日志，
          // 便于在 DSH 侧定位回传卡在哪一步。不影响主流程。
          try {
            const { appendFileSync } = await import('node:fs')
            const { homedir } = await import('node:os')
            const { join } = await import('node:path')
            const logFile = join(homedir(), '.dsh-tongji-aigc', 'relay-trace.log')
            const line = `[${new Date().toISOString()}] ${traceMsg} host=${url.searchParams.get('host') || ''} path=${url.searchParams.get('path') || ''}\n`
            appendFileSync(logFile, line, 'utf8')
          } catch { /* 日志失败不影响主流程 */ }
          response.writeHead(204)
          response.end()
          return
        }
        const token = String(url.searchParams.get('token') || '').trim()
        const okPage = (title, msg) =>
          `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>` +
          `<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f3f4f6;color:#111;display:flex;height:100vh;align-items:center;justify-content:center;margin:0}` +
          `.c{max-width:360px;padding:32px 28px;text-align:center;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.12)}` +
          `h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;font-weight:500;color:#374151;margin:0}p{font-size:13px;color:#6b7280;margin:14px 0 0}</style></head>` +
          `<body><div class="c"><h1>${title}</h1><h2>${msg}</h2><p>你可以直接关闭这个登录窗口了。</p></div></body></html>`
        if (token === '') {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(okPage('回传失败', '未收到令牌（token 为空）'))
          return
        }
        try {
          await validateToken(token)
        } catch (error) {
          response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(okPage('令牌无效', '回传的令牌未通过校验，请重试登录'))
          return
        }
        writeToken(token)
        live.client = null
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(okPage('登录成功', '同济 AIGC 已连接，令牌已安全保存到本机'))
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 账号密码面板 · 第 1 步：取登录验证码图。
     * 纯 HTTP 打通 discover → IAM 登录页 → 验证码图，宿主缓存 cookie jar 会话，
     * 把验证码 base64 返回给卡片显示。卡片提交账号/密码/验证码时走 iam-login。
     *
     * 返回：
     *   200 {sessionId, captcha, captchaMime} —— 验证码已就绪（sessionId 仅作标识）
     *   5xx {error}                            —— 取验证码失败（网络/站点改版）
     */
    register('/api/tongji-aigc/iam-captcha', async (request, response) => {
      try {
        // 重新就绪会话并现取一张验证码（「换一张」也走这里）。
        await beginIamLogin({
          agiBaseUrl: live.config.baseUrl,
          requestTimeoutMs: live.config.requestTimeoutMs,
        }, { fetchCaptcha: false })
        const cap = await fetchIamCaptcha()
        writeJson(response, 200, { captcha: cap.captchaBase64, captchaMime: cap.captchaMime })
      } catch (error) {
        if (error instanceof IamLoginError) {
          writeJson(response, 502, { error: error.code, detail: error.message })
          return
        }
        handleError(response, error)
      }
    })

    /**
     * 账号密码面板 · 第 2 步：用工号 + 密码 + 验证码完成登录，换回 agi 令牌并落盘。
     * 宿主用缓存会话里 RSA 加密密码提交 IAM，跟随授权链拿到 code，
     * 再 GET agi /auth/sso/callback?code&state 从**响应体**取 access_token（不碰浏览器 sessionStorage），
     * 校验通过后落盘。卡片随即变「已登录」。
     *
     * 返回：
     *   200 {configured:true, hint, expired} —— 登录成功，令牌已保存
     *   401/502 {error, detail}              —— 账号/密码/验证码有误或换令牌失败
     */
    register('/api/tongji-aigc/iam-login', async (request, response) => {
      try {
        let username = ''
        let password = ''
        let checkcode = ''
        try {
          const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
          username = String(body.username || '').trim()
          password = String(body.password || '')
          checkcode = String(body.checkcode || '').trim()
        } catch { /* 空 body 走下面校验 */ }
        if (username === '' || password === '') {
          writeJson(response, 400, { error: 'missing_fields', detail: '请填写工号与密码' })
          return
        }
        // 每次登录前先就绪会话（cookie jar + formAction），验证码按需再取。
        try {
          await beginIamLogin({
            agiBaseUrl: live.config.baseUrl,
            requestTimeoutMs: live.config.requestTimeoutMs,
          }, { fetchCaptcha: false })
        } catch (error) {
          if (error instanceof IamLoginError) {
            writeJson(response, 502, { error: error.code, detail: error.message })
            return
          }
          handleError(response, error)
          return
        }
        const result = await completeIamLogin({ username, password, checkcode })
        const token = String(result?.token || '').trim()
        if (token === '') {
          writeJson(response, 502, { error: 'no_token', detail: '登录未返回令牌' })
          return
        }
        try {
          await validateToken(token)
        } catch (error) {
          writeJson(response, 502, { error: 'invalid_token', detail: error?.message || '令牌校验失败' })
          return
        }
        writeToken(token)
        live.client = null
        const st = tokenStatus()
        writeJson(response, 200, { configured: true, hint: st.hint, expired: isTokenExpired(token), user: result?.user || null })
      } catch (error) {
        if (error instanceof IamLoginError) {
          const status = error.code === 'no_session' ? 401 : error.code === 'second_factor' ? 501 : 401
          writeJson(response, status, { error: error.code, detail: error.message })
          return
        }
        handleError(response, error)
      }
    })

    /**
     * 统一身份认证（SSO）跳转：插件调站点 /auth/sso/discover 取 IAM 授权地址。
     * 仅作为 login-start 的内部依赖 / 兼容保留；卡片应改用 login-start。
     */
    /**
     * 浏览器自动化登录（绕开 IAM 风控的人脸/短信增强认证）。
     * 开一个独立临时 user-data-dir + 调试端口的真浏览器窗口打开 IAM 授权页，
     * 用户在真浏览器里完成登录（含人脸/短信），插件常驻 CDP 监听抓瞬时 token 重定向。
     * 返回：200 {started:true} / 502 {error} / 503 {error:no_browser}
     */
    register('/api/tongji-aigc/browser-login-start', async (request, response) => {
      try {
        const data = await getClient().ssoDiscover('tongji')
        const authUrl = String(data?.redirect_url || data?.url || '').trim()
        if (authUrl === '') {
          writeJson(response, 502, { error: 'sso_discover_failed', detail: '站点未返回 SSO 授权地址' })
          return
        }
        const r = await startBrowserLogin(authUrl)
        writeJson(response, 200, r)
      } catch (error) {
        if (error instanceof BrowserLoginError) {
          const status = error.code === 'no_browser' ? 503 : 502
          writeJson(response, status, { error: error.code, detail: error.message, hint: error.hint })
          return
        }
        handleError(response, error)
      }
    })

    /**
     * 轮询浏览器登录结果。
     * 返回：200 {pending:false, token} 已抓到 / 202 {pending:true, reason} 等待中 / 50x {error}
     */
    register('/api/tongji-aigc/browser-login-poll', async (request, response) => {
      try {
        const r = await pollBrowserLogin()
        logInfo('[tongji-aigc] browser-login-poll → ' + JSON.stringify({ pending: r.pending, reason: r.reason, hasToken: !!r.token }))
        if (!r.pending && r.token) {
          // 取走 token 直接落盘。token 来自官方 SSO 回调（agi/api/v1/auth/sso/callback?token=），可信，
          // 不再走会挂起的 validateToken 网络校验（宿主网络栈下该请求曾永不返回，堵死成功响应）。
          const token = await takeBrowserLoginToken()
          writeToken(token, null)
          const st = tokenStatus()
          // 成功响应发出后再延迟清浏览器/会话，避免前端下次 poll 撞空误判「已取消」
          scheduleDeferredCleanup()
          writeJson(response, 200, { pending: false, configured: true, user: null, hint: st.hint, expired: st.expired })
          return
        }
        writeJson(response, 202, { pending: true, reason: r.reason || 'waiting' })
      } catch (error) {
        handleError(response, error)
      }
    })

    /** 取消浏览器登录：关浏览器、清临时目录。返回：200 {cancelled:true} */
    register('/api/tongji-aigc/browser-login-cancel', async (request, response) => {
      try {
        await cleanupBrowserLogin()
        writeJson(response, 200, { cancelled: true })
      } catch (error) {
        handleError(response, error)
      }
    })

    register('/api/tongji-aigc/sso-url', async (request, response) => {
      try {
        const data = await getClient().ssoDiscover('tongji')
        const url = String(data?.redirect_url || data?.url || '').trim()
        if (url === '') {
          writeJson(response, 502, { error: 'sso_discover_failed', detail: '站点未返回 SSO 授权地址' })
          return
        }
        writeJson(response, 200, { url })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 开始登录（零粘贴的起点）：宿主开一个隔离的一次性浏览器窗并加载临时扩展。
     *   - 先确认本机有可用浏览器（Edge / Chrome），没有就快速降级；
     *   - 取 IAM 授权地址；
     *   - 把临时扩展写到系统临时目录，扩展在 agi 站内轮询 sessionStorage.access_token，
     *     读到后通过顶层导航 `location.replace(origin + '/api/tongji-aigc/relay?token=...')` 回传
     *     （顶层导航不受混合内容拦截，可绕过 HTTPS→HTTP 限制）；
     *   - 用独立 --user-data-dir 开隔离窗口加载该扩展，打开 SSO 授权页；记住 {pid,...}。
     * 用户只需在弹出的隔离窗口里完成同济统一身份认证，令牌会由临时扩展自动回传并落盘，
     * 全程不用复制粘贴；窗口关闭 / 超时后临时扩展与配置目录被删除（关窗即卸载）。
     *
     * 请求体可带 { origin }：回传端点基于此源拼出，缺省则用当前请求的源。
     *
     * 返回：
     *   200 {started:true}             —— 隔离登录窗口已打开，卡片开始轮询
     *   503 {pending:false, reason}    —— 环境缺失（无可用浏览器）
     */
    register('/api/tongji-aigc/login-start', async (request, response) => {
      try {
        // 先确认本机有可用浏览器，缺了就快速降级，不必白打一次上游。
        const exe = await ensureLoginEnv()
        const data = await getClient().ssoDiscover('tongji')
        const authUrl = String(data?.redirect_url || data?.url || '').trim()
        if (authUrl === '') {
          writeJson(response, 502, { error: 'sso_discover_failed', detail: '站点未返回 SSO 授权地址' })
          return
        }
        let origin = ''
        try {
          const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
          origin = String(body.origin || '').trim()
        } catch { /* 没有 body 就用请求源 */ }
        if (origin === '') {
          const host = request.headers?.host || 'localhost'
          origin = `http://${host}`
        }
        const relayUrl = `${origin}/api/tongji-aigc/relay`
        await startLogin(authUrl, relayUrl)
        writeJson(response, 200, { started: true })
      } catch (error) {
        if (error instanceof AutoLoginError) {
          writeJson(response, 503, { pending: false, reason: error.code, detail: error.message })
          return
        }
        handleError(response, error)
      }
    })

    /**
     * 自动同步登录态：临时扩展已把 agi 站内的 sessionStorage.access_token 通过
     * 顶层导航回传并落盘。本端点读回令牌、校验通过后返回 configured，卡片轮询它，
     * 认证一完成就自动变为「已登录」，全程无需复制粘贴令牌。
     *
     * 返回：
     *   200 {configured:true, hint, expired} —— 已同步成功
     *   202 {pending:true, reason, detail}   —— 还没登录好，卡片继续轮询
     *   503 {pending:false, reason, detail}  —— 环境缺失，停止轮询并提示
     */
    register('/api/tongji-aigc/auto-login', async (request, response) => {
      try {
        const token = await readLoginToken()
        try {
          await validateToken(token)
        } catch (error) {
          writeJson(response, 202, { pending: true, reason: 'invalid_token', detail: String(error?.message || error) })
          return
        }
        writeToken(token)
        live.client = null
        writeJson(response, 200, { configured: true, hint: tokenStatus().hint, expired: isTokenExpired(token) })
      } catch (error) {
        if (error instanceof AutoLoginError) {
          const pending = NEED_BROWSER_LOGIN.has(error.code)
          writeJson(response, pending ? 202 : 503, {
            pending,
            reason: error.code,
            detail: error.message,
          })
          return
        }
        handleError(response, error)
      }
    })

    /**
     * AIGC 使用信号：面板不常驻，只在「用了 AIGC」时滑出。
     * 前端轮询 ?since=<上次的 seq>，`stale:false` 表示有新的一次使用，
     * 同时带上那次调用的参数快照供面板回填表单。
     */
    register('/api/tongji-aigc/activity', async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost')
        const since = Number(url.searchParams.get('since') ?? NaN)
        const signal = readActivity(since)
        writeJson(response, 200, {
          seq: signal.seq,
          stale: signal.stale,
          last: signal.last,
          configured: tokenStatus().configured,
        })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 待填写请求查询：面板按会话轮询自己是否有待填的卡片。
     * GET /api/tongji-aigc/pending?session=<sessionId>
     * 返回 { request: {...} | null }；request 存在即表示「工具正在等这个会话填完」。
     */
    register('/api/tongji-aigc/pending', async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost')
        const sessionId = String(url.searchParams.get('session') || '').trim()
        if (sessionId === '') {
          writeJson(response, 400, { error: 'missing_session' })
          return
        }
        writeJson(response, 200, { request: pendingForSession(sessionId) })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 提交用户填写的内容，唤醒阻塞中的工具调用。
     * POST /api/tongji-aigc/pending/submit
     * body: { request_id, values: { mode, template_code, prompt, params, reference_image?, count } }
     */
    register('/api/tongji-aigc/pending/submit', async (request, response) => {
      try {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
        const requestId = String(body.request_id || '').trim()
        if (requestId === '') {
          writeJson(response, 400, { error: 'missing_request_id' })
          return
        }
        const result = submitPending(requestId, body.values)
        if (!result.ok) {
          writeJson(response, result.error === 'not_found' ? 404 : 409, { error: result.error })
          return
        }
        writeJson(response, 200, { ok: true })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 取消本次填写：让阻塞中的工具立刻返回 cancelled，而不是空等到超时。
     * POST /api/tongji-aigc/pending/cancel  body: { request_id }
     */
    register('/api/tongji-aigc/pending/cancel', async (request, response) => {
      try {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
        const requestId = String(body.request_id || '').trim()
        if (requestId === '') {
          writeJson(response, 400, { error: 'missing_request_id' })
          return
        }
        writeJson(response, 200, cancelPending(requestId))
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 模板列表（卡片可选展示，方便选 template_code）。 */
    register('/api/tongji-aigc/templates', async (request, response) => {
      try {
        const type = new URL(request.url ?? '/', 'http://localhost').searchParams.get('type') || undefined
        const templates = await getClient().templates(type)
        writeJson(response, 200, { total: templates.length, templates })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 卡片快速生成。复用与工具同一条链路：创建任务 → 轮询 → 落盘。
     * 产物写到配置的 outputDir 或会话工作目录；返回绝对路径与产物 URL。
     */
    register('/api/tongji-aigc/generate', async (request, response) => {
      try {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
        const client = getClient()
        if (!readToken()) {
          writeJson(response, 401, { error: 'not_logged_in' })
          return
        }
        const mode = String(body.mode || '').trim()
        const prompt = String(body.prompt || '').trim()
        if (!mode) {
          writeJson(response, 400, { error: 'missing_mode' })
          return
        }
        // create_only：面板自己轮询（长任务不该把一个 HTTP 请求挂上几分钟）。
        const createOnly = body.create_only === true
        const result = await generateByMode(client, mode, prompt, {
          template_code: body.template_code,
          params: body.params || {},
          reference_image: body.reference_image,
          count: body.count,
          output_path: body.output_path,
          create_only: createOnly,
        })
        writeJson(response, 200, result)
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 生成前报价（面板的「预估」按钮）：不建任务，只回积分与耗时预估。
     * 与 generate 共用 generate.js 的模板解析，避免两处规则分叉。
     */
    register('/api/tongji-aigc/quote', async (request, response) => {
      try {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        if (!readToken()) {
          writeJson(response, 401, { error: 'not_logged_in' })
          return
        }
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
        const mode = String(body.mode || '').trim()
        if (!mode) {
          writeJson(response, 400, { error: 'missing_mode' })
          return
        }
        const result = await quoteByMode(getClient(), mode, String(body.prompt || ''), {
          template_code: body.template_code,
          params: body.params || {},
          reference_image: body.reference_image,
          count: body.count,
        })
        writeJson(response, 200, result)
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 轮询单个任务（面板轮询自己创建的任务）。
     * 成功时把产物下载到 outputDir 并返回本地路径；前端用 /file 端点预览。
     */
    register('/api/tongji-aigc/task', async (request, response) => {
      try {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        if (!readToken()) {
          writeJson(response, 401, { error: 'not_logged_in' })
          return
        }
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
        const taskId = String(body.task_id || '').trim()
        if (taskId === '') {
          writeJson(response, 400, { error: 'missing_task_id' })
          return
        }
        const client = getClient()
        const task = await client.getTask(taskId)
        const status = String(task?.status || '')
        const outputsReady = Array.isArray(task?.outputs) && task.outputs.length > 0
        const done = status === 'succeeded' || (status === 'moderating' && outputsReady)
        if (!done) {
          writeJson(response, 200, {
            task_id: taskId,
            status,
            progress: task?.progress ?? null,
            execution_stage: task?.execution_stage ?? null,
            done: false,
          })
          return
        }
        // 成功：下载到会话目录，前端按本地路径预览。
        const outputDir = path.resolve(
          String(body.output_path || live.config.outputDir || body.cwd || process.cwd()),
        )
        rememberOutputDir(outputDir)
        const files = await downloadTaskOutputs(client, task, outputDir)
        writeJson(response, 200, {
          task_id: taskId,
          status,
          done: true,
          outputs: files,
          output_dir: outputDir,
        })
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 预览本地产物：GET /api/tongji-aigc/file?path=<绝对路径>。
     *
     * 只允许读**产物目录**下的文件（本次会话生成的产物），路径先 resolve 再比对，
     * 防止面板被当成任意文件读取器。
     */
    register('/api/tongji-aigc/file', async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost')
        const raw = String(url.searchParams.get('path') || '').trim()
        if (raw === '') {
          writeJson(response, 400, { error: 'missing_path' })
          return
        }
        const target = path.resolve(raw)
        if (!isInsideOutputDir(target)) {
          writeJson(response, 403, { error: 'forbidden_path' })
          return
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          writeJson(response, 404, { error: 'not_found' })
          return
        }
        const ext = path.extname(target).toLowerCase()
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
        const stat = fs.statSync(target)
        response.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        })
        fs.createReadStream(target).pipe(response)
      } catch (error) {
        handleError(response, error)
      }
    })

    /**
     * 参考图上传：POST /api/tongji-aigc/upload，body 为原始图片字节，
     * `?name=<文件名>` 给扩展名。落盘到临时目录并返回绝对路径，
     * 前端随后把该路径作为 generate 的 reference_image 传入。
     */
    register('/api/tongji-aigc/upload', async (request, response) => {
      try {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        const url = new URL(request.url, 'http://localhost')
        const rawName = String(url.searchParams.get('name') || 'reference.png')
        // 只取 basename 与合法扩展名，绝不让上传决定目录。
        const ext = (path.extname(rawName) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '')
        const safeExt = /^\.(png|jpe?g|webp|gif|bmp)$/.test(ext) ? ext : '.png'
        const bytes = await readBody(request)
        if (bytes.length === 0) {
          writeJson(response, 400, { error: 'empty_body' })
          return
        }
        if (bytes.length > UPLOAD_MAX_BYTES) {
          writeJson(response, 413, { error: 'too_large' })
          return
        }
        // 不信扩展名也不信 Content-Type：只按文件头判断是不是真图片。
        // 这个端点会落盘，绝不能变成「本机任意内容写入器」。
        const sniffed = sniffImageType(bytes)
        if (sniffed === null) {
          writeJson(response, 415, { error: 'not_an_image' })
          return
        }
        const dir = path.join(os.tmpdir(), 'dsh-tongji-aigc', 'uploads')
        fs.mkdirSync(dir, { recursive: true })
        const name = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${sniffed}`
        const target = path.join(dir, name)
        fs.writeFileSync(target, bytes, { mode: 0o600 })
        writeJson(response, 200, { path: target, name, size: bytes.length })
      } catch (error) {
        handleError(response, error)
      }
    })

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          logWarn(`摘除 HTTP 路由失败：${String(error)}`)
        }
      }
    }
  })

  logInfo('dsh-tongji-aigc 装载完成：工具与卡片端点已就绪')
}

/** 复用 runner 的最小生成链路（给卡片快速生成用，避免把工具 executor 逻辑重复一遍）。 */
async function generateByMode(client, mode, prompt, options) {
  const { createTaskDependencies } = await import('./aigc/generate.js')
  const deps = createTaskDependencies(live.config)
  // 注意参数名：createTaskDependencies 的 run 认 `template_code` / `reference_image`，
  // 早期这里传的是 camelCase，键名对不上就被静默丢掉（模板总选默认、参考图永不生效）。
  return deps.run({ client, mode, prompt, ...options })
}

/** 只报价、不建任务（面板「预估」）。 */
async function quoteByMode(client, mode, prompt, options) {
  const { createTaskDependencies } = await import('./aigc/generate.js')
  const deps = createTaskDependencies(live.config)
  return deps.quoteOnly({ client, mode, prompt, ...options })
}

/**
 * 把一个已完成任务的产物下载到 outputDir，返回可预览的本地文件描述。
 * 文件名沿用 runner 的 `<taskId>-NN_<名称>` 约定，便于和工具产物认亲。
 */
async function downloadTaskOutputs(client, task, outputDir) {
  const outputs = Array.isArray(task?.outputs) ? task.outputs : []
  const results = []
  fs.mkdirSync(outputDir, { recursive: true })
  for (let i = 0; i < outputs.length; i += 1) {
    const output = outputs[i] || {}
    const url = typeof output.url === 'string' ? output.url : ''
    if (url === '') continue
    const fallbackExt = guessExtFromUrl(url)
    const baseName = path.basename(new URL(url, 'http://localhost').pathname) || `output-${i + 1}${fallbackExt}`
    const safeName = `${task?.id || 'task'}-${String(i + 1).padStart(2, '0')}_${baseName}`
    const absPath = path.join(outputDir, safeName)
    try {
      fs.writeFileSync(absPath, await client.downloadBuffer(url))
      results.push({
        index: i + 1,
        name: output.name || baseName,
        url,
        path: absPath,
        kind: mediaKindOf(absPath),
        width: output.width ?? null,
        height: output.height ?? null,
        duration: output.duration ?? null,
      })
    } catch (error) {
      results.push({ index: i + 1, name: baseName, url, path: null, error: String(error?.message || error) })
    }
  }
  return results
}

/** 从 URL 猜扩展名（下载前定文件名用）。 */
function guessExtFromUrl(url) {
  try {
    const match = new URL(url, 'http://localhost').pathname.match(/\.([a-zA-Z0-9]{2,4})$/)
    return match ? `.${match[1].toLowerCase()}` : '.png'
  } catch {
    return '.png'
  }
}

/** 按扩展名归类产物，前端据此决定用图片/视频/音频标签渲染。 */
function mediaKindOf(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (/^\.(png|jpe?g|webp|gif|bmp|ico|svg)$/.test(ext)) return 'image'
  if (/^\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(ext)) return 'video'
  if (/^\.(mp3|wav|ogg|m4a|flac|aac)$/.test(ext)) return 'audio'
  return 'file'
}

/**
 * 产物目录白名单：/file 端点只肯读这些目录下的文件。
 *
 * 安全约束（比「看起来能用」更重要）：
 *   1. 只认「本次运行真的往这里写过产物」的目录（live.outputDirs）；
 *      配置里的 outputDir 只有在确实用过之后才进白名单。
 *   2. 绝不接受文件系统根、用户主目录、盘符根这类过宽目录——
 *      否则 `outputDir: ""` 回落到会话工作目录时，白名单会大到覆盖整个 home。
 *   3. 先 realpath 再比对，防止符号链接把读取带出白名单。
 */
function isInsideOutputDir(target) {
  const realTarget = safeRealpath(target)
  if (realTarget === null) return false
  for (const dir of live.outputDirs) {
    const realDir = safeRealpath(dir)
    if (realDir === null) continue
    if (realTarget === realDir) return false // 目录本身不是文件，交给上层 404
    if (realTarget.startsWith(realDir + path.sep)) return true
  }
  return false
}

/** realpath；不存在或不可解析返回 null。 */
function safeRealpath(target) {
  try {
    return fs.realpathSync(path.resolve(target))
  } catch {
    return null
  }
}

/**
 * 目录是否「足够具体」到可以作为产物白名单。
 *
 * 拒绝：文件系统根、盘符根、用户主目录本身、以及层级过浅的目录。
 * 这些位置一旦进白名单，等于把整个用户目录暴露给 /file。
 */
function isSpecificDir(dir) {
  const real = safeRealpath(dir)
  if (real === null) return false
  const parsed = path.parse(real)
  if (real === parsed.root) return false // 盘符根 / 文件系统根
  if (real === os.homedir()) return false // 主目录本身
  const depth = real.split(path.sep).filter(Boolean).length
  return depth >= 3 // 至少 <盘符>/<一级>/<二级>，避免 ~/x 这种过宽目录
}

/** 扩展名 → MIME，用于 /file 预览。 */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.zip': 'application/zip',
}

/** 参考图上传大小上限（上游接受的原图通常远小于这个数）。 */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/**
 * 按文件头识别图片格式，返回安全扩展名；不是图片返回 null。
 *
 * 上传端点会落盘，因此只认魔数，不认扩展名、不认 Content-Type：
 * 否则这个端点就成了「往本机写任意文件」的通道。
 * @param {Buffer} bytes
 * @returns {string|null}
 */
function sniffImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png'
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  // GIF: "GIF87a" / "GIF89a"
  if (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a') return '.gif'
  // BMP: "BM"
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return '.bmp'
  // WebP: "RIFF"...."WEBP"
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  return null
}
