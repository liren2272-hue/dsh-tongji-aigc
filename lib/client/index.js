/**
 * dsh-tongji-aigc 客户端设置卡片。
 *
 * 出现在「设置 → 插件」。设计取向（状态优先的极简设置卡）：
 *   一张卡里只让一件事最重要——「你现在是谁」。身份用大字号做主角，登录/退出
 *   是唯一主动作；靠留白与字重分层，不靠逐层描边把信息框起来。
 *
 * 登录流程（自动，无输入框、无粘贴）：
 *   1. 点「统一身份认证登录」→ 宿主 /login-start 在本机找一个 Edge / Chrome，
 *      开一个独立临时配置目录的隔离窗口并加载一个临时生成的扩展，再打开 SSO 授权页
 *      （不是用户平时的浏览器，独立 --user-data-dir，不碰用户配置）；
 *   2. 用户就在那个隔离窗口完成同济统一身份认证；站点把令牌写进该窗口
 *      sessionStorage（地址栏不留 token）；
 *   3. 临时扩展的 content script 轮询 sessionStorage.access_token，读到后通过顶层导航
 *      location.replace(本机 DSH /api/tongji-aigc/relay?token=...) 回传（顶层导航不受
 *      mixed-content 拦截，可绕过 HTTPS→HTTP 限制）、校验、落盘；
 *   4. 卡片后台轮询 /api/tongji-aigc/status，一旦 configured 变 true 自动切到「已登录」并显示身份；
 *      登录窗口关闭 / 超时后临时扩展与配置目录被删除（关窗即卸载）。
 *   5. 仅当本机确实没有可用 Edge / Chrome 时，才降级为「复制取令牌脚本」（no-cors 回传）。
 *
 * 为什么是「临时扩展 + 隔离窗口」：宿主无法跨进程 / 跨源读用户浏览器的 sessionStorage；
 * 必须有一段代码跑在用户登录的那个浏览器会话里读令牌再回传。临时扩展只在本次登录写入
 * 并加载、用完即删，不要求开发者模式、不在用户常用浏览器里留下任何痕迹。
 *
 * 约定（照 dsh-api-rules 卡片）：
 *   - 纯 React DOM + 组件级 <style>，React 在 factory 顶层取一次；
 *   - 文案用扁平点号 key，`t(key)` 调用，中英两份字典同写；
 *   - 样式只用宿主真实存在的 --dsw-* token，且带兜底色，主按钮随深浅主题反转；
 *   - 字号分层：20px 标题/身份，14px 正文与按钮，13px 辅助，绝不靠 11px 撑版面。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-tongji-aigc',
  factory(require) {
    const name = 'dsh-tongji-aigc-client'
    const inject = ['slots', 'locale']
    const ReactTop = require('react')

    const zh = {
      'card.signIn': '统一身份认证登录',
      'card.signInBusy': '正在打开登录窗口…',
      'card.ssoFailed': '无法打开登录窗口，请确认本机装有 Edge 或 Chrome 后重试。',
      'card.waitingTitle': '等待登录完成',
      'card.waitingHint': '请在刚弹出的登录窗口里完成同济统一身份认证。登录成功后这里会自动变为已登录，无需复制或粘贴任何令牌；关闭该窗口即结束本次登录。',
      'card.waitingTimeout': '还没检测到登录。可以再点一次登录，或改用下方的备用方式。',
      'card.signOut': '退出登录',
      'card.signOutBusy': '正在退出…',
      'card.signedInAs': '当前登录',
      'card.stateOk': '登录有效',
      'card.stateExpired': '登录已过期',
      'card.autoOk': '登录态已自动同步。',
      'card.signedOutOk': '已退出登录。',
      'card.fallbackTitle': '自动登录暂不可用',
      'card.fallbackHint': '未检测到可用的 Edge / Chrome。可用备用方式：复制一段脚本，切到已登录的同济 AIGC 页面，按 F12 在 Console 里粘贴运行，令牌会自动回传。',
      'card.copyScript': '复制取令牌脚本',
      'card.copied': '脚本已复制。请切到同济 AIGC 页面，按 F12 → Console 粘贴并回车；完成后这里会自动更新。',
      'card.copyFailed': '复制失败，请手动选中下方脚本复制。',
      'card.scriptLabel': '备用脚本',
      'card.notLoggedIn': '尚未登录',
      'card.offline': '暂时无法读取登录状态',
      'card.retry': '重试',
      'card.accountTitle': '统一身份认证',
      'card.accountHint': '点击下方按钮打开同济统一身份认证页面，按提示完成登录（如遇人脸/短信验证照常操作），令牌自动保存，无需复制粘贴。',
      'card.username': '工号 / 学号',
      'card.password': '密码',
      'card.checkcode': '验证码',
      'card.captchaAlt': '登录验证码',
      'card.captchaRefresh': '换一张',
      'card.captchaLoading': '验证码加载中…',
      'card.captchaEmpty': '验证码未加载',
      'card.accountSignIn': '登录',
      'card.accountBusy': '正在登录…',
      'card.accountOk': '登录成功，令牌已保存。',
      'card.accountFailed': '登录失败，请核对工号、密码与验证码后重试。',
      'card.formMissing': '请填写工号、密码与验证码。',
      'card.browserSignIn': '统一身份认证登录',
      'card.browserBusy': '正在打开浏览器…',
      'card.browserWaiting': '已在浏览器打开同济登录页，请在弹出的窗口完成登录（含人脸/短信）…',
      'card.browserOk': '浏览器登录成功，令牌已保存。',
      'card.browserFailed': '浏览器登录失败，请重试。',
      'card.browserCancelled': '已取消浏览器登录。',
      'card.browserCancel': '取消登录',
      'card.quotaTitle': '额度监控',
      'card.refresh': '刷新',
      'card.refreshing': '刷新中…',
      'card.pointsLabel': '可用积分',
      'card.pointsUnit': '积分',
      'card.periodUsed': '本周期已用',
      'card.nextReset': '下次重置',
      'card.imageQuota': '图片额度',
      'card.videoQuota': '视频额度',
      'card.remainingOf': '剩余',
      'card.unitImage': '张',
      'card.unitVideo': '秒',
      'card.quotaLoading': '正在读取额度…',
      'card.quotaUnavailable': '额度暂时无法读取，点刷新重试。',
      'card.expiredTitle': '登录已过期',
      'card.expiredHint': '令牌已失效，请重新登录以继续使用同济 AIGC 的全部能力。',
      'card.reSignIn': '重新登录',
      'card.quotaWarn': '紧张',
      'card.quotaDanger': '告急',
    }

    const en = {
      'card.signIn': 'Unified identity sign-in',
      'card.signInBusy': 'Opening the sign-in window…',
      'card.ssoFailed': 'Could not open the sign-in window; make sure Edge or Chrome is installed and retry.',
      'card.waitingTitle': 'Waiting for sign-in',
      'card.waitingHint': 'Finish the Tongji unified identity sign-in in the window that just popped up. This card turns into "signed in" automatically — no token copying or pasting needed. Closing that window ends this sign-in attempt.',
      'card.waitingTimeout': 'Sign-in not detected yet. Try the button again, or use the fallback below.',
      'card.signOut': 'Sign out',
      'card.signOutBusy': 'Signing out…',
      'card.signedInAs': 'Signed in as',
      'card.stateOk': 'Signed in',
      'card.stateExpired': 'Session expired',
      'card.autoOk': 'Sign-in state synced automatically.',
      'card.signedOutOk': 'Signed out.',
      'card.fallbackTitle': 'Automatic sign-in unavailable',
      'card.fallbackHint': 'No usable Edge / Chrome was detected. Use the fallback: copy a short script, switch to the already signed-in Tongji AIGC page, press F12 and paste it into the Console. The token is sent back automatically.',
      'card.copyScript': 'Copy token script',
      'card.copied': 'Script copied. Switch to the Tongji AIGC page, press F12, paste into the Console and press Enter; this card updates automatically.',
      'card.copyFailed': 'Copy failed. Select the script below and copy it manually.',
      'card.scriptLabel': 'Fallback script',
      'card.notLoggedIn': 'Not signed in',
      'card.offline': 'Could not read the sign-in state',
      'card.retry': 'Retry',
      'card.accountTitle': 'Unified sign-in',
      'card.accountHint': 'Click the button to open the Tongji unified sign-in page and complete the login (follow any face/SMS prompts). The token is saved automatically — no copy-paste needed.',
      'card.username': 'Tongji ID',
      'card.password': 'Password',
      'card.checkcode': 'Captcha',
      'card.captchaAlt': 'Sign-in captcha',
      'card.captchaRefresh': 'New captcha',
      'card.captchaLoading': 'Loading captcha…',
      'card.captchaEmpty': 'Captcha not loaded',
      'card.accountSignIn': 'Sign in',
      'card.accountBusy': 'Signing in…',
      'card.accountOk': 'Signed in. Token saved.',
      'card.accountFailed': 'Sign-in failed. Check your ID, password and captcha, then retry.',
      'card.formMissing': 'Enter your Tongji ID, password and captcha.',
      'card.browserSignIn': 'Sign in with Tongji ID',
      'card.browserBusy': 'Opening browser…',
      'card.browserWaiting': 'Tongji login opened in a browser window. Finish signing in there (face/SMS if asked)…',
      'card.browserOk': 'Signed in via browser. Token saved.',
      'card.browserFailed': 'Browser sign-in failed. Please retry.',
      'card.browserCancelled': 'Browser sign-in cancelled.',
      'card.browserCancel': 'Cancel sign-in',
      'card.quotaTitle': 'Quota',
      'card.refresh': 'Refresh',
      'card.refreshing': 'Refreshing…',
      'card.pointsLabel': 'Available points',
      'card.pointsUnit': 'pts',
      'card.periodUsed': 'Used this cycle',
      'card.nextReset': 'Next reset',
      'card.imageQuota': 'Image quota',
      'card.videoQuota': 'Video quota',
      'card.remainingOf': 'Remaining',
      'card.unitImage': 'images',
      'card.unitVideo': 'seconds',
      'card.quotaLoading': 'Loading quota…',
      'card.quotaUnavailable': 'Quota unavailable right now. Tap refresh to retry.',
      'card.expiredTitle': 'Session expired',
      'card.expiredHint': 'Your token has expired. Sign in again to keep using Tongji AIGC.',
      'card.reSignIn': 'Sign in again',
      'card.quotaWarn': 'High',
      'card.quotaDanger': 'Critical',
    }

    const CSS = [
      '.ta-card{display:flex;flex-direction:column;gap:18px;font-family:var(--dsw-font-family, var(--dsw-font, system-ui, sans-serif));color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.ta-card *{box-sizing:border-box;}',
      '.ta-rule{height:1px;background:var(--dsw-alias-border-l1, #e3e5e8);border:0;margin:0;}',
      '.ta-main{display:flex;flex-direction:column;gap:14px;}',
      '.ta-eyebrow{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary, #7a7a7d);}',
      '.ta-identity{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.ta-name{margin:0;font-size:20px;font-weight:600;line-height:1.35;word-break:break-word;color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.ta-meta{margin:0;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary, #5a5a5c);word-break:break-word;}',
      '.ta-state{display:inline-flex;align-items:center;gap:8px;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary, #5a5a5c);flex-wrap:wrap;}',
      '.ta-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary, #1a7f37);}',
      '.ta-dot.bad{background:var(--dsw-alias-state-error-primary, #d93026);}',
      '.ta-dot.idle{background:var(--dsw-alias-label-tertiary, #7a7a7d);}',
      '.ta-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.ta-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:var(--dsw-radius-md, 8px);padding:10px 18px;font-family:inherit;font-size:14px;font-weight:600;line-height:1.4;cursor:pointer;transition:background-color .16s ease, opacity .16s ease;}',
      '.ta-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.ta-btn:disabled{opacity:.55;cursor:not-allowed;}',
      '.ta-btn.primary{background:var(--dsw-alias-button-primary-fill, currentColor);color:var(--dsw-alias-label-primary-foreground, CanvasText);border:1px solid transparent;}',
      '.ta-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover, currentColor);}',
      '.ta-btn.ghost{background:transparent;color:var(--dsw-alias-label-secondary, #5a5a5c);border:1px solid var(--dsw-alias-border-l2, #d0d3d8);}',
      '.ta-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, #f2f4f7);}',
      '.ta-wait{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.ta-wait-dot{width:8px;height:8px;margin-top:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-brand-primary, #2f6feb);animation:ta-pulse 1.4s ease-in-out infinite;}',
      '@keyframes ta-pulse{0%,100%{opacity:.35;}50%{opacity:1;}}',
      '.ta-wait-body{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.ta-wait-title{font-size:14px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.ta-wait-hint{font-size:14px;line-height:1.65;color:var(--dsw-alias-label-secondary, #5a5a5c);overflow-wrap:anywhere;}',
      '.ta-note{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary, #5a5a5c);overflow-wrap:anywhere;}',
      '.ta-note.ok{color:var(--dsw-alias-state-success-primary, #1a7f37);}',
      '.ta-note.bad{color:var(--dsw-alias-state-error-primary, #d93026);}',
      '.ta-fallback{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.ta-fallback-title{font-size:14px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.ta-fallback-hint{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary, #5a5a5c);overflow-wrap:anywhere;}',
      '.ta-script{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1, #fff);border:1px solid var(--dsw-alias-border-l2, #d0d3d8);font-family:var(--dsw-font-markdown-code-font-family, ui-monospace, monospace);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary, #1b1b1c);white-space:pre-wrap;word-break:break-all;user-select:all;}',
      '.ta-script-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary, #7a7a7d);}',
      '.ta-form{display:flex;flex-direction:column;gap:10px;padding-top:2px;}',
      '.ta-form-hint{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary, #7a7a7d);overflow-wrap:anywhere;}',
      '.ta-input{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, #d0d3d8);background:var(--dsw-alias-bg-layer-1, #fff);color:var(--dsw-alias-label-primary, #1b1b1c);font-family:inherit;font-size:14px;line-height:1.4;}',
      '.ta-input:focus{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:1px;border-color:transparent;}',
      '.ta-input:disabled{opacity:.55;}',
      '.ta-captcha-row{display:flex;align-items:center;gap:10px;}',
      '.ta-captcha{height:42px;width:auto;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, #d0d3d8);display:block;}',
      '.ta-captcha-empty,.ta-captcha-loading{font-size:12px;color:var(--dsw-alias-label-tertiary, #7a7a7d);min-width:96px;}',
      '.ta-captcha-refresh{flex:none;padding:7px 12px;font-size:13px;font-weight:500;}',
      '.ta-form-err{margin:0;font-size:12px;line-height:1.5;color:#c0392b;}',
      // ---- 额度监控：积分 44px 主角，两个百分比 22px 次级 ----
      // 配色原则：状态色一律走宿主语义 token（var(--dsw-alias-state-*)，仅带 fallback），
      // 阈值由 data-tier 属性（normal/warn/danger）驱动，绝不写死裸十六进制填充色。
      // 12px 辅助行统一用 label-secondary（实测 ≥5.8:1）而非 tertiary，保证 WCAG AA。
      '.ta-quota{display:flex;flex-direction:column;gap:10px;}',
      '.ta-quota-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.ta-quota-head-label{font-size:13px;font-weight:600;line-height:1.5;letter-spacing:.02em;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.ta-refresh{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:4px 6px;border-radius:var(--dsw-radius-sm, 6px);font-family:inherit;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary, #5a5a5c);cursor:pointer;}',
      '.ta-refresh:hover:not(:disabled){color:var(--dsw-alias-brand-primary, #2f6feb);background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.ta-refresh:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.ta-refresh:disabled{opacity:.55;cursor:not-allowed;}',
      '.ta-refresh svg{width:13px;height:13px;display:block;}',
      '.ta-refresh.spinning svg{animation:ta-spin .9s linear infinite;}',
      '@keyframes ta-spin{to{transform:rotate(360deg);}}',
      '.ta-balance{position:relative;display:flex;flex-direction:column;gap:0;padding:18px 20px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);background:var(--dsw-alias-bg-layer-2, #f7f8fa);overflow:hidden;}',
      '.ta-balance::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-brand-primary, #2f6feb);}',
      '.ta-balance-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}',
      '.ta-balance-label{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.ta-balance-value{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}',
      '.ta-points{margin:0;font-size:44px;font-weight:700;line-height:1.05;letter-spacing:-.025em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.ta-points-unit{font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.ta-balance-sub{margin:8px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.ta-balance-sep{height:1px;background:var(--dsw-alias-border-l1, #e3e5e8);border:0;margin:16px 0 14px;}',
      '.ta-meters{display:grid;grid-template-columns:1fr 1fr;gap:0;}',
      '.ta-meter{min-width:0;padding-right:18px;}',
      '.ta-meter + .ta-meter{padding-right:0;padding-left:18px;border-left:1px solid var(--dsw-alias-border-l1, #e3e5e8);}',
      '.ta-meter-top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 8px;row-gap:4px;}',
      '.ta-meter-label{font-size:12px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary, #5a5a5c);white-space:nowrap;}',
      '.ta-meter-right{display:inline-flex;align-items:center;gap:8px;margin-left:auto;}',
      '.ta-meter-pct{font-size:22px;font-weight:700;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary, #1b1b1c);}',
      // 状态冗余：高占用时百分比数字本身染状态色 + 带 ⚠ 图标的文字徽标，去色后也能读出告急。
      '.ta-meter-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;line-height:1.4;white-space:nowrap;border:1px solid currentColor;}',
      '.ta-meter-badge svg{width:12px;height:12px;display:block;}',
      // 轨道：用更实的 border-l2 底 + 一圈 border-l1 描边，深浅两套都能看清全长，不再悬空。
      '.ta-meter-track{height:7px;border-radius:999px;background:var(--dsw-alias-border-l2, #c6cbd2);border:1px solid var(--dsw-alias-border-l1, #b0b6bf);overflow:hidden;margin:9px 0 7px;}',
      '.ta-meter-fill{height:100%;border-radius:999px;transition:width .45s cubic-bezier(.2,.7,.3,1);}',
      '.ta-meter-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, #5a5a5c);font-variant-numeric:tabular-nums;}',
      // 三段阈值：normal 蓝(brand) / warn 橙(state-warning) / danger 红(state-error)，全走 token。
      '.ta-meter[data-tier="normal"] .ta-meter-fill{background:var(--dsw-alias-brand-primary, #2f6feb);}',
      '.ta-meter[data-tier="warn"] .ta-meter-fill{background:var(--dsw-alias-state-warning-primary, #9a6700);}',
      '.ta-meter[data-tier="danger"] .ta-meter-fill{background:var(--dsw-alias-state-error-primary, #c0261a);}',
      '.ta-meter[data-tier="warn"] .ta-meter-pct,.ta-meter[data-tier="warn"] .ta-meter-badge{color:var(--dsw-alias-state-warning-primary, #9a6700);}',
      '.ta-meter[data-tier="danger"] .ta-meter-pct,.ta-meter[data-tier="danger"] .ta-meter-badge{color:var(--dsw-alias-state-error-primary, #c0261a);}',
      '.ta-quota-loading,.ta-quota-error{font-size:13px;line-height:1.6;padding:14px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-2, #f7f8fa);color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.ta-quota-error{color:var(--dsw-alias-state-error-primary, #d93026);}',
      // ---- 令牌失效告警 ----
      '.ta-expired{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-state-error-primary, #d93026);background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.ta-expired-icon{flex:0 0 auto;width:18px;height:18px;margin-top:1px;color:var(--dsw-alias-state-error-primary, #d93026);}',
      '.ta-expired-body{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;}',
      '.ta-expired-title{font-size:14px;font-weight:700;line-height:1.5;color:var(--dsw-alias-state-error-primary, #d93026);}',
      '.ta-expired-hint{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.ta-expired-btn{align-self:flex-start;margin-top:2px;padding:7px 14px;font-size:13px;}',
      '@media (max-width:520px){.ta-points{font-size:38px;}.ta-meters{grid-template-columns:1fr;gap:14px;}.ta-meter + .ta-meter{padding-left:0;border-left:0;border-top:1px solid var(--dsw-alias-border-l1,#e3e5e8);padding-top:14px;}}',
    ].join('')

    /** 生成备用回传脚本：用运行时宿主源拼端点，端口不写死。 */
    function buildRelayScript(origin) {
      return [
        "(async () => {",
        "  const token = sessionStorage.getItem('access_token');",
        "  if (!token) { console.error('未登录：请先在本页面完成同济统一身份认证'); return; }",
        "  const relay = '" + origin + "/api/tongji-aigc/relay?token=' + encodeURIComponent(token);",
        "  window.location.replace(relay);",
        "})()",
      ].join('\n')
    }

    /** 额度剩余百分比：展示「还剩多少」而非「用了多少」，limit<=0 归零，封顶 100。 */
    function quotaPct(used, limit) {
      const u = Number(used)
      const l = Number(limit)
      if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return 0
      const remaining = Math.max(0, l - u)
      return Math.min(100, Math.round((remaining / l) * 100))
    }
    /** 进度条/状态语义（按剩余百分比）：剩余<=10% 危险 / <=30% 告警 / 否则正常。 */
    function quotaTier(pctValue) {
      if (pctValue <= 10) return 'danger'
      if (pctValue <= 30) return 'warn'
      return 'normal'
    }
    function fmtNum(n) {
      const v = Number(n)
      return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0'
    }
    /** "2026-11-19T20:11:33+08:00" → "11-19 20:11" */
    function fmtReset(iso) {
      if (!iso) return ''
      const s = String(iso)
      const m = s.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
      return m ? m[1] + '-' + m[2] + ' ' + m[3] + ':' + m[4] : s.slice(0, 16).replace('T', ' ')
    }

    function App({ React, t }) {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [waiting, setWaiting] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [noticeTone, setNoticeTone] = React.useState('info')
      const [fallback, setFallback] = React.useState(null)
      const [scriptVisible, setScriptVisible] = React.useState(false)
      // 额度监控：quota 为 /api/tongji-aigc/quota 的聚合结果；单独 loading/error，不拖垮主卡片。
      const [quota, setQuota] = React.useState(null)
      const [quotaBusy, setQuotaBusy] = React.useState(false)
      const [quotaError, setQuotaError] = React.useState(null)
      const pollRef = React.useRef(null)

      // 派生量提前到最顶部：任何 useEffect / useCallback 依赖它们都不会踩 TDZ 白屏坑。
      const offline = status?.__offline === true
      const configured = status?.configured === true
      const expired = status?.expired === true
      const user = status?.user || null

      const stopPolling = React.useCallback(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, [])

      React.useEffect(() => () => stopPolling(), [stopPolling])

      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/api/tongji-aigc/status', { cache: 'no-store' })
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error || 'status failed')
          setStatus(data)
        } catch {
          setStatus({ __offline: true })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      /** 拉额度聚合数据；后端各步独立容错，单个失败只置 quotaError，其余照常渲染。 */
      const loadQuota = React.useCallback(async () => {
        setQuotaBusy(true)
        setQuotaError(null)
        try {
          const res = await fetch('/api/tongji-aigc/quota', { cache: 'no-store' })
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error || 'quota failed')
          setQuota(data)
        } catch (error) {
          setQuotaError(String(error?.message || error))
          setQuota(null)
        } finally {
          setQuotaBusy(false)
        }
      }, [])

      // 登录态就绪后自动拉一次额度；令牌失效/未登录时不打扰上游。
      React.useEffect(() => {
        if (configured && !expired) loadQuota()
        else {
          setQuota(null)
          setQuotaError(null)
        }
      }, [configured, expired, loadQuota])

      /** 轮询直到 configured=true；auto 模式遇到环境缺失则切到降级。 */
      const startPolling = React.useCallback(
        (mode) => {
          stopPolling()
          let ticks = 0
          pollRef.current = setInterval(async () => {
            ticks += 1
            if (ticks > 90) {
              stopPolling()
              setWaiting(false)
              setNotice(t('card.waitingTimeout'))
              setNoticeTone('bad')
              return
            }
            try {
              const path = mode === 'status' ? '/api/tongji-aigc/status' : '/api/tongji-aigc/auto-login'
              const res = await fetch(path, { cache: 'no-store' })
              const data = await res.json()
              if (data?.configured === true) {
                stopPolling()
                setWaiting(false)
                setFallback(null)
                setScriptVisible(false)
                await load()
                setNotice(mode === 'auto' ? t('card.autoOk') : t('card.autoOk'))
                setNoticeTone('ok')
                return
              }
              if (mode === 'auto' && (res.status === 503 || data?.pending === false)) {
                stopPolling()
                setWaiting(false)
                setFallback(data)
              }
            } catch {
              /* 网络抖动，下一轮继续 */
            }
          }, 2000)
        },
        [load, stopPolling, t],
      )

      const signIn = async () => {
        if (busy || waiting) return
        setBusy('signin')
        setNotice(null)
        setFallback(null)
        setScriptVisible(false)
        try {
          // 关键：不再 window.open 到用户自己的 Chrome，也不依赖浏览器自动化服务。
          // 由宿主 login-start 在本机找一个 Edge / Chrome，开一个隔离的一次性窗口并加载
          // 临时扩展；用户在那个窗口完成 SSO，扩展通过顶层导航把令牌回传 DSH 并落盘。
          // 把当前宿主源带上，扩展回传端点才能真正命中本机 DSH（端口不写死）。
          const origin = String(window.location?.origin || '')
          const res = await fetch('/api/tongji-aigc/login-start', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(origin ? { origin } : {}),
          })
          const data = await res.json()
          if (!res.ok || data?.started !== true) {
            // 环境缺失（503 pending=false）→ 降级；其余当普通错误提示
            if (res.status === 503 || data?.pending === false) {
              setFallback(data)
            } else {
              throw new Error(data?.detail || data?.error || t('card.ssoFailed'))
            }
          } else {
            setWaiting(true)
            startPolling('auto')
          }
        } catch (error) {
          setNotice(String(error?.message || error))
          setNoticeTone('bad')
        } finally {
          setBusy('')
        }
      }

      const signOut = async () => {
        if (busy) return
        stopPolling()
        setWaiting(false)
        setBusy('signout')
        setNotice(null)
        setFallback(null)
        try {
          const res = await fetch('/api/tongji-aigc/token', { method: 'DELETE', cache: 'no-store' })
          if (!res.ok) throw new Error('sign out failed')
          setNotice(t('card.signedOutOk'))
          setNoticeTone('ok')
          await load()
        } catch (error) {
          setNotice(String(error?.message || error))
          setNoticeTone('bad')
        } finally {
          setBusy('')
        }
      }

      const copyScript = async () => {
        const origin = String(window.location?.origin || '')
        const script = buildRelayScript(origin)
        let copied = false
        try {
          await navigator.clipboard.writeText(script)
          copied = true
        } catch {
          copied = false
        }
        setScriptVisible(!copied)
        setNotice(copied ? t('card.copied') : t('card.copyFailed'))
        setNoticeTone(copied ? 'ok' : 'bad')
        // 回传落盘后 status 会变 configured，轮询状态即可，不再依赖浏览器自动化。
        setWaiting(true)
        startPolling('status')
      }

      // ---- 统一身份认证登录（弹浏览器，主路径）----
      const [formErr, setFormErr] = React.useState(null)

      // ---- 浏览器自动化登录（绕开 IAM 风控的人脸/短信增强认证）----
      const [browserBusy, setBrowserBusy] = React.useState(false)
      const [browserPolling, setBrowserPolling] = React.useState(false)

      /** 弹真浏览器登录（含人脸/短信），常驻 CDP 监听抓 token。 */
      const browserSignIn = async () => {
        if (browserBusy || browserPolling || busy !== '') return
        setFormErr(null)
        setBrowserBusy(true)
        try {
          const res = await fetch('/api/tongji-aigc/browser-login-start', { method: 'POST', cache: 'no-store' })
          const data = await res.json()
          if (!res.ok || !data?.started) throw new Error(data?.detail || data?.error || 'start failed')
          setBrowserPolling(true)
          setNotice(t('card.browserWaiting'))
          setNoticeTone('')
          // 轮询，最多 10 分钟
          const deadline = Date.now() + 10 * 60 * 1000
          let ok = false
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500))
            let pr
            try {
              pr = await (await fetch('/api/tongji-aigc/browser-login-poll', { method: 'POST', cache: 'no-store' })).json()
            } catch { continue }
            if (pr?.pending === false) {
              if (pr.configured === true) {
                setBrowserPolling(false)
                setBrowserBusy(false)
                await load()
                setNotice(t('card.browserOk'))
                setNoticeTone('ok')
                ok = true
              } else {
                setFormErr(pr?.detail || t('card.browserFailed'))
                setBrowserPolling(false)
              }
              break
            }
            if (pr?.reason === 'browser_closed' || pr?.reason === 'timeout' || pr?.reason === 'no_session') {
              setBrowserPolling(false)
              break
            }
          }
          if (!ok && !browserPolling === false) { /* loop end without ok */ }
          if (!ok) {
            setBrowserPolling(false)
            if (!formErr) setNotice(t('card.browserCancelled'))
          }
        } catch (error) {
          setFormErr(String(error?.message || error))
          setBrowserPolling(false)
        } finally {
          setBrowserBusy(false)
        }
      }

      /** 取消浏览器登录。 */
      const browserCancel = async () => {
        try { await fetch('/api/tongji-aigc/browser-login-cancel', { method: 'POST', cache: 'no-store' }) } catch {}
        setBrowserPolling(false)
        setNotice(t('card.browserCancelled'))
        setNoticeTone('')
      }

      const e = React.createElement
      const relayScript = buildRelayScript(String(window.location?.origin || ''))

      /** 一个额度 meter：标签 + 大百分比（小字号相对积分）+ 状态徽标 + 进度条 + 用量副行。 */
      const renderMeter = (labelKey, unitKey, bucket) => {
        const pctValue = quotaPct(bucket?.used, bucket?.limit)
        const remaining = Math.max(0, Number(bucket?.limit) - Number(bucket?.used))
        const tier = quotaTier(pctValue)
        const badge = tier === 'danger'
          ? e('span', { className: 'ta-meter-badge' },
              e('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
                e('path', { d: 'M8 1.5 15 14H1L8 1.5zm0 3.2L2.8 13h10.4L8 4.7zM7.2 7h1.6v3.4H7.2V7zm0 4.3h1.6v1.5H7.2v-1.5z' })),
              t('card.quotaDanger'))
          : tier === 'warn'
            ? e('span', { className: 'ta-meter-badge' },
                e('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
                  e('path', { d: 'M8 1.5 15 14H1L8 1.5zm0 3.2L2.8 13h10.4L8 4.7zM7.2 7h1.6v3.4H7.2V7zm0 4.3h1.6v1.5H7.2v-1.5z' })),
                t('card.quotaWarn'))
            : null
        return e(
          'div',
          { className: 'ta-meter', 'data-tier': tier },
          e('div', { className: 'ta-meter-top' },
            e('span', { className: 'ta-meter-label' }, t(labelKey)),
            e('span', { className: 'ta-meter-right' },
              badge,
              e('span', { className: 'ta-meter-pct' }, pctValue + '%'),
            ),
          ),
          e('div', { className: 'ta-meter-track' },
            e('div', { className: 'ta-meter-fill', style: { width: pctValue + '%' } }),
          ),
          e('div', { className: 'ta-meter-sub' },
            t('card.remainingOf') + ' ' + fmtNum(remaining) + ' / ' + fmtNum(bucket?.limit) + ' ' + t(unitKey),
          ),
        )
      }

      /** 额度监控区：积分大字 + 图片/视频两个小百分比。 */
      const renderQuota = () => {
        if (!configured || expired) return null
        const head = e('div', { className: 'ta-quota-head' },
          e('span', { className: 'ta-quota-head-label' }, t('card.quotaTitle')),
          e('button', {
            className: 'ta-refresh' + (quotaBusy ? ' spinning' : ''),
            type: 'button',
            onClick: loadQuota,
            disabled: quotaBusy,
            title: t('card.refresh'),
            'aria-label': t('card.refresh'),
          },
            e('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'aria-hidden': 'true' },
              e('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.4-3.7M13.5 2.5V5h-2.5' })),
            e('span', null, quotaBusy ? t('card.refreshing') : t('card.refresh')),
          ),
        )
        let body
        if (quotaBusy && !quota) {
          body = e('div', { className: 'ta-quota-loading' }, t('card.quotaLoading'))
        } else if (quotaError || !quota || quota.configured === false) {
          body = e('div', { className: 'ta-quota-error' }, t('card.quotaUnavailable'))
        } else {
          const p = quota.points || {}
          const resetStr = fmtReset(p.nextResetAt)
          body = e('div', { className: 'ta-balance' },
            e('div', { className: 'ta-balance-top' },
              e('span', { className: 'ta-balance-label' }, t('card.pointsLabel')),
            ),
            e('div', { className: 'ta-balance-value' },
              e('span', { className: 'ta-points' }, fmtNum(p.total)),
              e('span', { className: 'ta-points-unit' }, t('card.pointsUnit')),
            ),
            e('p', { className: 'ta-balance-sub' },
              t('card.periodUsed') + ' ' + fmtNum(p.periodUsed) +
                (resetStr ? ' · ' + t('card.nextReset') + ' ' + resetStr : ''),
            ),
            e('hr', { className: 'ta-balance-sep' }),
            e('div', { className: 'ta-meters' },
              renderMeter('card.imageQuota', 'card.unitImage', quota.image),
              renderMeter('card.videoQuota', 'card.unitVideo', quota.video),
            ),
          )
        }
        return e('div', { className: 'ta-quota' }, head, body)
      }

      /** 令牌失效告警：明确告知 + 重新登录按钮（复用浏览器登录主路径）。 */
      const renderExpired = () => {
        if (!expired) return null
        return e('div', { className: 'ta-expired' },
          e('svg', { className: 'ta-expired-icon', viewBox: '0 0 20 20', fill: 'currentColor', 'aria-hidden': 'true' },
            e('path', { d: 'M10 2 19 18H1L10 2zm0 3.4L2.6 16.5h14.8L10 5.4zM9.1 8.5h1.8v4.6H9.1V8.5zm0 5.6h1.8v1.9H9.1v-1.9z' }),
          ),
          e('div', { className: 'ta-expired-body' },
            e('span', { className: 'ta-expired-title' }, t('card.expiredTitle')),
            e('p', { className: 'ta-expired-hint' }, t('card.expiredHint')),
            e('button', {
              className: 'ta-btn primary ta-expired-btn',
              type: 'button',
              onClick: browserSignIn,
              disabled: busy !== '' || browserBusy,
            }, t('card.reSignIn')),
          ),
        )
      }

      const meta = user
        ? [user.college, user.role_display_name || user.role_name].filter(Boolean).join(' · ')
        : ''

      return e(
        'div',
        { className: 'ta-card' },
        e('style', null, CSS),
        e('hr', { className: 'ta-rule' }),

        e(
          'div',
          { className: 'ta-main' },
          configured && user
            ? e(
                'div',
                { className: 'ta-identity' },
                e('span', { className: 'ta-eyebrow' }, t('card.signedInAs')),
                e('p', { className: 'ta-name' }, user.nickname || user.username || t('card.signedInAs')),
                meta ? e('p', { className: 'ta-meta' }, meta) : null,
              )
            : null,

          e(
            'div',
            { className: 'ta-state' },
            e('span', {
              className: 'ta-dot' + (configured ? (expired ? ' bad' : '') : ' idle'),
            }),
            e(
              'span',
              null,
              configured
                ? expired
                  ? t('card.stateExpired')
                  : t('card.stateOk')
                : offline
                  ? t('card.offline')
                  : t('card.notLoggedIn'),
            ),
          ),

          // 令牌信息/到期时间按需求移除；失效时给明确告警 + 重新登录。
          renderExpired(),

          // 额度监控（积分大字 + 图片/视频小百分比）；未登录或失效时不显示。
          renderQuota(),

          waiting
            ? e(
                'div',
                { className: 'ta-wait' },
                e('span', { className: 'ta-wait-dot' }),
                e(
                  'div',
                  { className: 'ta-wait-body' },
                  e('span', { className: 'ta-wait-title' }, t('card.waitingTitle')),
                  e('span', { className: 'ta-wait-hint' }, t('card.waitingHint')),
                ),
              )
            : null,

          e(
            'div',
            { className: 'ta-actions' },
            !configured
              ? null
              : e(
                  'button',
                  {
                    className: 'ta-btn ghost',
                    type: 'button',
                    onClick: signOut,
                    disabled: busy !== '',
                  },
                  busy === 'signout' ? t('card.signOutBusy') : t('card.signOut'),
                ),
            offline
              ? e(
                  'button',
                  { className: 'ta-btn ghost', type: 'button', onClick: load },
                  t('card.retry'),
                )
              : null,
          ),

          // 统一身份认证登录：一个按钮，点它弹浏览器完成登录（含人脸/短信）。
          !configured
            ? e(
                'div',
                { className: 'ta-form' },
                e('div', { className: 'ta-eyebrow' }, t('card.accountTitle')),
                e('p', { className: 'ta-form-hint' }, t('card.accountHint')),
                formErr ? e('p', { className: 'ta-form-err' }, formErr) : null,
                e(
                  'button',
                  {
                    className: 'ta-btn primary',
                    type: 'button',
                    onClick: browserPolling ? browserCancel : browserSignIn,
                    disabled: busy !== '' || (browserBusy && !browserPolling),
                  },
                  browserPolling ? t('card.browserCancel') : (browserBusy ? t('card.browserBusy') : t('card.browserSignIn')),
                ),
              )
            : null,

          fallback && !configured
            ? e(
                'div',
                { className: 'ta-fallback' },
                e('span', { className: 'ta-fallback-title' }, t('card.fallbackTitle')),
                e('p', { className: 'ta-fallback-hint' }, t('card.fallbackHint')),
                e(
                  'button',
                  { className: 'ta-btn ghost', type: 'button', onClick: copyScript },
                  t('card.copyScript'),
                ),
                scriptVisible
                  ? e(
                      'div',
                      null,
                      e('div', { className: 'ta-script-label' }, t('card.scriptLabel')),
                      e('pre', { className: 'ta-script' }, relayScript),
                    )
                  : null,
              )
            : null,

          notice
            ? e('div', { className: 'ta-note ' + (noticeTone === 'ok' ? 'ok' : noticeTone === 'bad' ? 'bad' : '') }, notice)
            : null,
        ),
      )
    }

    // ===================== 右侧栏「同济 AIGC」生成面板 =====================
    //
    // 面板把「要输入的内容」从对话里的自然语言，拆成一张张可点选 / 可填写的卡片：
    //   生成模式 → 模板 → 提示词 → 模板参数（按 param_schema 自动生成）→ 参考图 → 预估 → 生成。
    // 数据来源都是插件已有的同源端点：/templates、/quote、/generate(create_only)、/task、/upload、/file。
    const PANEL_NS = 'tongjiAigcPanel'
    const PANEL_ID = '@local/dsh-tongji-aigc/panel'
    const PANEL_STORE_KEY = 'dsh-tongji-aigc.panel.v1'
    const REF_MODES = ['i2i', 'i2v', 'i23d']
    const MODE_IDS = ['t2i', 'i2i', 't2v', 'i2v', 't23d', 'i23d', 't2a']
    const MODE_GLYPHS = { t2i: '图', i2i: '图+', t2v: '影', i2v: '影+', t23d: '3D', i23d: '3D+', t2a: '乐' }

    const panelZh = {
      'tab.title': '同济 AIGC',
      'mode.title': '生成模式',
      'mode.t2i': '文生图', 'mode.i2i': '图生图', 'mode.t2v': '文生视频', 'mode.i2v': '图生视频',
      'mode.t23d': '文生 3D', 'mode.i23d': '图生 3D', 'mode.t2a': '文生音乐',
      'template.title': '模板',
      'template.loading': '正在读取模板…',
      'template.empty': '该模式暂无可用模板',
      'template.count': '个',
      'prompt.title': '提示词',
      'prompt.placeholder': '描述你想要的画面：主体、风格、光线、构图…',
      'prompt.required': '必填',
      'prompt.optional': '可选',
      'params.title': '参数',
      'params.empty': '该模板没有额外参数',
      'params.reset': '恢复默认',
      'params.random': '随机',
      'ref.title': '参考图',
      'ref.pick': '选择图片',
      'ref.change': '更换',
      'ref.clear': '移除',
      'ref.hint': '这个模式需要一张参考图',
      'ref.uploading': '正在上传…',
      'quote.title': '生成前预估',
      'quote.idle': '点「预估积分」先看看这次要花多少积分、大概多久。',
      'quote.check': '预估积分',
      'quote.checking': '正在预估…',
      'quote.points': '积分',
      'quote.duration': '预计耗时',
      'quote.range': '{a}–{b} 秒',
      'quote.failed': '暂时无法预估',
      'action.generate': '开始生成',
      'action.generating': '正在生成…',
      'action.submit': '提交这些参数',
      'action.submitting': '正在提交…',
      'action.submitHint': '提交后任务会继续；不提交就一直在等。',
      'action.cancel': '停止等待',
      'action.again': '再生成一次',
      'status.created': '已创建任务，排队中…',
      'status.queued': '排队中…',
      'status.submitted': '已提交…',
      'status.running': '生成中…',
      'status.moderating': '内容审核中…',
      'status.failed': '生成失败',
      'status.done': '生成完成',
      'result.title': '产物',
      'result.dir': '保存目录',
      'notLogin.title': '尚未登录同济 AIGC',
      'notLogin.hint': '到「设置 → 插件 → 同济 AIGC」完成统一身份认证，回来后即可在这里生成。',
      'dock.sub': '本次调用',
      'dock.close': '收起面板',
      'dock.needInput': '需要你填写生成参数',
      'dock.collapse': '收起',
      'dock.expand': '展开填写',
      'dock.cancel': '取消本次填写',
      'error.missingPrompt': '请先填写提示词',
      'error.missingRef': '这个模式需要先选一张参考图',
      'error.generic': '操作失败，请重试',
    }

    const panelEn = {
      'tab.title': 'Tongji AIGC',
      'mode.title': 'Mode',
      'mode.t2i': 'Text to image', 'mode.i2i': 'Image to image', 'mode.t2v': 'Text to video', 'mode.i2v': 'Image to video',
      'mode.t23d': 'Text to 3D', 'mode.i23d': 'Image to 3D', 'mode.t2a': 'Text to music',
      'template.title': 'Template',
      'template.loading': 'Loading templates…',
      'template.empty': 'No template for this mode',
      'template.count': '',
      'prompt.title': 'Prompt',
      'prompt.placeholder': 'Describe the subject, style, lighting and composition…',
      'prompt.required': 'required',
      'prompt.optional': 'optional',
      'params.title': 'Parameters',
      'params.empty': 'This template has no extra parameters',
      'params.reset': 'Reset',
      'params.random': 'Random',
      'ref.title': 'Reference image',
      'ref.pick': 'Choose image',
      'ref.change': 'Replace',
      'ref.clear': 'Remove',
      'ref.hint': 'This mode needs one reference image',
      'ref.uploading': 'Uploading…',
      'quote.title': 'Estimate',
      'quote.idle': 'Tap “Estimate cost” to see the points and expected time for this run.',
      'quote.check': 'Estimate cost',
      'quote.checking': 'Estimating…',
      'quote.points': 'pts',
      'quote.duration': 'Expected time',
      'quote.range': '{a}–{b} s',
      'quote.failed': 'Estimate unavailable',
      'action.generate': 'Generate',
      'action.generating': 'Generating…',
      'action.submit': 'Submit these settings',
      'action.submitting': 'Submitting…',
      'action.submitHint': 'The task continues once you submit; until then it keeps waiting.',
      'action.cancel': 'Stop waiting',
      'action.again': 'Generate again',
      'status.created': 'Task created, queued…',
      'status.queued': 'Queued…',
      'status.submitted': 'Submitted…',
      'status.running': 'Generating…',
      'status.moderating': 'Under review…',
      'status.failed': 'Generation failed',
      'status.done': 'Done',
      'result.title': 'Output',
      'result.dir': 'Saved to',
      'notLogin.title': 'Not signed in to Tongji AIGC',
      'notLogin.hint': 'Sign in under Settings → Plugins → Tongji AIGC, then come back here to generate.',
      'dock.sub': 'this call',
      'dock.close': 'Collapse panel',
      'dock.needInput': 'Your input is needed for generation',
      'dock.collapse': 'Collapse',
      'dock.expand': 'Fill in',
      'dock.cancel': 'Cancel this input',
      'error.missingPrompt': 'Enter a prompt first',
      'error.missingRef': 'This mode needs a reference image',
      'error.generic': 'Something went wrong, please retry',
    }

    const PANEL_CSS = [
      '.tp-root{display:flex;flex-direction:column;gap:12px;padding:14px 14px 20px;height:100%;box-sizing:border-box;overflow:auto;font-family:var(--dsw-font-family, system-ui, sans-serif);color:var(--dsw-alias-label-primary, #1b1b1c);font-size:13px;line-height:1.6;}',
      '.tp-root *{box-sizing:border-box;}',
      '.tp-card{display:flex;flex-direction:column;gap:9px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1, #fff);}',
      '.tp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:20px;}',
      '.tp-title{font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.tp-aside{font-size:11px;color:var(--dsw-alias-label-tertiary, #7a7a7d);font-variant-numeric:tabular-nums;}',
      '.tp-modes{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:7px;}',
      '.tp-mode{display:flex;align-items:center;gap:7px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);border-radius:8px;background:transparent;font-family:inherit;font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary, #1b1b1c);text-align:left;cursor:pointer;transition:border-color .14s ease, background-color .14s ease;}',
      '.tp-mode:hover{border-color:var(--dsw-alias-border-l2, #c6cbd2);background:var(--dsw-alias-interactive-bg-hover, #f2f4f7);}',
      '.tp-mode:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.tp-mode[data-on="true"]{border-color:var(--dsw-alias-brand-primary, #2f6feb);background:var(--dsw-alias-bg-layer-2, #f7f8fa);font-weight:600;}',
      '.tp-glyph{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--dsw-alias-bg-layer-2, #f2f4f7);font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.tp-mode[data-on="true"] .tp-glyph{background:var(--dsw-alias-brand-primary, #2f6feb);color:var(--dsw-alias-label-primary-foreground, #fff);}',
      '.tp-tpls{display:flex;flex-direction:column;gap:6px;max-height:212px;overflow:auto;}',
      '.tp-tpl{display:flex;align-items:center;gap:8px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);border-radius:8px;background:transparent;font-family:inherit;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary, #1b1b1c);text-align:left;cursor:pointer;}',
      '.tp-tpl:hover{background:var(--dsw-alias-interactive-bg-hover, #f2f4f7);}',
      '.tp-tpl:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.tp-tpl[data-on="true"]{border-color:var(--dsw-alias-brand-primary, #2f6feb);background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.tp-tpl-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tp-tpl[data-on="true"] .tp-tpl-name{font-weight:600;}',
      '.tp-tpl-code{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2, #d0d3d8);color:var(--dsw-alias-label-tertiary, #7a7a7d);font-variant-numeric:tabular-nums;}',
      '.tp-field{display:flex;flex-direction:column;gap:5px;}',
      '.tp-field + .tp-field{margin-top:2px;}',
      '.tp-label{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.tp-label em{font-style:normal;color:var(--dsw-alias-state-error-primary, #d93026);font-size:11px;}',
      '.tp-input,.tp-textarea{width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2, #d0d3d8);border-radius:7px;background:var(--dsw-alias-bg-layer-1, #fff);color:var(--dsw-alias-label-primary, #1b1b1c);font-family:inherit;font-size:12px;line-height:1.5;}',
      '.tp-textarea{min-height:88px;resize:vertical;}',
      '.tp-input:focus,.tp-textarea:focus{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:1px;border-color:transparent;}',
      '.tp-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.tp-chip{padding:5px 10px;border:1px solid var(--dsw-alias-border-l2, #d0d3d8);border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary, #5a5a5c);cursor:pointer;}',
      '.tp-chip:hover{background:var(--dsw-alias-interactive-bg-hover, #f2f4f7);}',
      '.tp-chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.tp-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary, #2f6feb);background:var(--dsw-alias-brand-primary, #2f6feb);color:var(--dsw-alias-label-primary-foreground, #fff);font-weight:600;}',
      '.tp-numrow{display:flex;align-items:center;gap:7px;}',
      '.tp-numrow .tp-input{flex:1 1 auto;font-variant-numeric:tabular-nums;}',
      '.tp-ref{display:flex;align-items:center;gap:10px;}',
      '.tp-ref-thumb{width:56px;height:56px;flex:0 0 auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);object-fit:cover;background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.tp-ref-drop{display:flex;align-items:center;justify-content:center;width:56px;height:56px;flex:0 0 auto;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2, #c6cbd2);background:var(--dsw-alias-bg-layer-2, #f7f8fa);color:var(--dsw-alias-label-tertiary, #7a7a7d);font-size:18px;cursor:pointer;}',
      '.tp-ref-drop:hover{border-color:var(--dsw-alias-brand-primary, #2f6feb);color:var(--dsw-alias-brand-primary, #2f6feb);}',
      '.tp-ref-body{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1 1 auto;}',
      '.tp-ref-name{font-size:11.5px;color:var(--dsw-alias-label-secondary, #5a5a5c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tp-ref-actions{display:flex;gap:6px;flex-wrap:wrap;}',
      '.tp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;font-family:inherit;font-size:12px;font-weight:600;line-height:1.4;cursor:pointer;transition:opacity .14s ease, background-color .14s ease;}',
      '.tp-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.tp-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.tp-btn.primary{background:var(--dsw-alias-button-primary-fill, currentColor);color:var(--dsw-alias-label-primary-foreground, #fff);}',
      '.tp-btn.primary:hover:not(:disabled){opacity:.9;}',
      '.tp-btn.ghost{background:transparent;border-color:var(--dsw-alias-border-l2, #d0d3d8);color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.tp-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, #f2f4f7);}',
      '.tp-btn.block{width:100%;padding:10px 14px;font-size:13px;}',
      '.tp-quote{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
      '.tp-quote-fig{display:flex;align-items:baseline;gap:6px;}',
      '.tp-quote-num{font-size:22px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;}',
      '.tp-quote-unit{font-size:11px;color:var(--dsw-alias-label-secondary, #5a5a5c);}',
      '.tp-quote-meta{font-size:11px;color:var(--dsw-alias-label-tertiary, #7a7a7d);}',
      '.tp-progress{display:flex;flex-direction:column;gap:6px;}',
      '.tp-track{height:5px;border-radius:999px;background:var(--dsw-alias-border-l2, #c6cbd2);overflow:hidden;}',
      '.tp-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary, #2f6feb);transition:width .4s ease;}',
      '.tp-fill.busy{width:35%;animation:tp-slide 1.3s ease-in-out infinite;}',
      '@keyframes tp-slide{0%{margin-left:0;}50%{margin-left:65%;}100%{margin-left:0;}}',
      '.tp-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;}',
      '.tp-result{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.tp-result img,.tp-result video{width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);display:block;background:var(--dsw-alias-bg-layer-2, #f7f8fa);}',
      '.tp-result audio{width:100%;}',
      '.tp-result-name{font-size:10.5px;color:var(--dsw-alias-label-tertiary, #7a7a7d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tp-note{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary, #5a5a5c);overflow-wrap:anywhere;}',
      '.tp-note.bad{color:var(--dsw-alias-state-error-primary, #d93026);}',
      '.tp-note.ok{color:var(--dsw-alias-state-success-primary, #1a7f37);}',
      '.tp-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary, #7a7a7d);}',
      '.tp-path{font-family:var(--dsw-font-markdown-code-font-family, ui-monospace, monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary, #7a7a7d);overflow-wrap:anywhere;}',
      // ---- 会话级卡片外壳：附在输入框下方，只在「工具正在等这个会话填写」时出现 ----
      // 它不浮动、不 portal：作为 composer.dock 的正常流内条目占一行，
      // 收起后缩成一条窄提示条（而不是彻底消失），因为此时工具还在阻塞等待。
      '.tp-dock{display:flex;flex-direction:column;width:100%;max-height:min(62vh, 560px);margin:8px 0 2px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);border-radius:12px;background:var(--dsw-alias-bg-layer-1, #fff);overflow:hidden;font-family:var(--dsw-font-family, system-ui, sans-serif);animation:tp-fade-in .18s ease;}',
      '@keyframes tp-fade-in{from{opacity:0;}to{opacity:1;}}',
      '@media (prefers-reduced-motion:reduce){.tp-dock{animation:none;}}',
      '.tp-dock-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, #e3e5e8);background:var(--dsw-alias-bg-layer-2, #f7f8fa);flex:0 0 auto;}',
      '.tp-dock-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary, #1b1b1c);min-width:0;}',
      '.tp-dock-sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary, #7a7a7d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tp-dock-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;}',
      '.tp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary, #5a5a5c);cursor:pointer;font-family:inherit;font-size:15px;line-height:1;}',
      '.tp-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover, #eceff3);color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.tp-icon-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.tp-dock-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:auto;}',
      '.tp-dock-body .tp-root{flex:1 1 auto;min-height:0;height:auto;overflow:visible;}',
      // 收起态：一条窄提示条，点击重新展开（此时工具仍在等待，不能让它无声消失）。
      '.tp-pill{display:flex;align-items:center;gap:8px;width:100%;margin:8px 0 2px;padding:7px 12px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1, #e3e5e8);border-radius:999px;background:var(--dsw-alias-bg-layer-2, #f7f8fa);color:var(--dsw-alias-label-secondary, #5a5a5c);font-family:inherit;font-size:12px;line-height:1.4;text-align:left;cursor:pointer;}',
      '.tp-pill:hover{background:var(--dsw-alias-interactive-bg-hover, #eceff3);color:var(--dsw-alias-label-primary, #1b1b1c);}',
      '.tp-pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color, #2f6feb);outline-offset:2px;}',
      '.tp-pill-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-brand-primary, #2f6feb);animation:tp-pulse 1.3s ease-in-out infinite;}',
      '@keyframes tp-pulse{0%,100%{opacity:.35;}50%{opacity:1;}}',
      '.tp-pill-spacer{flex:1 1 auto;}',
      '.tp-pill-hint{font-size:11px;color:var(--dsw-alias-label-tertiary, #7a7a7d);}',
    ].join('')

    /** 面板引导页图标（侧栏引导页入口用）。 */
    function PanelGlyph(props) {
      return ReactTop.createElement(
        'svg',
        {
          viewBox: '0 0 24 24', width: props?.size ?? 22, height: props?.size ?? 22,
          className: props?.className, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
        ReactTop.createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4 }),
        ReactTop.createElement('path', { d: 'M3 15l4.5-4.5 3 3L15 9l6 6' }),
        ReactTop.createElement('circle', { cx: 8.5, cy: 8, r: 1.4 }),
      )
    }

    /** 读模板 param_schema（上游给的是 JSON 字符串）。 */
    function panelFields(template) {
      let schema = template?.param_schema
      if (typeof schema === 'string') {
        try {
          schema = JSON.parse(schema)
        } catch {
          schema = null
        }
      }
      if (Array.isArray(schema)) return schema.filter((field) => field && typeof field === 'object' && field.key)
      if (schema && typeof schema === 'object') {
        return Object.values(schema).filter((field) => field && typeof field === 'object' && field.key)
      }
      return []
    }

    /** select 字段的可选项：优先 options，其次 map 的键。 */
    function panelOptions(field) {
      if (Array.isArray(field?.options) && field.options.length > 0) return field.options.map(String)
      if (field?.map && typeof field.map === 'object') return Object.keys(field.map)
      return []
    }

    /** 字段的初始值：模板默认值优先，没有就空。 */
    function panelDefault(field) {
      if (field?.default === undefined || field.default === null) return ''
      return String(field.default)
    }

    /** 按模板 schema 生成初始参数表。 */
    function panelInitialValues(fields) {
      const out = {}
      for (const field of fields) {
        if (field.type === 'image') continue
        const value = panelDefault(field)
        if (value !== '') out[field.key] = value
      }
      return out
    }

    /** 参数表 → 提交给宿主的 params（数字转 number，空值省略）。 */
    function panelBuildParams(fields, values) {
      const out = {}
      for (const field of fields) {
        if (field.type === 'image' || field.key === 'prompt') continue
        const raw = values[field.key]
        if (raw === undefined || raw === null || String(raw).trim() === '') continue
        if (field.type === 'int' || field.type === 'float') {
          const num = Number(raw)
          if (Number.isFinite(num)) out[field.key] = num
        } else {
          out[field.key] = String(raw)
        }
      }
      return out
    }

    /** 把 {a} / {b} 占位替换掉。 */
    function panelFormat(text, map) {
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (map && map[key] !== undefined ? String(map[key]) : whole))
    }

    /** 读上次选择（模式 / 模板），失败就当作没有。 */
    function panelReadStore() {
      try {
        const raw = window.localStorage.getItem(PANEL_STORE_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function panelWriteStore(patch) {
      try {
        window.localStorage.setItem(PANEL_STORE_KEY, JSON.stringify({ ...panelReadStore(), ...patch }))
      } catch { /* 隐私模式等场景写不了，忽略 */ }
    }

    /** 统一 POST JSON。 */
    async function panelPost(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!res.ok) throw new Error(data?.error || data?.detail || `HTTP ${res.status}`)
      return data
    }

    /** 生成面板主体。 */
    function Panel(props) {
      const React = ReactTop
      const h = React.createElement
      const t = props.t
      const { sessionId, useSessions, seed, signedIn } = props
      const cwd = useSessions ? useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd) : undefined

      const [status, setStatus] = React.useState(null)
      const [templates, setTemplates] = React.useState(null)
      const [templatesError, setTemplatesError] = React.useState(null)
      const stored = React.useRef(panelReadStore())
      // 宿主已经告诉我登录态时就不必再问一次；否则自己拉一遍。
      const configured = typeof signedIn === 'boolean' ? signedIn : status?.configured === true
      const offline = status?.__offline === true
      const [mode, setMode] = React.useState(() => {
        const saved = stored.current?.mode
        return MODE_IDS.includes(saved) ? saved : 't2i'
      })
      const [templateCode, setTemplateCode] = React.useState(() => String(stored.current?.templateCode || ''))
      const [prompt, setPrompt] = React.useState('')
      const [values, setValues] = React.useState({})
      const [refImage, setRefImage] = React.useState(null)
      const [refBusy, setRefBusy] = React.useState(false)
      const [quote, setQuote] = React.useState(null)
      const [quoteBusy, setQuoteBusy] = React.useState(false)
      const [job, setJob] = React.useState(null)
      const [error, setError] = React.useState(null)
      /** 提交模式下的提交中状态。 */
      const [submitting, setSubmitting] = React.useState(false)
      const fileRef = React.useRef(null)
      const timerRef = React.useRef(null)
      const aliveRef = React.useRef(true)

      React.useEffect(() => () => {
        aliveRef.current = false
        if (timerRef.current) clearTimeout(timerRef.current)
      }, [])

      // 登录态 + 模板：各拉一次，失败只影响对应区块。
      React.useEffect(() => {
        if (typeof signedIn === 'boolean') return undefined
        let active = true
        fetch('/api/tongji-aigc/status', { cache: 'no-store' })
          .then((res) => res.json())
          .then((data) => { if (active) setStatus(data) })
          .catch(() => { if (active) setStatus({ __offline: true }) })
        return () => { active = false }
      }, [signedIn])

      // 每次「用了 AIGC」都会带一份参数快照进来：回填表单，方便直接微调重跑。
      React.useEffect(() => {
        if (!seed || typeof seed !== 'object') return
        if (seed.mode && MODE_IDS.includes(seed.mode)) setMode(seed.mode)
        if (seed.template_code) setTemplateCode(String(seed.template_code))
        if (typeof seed.prompt === 'string' && seed.prompt.trim() !== '') setPrompt(seed.prompt)
        if (seed.params && typeof seed.params === 'object') {
          const next = {}
          for (const [key, value] of Object.entries(seed.params)) {
            if (value === null || value === undefined) continue
            next[key] = String(value)
          }
          setValues((prev) => ({ ...prev, ...next }))
        }
        setJob(null)
        setQuote(null)
      }, [seed])

      const loadTemplates = React.useCallback(async () => {
        setTemplatesError(null)
        try {
          const res = await fetch('/api/tongji-aigc/templates', { cache: 'no-store' })
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
          const list = Array.isArray(data?.templates) ? data.templates : []
          setTemplates(list)
          return list
        } catch (err) {
          setTemplatesError(String(err?.message || err))
          setTemplates([])
          return []
        }
      }, [])

      React.useEffect(() => { loadTemplates() }, [loadTemplates])

      const modeTemplates = React.useMemo(() => {
        const list = Array.isArray(templates) ? templates : []
        return list.filter((tpl) => String(tpl?.type || '') === mode)
      }, [templates, mode])

      const currentTemplate = React.useMemo(() => {
        if (!Array.isArray(modeTemplates) || modeTemplates.length === 0) return null
        return modeTemplates.find((tpl) => String(tpl?.code || tpl?.template_code || '') === templateCode) || modeTemplates[0]
      }, [modeTemplates, templateCode])

      const fields = React.useMemo(() => panelFields(currentTemplate), [currentTemplate])
      const promptField = React.useMemo(() => fields.find((field) => field.key === 'prompt') || null, [fields])
      const paramFields = React.useMemo(() => fields.filter((field) => field.key !== 'prompt'), [fields])
      const imageFields = React.useMemo(() => fields.filter((field) => field.type === 'image'), [fields])
      const needRef = REF_MODES.includes(mode)

      // 切模式 / 切模板时重置参数表，并同步记住选择。
      React.useEffect(() => {
        setValues(panelInitialValues(fields))
        setQuote(null)
      }, [fields])

      React.useEffect(() => {
        if (currentTemplate) {
          const code = String(currentTemplate.code || currentTemplate.template_code || '')
          if (code && code !== templateCode) setTemplateCode(code)
          if (code) panelWriteStore({ mode, templateCode: code })
        } else {
          panelWriteStore({ mode })
        }
      }, [currentTemplate, mode, templateCode])

      const setValue = (key, value) => setValues((prev) => ({ ...prev, [key]: value }))

      const pickImage = async (file) => {
        if (!file) return
        setRefBusy(true)
        setError(null)
        try {
          const bytes = await file.arrayBuffer()
          const name = String(file.name || 'reference.png')
          const res = await fetch('/api/tongji-aigc/upload?name=' + encodeURIComponent(name), {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: bytes,
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
          const preview = URL.createObjectURL(file)
          setRefImage({ path: data.path, name, preview })
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setRefBusy(false)
        }
      }

      const clearImage = () => {
        setRefImage((prev) => {
          if (prev?.preview) URL.revokeObjectURL(prev.preview)
          return null
        })
      }

      const buildRequest = () => ({
        mode,
        prompt,
        template_code: currentTemplate ? String(currentTemplate.code || currentTemplate.template_code || '') : '',
        params: panelBuildParams(fields, values),
        reference_image: refImage?.path,
        count: 1,
        cwd: cwd || undefined,
      })

      const runQuote = async () => {
        if (quoteBusy) return
        setQuoteBusy(true)
        setError(null)
        try {
          const data = await panelPost('/api/tongji-aigc/quote', buildRequest())
          setQuote(data)
        } catch (err) {
          setError(String(err?.message || err))
          setQuote(null)
        } finally {
          setQuoteBusy(false)
        }
      }

      const stopPolling = () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        setJob((prev) => (prev && prev.state === 'running' ? { ...prev, state: 'stopped' } : prev))
      }

      const pollTask = React.useCallback((taskId) => {
        const tick = async () => {
          if (!aliveRef.current) return
          try {
            const data = await panelPost('/api/tongji-aigc/task', { task_id: taskId, cwd: cwd || undefined })
            if (!aliveRef.current) return
            if (data?.done) {
              setJob({ state: 'done', taskId, status: data.status, outputs: data.outputs || [], dir: data.output_dir })
              return
            }
            setJob({ state: 'running', taskId, status: data.status, progress: data.progress })
            timerRef.current = setTimeout(tick, 2000)
          } catch (err) {
            if (!aliveRef.current) return
            setJob({ state: 'failed', taskId, error: String(err?.message || err) })
          }
        }
        tick()
      }, [cwd])

      const generate = async () => {
        if (job && job.state === 'running') return
        setError(null)
        if (promptField?.required && String(prompt).trim() === '') {
          setError(t('error.missingPrompt'))
          return
        }
        if (needRef && !refImage?.path) {
          setError(t('error.missingRef'))
          return
        }
        // 提交模式：卡片是「工具在等用户填参数」的前置步骤，不在这里直接生成，
        // 只把用户选好的参数交回去，由模型拿到后再调 generate 继续任务。
        if (typeof props.onSubmit === 'function') {
          setSubmitting(true)
          try {
            await props.onSubmit({
              mode,
              template_code: currentTemplate ? String(currentTemplate.code || currentTemplate.template_code || '') : '',
              prompt,
              params: panelBuildParams(fields, values),
              reference_image: refImage?.path || '',
              count: 1,
            })
          } catch (err) {
            setError(String(err?.message || err))
          } finally {
            setSubmitting(false)
          }
          return
        }
        setJob({ state: 'creating' })
        try {
          const data = await panelPost('/api/tongji-aigc/generate', { ...buildRequest(), create_only: true })
          if (!data?.task_id) throw new Error(t('error.generic'))
          setJob({ state: 'running', taskId: data.task_id, status: 'created' })
          pollTask(data.task_id)
        } catch (err) {
          setError(String(err?.message || err))
          setJob({ state: 'failed', error: String(err?.message || err) })
        }
      }

      const card = (titleKey, aside, children) => h(
        'section',
        { className: 'tp-card' },
        h('div', { className: 'tp-head' },
          h('span', { className: 'tp-title' }, t(titleKey)),
          aside ? h('span', { className: 'tp-aside' }, aside) : null,
        ),
        children,
      )

      const notLoggedIn = !offline && status !== null && configured !== true
      if (notLoggedIn) {
        return h('div', { className: 'tp-root' },
          h('style', null, PANEL_CSS),
          h('section', { className: 'tp-card' },
            h('div', { className: 'tp-head' }, h('span', { className: 'tp-title' }, t('notLogin.title'))),
            h('p', { className: 'tp-note' }, t('notLogin.hint')),
          ),
        )
      }

      const renderField = (field) => {
        const label = String(field.label || field.key)
        const required = field.required === true
        const options = panelOptions(field)
        const head = h('div', { className: 'tp-label' },
          h('span', null, label),
          required ? h('em', null, t('prompt.required')) : null,
        )
        let control
        if (field.type === 'select' && options.length > 0) {
          control = h('div', { className: 'tp-chips', role: 'group', 'aria-label': label },
            options.map((option) => h('button', {
              key: option,
              type: 'button',
              className: 'tp-chip',
              'data-on': String(values[field.key] ?? panelDefault(field)) === option,
              onClick: () => setValue(field.key, option),
            }, option)),
          )
        } else if (field.type === 'int' || field.type === 'float') {
          const min = field.min !== undefined ? Number(field.min) : undefined
          const max = field.max !== undefined ? Number(field.max) : undefined
          control = h('div', { className: 'tp-numrow' },
            h('input', {
              className: 'tp-input',
              type: 'number',
              value: values[field.key] ?? '',
              min: Number.isFinite(min) ? min : undefined,
              max: Number.isFinite(max) ? max : undefined,
              step: field.type === 'float' ? '0.01' : '1',
              'aria-label': label,
              onChange: (event) => setValue(field.key, event.target.value),
            }),
            field.randomize ? h('button', {
              type: 'button',
              className: 'tp-btn ghost',
              onClick: () => setValue(field.key, String(Math.floor(Math.random() * 100000))),
            }, t('params.random')) : null,
          )
        } else if (field.type === 'image') {
          return null
        } else {
          const long = field.max_len && field.max_len > 200
          control = long
            ? h('textarea', {
                className: 'tp-textarea',
                value: values[field.key] ?? '',
                'aria-label': label,
                onChange: (event) => setValue(field.key, event.target.value),
              })
            : h('input', {
                className: 'tp-input',
                type: 'text',
                value: values[field.key] ?? '',
                'aria-label': label,
                onChange: (event) => setValue(field.key, event.target.value),
              })
        }
        return h('div', { className: 'tp-field', key: field.key }, head, control)
      }

      const renderResults = () => {
        if (!job) return null
        if (job.state === 'creating' || job.state === 'running') {
          const pct = Number(job.progress)
          const known = Number.isFinite(pct) && pct > 0
          const statusKey = 'status.' + String(job.status || 'created')
          return h('div', { className: 'tp-card' },
            h('div', { className: 'tp-head' },
              h('span', { className: 'tp-title' }, t('action.generating')),
              h('button', { type: 'button', className: 'tp-btn ghost', onClick: stopPolling }, t('action.cancel')),
            ),
            h('div', { className: 'tp-progress' },
              h('div', { className: 'tp-track' },
                h('div', { className: known ? 'tp-fill' : 'tp-fill busy', style: known ? { width: Math.min(100, Math.max(3, pct)) + '%' } : undefined }),
              ),
              h('p', { className: 'tp-note' }, t(statusKey) + (known ? ' ' + Math.round(pct) + '%' : '')),
            ),
          )
        }
        if (job.state === 'failed') {
          return h('div', { className: 'tp-card' },
            h('div', { className: 'tp-head' }, h('span', { className: 'tp-title' }, t('status.failed'))),
            h('p', { className: 'tp-note bad' }, job.error || t('error.generic')),
          )
        }
        if (job.state === 'stopped') {
          return h('div', { className: 'tp-card' },
            h('p', { className: 'tp-note' }, t('action.cancel')),
            h('button', { type: 'button', className: 'tp-btn ghost', onClick: generate }, t('action.again')),
          )
        }
        if (job.state !== 'done') return null
        const outputs = Array.isArray(job.outputs) ? job.outputs : []
        return h('div', { className: 'tp-card' },
          h('div', { className: 'tp-head' }, h('span', { className: 'tp-title' }, t('result.title'))),
          outputs.length === 0
            ? h('p', { className: 'tp-note' }, t('status.done'))
            : h('div', { className: 'tp-results' },
                outputs.map((output) => {
                  const src = output.path ? '/api/tongji-aigc/file?path=' + encodeURIComponent(output.path) : output.url
                  const kind = output.kind || 'file'
                  const media = kind === 'image'
                    ? h('img', { src, alt: output.name || 'output', loading: 'lazy' })
                    : kind === 'video'
                      ? h('video', { src, controls: true, preload: 'metadata' })
                      : kind === 'audio'
                        ? h('audio', { src, controls: true, preload: 'metadata' })
                        : h('a', { href: src, target: '_blank', rel: 'noreferrer', className: 'tp-note' }, output.name || 'download')
                  return h('div', { className: 'tp-result', key: output.path || output.url || output.index },
                    media,
                    h('span', { className: 'tp-result-name', title: output.path || '' }, output.name || ''),
                  )
                }),
              ),
          job.dir ? h('div', null,
            h('div', { className: 'tp-aside' }, t('result.dir')),
            h('div', { className: 'tp-path' }, job.dir),
          ) : null,
          h('button', { type: 'button', className: 'tp-btn ghost', onClick: generate }, t('action.again')),
        )
      }

      // 预估卡片常驻：即使还没报价也要露出「预估积分」按钮，否则用户发现不了它。
      const quoteView = () => {
        const points = quote?.estimate?.total_points ?? quote?.quote?.total_points
        const duration = quote?.estimate?.duration
        const estimateError = quote?.estimate?.error
        const hasFigure = points !== undefined && points !== null
        return h('div', { className: 'tp-card' },
          h('div', { className: 'tp-head' },
            h('span', { className: 'tp-title' }, t('quote.title')),
            h('button', { type: 'button', className: 'tp-btn ghost', onClick: runQuote, disabled: quoteBusy },
              quoteBusy ? t('quote.checking') : t('quote.check')),
          ),
          quote === null
            ? h('p', { className: 'tp-note' }, t('quote.idle'))
            : hasFigure
              ? h('div', { className: 'tp-quote' },
                  h('span', { className: 'tp-quote-fig' },
                    h('span', { className: 'tp-quote-num' }, String(Math.round(Number(points) * 100) / 100)),
                    h('span', { className: 'tp-quote-unit' }, t('quote.points')),
                  ),
                  duration
                    ? h('span', { className: 'tp-quote-meta' },
                        t('quote.duration') + ' ' + panelFormat(t('quote.range'), { a: duration.p25_seconds, b: duration.p75_seconds }))
                    : null,
                )
              : h('p', { className: 'tp-note bad' }, estimateError || t('quote.failed')),
        )
      }

      const busy = job && (job.state === 'creating' || job.state === 'running')

      return h('div', { className: 'tp-root' },
        h('style', null, PANEL_CSS),

        // 1) 生成模式：卡片组
        card('mode.title', null,
          h('div', { className: 'tp-modes' },
            MODE_IDS.map((id) => h('button', {
              key: id,
              type: 'button',
              className: 'tp-mode',
              'data-on': mode === id,
              'aria-pressed': mode === id,
              onClick: () => {
                setMode(id)
                setTemplateCode('')
                setJob(null)
                setQuote(null)
              },
            },
              h('span', { className: 'tp-glyph', 'aria-hidden': 'true' }, MODE_GLYPHS[id]),
              h('span', null, t('mode.' + id)),
            )),
          ),
        ),

        // 2) 模板：卡片列表
        card('template.title',
          templates === null ? null : (modeTemplates.length + ' ' + t('template.count')).trim(),
          templates === null
            ? h('p', { className: 'tp-empty' }, t('template.loading'))
            : templatesError
              ? h('p', { className: 'tp-note bad' }, templatesError)
              : modeTemplates.length === 0
                ? h('p', { className: 'tp-empty' }, t('template.empty'))
                : h('div', { className: 'tp-tpls' },
                    modeTemplates.map((tpl) => {
                      const code = String(tpl?.code || tpl?.template_code || '')
                      return h('button', {
                        key: code,
                        type: 'button',
                        className: 'tp-tpl',
                        'data-on': currentTemplate === tpl,
                        'aria-pressed': currentTemplate === tpl,
                        onClick: () => { setTemplateCode(code); setQuote(null) },
                      },
                        h('span', { className: 'tp-tpl-name', title: String(tpl?.name || code) }, String(tpl?.name || code)),
                        h('span', { className: 'tp-tpl-code' }, code.length > 18 ? code.slice(0, 17) + '…' : code),
                      )
                    }),
                  ),
        ),

        // 3) 提示词
        card('prompt.title', promptField?.max_len ? String(prompt.length) + '/' + promptField.max_len : (promptField?.required ? t('prompt.required') : t('prompt.optional')),
          h('textarea', {
            className: 'tp-textarea',
            value: prompt,
            placeholder: promptField?.default ? String(promptField.default) : t('prompt.placeholder'),
            'aria-label': t('prompt.title'),
            onChange: (event) => setPrompt(event.target.value),
          }),
        ),

        // 4) 模板参数：按 schema 自动生成
        paramFields.length > 0
          ? card('params.title',
              h('button', {
                type: 'button',
                className: 'tp-btn ghost',
                onClick: () => { setValues(panelInitialValues(fields)); setQuote(null) },
              }, t('params.reset')),
              h('div', null, paramFields.map((field) => renderField(field)).filter(Boolean)),
            )
          : card('params.title', null, h('p', { className: 'tp-empty' }, t('params.empty'))),

        // 5) 参考图
        needRef || imageFields.length > 0
          ? card('ref.title', null,
              h('div', { className: 'tp-ref' },
                refImage?.preview
                  ? h('img', { className: 'tp-ref-thumb', src: refImage.preview, alt: refImage.name || 'reference' })
                  : h('button', {
                      type: 'button',
                      className: 'tp-ref-drop',
                      'aria-label': t('ref.pick'),
                      onClick: () => fileRef.current?.click(),
                    }, '+'),
                h('div', { className: 'tp-ref-body' },
                  h('span', { className: 'tp-ref-name' },
                    refBusy ? t('ref.uploading') : refImage ? refImage.name : t('ref.hint')),
                  h('div', { className: 'tp-ref-actions' },
                    h('button', {
                      type: 'button',
                      className: 'tp-btn ghost',
                      onClick: () => fileRef.current?.click(),
                      disabled: refBusy,
                    }, refImage ? t('ref.change') : t('ref.pick')),
                    refImage ? h('button', { type: 'button', className: 'tp-btn ghost', onClick: clearImage }, t('ref.clear')) : null,
                  ),
                ),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: 'image/*',
                  style: { display: 'none' },
                  onChange: (event) => {
                    const file = event.target.files && event.target.files[0]
                    event.target.value = ''
                    pickImage(file)
                  },
                }),
              ),
            )
          : null,

        // 6) 生成前预估
        quoteView(),

        // 7) 主按钮：提交模式 = 把参数交给等待中的工具；普通模式 = 直接生成
        h('div', { className: 'tp-card' },
          error ? h('p', { className: 'tp-note bad', role: 'alert' }, error) : null,
          h('button', {
            type: 'button',
            className: 'tp-btn primary block',
            onClick: generate,
            disabled: Boolean(busy) || submitting || templates === null,
          }, submitting
            ? t('action.submitting')
            : typeof props.onSubmit === 'function'
              ? t('action.submit')
              : busy ? t('action.generating') : t('action.generate')),
          typeof props.onSubmit === 'function'
            ? h('p', { className: 'tp-note' }, t('action.submitHint'))
            : null,
        ),

        // 8) 进度 / 产物
        renderResults(),
      )
    }

    /**
     * 浮层宿主：决定面板「以什么形态存在」。
     *
     * 三态：
     *   - 隐藏（连悬浮球都没有）：本次运行还没用过 AIGC，DOM 里什么都没有；
     *   - 悬浮球：用过之后被收起，吸附在右侧边缘，点一下重新展开；
     *   - 面板：展开态。
     *
     * 判定来源是宿主 /activity 的单调计数器：
     *   - 每 1.5s 轮询一次（面板打开时 2s，省点开销）；
     *   - seq 变大 → 展开面板，并把那次调用的参数回填进表单；
     *   - 用户点收起 → 只收成悬浮球，不再对同一次使用自动弹出；
     *     收起期间如果又用了 AIGC，球上冒红点提示（不抢焦点）。
     * 首次挂载时先读一次 seq 作为基线，所以刷新页面不会平白弹一个面板，
     * 也不会留下一个孤零零的悬浮球——「用过」这件事按本次页面会话记。
     */
    /**
     * 会话级参数卡片的宿主。
     *
     * 挂在 `conversation.composer.dock`（`{kind:'list', scope:'session'}`）上，
     * 所以每个对话各有自己的一份实例与自己的 `sessionId`——卡片天然按对话隔离。
     *
     * 出现条件只有一条：**宿主上有一个属于本会话的待填写请求**
     * （模型调了 `tongji_aigc_form`，工具正阻塞等用户）。没有待填写请求时
     * 组件返回 null，不占任何位置。
     *
     * 收起不等于忽略：收起后缩成一条窄提示条（工具仍在等，不能让它无声消失），
     * 点提示条可重新展开；要真正结束就点卡片里的「取消」。
     */
    function SessionCardDock(props) {
      const React = ReactTop
      const h = React.createElement
      const t = props.t
      const sessionId = props.sessionId

      /** 当前会话的待填写请求。 */
      const [request, setRequest] = React.useState(null)
      /** 是否被用户收起成提示条。 */
      const [collapsed, setCollapsed] = React.useState(false)
      /** 已提交过的 requestId，避免提交后短暂残留又弹一次。 */
      const submittedRef = React.useRef('')

      const enabled = typeof sessionId === 'string' && sessionId !== ''

      const poll = React.useCallback(async () => {
        if (!enabled) return
        try {
          const res = await fetch('/api/tongji-aigc/pending?session=' + encodeURIComponent(sessionId), { cache: 'no-store' })
          if (!res.ok) return
          const data = await res.json()
          const next = data?.request || null
          setRequest((prev) => {
            // 同一个请求不重复 setState，避免无谓重渲染把用户正在填的表单重置。
            if (prev?.request_id === next?.request_id) return prev
            if (next && next.request_id === submittedRef.current) return prev
            return next
          })
          if (next === null) setCollapsed(false)
        } catch { /* 宿主重启中，下一轮再试 */ }
      }, [enabled, sessionId])

      React.useEffect(() => {
        if (!enabled) return undefined
        poll()
        // 有待填请求时轮询密一点，提交后能立刻收起；空闲时也保持低频探测。
        const timer = setInterval(poll, request ? 1500 : 3000)
        return () => clearInterval(timer)
      }, [enabled, poll, request])

      const submit = React.useCallback(async (values) => {
        if (!request) return
        submittedRef.current = request.request_id
        try {
          const res = await fetch('/api/tongji-aigc/pending/submit', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: request.request_id, values }),
          })
          if (!res.ok) {
            const data = await res.json().catch(() => null)
            throw new Error(data?.error || `HTTP ${res.status}`)
          }
          setRequest(null)
          setCollapsed(false)
        } catch (error) {
          submittedRef.current = ''
          throw error
        }
      }, [request])

      const cancel = React.useCallback(async () => {
        if (!request) return
        try {
          await fetch('/api/tongji-aigc/pending/cancel', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: request.request_id }),
          })
        } catch { /* 忽略：宿主那边最终会超时 */ }
        setRequest(null)
        setCollapsed(false)
      }, [request])

      if (!enabled || request === null) return null

      const styles = h('style', null, PANEL_CSS)

      if (collapsed) {
        return h(React.Fragment, null,
          styles,
          h('button', {
            type: 'button',
            className: 'tp-pill',
            onClick: () => setCollapsed(false),
            title: t('dock.expand'),
          },
            h('span', { className: 'tp-pill-dot', 'aria-hidden': 'true' }),
            h('span', null, t('dock.needInput')),
            h('span', { className: 'tp-pill-spacer' }),
            h('span', { className: 'tp-pill-hint' }, t('dock.expand')),
          ),
        )
      }

      const note = request?.hints?.note || ''
      return h('div', { className: 'tp-dock', role: 'region', 'aria-label': t('tab.title') },
        styles,
        h('div', { className: 'tp-dock-bar' },
          h('div', { className: 'tp-dock-title' },
            h(PanelGlyph, { size: 15 }),
            h('span', null, t('dock.needInput')),
            note ? h('span', { className: 'tp-dock-sub', title: note }, note) : null,
          ),
          h('div', { className: 'tp-dock-actions' },
            h('button', {
              type: 'button', className: 'tp-icon-btn', onClick: () => setCollapsed(true),
              'aria-label': t('dock.collapse'), title: t('dock.collapse'),
            }, '−'),
            h('button', {
              type: 'button', className: 'tp-icon-btn', onClick: cancel,
              'aria-label': t('dock.cancel'), title: t('dock.cancel'),
            }, '×'),
          ),
        ),
        h('div', { className: 'tp-dock-body' },
          h(Panel, {
            ...props,
            seed: request?.hints || null,
            signedIn: true,
            // 提交模式：主按钮变成「提交参数」，且卡片自带取消。
            onSubmit: submit,
            onCancel: cancel,
          }),
        ),
      )
    }

    function apply(ctx) {
      const namespace = 'settings.tongji-aigc'
      ctx.effect(() => ctx.locale.register(namespace, { zh, en }), '[dsh-tongji-aigc] register locale')
      const t = ctx.locale.bind(namespace)
      ctx.slots.inject(
        'plugins.bundle.config',
        () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: '@local/dsh-tongji-aigc', locale: namespace },
            () => ReactTop.createElement(App, { React: ReactTop, t }),
          ),
      )

      // ---- 会话级参数卡片 ----
      // 挂进 conversation.composer.dock（会话作用域的 list slot）：
      //   - 每个对话一份实例，sessionId 由 slot 注入 → 卡片按对话隔离；
      //   - 只在「本会话有待填写请求」时渲染，其余时间不占位；
      //   - 附在输入框下方，就是「任务中期的选项」那种位置。
      const panelLocale = ctx.locale.bind(PANEL_NS)
      ctx.inject(['slots'], (panelCtx) => {
        panelCtx.effect(
          () => panelCtx.locale.register(PANEL_NS, { zh: panelZh, en: panelEn }),
          '[dsh-tongji-aigc] panel locale',
        )
        panelCtx.effect(
          () => panelCtx.slots.inject('conversation.composer.dock', () => panelCtx.slots.register(
            // composer.dock 是 list slot：条目用 `id` 标识（不是 keyed slot 的 key）。
            { name: 'conversation.composer.dock', id: PANEL_ID, locale: PANEL_NS },
            (props) => ReactTop.createElement(SessionCardDock, { ...props, t: panelLocale }),
          )),
          '[dsh-tongji-aigc] session card dock',
        )
      })
    }

    return { apply, inject, name }
  },
})
