# 榫卯 Tenon · Android 原生 App（v2.1 消费级超级终端）

**包名** `com.minzzj.tenon` · **Kotlin** · minSdk 26 / targetSdk 34 · versionName `0.2.0`
**一句话**：一个小软件调动家里所有设备与程序——**手机往前一倾，页面自动滑到电脑**；**按住说话**，AI 拆成计划在电脑上执行。
本目录是 v2.1 消费级超级终端 Android 客户端（对应 task-23；v2 P0 基础能力对应 `_internal/契约-v2-P0.md` §5、`_internal/需求确认-v2-确认版.md`）。

## v0.2.0 新增（消费级超级终端）

1. **倾斜甩屏**（首页「流转」区）：`SensorManager` 加速度计 + 低通滤波求前倾角；检测到「前倾角 ≥ 灵敏度（默认 25°）且 1.2 秒内变化 ≥15°」→ 显示「正在甩到电脑…」→ `POST /api/v2/super/handoff {kind:'page',url:'tenon://android/page',text:'手机页面（手机前倾甩屏）'}`；2 秒冷却防抖；另提供显式「甩到电脑（手动）」按钮与「拉取流转状态」。
2. **语音指令**：`SpeechRecognizer`（zh-CN，`RECORD_AUDIO`）**按住说话 → 识别 → `POST /api/v2/super/ask {text}` → 展示 AI 回复与计划步骤**；无语音引擎/无权限/识别失败时自动降级到文字输入（文字框始终可用）。
3. **快捷程序面板**：打开微信 / 打开 Chrome / 打开记事本 / 放首歌 / 回家模式 五个一键指令（点击 = 发送一句 ask）。
4. **设置页新增**：中枢地址、配对状态（peerId / 令牌是否已填）、语音权限与语音引擎状态、倾斜甩屏灵敏度（低 20° / 中 25° / 高 30°）。
5. **从电脑端接收流转**：Android 侧可忽略（电脑节点 `handoff.show` 会把内容打开在浏览器 `#/handoff`）；App 可 `GET /api/v2/super/state` 拉取最近流转状态。

## 一、环境与工具链（本机已安装）

| 工具 | 版本 / 路径 |
|---|---|
| JDK | 17.0.20（`C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot`）；本机另有 jdk-21，构建已用 JDK17 |
| Android SDK | `C:\Android\Sdk`（commandline-tools 11076708 / cmdline-tools 12.0） |
| SDK 包 | platform-tools 37.0.1、platforms;android-34、build-tools;34.0.0 |
| Gradle | **8.7**（wrapper 已生成；distributionUrl 指向腾讯镜像 `mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip`，与官方 8.7-bin.zip SHA256 一致：`544c35d6…961d`） |
| Android Gradle Plugin | 8.5.2（`google()` 仓库） |
| Kotlin | 1.9.24 |
| 唯一第三方依赖 | `com.google.zxing:core:3.5.3`（本地二维码生成/解码，无相机第三方库、无 okhttp） |

> SDK 安装命令（供复现）：
> ```powershell
> $env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot'
> C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat --sdk_root=C:\Android\Sdk --licenses
> C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat --sdk_root=C:\Android\Sdk `
>   "platform-tools" "platforms;android-34" "build-tools;34.0.0"
> ```

## 二、构建

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot'
$env:ANDROID_HOME='C:\Android\Sdk'
$env:ANDROID_SDK_ROOT='C:\Android\Sdk'
cd H:\minzzj文件\技术部\项目\官方\榫卯\android
.\gradlew.bat --no-daemon assembleDebug
```

- 产物：`app/build/outputs/apk/debug/app-debug.apk`
- 首次构建会由 wrapper 下载 Gradle 8.7 发行版（镜像），再由 Gradle 拉取 AGP/Kotlin/zxing 依赖；之后走缓存。
- `local.properties` 已写 `sdk.dir=C:/Android/Sdk`（本机路径；换机器改这里或设 `ANDROID_HOME`）。
- 只读静态检查：`.\gradlew.bat --no-daemon lint`（可选）。

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