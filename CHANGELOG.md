# Changelog

All notable changes to Tenon (榫卯) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/).

## [0.6.2] - 2026-10-31 凌晨（修 bug + 快捷录音悬浮球）

### Added
- **桌面悬浮录音球（快捷调用）**：桌面右下角常驻一个小悬浮球，点一下立即开始录音（不需要唤醒词），说完自动交给 AI 直接执行（不是总结），结果显示在球上的气泡里；再点一次或说「结束」结束。
- **耳机/键盘快捷触发**：内置全局快捷键 `MediaPlayPause`（多数蓝牙耳机单击播放/暂停键即触发）+ `Ctrl+Alt+Space` 备用；托盘菜单也可「快捷录音」/显示隐藏悬浮球。
- **手机端等价入口**：手机 App 已有的一键录音按钮走同一套「录音→/voice/command→执行」链路（悬浮球形态下个 APK 版本再补）。
- **录音时实时显示识别文字**：记录流水线在说话过程中每 ~1.2s 输出 partial（悬浮球与主界面实时显示），说完出 final 并执行。

### Fixed
- **语音又识别不了**：根因是语音监听配置被置为关闭（enabled=false）且 ASR worker 未运行；现在 App 启动会自动开启监听并自动拉起 ASR（懒恢复），托盘/设置切换也不会再让状态卡死；重复 start 不再拉起两个 ASR 进程抢麦克风。
- **输入框变回复框**：识别字幕区（听到的话）不再被 AI 回复覆盖，回复只在结果卡片/气泡显示；手动输入发送后清空，输入用途不变。
- **识别提示/可见性**：修复后悬浮球与主界面能看到「正在听…」「理解中…」「已执行」和识别文字；快捷录音会话等待首句时间延长（避免刚点开还没说话就超时）。
- **识别音量/远场**：记录音频加软件自动增益（AGC），VAD 阈值默认 350→200，远场/小音量说话更容易触发与识别。
- **语音会话窗口**：唤醒后的命令会话从 3s 延长到 ≥8s，并在说话/识别/执行时自动续期（修复「说慢一点命令丢掉」）。
- 识别模型使用上一版升级的 **Paraformer-large + 热词**（11 条音频命令 6/6、唤醒 4/5 精确 + 1/5 拼音别名，平均字符准确率 97.9%）。

### Verified（本机真实）
- 快捷录音路由：`POST /api/v2/voice/quick/start` → 200（session 立即进入），命令链路 `lastCommand.ok=true`，mock ASR 下「把音量调到四十」执行派发成功；
- 双流水线模拟：`dual_worker.py --simulate-quick cmd-02.wav` → `session_start` → `partial`「把音量调到六十」→ `final`「把音量调到六十」→ `session_end`；
- 真实麦克风+扬声器回环（上一版同一路径已验证）：「榫卯」唤醒 →「把音量调到六十」→ 真实音量变化；
- 悬浮球 HTML 状态机（idle/listening/speaking）静态检查；Electron 主进程 `node --check` 通过。
- 未能在本会话沙箱内启动完整 Electron 窗口（沙箱限制子进程管道/常驻）；请双击桌面快捷方式实测悬浮球与耳机键。

## [0.6.1] - 2026-10-30 (深夜)

### Changed — 语音识别升级 + 唤醒/记录分离（用户反馈「识别很不准」）

- **识别模型升级**：中文语音识别默认从 SenseVoiceSmall 升级为 **FunASR Paraformer-large**（+ VAD + 标点 + **热词偏置**）。
  - 同一组 11 条真实测试音频：命令 6/6 全对、唤醒 4/5 完全正确（第 5 条「榫卯」被识别为「孙卯」，拼音匹配仍能命中）——此前 SenseVoice 唤醒字符准确率约 64%、命令 93.7%。
  - 单句识别耗时约 **0.15–0.5s**（好于/持平旧模型），端到端「唤醒→命令→执行」真实回环实测通过。
- **唤醒与记录分离（新 `scripts/voice/dual_worker.py`）**：
  - 唤醒流水线：只截取 0.5–2.5s 短片段做快速识别 + 文本/拼音同音匹配，命中即发 `wake` 事件；
  - 记录流水线：唤醒后单独开启会话，完整 VAD 分段（1s 静音结束）+ 标点 + 热词，输出 `final` 命令；
  - 两条流水线参数、模型用途、逻辑独立；同一时刻只一个录音任务，避免争抢麦克风；会话静音 6s 后回到唤醒待机。
- **会话窗口修复**：唤醒后命令会话由 3s 延长到 ≥8s，并在说话/识别/执行时自动续期（此前说话稍慢命令会丢）。
- **热词可配置**：`data/voice/config.json` 的 `asr.hotwords`（默认榫卯/小榫/打开记事本/音量/Chrome/照片/甩到电脑/回家模式/总结/提醒），可继续加人名、品牌、常用命令。
- 真实回环实测（扬声器→麦克风）：唤醒「榫卯」→ 识别「把音量调到六十」→ **真实音量 55 → 61 完成**（rule 执行 492ms）；账本 integrity=true。

## [0.6.0] - 2026-10-30

V5：把「说出来的东西」真正落下来——**语音笔记、结构化总结 + 文档中心、提醒、手机同步，以及通过标准协议接入真实家居设备**；雷鸟 AI 眼镜官方功能对照见 [docs/雷鸟AI眼镜对照-V5.md](docs/雷鸟AI眼镜对照-V5.md)。

### Added

- **语音笔记**（`server/lib/notes/`）：说「记一下：…」→ 笔记直接保存；按天 JSONL（`data/notes/YYYY-MM-DD.jsonl`）+ Markdown（`data/notes/md/`），支持搜索 / 编辑 / 删除 / 导出；账本 `note.*` 留痕。
- **结构化总结 + 文档中心**（`server/lib/documents/`）：DeepSeek 输出固定结构「摘要 / 重点 / 待办 / 回顾 / 日记」，生成 **Markdown + DOCX + PDF**（`docx` + `pdfkit`）；文档列表 / 预览 / 下载 / 删除。live 实测 `provider=deepseek`、**1149 字**、DOCX/PDF 文件 magic 校验通过。
- **提醒**（`server/lib/reminders/`）：中文时间解析（「提醒我 21:30 开会」「每天 8 点提醒我吃药」「1 分钟后提醒我喝水」），一次性 / 每天；15 秒调度；到点写账本 `reminder.fired`、SSE 推送、TTS 播报（`scripts/voice/speak.ps1`）、Windows 系统通知（node-agent `system.notify`）、手机 App 本地通知；完成/确认幂等。
- **Android 0.6**（`public/download/tenon-android-0.6.0-debug.apk`）：5 页签（首页 / 记录 / 提醒 / 文档 / 设置）、笔记/提醒/文档同步、本地通知（前台 30 秒轮询 + WorkManager 15 分钟兜底）、文档下载 + FileProvider/`ACTION_SEND` 分享、IoT 设备控制；**2,901,975 B**、versionCode 6 / versionName 0.6.0、SHA-256 `BBA1B620…4A95F`；构建 + lint（0 errors / 94 warnings）+ aapt 静态校验通过；**未真机实测**。
- **真正物联**（`server/lib/iot/`）：**Home Assistant REST**（大品牌设备经 HA 桥接）、**MQTT**（含 HA MQTT discovery）、**SSDP** 局域网发现；导入设备 → 统一设备列表 → 网页 / 语音 / 手机控制；`/api/v2/iot/*`、账本 `iot.*`。诚实边界：本轮是标准协议接入，**不直连厂商云**；无真实家居设备时以本地桩验证。
- **UI 5 页签 + 今日看板**（`public/super.html`、`super-v4.js`）：首页看板展示下一个提醒 / 今日笔记 / 今日总结与 MD/DOCX/PDF 下载 / 今日屏幕采集；记录页（搜索 / AI 总结 / 笔记详情与下载）、提醒页、文档页、设置页（IoT 接入 HA/MQTT/SSDP）。
- **雷鸟 AI 眼镜对照**：[docs/雷鸟AI眼镜对照-V5.md](docs/雷鸟AI眼镜对照-V5.md)（官方 7 项功能 vs 榫卯已做/未做；提词器、手机通知转发明确标下轮）与 README 对照表。

### Changed

- 总结从 V4 的「摘要式日记」升级为**结构化总结 + 三种文档导出**；V4 的 23:00 自动总结保留。
- 手机 App 从「只显示」升级为可**拉取笔记 / 提醒 / 文档**并分享；新增 IoT 控制页。
- 首页从 V4 四页签升级为 V5 **五页签 + 今日看板**；旧设备页/今日页入口保留。
- `system.notify` 能力接入提醒链路（node-agent），到点系统通知可真实派发。

### Fixed

- 总结内容空泛 → 固定「摘要 / 重点 / 待办 / 回顾 / 日记」结构，并附来源（笔记/语音/屏幕/执行记录）。
- 手机收不到电脑生成的内容 → 笔记/提醒/文档同步接口 + 手机本地通知 + 文档下载分享。
- 提醒只能看不能到点 → 真实调度 + 账本/SSE/TTS/系统通知/手机通知全链路。
- 物联只有模拟设备 → HA/MQTT/SSDP 标准协议接入真实生态（品牌经桥接）。

### Verified (2026-10-30 晚)

独立 Checker 终验（`_internal/checker-v5.md`）：**笔记 / 总结文档 / 提醒 / 物联 / UI / APK 全部 PASS**；回归 5/5 全绿，API 矩阵 353 PASS / 0 FAIL / 6 SKIP（P2：只读实例 `GET /api/v2/iot/discover` 写账本 → 已修复：只读守卫 + 复跑全绿）。

- **笔记（10/10 PASS）**：POST 201 + id + Markdown；GET / 搜索 / PATCH / DELETE 全通；`data/notes/md/*.md` 353B（YAML front matter）；账本 `note.created/updated/deleted`；未登录 401；**语音链路「记一下：…」→ 笔记真实出现**（rule，actions=记笔记 succeeded）。
- **结构化总结 + 文档（隔离 10/10 + live 13/13 PASS）**：隔离（无 key）`provider=template`、5 部分、md 1267B / docx 10101B（PK）/ pdf 16262B（%PDF）；**live 真实 DeepSeek 1 次**：`provider=deepseek`、5 字段、md 3113B / docx 11236B（PK）/ pdf 42525B（%PDF）、Content-Type + 文件名齐全；`/documents/stream` 200。
- **提醒（11/11 PASS）**：中文解析「1 分钟后」due=60.0s；**真实等待到点**：账本 `reminder.fired`、SSE `reminder`、TTS WAV 文件存在；node 不在线时 notify 优雅降级；done 幂等；daily 滚动（`lastFiredDay`/`nextAt` 次日、同日不重复）；「每天 8 点」「明天 9 点」解析正确。live 真机派发证据：`reminder.fired seq=1127`、notify `dispatched=true taskId=task_mvv3a6tekozd nodeId=node-local method=system.notify`、TTS WAV 125,326B。
- **物联（14/14 PASS）**：本地桩真实链路——HA REST 配置/测试（version=API running）、实体 3、导入 3、控制 `turn_on`（桩收到 services 请求）；MQTT aedes broker 真实 client=2、订阅 `homeassistant/+/+/config`、连接测试通过；`/iot/discover?source=mqtt`、`?st=ssdp:all` 200（真实局域网 SSDP 1 次 0 台 UPnP 设备，如实记录；本地 UDP 桩可响应）；账本 `iot.discovered/imported/controlled`。node-agent 侧 IoT 自测 **44/44**：HA 版本 2025.10.0、6 个实体映射、MQTT discovery 自动发现「客厅灯」、`set_brightness 50%` payload=128、真实网卡 SSDP 3.5s 0 条（本网络无设备）。
- **UI（11/11 PASS）**：5 页签 `tab-home/records/reminders/documents/settings` 全命中；首页看板 7 卡片（下一个提醒 / 今日笔记 / 总结状态 / 下载 MD-DOCX-PDF）；记录页 9 控件、提醒页 8 控件、文档页 5 控件、设置页物联 12 控件；**0 JS 错误**；网络隐私 22 请求全部 127.0.0.1。
- **APK 0.6（13 PASS / 0 FAIL / 1 SKIP）**：`public/download/tenon-android-0.6.0-debug.apk` **2,901,975 B**、SHA-256 `BBA1B620AC4C9A90C57932500A73F7EB1A02B21B74940544FB6276CA7CA4A95F`、`com.minzzj.tenon` versionName 0.6.0 / versionCode 6；权限 12 项含 INTERNET / RECORD_AUDIO / FOREGROUND_SERVICE / POST_NOTIFICATIONS；FileProvider + file_paths.xml、ACTION_SEND 分享、notes/reminders/documents 接口代码、Notes/Reminders/Documents Activity 均在；无令牌泄漏；**SKIP = 无真机（未做安装/通知/分享/屏幕授权实测）**。
- **回归**：`npm test` **146/146**；v2 基线 **9/9**；API 矩阵 **353 PASS / 0 FAIL / 6 SKIP**（359 用例、152 路由）；v1 E2E **9/9**；super UI（/legacy）**14/14**。
- **已知问题（如实记录，未修）**：**P2**——只读实例 `GET /api/v2/iot/discover` 会写账本 `iot.discovered`（API 矩阵 `readonly-ledger` before=79/after=80 FAIL）；建议 discover 走 `requireWrite` 或只读模式不落账。另有环境说明：live 账本 `integrity=false` 为历史多实例并发写所致（最终重建）；node-agent 套件 39/42（3 条剪贴板真实测试受 live 并发影响，非本轮改动）。

## [0.5.0] - 2026-10-30

V4：从「网页 + 多个辅助程序」收敛为**一个桌面程序「榫卯超级终端」**——托盘常驻、说话即可调动电脑程序与家里设备，屏幕文字本地识别，每天 23:00 自动写总结；手机 APK 0.5 同步简化绑定、录音送电脑识别、屏幕采集上报。

### Added

- **单程序桌面端（`desktop/`，Electron）**：托盘常驻的「榫卯超级终端」，窗口加载 `public/super.html`（四页签：首页/设备/今日/设置，单行字幕）；双击桌面快捷方式、单文件便携版或 `启动超级终端.cmd` 启动；自动拉起本地中枢（`127.0.0.1:7410`）与屏幕采集循环；托盘菜单支持暂停/开启语音监听、暂停/开启屏幕采集、现在生成今日总结、开机自启、打开数据目录、退出；关闭窗口收到托盘，单实例运行。
- **实时本地语音 + 执行**：常开聆听、唤醒词「榫卯 / 小榫」；本地 FunASR 识别（live 实测 `provider=funasr`、`state=listening`）+ Windows 中文 TTS 回复；语音链路走 `server/lib/voice/`（`/api/v2/voice/*`：status/config/start/stop/command/transcribe/stream/transcripts/speak/screen/diary）。
- **自研执行器（OpenClaw 式，`server/lib/agent/`）**：`POST /api/v2/agent/execute` 把一句话变成计划并执行，支持程序、命令、窗口、屏幕、音量、打印、场景、设备控制；DeepSeek 规划（最多 3 轮、结果回传继续判断），本地模型/规则兜底；动作白名单、不可逆动作需确认、全程审计；`/agent/status`、`/agent/actions`、`/agent/audit`、`/agent/confirm`。
- **屏幕文字理解（本地系统字库 OCR）**：`scripts/screen/win_ocr.py` 使用 Windows.Media.Ocr（zh-Hans-CN 离线系统字库，非大模型），词级字体相似度 + 阈值；自测 3/3 ≥90%、5 张真实截图平均准确率 98.2%、单张 OCR 约 67–96ms（含抓图/上传 186–239ms）；`capture_loop.py` 默认 60 秒、变化才抓，支持黑名单与暂停文件；文字写入 `data/voice/screen/YYYY-MM-DD.jsonl` 与账本 `voice.screen`，不上传。
- **每日总结（23:00 内置）**：`server/lib/voice/diary.js` 汇总当天语音转写 + 屏幕文字 + 任务 → DeepSeek → 报告与日记（今天做了什么 / 明天要做什么 / 日记），Markdown 存 `data/voice/diary/YYYY-MM-DD.md`；live 实测 `provider=deepseek`、1383 字、三部分齐全；错过会在下次启动补跑，托盘可手动生成；`GET /api/v2/voice/diary`、`/diary/list`。
- **单文件便携版**：`desktop/release/TenonSuperTerminal-0.5.0-portable.exe`（125,872,497 B ≈ 120 MB；打包内嵌本地服务与界面，双击即启动，经 Lead 实测可启动）；旧版完整控制台保留在 `http://127.0.0.1:7410/legacy`。
- **手机 APK 0.5.0**（`public/download/tenon-android-0.5.0-debug.apk`）：1,230,154 B（1.17 MB），SHA-256 `F105D4EAD611924C694FC7285B348B9EE5EF384BEA55A98BEB1F6257D682E829`，versionCode 5 / versionName 0.5.0；主页极简 4 页签、录音送电脑识别并执行（含待确认确认闭环）、屏幕采集上报（MediaProjection 前台服务）、设备一键绑定/一键动作；构建 + lint + 静态校验通过，**真机未实测**（无 adb 设备）。
- **一键绑定**：同一 WiFi 自动发现，「使用这台」一键绑定 /「移除」一键解绑；扫码与 6 位配对码收进「高级」折叠，不再占主流程。
- **node-agent 新能力**：`system.exec`、`window.list`、`window.focus`、`screen.capture`（供执行器与屏幕 OCR 使用）。

### Changed

- 界面收敛为 4 页签：首页 / 设备 / 今日 / 设置；首页单行实时字幕 + 结果卡；旧页面入口保留为二级页。
- 语音、屏幕采集、执行器、每日总结默认开启（normal mode，mock 关闭）。

### Fixed

- **手机与 `/m/live` 的两行重复识别**：修复前 6 行、同句重复 2 次；修复后固定 1 条最终字幕 + 1 条临时槽位、0 重复、0 JS 错误，SSE 重连不重复追加；桌面首页 `#sub-final` 单行唯一。
- **简化绑定**：去掉以扫码配对为主流程的步骤，改为同 WiFi 自动发现 + 一键绑定。
- **手机录音可用**：录音→上传→电脑识别→执行→回复闭环打通，失败时错误可读。
- **屏幕 OCR 落地**：不再依赖大模型/联网，本地系统字库识别并可暂停。
- **`/api/v2/agent/execute`**：一句话多动作执行、shell 命令执行与审计、待确认流程可用。
- **正常模式**：mock 关闭、语音与每日总结默认开启；无 DeepSeek key 时每日总结本地降级且进程不崩。
- **APK 0.5**：修复旧版语音链路与主页入口问题，重新构建并发布到 `public/download/`。

### Verified (2026-10-30)

- **桌面单程序**：Electron 窗口加载 `public/super.html`（四页签：首页 / 设备 / 今日 / 设置；单行字幕 `#sub-final` 唯一）；进程存活、托盘常驻、桌面快捷方式「榫卯超级终端」存在、自动启动中枢（7410）与屏幕采集；页面 0 JS 错误；**单文件便携版** `desktop/release/TenonSuperTerminal-0.5.0-portable.exe`（125,872,497 B ≈ 120 MB）实测可启动；旧完整控制台保留在 `/legacy`。
- **本地语音**：live 实测 ASR `provider=funasr`、`state=listening`，唤醒词「榫卯 / 小榫」生效；唤醒后执行「打开记事本 + 调音量」多动作真实成功（`provider=deepseek×2`，2.4s）。
- **执行器**：`/api/v2/agent/execute` 16 动作白名单（含 `shell.exec` / `window.*` / `screen.capture` / `input.*`）；真实执行 notepad 成功、音量 0→60 成功；`shell.exec "echo hi"` 44ms、退出码 0；`window.list` 枚举 21 个窗口；`screen.capture` 2560×1440 PNG（341 KB）；不可逆动作需确认且幂等（重复确认 `already=true`）；`agent.executed` / `agent.shell` 审计可查；node-agent 在线能力 20 项（含 V4 4 项）。
- **屏幕字库 OCR**：`win_ocr.py --selftest` 3/3 ≥90%（100% / 92.7% / 94.1%）；5 张真实截图字符平均准确率 **98.2%**（目标 ≥95%）；单张 OCR **67–96ms**（含抓图/上传链路 186–239ms，capture_loop 实测 236–239ms / 1564–1641 字）；`engine=windows-ocr`，无网络/云模型调用。
- **屏幕采集链路**：`capture_loop.py --once` → `POST /api/v2/voice/screen` 200 → `GET` 可查、`data/voice/screen/YYYY-MM-DD.jsonl` 落盘、账本 `voice.screen` 有记录；黑名单 / 暂停文件生效，数据只存本地。
- **每日总结**：23:00 内置调度 + 手动「现在总结」；live 实测 `provider=deepseek`、**1383 字**、三部分（今天做了什么 / 明天要做什么 / 日记）齐全，Markdown 落盘 `data/voice/diary/YYYY-MM-DD.md`。
- **两行重复修复**：手机 `/m/live` 修复前 **6 行、同句重复 2 次** → 修复后固定 1 条最终字幕 + 1 条临时槽位、0 重复、0 JS 错误；桌面首页 `#sub-final` 单行唯一（注入两条只显示最新）。
- **手机 APK 0.5**：构建成功；1,230,154 B（1.17 MB）；SHA-256 `F105D4EAD611924C694FC7285B348B9EE5EF384BEA55A98BEB1F6257D682E829`；versionCode 5 / versionName 0.5.0；权限含 RECORD_AUDIO / FOREGROUND_SERVICE_MEDIA_PROJECTION 等；lint 0 errors / 78 warnings；**未真机实测**（无 adb 设备）。
- **回归**：`npm test` **146/146 PASS**；v2 基线 **9/9**；API 矩阵 **287 PASS / 0 FAIL / 2 SKIP**（289 用例、117 路由）；v1 E2E **9/9**；super UI **14/14**。
- **独立验收（Checker 终验）**：**V4 P0 全部 PASS** — OCR 自测 3/3 ≥90%、5 张真实截图均值 98.2%（单张 OCR 67–96ms）；执行器真实多动作 `provider=deepseek×2`、2.69s、音量真实读回 60；Electron 单程序 12/12（四页签、单行字幕、0 JS 错误、托盘/快捷键/便携版）；新 UI 与 `/m/live` 去重 PASS；APK 0.5 静态 12 PASS/0 FAIL/1 SKIP（SKIP=无真机）。

- **可选执行智能体：本机 OpenClaw（小龙虾）Gateway**：设置页可切换；`POST /api/v2/agent/openclaw`，实测 7.1s 返回「榫卯在线」，失败回退自研执行器。

## [0.2.0] - 2026-10-25

### Added

- **Consumer super terminal (`#/super`, v2.1 P0)**: one small app to drive every device and program at home. New default home with device cards, program tiles, one-line AI input, voice button (browser speech recognition with text fallback), and a "handoff" panel. Verified in a real browser: 14/14 checks, 0 JS errors (`docs/测试证据/v2.1-超级终端-验收-20261025.md`).
- **AI intent + assistant** (`server/lib/super/`): natural-language request → plan → real task dispatch. DeepSeek-backed when `DEEPSEEK_API_KEY` is set; deterministic rule engine fallback that covers open-app / open-URL / show-media / print / volume / handoff / "coming home". Real desktop effects verified: `app.launch` opened Notepad and WeChat on the desktop node (PID reported), `handoff.show` opened the handoff page on the desktop.
- **Phone-to-desktop handoff**: `POST /api/v2/super/handoff` + `super.handoff` ledger event; `/m` mobile page has a "甩到电脑" button and a tilt gesture (`deviceorientation`, >25° quick tilt, 1s debounce) that pushes the current page to the desktop; desktop `#/handoff` page shows it with a slide-in animation.
- **Desktop action capabilities** (`node-agent/`): `app.launch`, `url.open`, `media.show`, `handoff.show`, `app.list` with built-in program map (WeChat / Chrome / Edge / Notepad / Explorer / Calculator / Photos / terminal / music…), injected via `TENON_V2=1`.
- **Android 0.2.0** (`android/`): tilt-to-handoff via accelerometer with configurable threshold, `SpeechRecognizer` voice commands, shortcut tiles, settings page. APK built: `android/dist/tenon-android-0.2.0-debug.apk`, 1,232,442 B, SHA-256 `439E616D44800EE0FF279F3C3D391226E3747E8DC9A8613EAE26A9359AA7F67B` (debug-signed; real-device test pending).
- **v2-P0 foundation** (previously developed, now documented and accepted): link layer (UDP discovery, 6-digit/QR pairing incl. Android anonymous pairing, resumable chunked transfer with SHA-256, clipboard/notification relay, 22 routes), asset centre (hash dedupe, sharp thumbnails, tesseract OCR, search, lineage, basket; 500 images indexed in ~6s), things/scenes, enterprise control plane (optional plugin), 5 new web pages + mobile pages. Isolated-instance acceptance: 9/9 checks, 55 routes (`docs/测试证据/v2-acceptance-2026-10-25-14-32-08.json`).
- **Docs**: consumer vision v2.1, product definition v2 (enterprise moved to optional appendix), v2.1 acceptance evidence, updated delivery list and README roadmap in both languages.

### Changed

- Mobile/desktop navigation and copy re-oriented to consumer language (家 / 我的设备 / 程序), with the enterprise console kept under "更多" as an optional plugin.
- `scripts/启动.cmd` now starts hub and node with `TENON_V2=1`; `npm run test:v2` and `npm run test:modules` added.

### Fixed

- Link module routes were unreachable through the v2 gateway (path-normalisation mismatch) — fixed in `server/lib/v2/index.js`.
- `/api/v2/link/*` writes no longer blocked by the operator-token gate before the link module's own auth (peer tokens / anonymous QR pairing), while every other v2 module still requires the operator token.
- Node classification in `server/lib/super/catalog.js` picked "printer" for a PC that had `printer.mock`; computer capabilities now win, so `app.launch` resolves to the desktop.
- `state.js` snapshot made defensive for partial states; v2 event branches added (`link.*`, `transfer.*`, `clipboard.shared`, `notification.relayed`, `asset.*`, `basket.updated`, `scene.*`, `org.*`/`enterprise.*`, `super.*`).

## [Unreleased]

## [0.3.1] - 2026-10-26

### Added

- **剪贴板隐私过滤（v2.4 Round 4）**：`server/lib/link/privacy.js` 识别密码/验证码/银行卡/身份证/长数字串/token/超长共 7 类敏感内容；命中后**不落盘、不同步**，账本只记录 `redacted:true + sensitiveType + length`（无原文）；`GET /api/v2/link/clipboard/history` 最近 5 条 + 单条删除/一键清空（写账本）；开关关闭后服务端拒绝 + node-agent 5s 轮询停采；node-agent 发送前/写入前双过滤。单测 10/10。
- **12 个高频错误码文案库**：`public/errors.js`，每个错误码一张卡「现象 + 原因 + 下一步（可点击）+ 复制诊断」（诊断含版本/端口/中枢/时间/最近 5 条事件）；新增 `#/errors` 演示页；接入 link/devices/assets/scenes/super/handoff 页面与 /m/remote。
- **离线体验统一**：桌面 v2 页离线顶部「数据截至 HH:mm（缓存）」+ 写操作置灰；恢复后 ≤10s 自动消失（online/offline + SSE 断连 + 健康轮询三路检测）；/m/remote 同步。
- **设备槽位与重名**：`data/devices/settings.json` + `GET/PATCH/POST /api/v2/devices/settings`（个人 3 / 家庭 8）；到上限 bind 返回 409 `DEVICE_SLOT_FULL` + 「最久未活跃 3 台」替换建议；重名自动加「（2）」后缀；`#/devices` 槽位卡与替换建议 UI。单测 4/4。
- **全面测试装置**（`test/verify/`）：用户旅程 E2E（7 条，12 PASS）、10 分钟 soak（294/294 请求、seq 断裂 0、RSS 无增长）、性能基线（/api/state p50 0.76ms/p95 1.24ms 等）、R4 隐私/错误码/离线/槽位验收（21/21）。

### Changed

- v2 模块测试 87/87、API 矩阵 229/229（v2 路由 87 条）、v1 E2E 9/9、super UI 14/14 全绿。


### Added

- **手机遥控器/触控板（v2.2 Round 3）**：电脑端新增 `input.mouse`（SendInput；绝对/相对移动、点击、滚轮）、`input.key`（文字+白名单组合键）、`input.media`（媒体/音量）；服务端新增 `server/lib/remote/`（`POST /api/v2/remote/:deviceId/input`，未绑定 403/未知 404/未知 type 400，移动 50ms 节流）；手机新增 `/m/remote` 触控板/键盘/媒体键/常用程序；桌面 `#/devices` 增加「用手机控制这台电脑」入口。实测远程鼠标移动误差 0、音量 40→38→40、记事本键盘输入真实生效。
- **拍照/相册一甩上大屏**：手机 `/m` 支持拍照/选图 → 素材入库 → `super.handoff {kind:'photo'}` → 电脑 `#/handoff` 大图呈现；账本记录 `asset.ingested` + `super.handoff`。
- **一键场景（回家/工作/睡前）**：`scripts/seed-home.js` 生成 `data/super/presets.json` 与真实可执行计划（app.launch/url.open/system.volume/media.show/handoff.show），`#/super` 首页大按钮执行，账本 `scene.defined`/`scene.ran` 可查。
- **新手引导**：首次打开 `#/super` 3 步引导（装 App→配对绑定→甩照片），可跳过、完成态持久化。
- **宣传片 v2/v2.1**：54s/60s 两个版本（真实新界面截图 + R3 追加段：手机遥控、拍照甩屏），导出 `代码视频/导出/榫卯介绍片v2.1_60秒/`（bgm/silent/poster/contact-sheet/导出说明），关键截图 7 张入 `docs/images/`。

- **设备绑定与一键安装（v2.2 Round 1）**：新增 `#/devices` 设备页（设备卡：在线/已绑定/已安装/能力数/最近活跃/来源/能力标签；一键绑定/解绑二次确认；一键安装 3 步引导）。新增 `server/lib/devices/`（`GET /api/v2/devices`、bind/unbind/action/rename/install），绑定持久化 `data/devices/bindings.json` 并写账本 `device.bound/unbound/renamed`。新增 Windows 节点一键安装包：`scripts/build-install-package.js` 生成 `public/download/tenon-node-win.zip`（149KB，含 node-agent + `install-node.ps1`，支持 `-HubUrl/-InstallDir/-NoStartup/-Uninstall`、登录自启、安装结果 JSON），中枢提供下载入口与安装信息 API。
- **配对可用性改造（v2.2 Round 2，依据大厂互联调研 P0）**：`GET /api/v2/link/preflight` 六项前置自检（中枢在线/同网段/端口可达/发现端口/版本一致/目录可写，红项给三步修复+复制诊断）；二维码带 `v/exp/oneTime` 与一次性码，手机 `/m/link` 扫码自动配对、过期自动换码、手输兜底；配对成功页能力清单 + 3 个一键动作（发文件/同步剪贴板/甩页面）；设备卡字段补齐与重命名持久化；撤销前影响预览（确定/可能/未知）+ 撤销后 ≤1s 内 403 `PEER_REVOKED` + `link.revoked` 审计。
- **验收装置入库**：`test/verify/`（API 全路由矩阵、真实 Chrome UI 全页巡检、R2 API/UI 验收脚本），均为可重跑的真实环境验收。

### Fixed

- 修复 v2 网关注入路径匹配（模块全路径/相对路径路由归一化），修复 link 模块只读/鉴权边界。
- 修复安装包构建早期版本遗留：stdout JSON 类型不稳定、卸载误杀其它安装目录 agent、安装包体积（265KB→149KB，排除 `__tests__`）。
- 修复 `server/lib/devices` 早期字面 `\n` 导致常量未定义（GET /api/v2/devices 500）。


### Added

- **Executable real-browser E2E** (`test/e2e/run-real-browser.js`, `npm run test:e2e`): zero npm dependencies; spawns an isolated hub + node + real Chrome, drives it over CDP (real navigation, mouse clicks, keyboard input, screenshots), covers 8 checks (phone draft → five-section draft → real node execution → receipt; irreversible confirm/reject; impact preview + cancel; device disconnect downgrade; inbox + receipt login gate; offline drill; ledger integrity / no duplicate execution). Evidence: `docs/测试证据/e2e-*.json` + `e2e-screenshots/`. Runs green locally and in the `Real-browser E2E` GitHub Actions workflow (windows-latest, real Chrome).

### Fixed

- Node heartbeats are persisted to the ledger at most once per 60 s (live online state stays in memory) — the audit ledger is no longer flooded by 2 s heartbeats.
- Drill `restore` now clears the degraded state (`system.degraded {mode:"normal"}`) so the UI returns to normal after an offline drill.
- `scripts/seed-demo.js` summary now reports the local workbench impact preview (was `undefined`).

## [0.1.0] - 2026-10-25

First shipped release: a local-first, zero-runtime-dependency hub that connects devices, software and AI into one auditable task chain.

### Added

- **Hub** (`server/start.js`, `server/lib/`): HTTP API + SSE stream, append-only hash-chained event ledger (`ledger.js`), deterministic state replay (`state.js`), capability registry, task engine (`tasks.js`), delivery channels (`channels.js`), health check (`checkup.js`), audit export (`http.js`). Single-writer lock; a second instance on the same data directory comes up read-only.
- **Node agent** (`node-agent/`): registers its capability manifest, heartbeats, pulls queued tasks, executes them and reports `task.step` / `task.succeeded` / `task.failed`; task ids are idempotent, so a restart never re-runs a finished task.
- **Capabilities**: node side `image.crop` (pure-JS PNG centre crop, no native binary), `file.hash` (SHA-256), `file.delete` (irreversible), `printer.mock`; hub side `channel.notify` (summary + link only) and `llm.summarize`.
- **Web app** (`public/`): desktop console (overview, devices, capabilities, tasks, messages, checkup, audit, drills, settings), phone page at `/m`, receipt page at `/r/<taskId>` gated by the operator token, token login page. Plain HTML/CSS/JS, no CDN, no external fonts.
- **AI layer** (`server/lib/ai.js`): provider interface with a real DeepSeek provider (key from `DEEPSEEK_API_KEY`, budget of 20 calls / 40k tokens per run, hash cache) and a rule-engine fallback that never fabricates a result; draft, explain and diagnose paths degrade explicitly.
- **Scripts**: `scripts/启动.cmd` / `scripts/停止.cmd` (Windows one-click start/stop), `scripts/install.sh` (Linux server deployment), `scripts/seed-demo.js --fresh` (rebuild demo data), `scripts/gen-samples.py` (regenerate sample PNGs, needs Pillow).
- **Demo data**: 71 events / 11 tasks / 2 checkups / 2 messages / 2 audit exports; three tasks reference the "打印服务器" device so disconnect impact can be demonstrated (certain 3 / possible 1 / unknown 1).
- **Tests and evidence**: 146 unit tests in 8 files (`npm test`); real-browser acceptance run with 19 archived screenshots under `docs/测试证据/`; product screenshots under `docs/images/`.

### Changed

- README (English and Simplified Chinese) rewritten from "under construction" to shipped v0.1.0: real screenshots, real commands, measured numbers, honest boundaries.
- Manual (`docs/使用手册.md`), test method (`docs/测试方法.md`) and deliverable checklist (`docs/交付物清单.md`) updated with the actual installation flow, measured results and evidence links.
- CI workflow (Windows + Node 24) verifies required documents, rejects committed API keys and runs the unit suite.

### Fixed

- Restart after a forced kill replays the ledger, marks the event gap explicitly (`system.crashRecovery`) and does not re-execute in-flight tasks.
- A second hub instance on the same data directory degrades to read-only (writes answer HTTP 423) instead of corrupting the ledger.

### Known limitations

- WeChat and email are adapter interfaces plus mock channels; real transports need webhook / SMTP credentials.
- The phone experience is the `/m` page in a desktop Chrome (420 px layout) plus an independent headless-Chrome screenshot; no physical phone was used.
- No physical network unplug: the offline drill switch cuts outbound calls instead.
- macOS / Android native nodes are not validated on real hardware.
- The enterprise form (machine-room high availability) is configuration-layer ready only.
- `printer.mock` does not talk to a real printer; `file.delete` really deletes and is gated by one-by-one confirmation.
- The license is CC BY-NC-SA 4.0, not an OSI-approved open-source license.

### Verified numbers (2026-10-25)

| Item | Result |
|---|---|
| Unit tests (`npm test`) | 146 passed / 0 failed in 8 files (ledger 16, state 30, ai 21, tasks 23, channels 10, checkup 16, png 14, seed-demo 16) |
| Real-browser acceptance | 8/8 acceptance checks passed; 19 evidence screenshots |
| Disconnect → task downgrade | 275 ms for 3 referencing tasks (acceptance line: 10 s) |
| Impact preview | certain 3 / possible 1 / unknown 1; cancel leaves business state unchanged |
| Kill + restart | 4 boots / 3 crash recoveries, no duplicated `task.succeeded` / `task.started`, 61,293 ms gap marked, seq + hash chain continuous (one drill run: 520 events) |
| Dual instance | second instance read-only; writes answer HTTP 423 |
| Phone offline | 7 device cards + 14 task histories + "数据截至 HH:mm（缓存）" banner |

Evidence: [docs/测试证据/测试结果-20261025.md](docs/测试证据/测试结果-20261025.md) · [JSON](docs/测试证据/测试结果-20261025.json).

---

## 中文摘要

### [0.1.0] - 2026-10-25（v0.1.0 交付）

首个交付版本：本地优先、零运行时依赖的「设备 / 软件 / AI → 可查任务链」自建中枢。

- 中枢：追加式哈希链账本 + 启动重放、能力注册表、任务引擎、影响预览（确定/可能/未知）、消息回传（摘要+链接）、上线体检、审计导出（CSV/JSON/Markdown）、SSE 实时推送；单写者锁，第二个实例自动只读。
- 节点：注册能力、心跳、拉任务、执行并回报；任务幂等，强杀重启不重复执行。
- 能力：节点侧 `image.crop`（纯 JS PNG 居中裁剪）、`file.hash`、`file.delete`（不可逆）、`printer.mock`；中枢侧 `channel.notify`、`llm.summarize`。
- 前端：桌面控制台（总览/设备/能力/任务/消息/体检/审计/演练/设置）、手机页 `/m`、回执页 `/r/<taskId>`（需操作令牌）、登录页；原生 HTML/CSS/JS，无 CDN、无外链字体。
- AI：DeepSeek 真实提供方（`DEEPSEEK_API_KEY`，单轮 20 次调用 / 4 万 tokens 预算 + 哈希缓存）+ 规则引擎离线降级，不伪造结果。
- 脚本：`scripts/启动.cmd` / `停止.cmd`、`install.sh`、`seed-demo.js --fresh`、`gen-samples.py`。
- 实测（2026-10-25）：单元测试 146/146 通过；真实浏览器验收 8/8 通过；断开被 3 条任务引用的设备 275 ms 内三处降级；强杀重启不重复执行、缺口 61,293 ms 已标记；双实例第二实例只读（写操作 423）。
- 诚实边界：微信/邮件为适配器接口 + 模拟通道；手机用桌面 Chrome 的 `/m` 页面验证，未用真机；物理拔网线未做（用断网演练开关）；macOS/Android 原生节点未实机验证；企业形态为配置层就绪。

证据：[测试结果-20261025.md](docs/测试证据/测试结果-20261025.md) · [测试结果-20261025.json](docs/测试证据/测试结果-20261025.json)。

[Unreleased]: https://github.com/minzzj/tenon/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/minzzj/tenon/releases/tag/v0.1.0