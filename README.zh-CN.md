# 榫卯 Tenon

> 把设备、软件与 AI 串成**一条可查的任务链**的自建中枢。

[English](README.md) · [文档](docs/) · [许可证](LICENSE) · [商用说明](COMMERCIAL.md) · [安全](SECURITY.md)

**状态：v0.1.0 已交付（2026-10-25）。** 中枢、节点、桌面控制台与手机页全部可运行；**146 条单元测试全部通过**，**人工真实浏览器验收 8/8 通过、可执行 E2E 9/9 通过**，仓库还随附**可执行的真实浏览器 E2E**（`npm run test:e2e`，8/8 项检查通过）。仓库：<https://github.com/minzzj/tenon>。

证据：[测试结果-20261025.md](docs/测试证据/测试结果-20261025.md) · [JSON](docs/测试证据/测试结果-20261025.json) · [证据截图 19 张](docs/测试证据/screenshots/)。

---

## 只回答三个问题

榫卯服务的是一个人、一个 3–20 人的小工作室，或有内网与合规要求的企业团队：

| 问题 | 你看到什么 |
|---|---|
| **这台机器能做什么？** | 设备卡：提供哪些能力、谁可以用、每条关系都有证据、授权何时到期 |
| **这件事办到哪一步？** | 一条时间线：草案、确认、排队、执行中、完成/失败、已回传，每一步都有证据 |
| **数据出了哪道门？** | 数据域标记 + 可导出的审计：哪台设备、哪个能力、哪个模型、哪条通道 |

相邻品类解决「能不能连」；榫卯解决连上之后的**谁批准、办到哪、数据去了哪**。协议解决连接，账本解决责任。

## 六项能力（v0.1.0 已全部落地）

| # | 能力 | 你会得到 |
|---|---|---|
| 1 | **自动发现** | 节点启动即出现在列表并标出能力；可补扫、可隐身、可只读接入；失败说明卡在哪一步 |
| 2 | **能力视图** | 谁提供、谁能用、最近三次调用、授权到期；每条关系可点开证据；无证据显示「未知」 |
| 3 | **任务代办** | 手机说一句 → 电脑出现五段草案；不可逆动作逐次确认；可取消、可重试 |
| 4 | **影响预览** | 断开设备/撤销授权前，列出会断的任务，分「确定/可能/未知」；取消后状态零变化 |
| 5 | **消息回传** | 只发摘要+链接，正文不出内网；限流→排队重试→换通道→标未送达，全程可见 |
| 6 | **部署与体检** | 一页看清阻断/警告/提示/无法判定；没有发现时列出检查范围；审计可导出 CSV/JSON/Markdown |

已交付的能力插件：节点侧 `image.crop`（纯 JS PNG 居中裁剪）、`file.hash`、`file.delete`、`printer.mock`；中枢侧 `channel.notify`、`llm.summarize`。

## 真实截图

> 全部来自 2026-10-25 的真实运行界面（1280×800），不是设计稿。

**总览**：三个问题各有一块入口；设备卡标出在线状态、能力、证据档位。

![总览](docs/images/01-总览.png)

**任务**：一句话生成五段草案（任务草案/用到的能力/目标设备/缺失项/风险等级），右侧时间线每一步都有证据。

![任务时间线](docs/images/02-任务时间线.png)

**影响预览**：断开设备前先看「确定 3 / 可能 1 / 未知 1」三级清单；点取消，业务状态零变化。

![断开影响预览](docs/images/03-断开影响预览.png)

**消息**：只发摘要 + 链接，通道明确标「模拟通道」；`/r/<taskId>` 链接需登录才能看正文。

![消息收件箱](docs/images/04-消息收件箱.png)

**体检**：一页看清阻断/警告/提示/无法判定；没有发现时列出检查范围；可导出 Markdown。

![上线体检](docs/images/05-上线体检.png)

**手机断网**：中枢不可达时显示本机缓存与「数据截至 HH:mm」，只读并提示恢复后可继续。

![断网手机缓存](docs/images/06-断网手机缓存.png)

## 快速开始（下列命令均实测可用）

需要 **Node.js >= 22**（实测 Node 24.15.0）。零运行时依赖，**不需要 `npm install`**。

获取代码：`git clone https://github.com/minzzj/tenon.git`，或从 [v0.1.0 Release](https://github.com/minzzj/tenon/releases/tag/v0.1.0) 下载源码 zip。

### Windows 一键

1. 进入仓库根目录，双击 `scripts/启动.cmd`。
2. 自动打开中枢窗口、节点窗口与浏览器 `http://127.0.0.1:7410`。
3. 首次启动生成 `data/secrets.json`，中枢窗口打印操作令牌；用它登录后才能做写操作。
4. 停止：`scripts/停止.cmd`，或关闭两个窗口。

### 手动启动（任意系统）

```bash
cd <仓库根>
node server/start.js          # 终端 1：中枢，默认 http://127.0.0.1:7410
node node-agent/agent.js      # 终端 2：节点，默认连 http://127.0.0.1:7410
# 浏览器打开 http://127.0.0.1:7410 ，用启动日志里的操作令牌登录
```

### 手机端（同一局域网）

```text
http://<电脑IP>:7410/m
```

- 只读浏览**无需登录**；写操作在页面输入操作令牌（启动日志或 `data/secrets.json` 的 `operatorToken`）。
- 中枢默认只监听 `127.0.0.1`；要让手机访问，需以 `TENON_HOST=0.0.0.0` 启动中枢，并在防火墙放行端口。

### 配置（环境变量）

| 变量 | 作用 | 默认 |
|---|---|---|
| `TENON_MODE` | 运行形态标记：`solo` / `team` / `enterprise`（写入启动事件/快照；团队与企业的审计保留策略属配置层，见假设清单） | `solo` |
| `TENON_HOST` | 监听地址（手机局域网访问需 `0.0.0.0`） | `127.0.0.1` |
| `TENON_PORT` | 端口 | `7410` |
| `TENON_DATA_DIR` | 数据目录 | `./data` |
| `DEEPSEEK_API_KEY` | 可选：真实 DeepSeek 接入；未设置则规则引擎降级 | 未设置 |

### 演示数据

```bash
# 重置演示数据：71 条事件 / 11 条任务 / 2 份体检 / 2 条消息 / 2 条审计导出
node scripts/seed-demo.js --fresh

# 重新生成示例图片（需要 Pillow：pip install pillow）
python scripts/gen-samples.py
```

## 架构（v0.1.0 已交付）

```text
[手机网页 /m]   [桌面网页 /]   [回执页 /r/<taskId>]
        \           |            /
             中枢 Hub（Node.js，server/start.js）
  追加式哈希链账本 · 启动重放索引 · 能力注册表 · 任务引擎
  影响预览 · 通道管理器 · 上线体检 · AI 提供方 · HTTP API + SSE
                   |
             节点 Agent（node-agent/agent.js）── 注册能力、心跳、拉任务、回报事件
                   |
  节点能力：image.crop · file.hash · file.delete · printer.mock
  中枢能力：channel.notify · llm.summarize
```

## 设计原则

- **本地优先**：全部跑在你自己的机器或局域网；没有厂商云在中间；公网中继：接口预留，当前版本未实现；默认零外联。
- **证据优先于猜测**：关系强度只有「确定/可能/未知」；没有证据的关系显示「未知」，绝不把猜的写成事实。
- **追加式账本**：事件带 seq 与哈希链，启动重放成索引——崩溃恢复、审计、导出、迁移读同一个事实来源。
- **零运行时依赖**：只用 Node.js 内置模块；前端原生 HTML/CSS/JS，无 CDN、无外链字体，断网功能不减。
- **插件边界**：AI 提供方、能力、回传通道都是接口；本轮交付实现 DeepSeek + 规则降级、节点能力插件与模拟通道，换真实通道不动核心。

## 测试与证据（2026-10-25 实测）

测试按用户的方式做：**真实 Chrome 点击、真实文件、真实强杀进程**，不用 API 调用冒充用户操作。所有数字都能在 [测试证据](docs/测试证据/测试结果-20261025.md) 里找到出处。

| 项目 | 实测结果 |
|---|---|
| 单元测试 | **146 条全部通过 / 0 失败**，8 个文件（`npm test`；ledger 16 / state 30 / ai 21 / tasks 23 / channels 10 / checkup 16 / png 14 / seed-demo 16） |
| 真实浏览器验收 | **8/8 条验收全部通过**（另含双实例只读、AI 真实接入 2 项附加验收），19 张证据截图 |
| 可执行真实浏览器 E2E | `npm run test:e2e`：**9/9 项自动检查通过**（自动种子隔离实例 + 真实 Chrome/CDP 真实点击/输入/截图；新增只读第二实例回归：所有写账本路径 423、账本不变），证据 `docs/测试证据/e2e-2026-10-25-11-13-07.json` + `e2e-screenshots/`；GitHub Actions `Real-browser E2E` workflow 也已跑通 |
| 断开被 3 条任务引用的设备 | **275 ms** 内 3 条任务全部降级为「待确认」（验收线 10 s） |
| 影响预览 | **确定 3 / 可能 1 / 未知 1**；取消后业务状态零变化 |
| 双实例 | 第二个实例只读，写操作返回 **423**「另一窗口为只读」 |
| 强杀重启 | **4 次 boot / 3 次 crashRecovery**，无重复执行，缺口 **61,293 ms** 已标记，seq 与哈希链连续 |
| 手机断网页 | 7 张设备卡 + 14 条任务历史 + 「数据截至 HH:mm（缓存）」 |
| AI 真实接入 | DeepSeek 真实 key：tokens 392/108；有缓存、预算与规则降级 |

常用命令：

```bash
npm test                          # 单元测试：146 条通过
node scripts/seed-demo.js --fresh # 重置演示数据
npm run test:e2e                  # 可执行真实浏览器 E2E：隔离实例 + 真实 Chrome/CDP，8/8 项通过
```

## 仓库结构

```text
server/       中枢：start.js + lib/{ledger,state,ai,tasks,channels,checkup,http}.js
node-agent/   节点：agent.js、capabilities.js、lib/png.js（纯 JS PNG 编解码）
public/       桌面控制台 index.html / app.js / style.css；手机页 m.html / m.js；登录页 login.html
plugins/      能力 / 通道 / AI 提供方接口占位
scripts/      启动.cmd、停止.cmd、install.sh、seed-demo.js、gen-samples.py
test/unit/    8 个单元测试文件（146 条）；test/e2e/run-real-browser.js（可执行真实浏览器 E2E）
docs/         使用手册、测试方法、测试证据、产品截图、样例输出、假设清单
示例空间/      演示用样品图、临时文件与裁剪输出
```

## 边界：v0.1.0 不吹的点

- **微信 / 邮件**：目前是**适配器接口 + 模拟通道**（界面明确标「模拟通道」）；真实通道需要 webhook / SMTP 凭据。
- **手机**：交付验证方式是**桌面 Chrome 的 `/m` 页面 + 独立浏览器截图**，没有用真机。
- **物理拔网线**：没有做；用「断网演练」开关真实切断外联来验证功能不减。
- **真实打印机**：`printer.mock` 只生成模拟打印单，不连真实设备。
- **macOS / Android 原生节点**：节点脚本同构，没有实机验证。
- **企业形态**：机器房高可用为配置层就绪，没有做真实机房验证。
- `file.delete` 会真删除文件，因此被列为不可逆能力，必须逐次确认。
- **许可证不是 OSI 开源许可**：CC BY-NC-SA 4.0 禁止商用，GitHub 侧栏显示 "Other"。

完整清单：[docs/假设与未覆盖清单.md](docs/假设与未覆盖清单.md)。

## 非目标

榫卯**不**实现 Matter/Thread 配网，**不**做云端自动化 SaaS，**不**做网盘或聊天，**不**做 GUI 点击机器人。它站在这些东西之上：给你已有的设备、软件和模型加一层「任务与责任」。


## V5 超级终端（v0.6.0，2026-10-30 晚）

**会记、会总结、会提醒、能连真实家居。** 在 V4 单程序基础上，V5 补上用户说的五件事：说出来的东西直接记下来、总结生成真正的文档、发到手机、能提醒、能配真实设备。

- **语音笔记**：说「记一下：…」→ 自动写成笔记；本地按天保存（`data/notes/YYYY-MM-DD.jsonl` + Markdown `data/notes/md/`），可搜索、编辑、删除、导出；账本 `note.*` 留痕。
- **真正的总结 + 文档中心**：说「总结今天」或在记录页点「AI 总结」→ DeepSeek 输出结构化 **摘要 / 重点 / 待办 / 回顾 / 日记**，生成 **Markdown / DOCX / PDF** 三种文档，可下载或分享（手机 App 也能下载并分享）；live 实测 `provider=deepseek`、**1149 字**、DOCX/PDF 文件 magic 校验通过。
- **提醒**：语音「提醒我 21:30 开会」「每天 8 点提醒我吃药」「1 分钟后提醒我喝水」，或在设置页创建；支持一次性与每天；到点写入账本 `reminder.fired`、网页 SSE 推送、电脑 TTS 播报、Windows 系统通知（node-agent `system.notify`）与手机 App 通知。
- **Android 0.6**：APK `public/download/tenon-android-0.6.0-debug.apk`（2,901,975 B；versionCode 6 / versionName 0.6.0；SHA-256 `BBA1B620…4A95F`）；5 页签（首页/记录/提醒/文档/设置）、笔记/提醒/文档同步、本地通知、文档下载 + 系统分享（FileProvider/ACTION_SEND）、IoT 设备控制。**未真机实测**，以构建 + lint + 静态校验为准。
- **真正的物联**：**Home Assistant REST**（大品牌设备经 HA 桥接）、**MQTT**（含 HA MQTT discovery）、**SSDP** 局域网发现；导入设备 → 统一设备列表 → 网页 / 语音 / 手机控制；账本 `iot.*`。
  - 诚实边界：本轮是**标准协议接入**，不直连厂商云（小米/华为/苹果/Aqara/涂鸦等需经 HA 或 MQTT 网关桥接）；SSDP 发现的设备仅能查看，是否可控取决于其 UPnP 实现；无真实家居设备时以本地桩验证（无真实设备实测）。
- **UI**：5 页签（首页 / 记录 / 提醒 / 文档 / 设置）+ 首页**今日看板**（下一个提醒 / 今日笔记 / 今日总结与下载 / 今日屏幕采集）。

### 雷鸟 AI 眼镜对照

| 雷鸟官方能力 | 榫卯 V5 | 状态 |
|---|---|---|
| 看板 | 首页今日看板 | ✅ 已做 |
| 实时字幕（含翻译） | 本地实时单行字幕；翻译下轮 | 🟡 已有字幕 |
| AI 录音总结（摘要/重点/待办/回顾） | 语音笔记 + 结构化总结（多「日记」）+ 文档导出 | ✅ 已做 |
| 提词器 | — | ⏳ 下轮 |
| 手机通知提醒 | 提醒中心（到点账本/SSE/TTS/系统通知/手机通知） | ✅ 已做 |
| 手机通知转发到其他屏幕 | — | ⏳ 下轮 |
| 全天智记 → AI 日记 | 24/7 本地转写 + 屏幕 OCR + 每晚总结日记 | ✅ 已做 |
| 与大模型对话 | 唤醒对话 + 执行器（可执行程序/命令/设备） | ✅ 已做 |
| 大品牌物联 | HA/MQTT/SSDP 标准协议（桥接） | ✅ 已做（桥接，不直连厂商云） |

完整对照见 [docs/雷鸟AI眼镜对照-V5.md](docs/雷鸟AI眼镜对照-V5.md)。

### 启动方式（沿用 V4）

双击桌面「榫卯超级终端」快捷方式、单文件便携版 `desktop/release/TenonSuperTerminal-0.6.0-portable.exe`（约 128 MB，已构建）或仓库根 `启动超级终端.cmd`；开发模式 `cd desktop && npm start`。旧完整控制台仍在 `http://127.0.0.1:7410/legacy`。V5 新数据目录：`data/notes/`、`data/reminders/`、`data/documents/`、`data/iot/`。

> 版本 0.6.0。独立 Checker 终验：**笔记 / 总结文档 / 提醒 / 物联 / UI / APK 全部 PASS**；回归 `npm test` **146/146**、v2 基线 9/9、v1 E2E 9/9、super UI 14/14（API 矩阵 352 PASS / 1 FAIL，1 个 P2：只读实例 IoT 发现会写账本，详见[交付物清单](docs/交付物清单.md) §12）；APK 未真机实测（⏳）。

## V4 超级终端（v0.5.0，2026-10-30）

**一个桌面程序就够了。** 「榫卯超级终端」是一个 Electron 桌面应用（托盘常驻，有单文件便携版），本地服务内嵌其中：说一句话，就能调动电脑上的程序、命令与家里的设备。

- **实时本地语音**：常开聆听，唤醒词「榫卯 / 小榫」；本地 **FunASR** 识别（live 实测 ASR `provider=funasr`、`state=listening`）。说完一句 → 自研 OpenClaw 式执行器（DeepSeek 规划）执行程序 / 命令 / 设备控制，结果回传继续判断（最多 3 轮），不可逆动作必须确认，每一步写入审计账本。live 实测：唤醒后「打开记事本 + 调音量」多动作真实执行成功（`provider=deepseek×2`，2.4s）。
- **屏幕文字理解（非大模型）**：本地 **Windows 系统字库 OCR**（`Windows.Media.Ocr`，zh-Hans-CN，非大模型、不联网）；自测 3/3 ≥90%，5 张真实截图平均 98.2%，单张 OCR 约 67–96ms（含抓图/上传链路约 186–239ms）；电脑每 60 秒检查一次、变化才抓，支持黑名单与暂停；文字只存本机 `data/voice/screen/`。
- **每天 23:00 内置总结**：汇总当天语音 + 屏幕文字 + 任务 → DeepSeek → 「今天做了什么 / 明天要做什么 / 日记」，Markdown 存 `data/voice/diary/YYYY-MM-DD.md`；可手动「现在总结」；live 实测 `provider=deepseek`、1383 字、三部分齐全。
- **手机 APK 0.5**：主页超级终端 + 4 页签；录音送电脑识别并执行；屏幕采集（MediaProjection）上报同一接口；设备一键绑定 / 移除。APK 位于 `public/download/tenon-android-0.5.0-debug.apk`（1,230,154 B；versionName 0.5.0 / versionCode 5；**未真机实测**，以构建 + lint + 静态校验为准）。
- **两行重复识别已修复**：手机 `/m/live` 修复前 6 行、同句重复 2 次 → 修复后仅 1 条最终字幕、0 JS 错误；桌面首页单行字幕 `#sub-final` 唯一（注入两条也只显示最新）。
- **隐私边界**：音频、屏幕文字、日记只存本机；只有唤醒后的命令文本与每日总结会发 DeepSeek（不配置 key 或断网时本地降级）。

### 启动方式

1. **双击单文件便携版** `desktop/release/TenonSuperTerminal-0.5.0-portable.exe`（约 120 MB；Lead 实测可启动）；
2. 双击桌面「榫卯超级终端」快捷方式；
3. 仓库根 `启动超级终端.cmd`（仓库内运行，需本机 Node.js >= 22）；
4. 开发模式：`cd desktop && npm start`。

旧版完整控制台保留在 `http://127.0.0.1:7410/legacy`。首次启动会自动拉起本地中枢（`127.0.0.1:7410`）与屏幕采集；关闭窗口收到托盘，托盘可暂停监听 / 暂停采集 / 现在生成今日总结 / 开机自启 / 退出。本地语音识别与屏幕 OCR 的 worker 依赖本机 Python 3 环境。

### 手机端

- APK：`public/download/tenon-android-0.5.0-debug.apk`；安装后与电脑同一 WiFi 自动发现，点「使用这台」一键绑定；令牌在 `data/secrets.json` 的 `operatorToken`。
- 完整操作步骤与常见问题见 [使用手册 V4](docs/使用手册-V4.md)。

> 回归：`npm test` **146/146**、v2 基线 9/9、v1 E2E 9/9、super UI 14/14；V4 独立验收（Checker 终验）**全部 PASS**（OCR 98.2% / 执行器真实多动作 2.69s / Electron 12/12 / APK 静态 12 PASS + 无真机 SKIP），证据与数字见[交付物清单](docs/交付物清单.md) §11。

- **可选执行智能体：本机 OpenClaw（小龙虾）Gateway** — 设置页可在「自研执行器 / OpenClaw」之间切换；OpenClaw 通过本机 Gateway（端口 18789）执行开放式任务并回传结果（实测 7.1s 返回「榫卯在线」）；不可用时自动回退自研执行器（`POST /api/v2/agent/openclaw`）。

## 宣传片（v2.1，60 秒）

[![榫卯 v2.1 宣传片海报](docs/images/v2-promo-poster.jpg)](https://github.com/minzzj/tenon/releases/tag/v0.3.0)

全部来自运行中的真实界面（2026-10-26 采集），包含手机遥控触控板真实移动电脑光标、手机拍照片一甩上电脑大屏的真实交互。文件：[带 BGM 版](https://github.com/minzzj/tenon/releases/tag/v0.3.0/tenon-v2.1-promo-60s-bgm.mp4) · [静音版](https://github.com/minzzj/tenon/releases/tag/v0.3.0/tenon-v2.1-promo-60s-silent.mp4) · [海报](https://github.com/minzzj/tenon/releases/tag/v0.3.0/tenon-v2.1-poster.jpg) · [分镜缩略图](https://github.com/minzzj/tenon/releases/tag/v0.3.0/tenon-v2.1-contact-sheet.jpg)。

## 路线图（v2.1）：消费级超级终端

**主线是消费级超级终端：面向家庭、个人与小团队使用，不是企业系统。** 一个小软件调动家里所有设备与所有程序：说一句（也可以语音），AI 把不同设备上的不同程序调起来；手机往前一倾，正在看的内容就滑上电脑大屏。

底座已就位：**v2-P0（互联 + 素材中心 + 场景）已实现并通过验收**——2026-10-25 14:11 隔离实例 9/9 项检查通过（证据 [v2-acceptance-2026-10-25-14-11-45.json](docs/测试证据/v2-acceptance-2026-10-25-14-11-45.json)）。消费级超级终端 P0（`#/super` 首页、语音 + AI 意图、设备/程序目录、流转 handoff、手机甩屏手势）已于 2026-10-25 晚**实现并本地验收**：真实浏览器 14/14 项通过、0 JS 错误，真实拉起电脑程序并完成一次「手机→电脑」流转（证据：[v2.1-超级终端-验收-20261025.md](docs/测试证据/v2.1-超级终端-验收-20261025.md)）。Android 真机安装仍待接入（无设备；APK 已构建并签名）。

- [产品愿景 v2.1：消费级超级终端](docs/产品愿景-v2.1-消费级超级终端.md)——三个核心体验、与鸿蒙超级终端/苹果接力/小米妙享对标、今晚 P0 范围、与原始愿景的对照。
- [产品定义 v2](docs/产品定义-v2.md)——v2-P0 规格（互联/素材/场景）+ v2.1 主线；企业版为可选插件。
- [使用手册 v2：互联与素材](docs/使用手册-v2-互联与素材.md)——`#/link`、`#/assets`、`#/basket`、`#/scenes`、`#/enterprise` 操作规格。

企业能力（角色/审批/审计保留期）以**可选插件形态**提供，不是主线。状态与证据在验收后才更新。

## 许可证

Copyright © 2026 minzzj · 榫卯 Tenon

[Creative Commons 署名—非商业性使用—相同方式共享 4.0 国际](LICENSE) —— 允许下载、运行、修改、**非商业**分享；分发修改版必须沿用同一许可证（或兼容许可证）。**不允许商用**，详见 [COMMERCIAL.md](COMMERCIAL.md) 与 [中文说明](COMMERCIAL.zh-CN.md)。

这不是 OSI 认可的开源许可证，GitHub 会显示 "Other"。以 [LICENSE](LICENSE) 中的英文法律文本为准；[LICENSE.zh-CN.md](LICENSE.zh-CN.md) 是官方简体中文译本，供参考。

## 文档

- [使用手册](docs/使用手册.md) · [测试方法](docs/测试方法.md) · [测试证据](docs/测试证据/测试结果-20261025.md) · [交付物清单](docs/交付物清单.md)
- [产品定义](docs/产品定义.md) · [假设与未覆盖清单](docs/假设与未覆盖清单.md) · [变更记录](CHANGELOG.md) · [文档索引](docs/README.md)