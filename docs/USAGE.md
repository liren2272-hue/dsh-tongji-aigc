# dsh-tongji-aigc 使用说明

把**同济 AIGC 专区**（<https://agi.tongji.edu.cn>）的图片 / 视频 / 3D / 音乐生成能力，以反向代理的方式接进 DSH：在「设置 → 插件」里点一次**统一身份认证登录**，插件自动把浏览器里的登录态同步进来；之后在对话里调用工具，产物自动落盘并返回绝对路径。

> 登录形态只有一种：**统一身份认证（SSO）一键登录**。卡片没有账号密码输入框——同济 AIGC 的普通用户走学校 SSO，账号密码表单是管理员专用、填了必然报错，所以不提供账号密码登录。

## 一、安装

插件本体在本仓库目录，安装进桌面 profile（把路径换成你本机的实际位置）：

```bash
dsh plugin --profile desktop add "/path/to/dsh-tongji-aigc"
```

> 装完**需要重启 DSH 桌面端**才能加载本插件（插件代码改动同理，改完重启才生效）。

## 二、登录（一键、零粘贴）

站点默认登录走**同济大学统一身份认证（SSO）**，本地账号密码表单仅管理员可用，普通用户账号体系不同。登录成功后，站点把访问令牌（`access_token`，一个 JWT）写进浏览器 `sessionStorage`，并直接跳回站内——**地址栏不会显示 `token=`**。卡片里**没有任何需要复制粘贴的令牌输入框**：登录窗口由插件自己在隔离浏览器会话里打开，令牌由临时扩展自动读回并回传，全自动完成。

1. 打开 **设置 → 插件 → 同济 AIGC**；
2. 点 **统一身份认证登录**。插件调站点 `/auth/sso/discover` 拿到 IAM 授权地址，并在本机找一个已安装的 **Edge / Chrome**，开一个**独立临时配置目录**的隔离窗口、加载一个**临时生成的扩展**，再在那个窗口里打开 SSO 授权页（不是你平时用的浏览器，独立 `--user-data-dir`，不碰你的个人配置）；
3. 在弹出的隔离窗口里完成 `iam.tongji.edu.cn` 统一身份认证。登录完成后页面跳回 `agi.tongji.edu.cn` 站内，令牌写进该窗口的 `sessionStorage`；
4. **回到卡片，什么都不用做**：临时扩展的 content script 会轮询 `sessionStorage.access_token`，读到后通过顶层导航 `location.replace(本机 DSH /api/tongji-aigc/relay?token=...)` 回传（不受 mixed-content 拦截）、校验、落盘；卡片每 2 秒自动轮询一次，一旦 `configured` 变 `true` 就自动变为「登录有效」，显示姓名、学院与身份。关闭该隔离窗口 / 超时后，临时扩展与临时配置目录会被删除（关窗即卸载）。

关键：**为什么是临时扩展 + 隔离窗口**——DSH 宿主无法跨进程、跨源读用户浏览器的 `sessionStorage`；要让令牌出来，必须有代码跑在用户登录的那个浏览器会话里读 `sessionStorage` 再回传。临时扩展只在本次登录写入并加载、用完即删，不要求开发者模式、不在你常用浏览器里留下任何痕迹。若只把 SSO 地址丢进你平时用的浏览器窗口，插件将永远读不到令牌、只能退回到手动粘贴。所以登录窗口由插件全程拥有，这是「零粘贴」的前提。

- 令牌**只存在本机**，**不会**回传明文（状态接口只回掩码，如 `********xzlg`）。
- 令牌过期会在卡片上显示「登录已过期」，重新点一次登录按钮即可。
- 点 **退出登录** 可一键清除令牌，不影响任何配置。

### 自动登录依赖与降级

自动同步依赖**本机已安装 Edge 或 Chrome**（任一个即可）。插件会自动查找常见安装位置（`C:\Program Files (x86)\Microsoft\Edge`、`C:\Program Files\Microsoft\Edge`、`C:\Program Files\Google\Chrome` 及 `LOCALAPPDATA` 下的 Edge / Chrome，最后回退到 `PATH`），可用环境变量 `TONGJI_AIGC_CHROMIUM_PATH` 显式指定可执行文件路径（显式配置不存在就当作不可用，不再回退）。本次登录的临时会话信息记在 `~/.dsh-tongji-aigc/login-state.json`，宿主重载后仍可续管同一个隔离窗口。

若本机实在没有可用浏览器，卡片会**自动降级**并提供「复制取令牌脚本」：切到已登录的同济 AIGC 页面，`F12 → Console` 粘贴运行那段脚本，它会用 `no-cors` 简单请求把令牌回传到本机宿主端点，卡片检测到后同样自动变为「已登录」。这一步只在自动通道不可用时才需要，正常情况无需任何手动操作。

> 端点端口随会话变化，脚本用运行时 `location.origin` 拼接，不写死端口。令牌实际落盘在 `~/.dsh-tongji-aigc/token.json`（注意不是 `~/.dsh/.tongji-aigc/`）。

## 三、对话里的工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `tongji_aigc_form` | 弹参数卡片并阻塞等待用户填写（推荐入口） | `mode`、`prompt`、`template_code`、`note`（都可选，仅作预填与说明） |
| `tongji_aigc_generate` | 生成（主链路） | `mode`（t2i / i2i / t2v / i2v / t23d / i23d / t2a）、`prompt`、`reference_image`、`template_code`、`params`、`count`、`output_path`、`estimate_only` |
| `tongji_aigc_templates` | 列出可用模板/工作流 | `type`（image / video / 3d / music，可选） |
| `tongji_aigc_task` | 查询单个任务并下载产物 | `task_id`、`download`、`output_path` |
| `tongji_aigc_tasks` | 任务历史分页列表 | `page`、`page_size`、`status` |
| `tongji_aigc_quote` | 生成前报价（积分/费用） | `template_code`、`params`、`count` |
| `tongji_aigc_health` | 健康检查 + 登录态 | 无参数 |

## 三之二、卡片式参数表单（任务中期暂停，填完才继续）

模型判断「这次要用 AIGC」后，会先调用 `tongji_aigc_form`，在你的**输入框下方**弹出参数卡片，并**暂停任务等你填写**：

1. **它会自己出现，而且只在本对话出现**：卡片注册在会话作用域的输入框下方插槽（`conversation.composer.dock`），按 `sessionId` 隔离。A 对话在等你填写时，B 对话既看不到这张卡，也不会拿到 A 的参数。
2. **不填就不会继续**：工具会一直阻塞到你提交为止（等待期间不消耗 token）。点 **−** 收成一条提示条稍后再填——**工具仍在等**，不会静默超时；点 **×** 才是取消，模型会收到 `cancelled` 并停下来问你。
3. **提交后任务自动继续**：点「提交这些参数」把结果交回模型，模型随即继续后续步骤（预估、生成），卡片自动消失、界面恢复常态。
4. **卡片分区**（自上而下）：
   - **生成模式**：7 种模式点选，切换会重置模板与参数；
   - **模板**：只列当前模式的模板，带 code；
   - **提示词**：多行输入，右上角显示字数 / 上限；
   - **参数**：完全由该模板的 `param_schema` 生成——下拉变选项芯片、整数变数字框（种子可点「随机」）、长文本变多行框；「恢复默认」一键回到模板默认值；
   - **参考图**：`i2i` / `i2v` / `i23d` 必填，点「选择图片」上传本地图，显示缩略图，可更换 / 移除；
   - **生成前预估**：点「预估积分」显示这次消耗的积分与预计耗时区间（来自上游 `estimate`）。
5. **模型会给初始建议**：卡片顶部显示模型写的一句说明（如「请先确认这张图的参数」），并按它给的模式 / 模板 / 提示词预先选好，你在基础上改即可。
6. **切模板不会报错**：卡片按新模板的 schema 过滤参数，上一次模板留下的字段不会带过去（上游会把多余参数报成「未知参数」）。

> 等待上限默认 15 分钟，可用配置项 `formTimeoutMs`（或环境变量 `TONGJI_AIGC_FORM_TIMEOUT_MS`）调整；超时后工具返回 `timeout`，模型会转为向你确认而不是继续。

`mode` 取值：

- `t2i` 文生图、`i2i` 图生图
- `t2v` 文生视频、`i2v` 图生视频
- `t23d` 文生 3D、`i23d` 图生 3D
- `t2a` 文生音乐

生成示例（文生图）：

```
用 tongji_aigc_generate 生成一张图：mode=t2i，prompt="赛博朋克风格的外滩夜景，霓虹灯光，雨后地面反射"，count=1
```

图生视频（需要一张参考图，传本地绝对路径或 URL）：

```
用 tongji_aigc_generate 做图生视频：mode=i2v，prompt="镜头缓慢推近"，reference_image="D:/xxx/ref.png"
```

产物默认落到**当前会话工作目录**下的 `tongji-aigc-<时间戳>/`，文件名 `<taskId>-NN_<名称>`，工具返回里带每个产物的绝对路径。

## 四、配置

优先级（高的赢）：**插件配置（profile 的 cordis.patch.yml）> 配置文件 > 环境变量 > 内置默认值**。

配置文件：`~/.dsh/.dsh-tongji-aigc/config.json`（可手工编辑，改完重启生效）：

```json
{
  "baseUrl": "https://agi.tongji.edu.cn/api/v1",
  "requestTimeoutMs": 300000,
  "pollIntervalMs": 2000,
  "pollTimeoutMs": 600000,
  "outputDir": "",
  "maxCount": 4,
  "formTimeoutMs": 900000
}
```

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `baseUrl` | 上游 API 基址 | `https://agi.tongji.edu.cn/api/v1` |
| `requestTimeoutMs` | 单次 HTTP 请求超时 | 300000 |
| `pollIntervalMs` | 任务轮询间隔 | 2000 |
| `pollTimeoutMs` | 任务轮询总超时 | 600000 |
| `formTimeoutMs` | 参数卡片等待用户填写的上限 | 900000 |
| `outputDir` | 默认产物目录（留空用会话工作目录） | `""` |
| `maxCount` | 单次生成数量上限 | 4 |

环境变量：`TONGJI_AIGC_BASE_URL` / `TONGJI_AIGC_POLL_INTERVAL_MS` / `TONGJI_AIGC_POLL_TIMEOUT_MS` / `TONGJI_AIGC_REQUEST_TIMEOUT_MS` / `TONGJI_AIGC_OUTPUT_DIR` / `TONGJI_AIGC_MAX_COUNT` / `TONGJI_AIGC_FORM_TIMEOUT_MS` / `TONGJI_AIGC_CHROMIUM_PATH` / `TONGJI_AIGC_TOKEN_FILE` / `TONGJI_AIGC_LOGIN_STATE_FILE`。

> 令牌**不进配置文件**，由卡片写在 `~/.dsh-tongji-aigc/token.json`；隔离登录会话写在同目录 `login-state.json`，两者都与配置互不影响。

## 五、常见问题

- **提示未登录 / 登录态已失效**：点「统一身份认证登录」，在弹出的隔离登录窗口里完成认证后卡片会自动同步；无需复制或粘贴任何令牌。
- **登录后提示密码错误**：本站默认登录走**统一身份认证**，不是本地管理员账号密码。请用卡片上的 SSO 登录按钮跳转；本地账号密码表单是管理员专用，普通账号填进去必然提示密码错误。
- **没看到 callback / 地址栏没有 token**：正常。站点在登录后把令牌写进隔离窗口的浏览器 `sessionStorage` 并直接跳回站内，地址栏不留 `token=`。临时扩展会自动去读并回传，无需手动取。
- **一直停在「等待登录完成」**：确认本机装了 Edge / Chrome；登录必须在**隔离登录窗口**里完成，若你关掉了那个窗口请重新点一次登录按钮；或在卡片里点「复制取令牌脚本」走降级通道。
- **自动登录失败 / 卡片提示环境缺失**：通常是本机没有可用 Edge / Chrome；自动通道不可用时卡片会给出降级说明，按提示用 Console 脚本回传即可。
- **保存后提示 invalid_token**：取到的令牌不对或已过期，重新点一次登录按钮。
- **生成卡住 / 超时**：视频、3D、音乐耗时较长，可在配置里调大 `pollTimeoutMs`。
- **需要改上游地址**：改 `baseUrl`（生产默认同域 `https://agi.tongji.edu.cn/api/v1`）。
