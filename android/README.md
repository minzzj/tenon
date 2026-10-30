# 榫卯 Tenon · Android 原生 App（v0.6 记录/提醒/文档/IoT）

**包名** `com.minzzj.tenon` · **Kotlin** · minSdk 26 / targetSdk 34 · **versionName 0.6.0（versionCode 6）**
**一句话**：手机上就能收到电脑生成的笔记与总结文档（下载/分享/打开）、到点本地通知提醒、并控制已接入的 IoT 设备（HA/MQTT 导入）。

## v0.6.0 本次更新（用户 10-30 晚：总结/文档发到手机、能提醒、配各种设备）

### 1) 底部 5 页签：首页 / 记录 / 提醒 / 文档 / 设置
风格延续 0.5 超级终端；首页 = 大麦克风语音（送电脑识别→执行→needConfirm 确认）+ 单行字幕 + 今日摘要；新增 4 个能力页。

### 2) 记录页（NotesActivity）
- `GET /api/v2/notes?q=&limit=` 列表（时间/标题/摘要/来源 语音或文字），搜索框，点开看详情（`GET /notes/:id`）；
- 删除（`DELETE /notes/:id`，二次确认）；「总结这段」→ `POST /api/v2/documents/generate {kind:'note-summary', noteId, date}`，弹窗展示**结构化结果**（摘要/重点/待办/回顾/日记，兼容多种字段名），可跳文档页下载。

### 3) 提醒页（RemindersActivity + ReminderNotifier + ReminderWorker）
- 新建（内容 + 时间 `yyyy-MM-dd HH:mm` + 一次性/每天）→ `POST /api/v2/reminders {text,at,recurrence}`；列表状态 待触发/已逾期/已完成；完成（`POST /reminders/:id/done`）、删除；
- **前台每 30 秒**轮询 `GET /api/v2/reminders/pending`，用 `NotificationManager` 弹本地通知（channel id `tenon-reminders`，名称「提醒」，IMPORTANCE_HIGH），去重（已通知 id 存本地），点击通知打开 App 并跳到提醒页；
- **后台兜底**：WorkManager `PeriodicWorkRequest` 每 15 分钟（Android 14 最小周期）拉 pending 并发通知；App 启动自动调度；
- Android 13+ 首次进入请求 `POST_NOTIFICATIONS` 权限，设置页可看状态/发测试通知。

### 4) 文档页（DocumentsActivity）
- `GET /api/v2/documents` 列表（标题/类型/时间/大小）；
- 「生成今日总结」→ `POST /api/v2/documents/generate {kind:'daily-summary', date}`；
- 每个文档可 **分享 MD / DOCX / PDF**（`GET /documents/:id/download?format=` 下载到 App 私有目录 `files/documents/` → **FileProvider**（authority `com.minzzj.tenon.fileprovider`）+ `ACTION_SEND` 分享到微信/QQ/邮件），也可「打开 MD」（系统查看器）或仅下载；设置页可清空本机已下载文档。

### 5) IoT 页（IotActivity）+ 设置
- `GET /api/v2/iot/status` 显示 HA/MQTT 状态；`GET /api/v2/iot/devices` 列出已接入设备（名称/类型/状态/adapter）；
- 每张卡「开 / 关 / 亮度+」→ `POST /api/v2/iot/devices/:id/control {command, params}`（灯用 turn_on/turn_off，开关用 on/off，亮度带 brightness_pct）；
- 设置页新增「07 IoT 与设备」（状态只读 + 打开 IoT/设备页）；HA/MQTT/SSDP 配置在电脑端 V5 设置页完成，手机只做状态与控制。

### 6) 设置页（全部集中，新增 3 区）
05 提醒与通知（提醒开关/请求通知权限/发测试通知/打开提醒页/30s+15min 机制说明）→ 06 笔记与文档（存储说明/打开记录页/打开文档页/清空本机下载）→ 07 IoT 与设备（状态/入口）→ 08 本机 → 09 设备与二级页 → 10 关于/隐私（含文档与通知隐私说明）。

## 本机构建结果（2026-10-30 实测，v0.6.0）

| 项 | 结果 |
|---|---|
| 构建 | `.\gradlew.bat --no-daemon assembleDebug` → **BUILD SUCCESSFUL in 35s**（37 tasks） |
| APK 分发包 | `public/download/tenon-android-0.6.0-debug.apk`（gitignored，仅分发） |
| 大小 | **2,901,975 B（2.77 MB）** |
| SHA-256 | `BBA1B620AC4C9A90C57932500A73F7EB1A02B21B74940544FB6276CA7CA4A95F` |
| 包信息（aapt2 badging） | `com.minzzj.tenon` · versionCode **6** · versionName **0.6.0** · minSdk 26 / targetSdk 34 / compileSdk 34 · launchable `MainActivity` |
| 权限清单 | INTERNET / ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE / CAMERA / RECORD_AUDIO / FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC / FOREGROUND_SERVICE_MEDIA_PROJECTION / **POST_NOTIFICATIONS** / WAKE_LOCK / **RECEIVE_BOOT_COMPLETED**（WorkManager）/ DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION（WorkManager） |
| 组件校验 | Manifest 含 `NotesActivity`、`RemindersActivity`、`DocumentsActivity`、`IotActivity`、`androidx.core.content.FileProvider`（authorities `com.minzzj.tenon.fileprovider`）、WorkManager 初始化组件与服务（aapt2 xmltree 实测） |
| lint | `lintDebug` → **0 errors / 94 warnings**（非阻断：中文硬编码 i18n、局域网明文 HTTP、未用资源、WebView JS 等） |
| 敏感信息扫描（解压 dex 实测） | **无 DeepSeek API key**（`sk-<20+位>` 匹配 0 个）、无 nodeToken；内置默认 `operatorToken` 与局域网 IP 为 `local.properties`(gitignore) 注入的体验默认值（正式对外分发需删除默认令牌重构建） |
| 后端契约 | 本机实测 `/api/v2/notes|reminders|reminders/pending|documents|iot/devices|iot/status` 当前均 404（后端并行实现中）——App 已按任务卡契约实现，未就绪时页面显示「电脑端接口未就绪（后端并行实现中），稍后刷新」，不假装成功；就绪后无需改 App |
| 真机 | **未实测**（无 adb 设备）：以构建成功 + lint + aapt/解压静态校验 + 接口契约为准；通知/分享/WorkManager 需在手机上实际体验 |

## 安装 / 权限 / 功能说明

1. 手机与电脑同一 WiFi；电脑端启动中枢（默认 7410），手机 APK 首次打开已内置中枢地址与体验令牌。
2. 安装 `public/download/tenon-android-0.6.0-debug.apk`（允许未知来源）。
3. 首次打开会请求通知权限（提醒需要）；也可在「设置 → 05 提醒与通知」补授权并发测试通知。
4. 记录页：语音说「记一下…」后出现在列表；点笔记可删除或「总结这段」（生成结构化总结，去文档页下载分享）。
5. 提醒页：新建提醒 → 到点本地通知（前台 30s 内、后台 15 分钟内）；点击通知打开 App。
6. 文档页：生成今日总结 → 分享 MD/DOCX/PDF 到微信/QQ/邮件或系统查看器打开；下载文件存 App 私有目录。
7. IoT：先在电脑端 V5 设置配置 Home Assistant / MQTT / SSDP 并导入设备，手机 IoT 页即可开/关/亮度控制。

## 构建复跑

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot'
$env:ANDROID_HOME='C:\Android\Sdk'
cd H:\minzzj文件\技术部\项目\官方\榫卯\android
.\gradlew.bat --no-daemon assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
.\gradlew.bat --no-daemon lintDebug      # 0 errors / 94 warnings
```

## 关键文件（v0.6.0 新增）

```text
android/app/src/main/java/com/minzzj/tenon/
├── NotesActivity.kt        # 记录页：笔记列表/搜索/详情/删除/总结这段（结构化结果）
├── RemindersActivity.kt    # 提醒页：创建/列表/完成/删除 + 前台 30s 轮询 pending
├── DocumentsActivity.kt    # 文档页：列表/生成今日总结/下载 MD-DOCX-PDF/FileProvider 分享/打开
├── IotActivity.kt          # IoT 页：状态 + 设备列表 + 开/关/亮度控制
├── ReminderNotifier.kt     # 通知频道「提醒」/ pending 去重/本地通知/点击打开 App
├── ReminderWorker.kt       # WorkManager 15 分钟兜底轮询
├── MainActivity.kt         # 5 页签 + 前台 30s 提醒轮询 + 通知权限
├── SettingsActivity.kt     # +05 提醒与通知 / 06 笔记与文档 / 07 IoT 与设备
├── net/TenonClient.kt      # +notes/reminders/documents/iot API + 文档二进制下载
├── net/TenonHttp.kt        # +getBin 二进制 GET
└── res/xml/file_paths.xml  # FileProvider 路径（files/documents、cache）
```

## 版本历史

- 0.6.0（2026-10-30）：5 页签 + 记录（笔记/总结）+ 提醒（本地通知/WorkManager）+ 文档（下载/分享/打开）+ IoT 控制；构建成功。
- 0.5.0（2026-10-30）：单程序超级终端（4 页签）+ 极简设备一键绑定 + 语音送电脑 + 屏幕采集上报 + needConfirm 确认闭环。
- 0.4.0（2026-10-26）：主页面极简超级终端 + 语音输入/执行 + 设置页集中。
- 0.2.0（2026-10-25）：倾斜甩屏 + 系统语音识别指令 + 快捷程序面板。
- 0.1.0（2026-10-25）：v2 P0 基础（发现/配对/传输/剪贴板/通知/素材 WebView/分享目标）。

---

## 以下为 0.5.0 历史构建记录（保留）

## 本机构建结果（2026-10-30 实测，v0.5.0）

| 项 | 结果 |
|---|---|
| 构建 | `.\gradlew.bat --no-daemon assembleDebug` → **BUILD SUCCESSFUL**（首次 36s，最终增量 19s） |
| APK 分发包 | `public/download/tenon-android-0.5.0-debug.apk`（gitignored，仅分发） |
| 大小 | **1,230,154 B（1.17 MB）** |
| SHA-256 | `F105D4EAD611924C694FC7285B348B9EE5EF384BEA55A98BEB1F6257D682E829` |
| 包信息（aapt2 badging） | `com.minzzj.tenon` · versionCode **5** · versionName **0.5.0** · minSdk 26 / targetSdk 34 / compileSdk 34 · launchable `MainActivity` |
| 权限清单 | INTERNET / ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE / CAMERA / RECORD_AUDIO / FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC / **FOREGROUND_SERVICE_MEDIA_PROJECTION** / POST_NOTIFICATIONS / WAKE_LOCK |
| 组件校验 | Manifest 含 `DevicesActivity`、`TodayActivity`、`ScreenCaptureService(foregroundServiceType=mediaProjection 0x20)`（aapt2 xmltree 实测） |
| lint | `lintDebug` → **0 errors / 78 warnings**（非阻断：中文硬编码 i18n、局域网明文 HTTP、未用资源、WebView JS 等） |
| 敏感信息扫描（解压 dex 实测） | **无 DeepSeek key、无 nodeToken、无 "sk-"**；内置默认 `operatorToken` 与局域网 IP 为 `local.properties`(gitignore) 注入的体验默认值，仅本机分发（正式对外分发需删除默认令牌重构建） |
| 默认中枢/令牌注入 | `local.properties` 的 `tenon.defaultHub` / `tenon.defaultToken` → `BuildConfig.DEFAULT_HUB/DEFAULT_TOKEN`；不写入仓库跟踪文件 |
| 真机 | **未实测**（无 adb 设备）：以构建成功 + lint + 静态校验为准；屏幕采集为系统授权 UI，需用户在手机上点「开始录制」 |

## 安装 / 权限 / 屏幕采集说明

1. 手机与电脑同一 WiFi；电脑端启动中枢（默认 7410）。
2. 安装 `public/download/tenon-android-0.5.0-debug.apk`（需允许未知来源）。
3. 首次打开默认已带中枢地址与体验令牌；顶部显示「中枢在线」即可按住/点击大麦克风说话（首次请求麦克风权限）。
4. 设备页：进页面即自动发现，点「使用这台」一键绑定；「高级」里保留旧扫码/配对码。
5. 屏幕内容采集：设置 → 「04 屏幕内容采集」→ 选间隔 →「授权并开启采集」→ 系统弹窗选「开始录制/共享屏幕」；通知栏常驻显示采集状态；「暂停采集」随时停止。需通知权限（Android 13+）。
6. 今日页：时间线（语音转写/屏幕/执行）+「现在总结」生成今日日报 + 前后日期切换。

## 构建复跑

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot'
$env:ANDROID_HOME='C:\Android\Sdk'
cd H:\minzzj文件\技术部\项目\官方\榫卯\android
.\gradlew.bat --no-daemon assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
.\gradlew.bat --no-daemon lintDebug      # 0 errors / 78 warnings
```

## 关键文件（v0.5.0）

```text
android/app/src/main/java/com/minzzj/tenon/
├── MainActivity.kt            # 主页超级终端（状态/大麦克风/单行字幕/结果+确认/今日摘要/4 页签）
├── DevicesActivity.kt         # 简化设备页（自动发现/使用这台/移除/每卡3动作/高级折叠）
├── TodayActivity.kt           # 今日时间线 + 现在总结 + 历史日期
├── SettingsActivity.kt        # 全部设置（中枢/令牌/语音管家/语音来源/屏幕采集/本机/入口/隐私）
├── service/ScreenCaptureService.kt  # MediaProjection 前台服务（截屏 JPEG → /voice/screen）
├── VoiceRecorder.kt           # 16kHz 单声道 WAV 录音
├── net/TenonClient.kt         # voice/status|config|transcribe|command|confirm|diary|screen + devices + 状态
├── net/TenonHttp.kt            # JSON + multipart（30s 超时）
├── App.kt                     # 配置/SharedPreferences（默认 hub/token 来自 BuildConfig；屏幕采集偏好）
└── WebPageActivity.kt         # 二级页 WebView（旧版互联/素材等）
```

## 版本历史

- 0.5.0（2026-10-30）：单程序超级终端（4 页签）+ 极简设备一键绑定 + 语音送电脑 + 屏幕采集上报 + needConfirm 确认闭环；构建成功。
- 0.4.0（2026-10-26）：主页面极简超级终端 + 语音输入/执行 + 设置页集中；构建成功。
- 0.2.0（2026-10-25）：倾斜甩屏 + 系统语音识别指令 + 快捷程序面板。
- 0.1.0（2026-10-25）：v2 P0 基础（发现/配对/传输/剪贴板/通知/素材 WebView/分享目标）。

---

## 以下为 0.4.0 历史构建记录（保留）

## 本机构建结果（2026-10-26 实测，v0.4.0）

| 项 | 结果 |
|---|---|
| 构建命令 | `.\gradlew.bat --no-daemon assembleDebug`（JDK17 + Android SDK 34） |
| 结果 | **BUILD SUCCESSFUL in 1m 35s**（37 tasks，18 executed） |
| APK | `app/build/outputs/apk/debug/app-debug.apk`，**1,181,173 B（1.13 MB）** |
| 分发包 | `public/download/tenon-android-0.4.0-debug.apk`（该目录 gitignored，仅供分发给用户） |
| SHA-256 | `31D7C3895DB0AC99049DA9D8076A27870BDFB4060AC4E948E1914C91791F05EC` |
| 包信息（aapt2） | `com.minzzj.tenon`，versionCode **4** / versionName **0.4.0**，minSdk 26 / targetSdk 34 / compileSdk 34，launchable Activity `MainActivity`，含 `RECORD_AUDIO` 权限 |
| 静态检查（lintDebug） | **0 errors / 58 warnings**（均为非阻断：中文硬编码 i18n、局域网明文 HTTP、未用资源、WebView JS、权限提示等） |
| 默认中枢/令牌注入 | 从 `local.properties`（已 gitignore）读取 `tenon.defaultHub` / `tenon.defaultToken` → BuildConfig；**不写入仓库跟踪文件**，APK 内置仅用于本机体验 |
| 语音接口契约自测 | 无令牌 → 401「需要登录令牌」；带令牌 multipart WAV → **200**，返回 `{"text":"嗯。","provider":"funasr-sensevoice","ms":317,...}`（真机录音链路字段/鉴权已验证） |
| 真机 | **未实测**：`adb devices` 无设备；以构建成功 + lint + 真实语音接口契约自测为准，用户自行安装 |

## 安装 / 第一次使用

1. 手机与电脑同一 WiFi；电脑端启动中枢（默认 7410）。
2. `adb install -r public/download/tenon-android-0.4.0-debug.apk`（或直接把 APK 发到手机安装；首次安装需允许「未知来源」）。
3. 打开 App：默认已内置中枢地址与体验令牌（本机 APK），顶部显示「中枢在线」即可说话；若显示离线 → 设置 → 01 中枢连接 改成电脑局域网 IP:7410，并可粘贴 `data/secrets.json` 的 operatorToken。
4. 按住中央大按钮说话（首次会申请麦克风权限），松手后自动：本地转写 → 云端理解 → 执行 → 显示回复与步骤；电脑端 TTS 会播报（可在设置关闭）。
5. 所有设置都在「设置」页：中枢/令牌、唤醒词、24/7 记录、TTS、每晚总结时间、保留天数、设备绑定/一键安装入口、清空本机记录、关于/隐私。

## 构建复跑

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot'
$env:ANDROID_HOME='C:\Android\Sdk'
cd H:\minzzj文件\技术部\项目\官方\榫卯\android
.\gradlew.bat --no-daemon assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
.\gradlew.bat --no-daemon lintDebug        # 0 errors / 58 warnings
```

> `local.properties`（gitignore）需包含 `sdk.dir`、`tenon.defaultHub`、`tenon.defaultToken` 才能在首次安装时直接连上本机 hub；缺省时 App 内填即可。

## 目录结构（v0.4.0 关键文件）

```text
android/app/src/main/java/com/minzzj/tenon/
├── MainActivity.kt           # 极简超级终端主页（连接状态/大语音按钮/回复/今日摘要/三入口）
├── SettingsActivity.kt       # 全部设置集中（中枢/令牌/唤醒词/24-7/TTS/总结时间/保留天数/入口/隐私）
├── VoiceRecorder.kt          # 16kHz 单声道 WAV 录音
├── WebPageActivity.kt        # 二级页 WebView（设备绑定/遥控/素材）
├── App.kt                    # 配置与 SharedPreferences（默认 hub/token 来自 BuildConfig）
├── net/TenonClient.kt        # voice/status|config|transcribe|command|transcripts + hub 状态
├── net/TenonHttp.kt          # JSON + multipart 上传（30s 超时）
├── ScanActivity / ShareActivity / AssetsActivity / ClipboardSyncService / TenonNotificationListener 等（0.2.0 能力保留）
└── ...
```

## 版本历史

- 0.4.0（2026-10-26）：主页面极简超级终端 + 语音输入/执行 + 设置页集中；构建成功。
- 0.2.0（2026-10-25）：倾斜甩屏 + 语音指令（系统 SpeechRecognizer）+ 快捷程序面板。
- 0.1.0（2026-10-25）：v2 P0 基础（发现/配对/传输/剪贴板/通知/素材 WebView/分享目标）。

---

## 以下为 0.2.0 历史构建记录（保留）

## 本机构建结果（2026-10-25 实测）

| 项 | 结果 |
|---|---|
| 构建命令 | `.\gradlew.bat --no-daemon assembleDebug`（JDK17 + Android SDK 34） |
| 结果 | **BUILD SUCCESSFUL**（v0.2.0 首次全量 38s；最终产物增量重建 15s；v0.1.0 首建 44s） |
| APK | `app/build/outputs/apk/debug/app-debug.apk`，**1,232,442 B（1.18 MB）** |
| APK 副本 | `dist/tenon-android-0.2.0-debug.apk`（同文件，便于交付） |
| SHA-256 | `439E616D44800EE0FF279F3C3D391226E3747E8DC9A8613EAE26A9359AA7F67B` |
| 包信息（aapt2 badging） | `com.minzzj.tenon`，versionCode 2 / versionName 0.2.0，minSdk 26 / targetSdk 34 / compileSdk 34，launchable-activity `com.minzzj.tenon.MainActivity` |
| 签名 | debug 签名（apksigner verify 通过；debug cert `CN=Android Debug`） |
| 静态检查（lintDebug） | **0 errors, 46 warnings**（均为非阻断：中文硬编码文案 i18n、局域网明文 HTTP、未用资源、扫码页固定竖屏、WebView JS、语音/传感器权限提示等，P0 可接受） |
| 真机/模拟器实测 | **未实测**：`adb devices` 无设备；本机 Windows 未启用 Hyper-V/WHPX，Android 模拟器无硬件加速不可用（见 `_internal/v2-android.md` §5） |

> 构建注意：①工程在含中文的 H: 路径下，`gradle.properties` 已加 `android.overridePathCheck=true`（AGP 非 ASCII 路径误报）；②wrapper 的 `distributionUrl` 指向腾讯镜像（与官方 gradle-8.7-bin.zip 同 SHA256 `544c35d6…961d`），因本机直连 services.gradle.org 会卡住；③`local.properties` 写死本机 `sdk.dir`，换机器请改。

## 三、安装与第一次使用

1. 手机开「开发者选项 → USB 调试」，USB 连接电脑后：
   ```powershell
   C:\Android\Sdk\platform-tools\adb.exe devices          # 应看到设备
   C:\Android\Sdk\platform-tools\adb.exe install -r app\build\outputs\apk\debug\app-debug.apk
   ```
   无线调试也可：`adb pair <IP:PORT>` 后 `adb connect <IP:PORT>`。
2. 手机与电脑接**同一 WiFi**，电脑端启动榫卯中枢（默认 7410）。
3. 打开「榫卯 Tenon」App：
   - 在 **01 中枢连接** 填电脑局域网 IP:7410（如 `192.168.1.10:7410`），点「保存并测试」；
   - 写操作需要令牌：把电脑端 `data/secrets.json` 的 `operatorToken` 填到「访问令牌」（或由配对流程返回）；
   - 兜底：没有 UDP 发现也可直接手输 IP。
4. 配对：电脑端 v2「互联」页（`#/link`）显示 6 位配对码/二维码；
   - App「03 配对」→ 输入 6 位码点「用配对码配对」；或点「扫码配对」扫电脑上的二维码（内容 `tenon://pair?host=IP:PORT&code=XXXX`）。
5. 文件互传：选文件 →「上传到电脑」（分块 PUT + SHA-256 校验）；下载输入服务端返回的 transferId →「下载接收」。
6. 剪贴板：打开「05 剪贴板同步」开关（启动前台服务，常驻通知）；也可「立即上报当前剪贴板 / 拉取远端最新」。
7. 通知镜像：点「打开通知监听设置」→ 给「榫卯通知镜像」授予通知使用权。
8. 素材库：主界面「浏览素材库」打开 Web 端 `#/assets`（WebView，自动注入令牌到 localStorage）。
9. 分享目标：相册/文件管理器里选文件 → 分享 →「榫卯 Tenon」→ 优先上传素材库，失败自动降级为文件传输。

## 四、权限说明

| 权限 | 用途 | 何时申请 |
|---|---|---|
| `INTERNET` / `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | 同一 WiFi 直连中枢（HTTP）+ UDP 发现 | 安装即授予 |
| `CAMERA` | 扫码配对（zxing 本地解码） | 首次点「扫码配对」时 |
| `POST_NOTIFICATIONS` | 前台服务常驻通知、剪贴板/配对提示 | Android 13+ 首次启动 |
| `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC` | 剪贴板同步前台服务保活 | 安装即授予 |
| 通知使用权（`BIND_NOTIFICATION_LISTENER_SERVICE`） | 通知镜像（读 title/app） | 用户去系统设置手动开启 |

隐私与边界：默认只连**局域网明文 HTTP**（同一 WiFi 私有部署，不出公网）；通知镜像只上传 app 名/标题/摘要，不上传通知图片与操作按钮；剪贴板内容仅在中枢与已配对设备间同步。

## 五、功能与契约对应（P0）

| 需求 | 实现 | 契约端点 |
|---|---|---|
| 局域网 UDP 发现（7413） | `net/Discovery.kt`：监听 `tenon-hello` 广播 + 每 2.5s 广播自身；手输 IP 兜底 | 契约 §5 |
| 扫码/配对码配对 | `ScanActivity`（Camera1 + zxing-core）、主界面 03 区输入 6 位码 | `POST /api/v2/link/pair` |
| 文件分块上传 | `net/TenonClient.uploadFile`：init → 1MB 分块 `PUT ?offset=` → finish(sha256) | `POST /link/transfer/init`、`PUT /link/transfer/:id/chunk`、`POST /link/transfer/:id/finish` |
| 下载接收 | `downloadTransfer`：先 `GET .../download?index=0`，退化 `GET .../chunk?offset=0`（见「已知限制」） | 契约 §4 未定义下载端点 |
| 剪贴板同步（前台服务） | `service/ClipboardSyncService.kt`：3s 轮询远端 + 本机剪贴板监听上报 | `POST/GET /api/v2/link/clipboard` |
| 通知监听 | `service/TenonNotificationListener.kt`：NotificationListenerService → 上报 app/title/text | `POST /api/v2/link/notify`（契约缺口，见下） |
| 素材库浏览 | `AssetsActivity`：WebView 打开 `#/assets`，注入令牌 | Web 端 v2 页面 |
| 分享目标 | `ShareActivity`：`ACTION_SEND`/`SEND_MULTIPLE` → multipart 上传，失败降级分块传输 | `POST /api/v2/assets/ingest`（multipart） |
| 设置页 | `SettingsActivity`：中枢地址 / 令牌 / 设备名 / 权限状态 / 限制说明 | — |

## 六、已知限制与剩余风险（P0 诚实标注）

1. **v2 服务端接口并行开发中**：`/api/v2/link/*`、`/api/v2/assets/*` 由 link-core / assets-core 模块提供、Lead 集成到 `http.js`。App 已按契约实现，接口未就绪时会显示明确失败原因（不崩溃），联调需服务端先合入。
2. **通知镜像端点缺口**：契约 §4 未列通知上传端点，App 按 §5 需求使用 `POST /api/v2/link/notify`；需服务端补该路由（或改走其它事件通道），否则通知镜像会提示失败。
3. **下载接收端点缺口**：契约 §4 只定义上传分块 `PUT .../chunk?offset=`，未定义下载；App 用 `GET .../download?index=0` → `GET .../chunk?offset=0` 双兜底，若服务端均未实现则明确报错。
4. **Android 10+ 剪贴板后台读取限制**：前台服务不再拥有后台读剪贴板权限，稳定同步需 App 可见或由电脑端主动推送（已在前台服务中 try/catch 并记录日志）。
5. **真机未实测**：本机构建环境 `adb devices` 无设备；且本机 Windows 未启用 Hyper-V/WHPX，Android 模拟器无硬件加速不可用 → 本轮只完成**编译验证 + APK 产出 + 静态检查**，未做真机安装/交互实测（步骤见上，接真机后即可验证）。
6. **peerId 约定**：配对成功优先取响应里的 `peerId`（其次 `deviceId`），都没有时默认 `hub`；需服务端按契约返回。
7. 明文 HTTP 仅限局域网私有部署；不要暴露到公网（与企业版「出域审批/数据域」配套）。

## 七、目录结构

```text
android/
├── README.md
├── build.gradle / settings.gradle / gradle.properties / local.properties
├── gradlew / gradlew.bat / gradle/wrapper/*
└── app/
    ├── build.gradle / proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── res/                 # 深色主题、字符串、图标、network_security_config
        └── java/com/minzzj/tenon/
            ├── App.kt           # 配置：中枢地址/令牌/设备身份
            ├── LogBus.kt        # 内存日志（真机排障）
            ├── Ui.kt            # 程序化深色 UI 组件
            ├── MainActivity.kt  # 主界面（发现/配对/传输/剪贴板/通知/素材/日志）
            ├── ScanActivity.kt  # 相机扫码（Camera1 + zxing-core）
            ├── SettingsActivity.kt
            ├── AssetsActivity.kt    # 素材库 WebView
            ├── ShareActivity.kt     # 分享目标
            ├── net/
            │   ├── Peer.kt / TenonHttp.kt / TenonClient.kt / Discovery.kt
            └── service/
                ├── ClipboardSyncService.kt
                └── TenonNotificationListener.kt
```

## 八、版本

- 0.1.0（2026-10-25）：v2 P0 首版 Android 原生端；UDP 发现 / 扫码与配对码 / 分块上传与下载接收 / 剪贴板同步前台服务 / 通知镜像 / 素材库 WebView / 分享目标 / 设置页；`./gradlew assembleDebug` 产出 debug APK。
- **0.2.0（2026-10-25，消费级超级终端）**：倾斜甩屏（加速度计 + 低通滤波 + 1 秒窗口 + 防抖）→ `POST /api/v2/super/handoff`；语音指令（SpeechRecognizer zh-CN）→ `POST /api/v2/super/ask` + AI 回复展示；快捷程序面板（微信/Chrome/记事本/放歌/回家模式）；设置页新增语音权限/引擎状态与倾斜灵敏度。新增权限 `RECORD_AUDIO`。