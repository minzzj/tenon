# Changelog

All notable changes to Tenon (榫卯) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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