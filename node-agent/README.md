# 榫卯 Tenon · 电脑端节点 Agent

Windows 电脑上的节点执行器。v0.1 负责「注册能力 → 心跳 → 拉任务 → 执行 → 回报」；
v2-P0 在同一进程里增加「剪贴板双向同步、文件收发、通知镜像、受控动作」，由 `TENON_V2=1` 启用，现有能力不变。

## 文件

| 文件 | 作用 |
|---|---|
| `agent.js` | 入口：读 `data/secrets.json` 令牌，注册/2s 心跳/1s 拉任务/执行/回报/幂等/优雅退出 |
| `capabilities.js` | v0.1 能力：`image.crop` / `file.hash` / `file.delete` / `printer.mock` |
| `actions.js` | v2 受控动作：`system.open` / `system.volume` / `system.power`（默认禁用）/ `file.print` |
| `clipboard.js` | Windows 剪贴板读写（PowerShell 5.1 -STA，1s 轮询），双向同步 + 防回环 |
| `link.js` | 文件收发：拉取入站传输→落盘接收目录→sha256 校验→ack；出站分块 PUT + finish |
| `files.js` | 扫描目录、调用中枢入库、打开文件/文件夹、Windows 打印 |
| `notifier.js` | Windows 通知（WinRT Toast → NotifyIcon → msg → 日志兜底），订阅 SSE 做手机通知镜像 |
| `hub.js` | 中枢 HTTP 客户端（v2 用 operatorToken，节点接口用 nodeToken）+ SSE 订阅 |
| `v4.js` | V4 执行器能力：`system.exec`（命令执行/危险词拒绝/超时杀进程树/审计）/ `window.list` / `window.focus` / `screen.capture`（截图供 OCR） |
| `lib/ps.js` | PowerShell 桥（`-EncodedCommand`，临时 JSON 文件回传，避免中文/引号问题） |
| `lib/png.js` | v0.1 纯 Node PNG 解码/居中裁剪/编码（自实现 CRC32） |

## 启动

```powershell
# 先启动中枢（生成 data/secrets.json），再启动节点
node node-agent/agent.js                      # v0.1 能力
$env:TENON_V2=1; node node-agent/agent.js     # v2 桌面端模块 + 受控动作
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TENON_HUB_URL` | `http://127.0.0.1:7410` | 中枢地址 |
| `TENON_NODE_NAME` | `工作台` | 节点名 |
| `TENON_NODE_ID` | `node-local` | 首次生成的节点 id（之后持久化在 `data/node-identity.json`） |
| `TENON_DATA_DIR` | `<仓库根>/data` | 数据目录（含 `secrets.json` / `node-identity.json` / `node-state.json`） |
| `TENON_V2` | 空 | `1` = 启用 v2 桌面模块与动作能力 |
| `TENON_RECEIVE_DIR` | `示例空间/接收` | v2 文件接收目录（相对仓库根） |
| `TENON_CLIPBOARD` | `1` | `0` 关闭剪贴板同步 |
| `TENON_CLIPBOARD_MS` | `1000` | 剪贴板轮询间隔 |
| `TENON_ALLOW_POWER` | 空 | `1` 才允许 `system.power`（仍需 `params.confirm=true`） |
| `TENON_POWER_DRYRUN` | 空 | `1` 时电源动作只演练不执行（自测用） |
| `TENON_ACTION_DRYRUN` | 空 | `1` 时音量动作只演练（自测用） |
| `TENON_OPERATOR_TOKEN` | 空 | 覆盖 `data/secrets.json` 的 operatorToken（联调排障用） |

## v2 对接的中枢接口（契约 `_internal/契约-v2-P0.md`）

全部写接口带 `x-tenon-token: <operatorToken>`，同时附 `x-tenon-node`：

- 剪贴板：`POST /api/v2/link/clipboard {kind,text,from}`；`GET /api/v2/link/clipboard/latest → {clipboard:{...}}`
- 通知：`POST /api/v2/link/notification {from,app,title,text}`
- 素材入库：`POST /api/v2/assets/ingest {deviceId,path}`
- 文件入站：`GET /api/v2/link/transfers?nodeId=&state=incoming` → `GET /api/v2/link/transfer/:id/file?index=` → `POST .../ack {nodeId,saved,ok}`
- 文件出站：`POST /api/v2/link/transfer/init {peerId,direction:'from-desktop',files}` → `PUT .../chunk?offset=` → `POST .../finish`
- 事件镜像：订阅现有 `GET /api/stream`（`notification.relayed` → 本机通知；`transfer.*` → 立即拉一次入站）

中枢 v2 路由未就绪时：剪贴板/传输/入库只记一次告警并按间隔重试，不崩、不影响 v0.1 任务执行。

## 本机自测

```powershell
node --test --test-force-exit node-agent/__tests__/*.test.mjs  # 单测（27 条：v0.1 能力/剪贴板/收发/动作/超级终端动作；Windows GUI 子进程需 --test-force-exit）
node node-agent/__tests__/run-tests.mjs                     # 同上（日志写 evidence/test-run.log，只打印摘要）
node node-agent/__tests__/run-desktop-evidence.mjs        # 本机真实证据（剪贴板双向/扫描入库/受控动作/agent 端到端）
node node-agent/__tests__/run-super-desktop-evidence.mjs  # v2.1 超级终端真实证据（打开程序/网页/媒体/流转 + 截屏 + task pull）
node node-agent/__tests__/run-v4-evidence.mjs          # V4 执行器真实证据（隔离中枢：system.exec/window.list/window.focus/screen.capture + 审计，11 项）
```

## 安全边界

- `system.power` 默认禁用，双闸：`TENON_ALLOW_POWER=1` + `params.confirm=true`；自测只有 dryrun。
- `file.print` / `file.delete` 标为不可逆，走任务引擎确认；`system.open` 只允许存在的路径或 http(s) 链接。
- 剪贴板只同步文本/链接（图片/文件走传输通道，P1），超过 20 万字符不上报，防止刷爆账本。
- 令牌只从 `data/secrets.json` 读，不在命令行/日志打印。
## V4 执行器能力（TENON_V2=1 时注册，供 /api/v2/remote/input 与执行器任务队列调用）

| 能力 | 参数 | 行为 |
|---|---|---|
| `system.exec` | `{command, cwd?, timeoutMs?}` | Windows `cmd.exe /d /s /c` 执行；危险操作黑名单直接拒绝；超时 kill 进程树；stdout/stderr 各截断 4000 字；本地 `data/exec-audit.log` 审计；返回 `{ok,exitCode,stdout,stderr,durationMs}` |
| `window.list` | `{}` | Win32 EnumWindows 枚举可见顶层窗口（标题/进程/PID/是否前台/是否最小化），最多 50 条 |
| `window.focus` | `{title?, process?}` | 按窗口标题（模糊）或进程名激活窗口（ShowWindow + SetForegroundWindow，AppActivate 兜底），失败给可读错误 + 窗口示例 |
| `screen.capture` | `{region?, base64?}` | 截全屏/多屏虚拟桌面，或截 `{x,y,width,height}` 区域；PNG 保存到 `data/screen/`，返回路径+宽高+字节；`base64:true` 时 ≤512KB 内联 |

调用示例（中枢 7410 + 已绑定电脑；任务走队列，结果用 taskId 查）：

```powershell
$token = (Get-Content data/secrets.json -Raw | ConvertFrom-Json).operatorToken
$H = @{ "x-tenon-token" = $token; "Content-Type" = "application/json" }
# 1) 执行命令
Invoke-RestMethod -Method POST "http://127.0.0.1:7410/api/v2/remote/node-local/input" -Headers $H -Body '{"type":"system.exec","payload":{"command":"dir"}}'
# 2) 窗口列表
Invoke-RestMethod -Method POST "http://127.0.0.1:7410/api/v2/remote/node-local/input" -Headers $H -Body '{"type":"window.list","payload":{}}'
# 3) 截屏（区域）
Invoke-RestMethod -Method POST "http://127.0.0.1:7410/api/v2/remote/node-local/input" -Headers $H -Body '{"type":"screen.capture","payload":{"region":{"x":0,"y":0,"width":800,"height":600}}}'
# 4) 取任务结果（stdout/exitCode/path/windows 在 result.data 与平铺字段里）
Invoke-RestMethod "http://127.0.0.1:7410/api/v2/remote/node-local/task/<taskId>"
# 或看最近队列
Invoke-RestMethod "http://127.0.0.1:7410/api/v2/remote/node-local/status"
```

安全：`system.exec` 的 manifest risk=`irreversible`（执行器应按不可逆动作要求确认）；危险词命中即拒绝并写审计；所有命令都在本机执行、不转发到其它设备。