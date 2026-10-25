# Changelog

All notable changes to Tenon (榫卯) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/).

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