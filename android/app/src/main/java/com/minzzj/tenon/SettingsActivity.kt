package com.minzzj.tenon

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import com.minzzj.tenon.service.AmbientRecordService
import com.minzzj.tenon.service.OverlayService
import com.minzzj.tenon.service.ScreenCaptureService
import com.minzzj.tenon.voice.OneTapVoice
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * v0.4 设置页：所有设置集中在这里。
 * - 中枢连接（地址 / 操作令牌 / 测试）
 * - 语音管家（写入中枢：唤醒词、24/7 记录、TTS、每晚总结、保留天数）
 * - 本机（手机朗读、麦克风说明、清空本机记录）
 * - 二级页入口（设备绑定/一键安装、素材、遥控、旧版互联）
 * - 关于 / 隐私 / 恢复默认
 */
class SettingsActivity : Activity() {
    companion object {
        private const val REQ_SCREEN_CAPTURE = 3001
        private const val REQ_NOTIF_SCREEN = 3002
        private const val REQ_OVERLAY = 3003
        private const val REQ_AUDIO_AMBIENT = 3004
    }

    private lateinit var hubInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView
    private lateinit var configText: TextView

    private lateinit var alwaysRecordSwitch: Switch
    private lateinit var wakeEnableSwitch: Switch
    private lateinit var wakeWordsInput: EditText
    private lateinit var ttsSwitch: Switch
    private lateinit var diaryTimeInput: EditText
    private lateinit var retentionInput: EditText
    private lateinit var micText: TextView

    private lateinit var ttsLocalSwitch: Switch
    private lateinit var aboutText: TextView

    // V0.5 屏幕内容采集
    private lateinit var screenSwitch: Switch
    private lateinit var screenStatus: TextView
    private lateinit var screenBlacklistInput: EditText

    // 0.6.8 悬浮窗 / 手机 24h 录制
    private lateinit var overlaySwitch: Switch
    private lateinit var overlayStatus: TextView
    private lateinit var ambientSwitch: Switch
    private lateinit var ambientStatus: TextView
    private var suppressSwitch = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)

        // 顶部
        val top = Ui.row(this)
        top.addView(Ui.pageHead(this, "设置", "中枢 · 语音 · 一键更新"))
        top.addView(Ui.action(this, "刷新") { refreshFromHub() })
        top.addView(Ui.action(this, "首页") { TabNav.goHome(this) })
        root.addView(top)

        // ---------- 1. 中枢连接 ----------
        val sHub = Ui.section(this, "01 · 中枢连接")
        hubInput = Ui.input(this, "中枢地址，如 http://192.168.3.123:7410")
        tokenInput = Ui.input(this, "操作令牌 operatorToken（写操作需要）")
        tokenInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        sHub.addView(hubInput)
        sHub.addView(tokenInput)
        val rowHub = Ui.row(this)
        rowHub.addView(Ui.button(this, "保存并测试", true) { saveConnection() })
        rowHub.addView(Ui.button(this, "重新读取") { refreshFromHub() })
        val rowPreset = Ui.row(this)
        rowPreset.addView(Ui.button(this, "局域网地址") { hubInput.setText("http://192.168.3.123:7410") })
        rowPreset.addView(Ui.button(this, "公网地址") { hubInput.setText("http://103.40.14.91:36996") })
        sHub.addView(rowPreset)
        sHub.addView(rowHub)
        statusText = Ui.body(this, "尚未测试")
        statusText.textSize = 13f
        sHub.addView(statusText)
        sHub.addView(Ui.hint(this, "APK 不内置操作令牌：首次连接请填写电脑端 data/secrets.json 里的 operatorToken。新版服务端 GET 也需要令牌。"))
        root.addView(sHub)

        // ---------- 2. 语音管家（写入中枢） ----------
        val sVoice = Ui.section(this, "02 · 语音管家（电脑端配置）")
        sVoice.addView(Ui.hint(this,
            "识别在电脑本地完成（funasr），理解由云端 DeepSeek 完成；手机只上传录音到你的中枢，不经过第三方。"))
        alwaysRecordSwitch = Ui.switchRow(this, "常驻语音监听（24/7 记录）", false) { on -> onAlwaysRecordChanged(on) }
        sVoice.addView(alwaysRecordSwitch)
        wakeEnableSwitch = Ui.switchRow(this, "唤醒词唤醒", App.wakeEnabledLocal()) { on ->
            App.setWakeEnabledLocal(on)
        }
        sVoice.addView(wakeEnableSwitch)
        wakeWordsInput = Ui.input(this, "唤醒词 / 别名（逗号分隔，如 榫卯,小榫）")
        sVoice.addView(wakeWordsInput)
        ttsSwitch = Ui.switchRow(this, "电脑端 TTS 播报（语音管家回复时朗读）", true) { _ -> }
        sVoice.addView(ttsSwitch)
        diaryTimeInput = Ui.input(this, "每晚总结时间（HH:mm，如 23:00）")
        sVoice.addView(diaryTimeInput)
        retentionInput = Ui.input(this, "语音记录保留天数（默认 30）")
        retentionInput.inputType = InputType.TYPE_CLASS_NUMBER
        sVoice.addView(retentionInput)
        micText = Ui.hint(this, "麦克风设备：读取中…")
        sVoice.addView(micText)
        val rowVoice = Ui.row(this)
        rowVoice.addView(Ui.button(this, "保存到中枢", true) { saveVoiceConfig() })
        rowVoice.addView(Ui.button(this, "读取中枢配置") { refreshFromHub() })
        sVoice.addView(rowVoice)
        configText = Ui.hint(this, "")
        sVoice.addView(configText)
        root.addView(sVoice)

        // ---------- 03 语音来源 ----------
        val sSource = Ui.section(this, "03 · 语音来源")
        sSource.addView(Ui.hint(this,
            "默认把录音送到电脑识别（本地 FunASR，低占用、隐私不出局域网）；云端理解由电脑端 DeepSeek 完成。" +
            "手机离线识别为 P1，暂未提供，不假装可用。"))
        sSource.addView(Ui.hint(this, "当前：送电脑识别（/api/v2/voice/transcribe）· 手机不做本地 ASR"))
        root.addView(sSource)

        // ---------- 04 屏幕内容采集 ----------
        val sScreen = Ui.section(this, "04 · 屏幕内容采集（手机截屏上报）")
        screenSwitch = Ui.switchRow(this, "开启屏幕内容采集", App.screenEnabled()) { on -> onScreenToggle(on) }
        sScreen.addView(screenSwitch)
        screenStatus = Ui.body(this, "")
        screenStatus.textSize = 13f
        sScreen.addView(screenStatus)
        sScreen.addView(Ui.hint(this,
            "每间隔截屏一次（缩放到 ≤960px、JPEG 压缩）上报中枢 /api/v2/voice/screen，由电脑端识别屏幕文字并纳入每日总结。" +
            "首次需在系统弹窗授权「共享屏幕」；可随时暂停。"))
        val rowInt = Ui.row(this)
        rowInt.addView(Ui.button(this, "60 秒") { setScreenInterval(60) })
        rowInt.addView(Ui.button(this, "120 秒（默认）") { setScreenInterval(120) })
        rowInt.addView(Ui.button(this, "300 秒") { setScreenInterval(300) })
        sScreen.addView(rowInt)
        screenBlacklistInput = Ui.input(this, "黑名单应用（逗号分隔，如 银行,微信；供电脑端过滤敏感屏幕）")
        sScreen.addView(screenBlacklistInput)
        val rowScreen = Ui.row(this)
        rowScreen.addView(Ui.button(this, "授权并开启采集", true) { requestScreenCapture() })
        rowScreen.addView(Ui.button(this, "暂停采集") { stopScreenCapture() })
        sScreen.addView(rowScreen)
        root.addView(sScreen)

        // ---------- 05 提醒与通知 ----------
        val sNotify = Ui.section(this, "05 · 提醒与通知")
        sNotify.addView(Ui.switchRow(this, "提醒通知（到点手机弹通知）", App.remindersEnabled()) { on ->
            App.setRemindersEnabled(on)
            if (on) {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF_SCREEN)
                } else {
                    Toast.makeText(this, "提醒通知已开启", Toast.LENGTH_SHORT).show()
                }
            }
        })
        val rowNotify = Ui.row(this)
        rowNotify.addView(Ui.button(this, "请求通知权限", true) {
            if (Build.VERSION.SDK_INT >= 33) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF_SCREEN)
            } else {
                Toast.makeText(this, "当前系统无需单独通知权限", Toast.LENGTH_SHORT).show()
            }
        })
        rowNotify.addView(Ui.button(this, "发一条测试通知") {
            if (!ReminderNotifier.canPost(this)) {
                Toast.makeText(this, "先授予通知权限", Toast.LENGTH_SHORT).show()
            } else {
                ReminderNotifier.notify(this, "test", "测试通知：到点提醒会像这样弹出", "现在")
                Toast.makeText(this, "已发送测试通知", Toast.LENGTH_SHORT).show()
            }
        })
        rowNotify.addView(Ui.button(this, "打开提醒页") { startActivity(Intent(this, RemindersActivity::class.java)) })
        sNotify.addView(rowNotify)
        sNotify.addView(Ui.hint(this,
            "前台：App 打开时每 30 秒检查一次 /api/v2/reminders/pending 并弹本地通知；后台：WorkManager 每 15 分钟兜底（Android 14 最小周期）。" +
            "通知频道「提醒」，点击通知打开 App。"))
        root.addView(sNotify)

        // ---------- 06 笔记与文档 ----------
        val sDocs = Ui.section(this, "06 · 笔记与文档")
        sDocs.addView(Ui.hint(this,
            "笔记在电脑端 data/notes 生成并可同步到手机（记录页可搜索/查看/删除）；文档（AI 总结/日报）从电脑端生成，" +
            "下载后保存在本机 App 私有目录（files/documents），可用 FileProvider 分享到微信/QQ/邮件或用系统查看器打开。"))
        val rowDocs = Ui.row(this)
        rowDocs.addView(Ui.button(this, "打开记录页", true) { TabNav.go(this, TabNav.RECORDS) })
        rowDocs.addView(Ui.button(this, "打开文档页") { TabNav.go(this, TabNav.DOCUMENTS) })
        sDocs.addView(rowDocs)
        val rowDocs2 = Ui.row(this)
        rowDocs2.addView(Ui.button(this, "清空本机已下载文档") {
            App.clearDocuments()
            Toast.makeText(this, "已清空本机下载文档（电脑端不受影响）", Toast.LENGTH_SHORT).show()
        })
        sDocs.addView(rowDocs2)
        root.addView(sDocs)

        // ---------- 07 IoT 与设备 ----------
        val sIot = Ui.section(this, "07 · IoT 与设备")
        val iotStatusText = Ui.hint(this, "IoT 状态：读取中…")
        sIot.addView(iotStatusText)
        val rowIot = Ui.row(this)
        rowIot.addView(Ui.button(this, "打开 IoT 设备页", true) { startActivity(Intent(this, IotActivity::class.java)) })
        rowIot.addView(Ui.button(this, "打开设备页") { startActivity(Intent(this, DevicesActivity::class.java)) })
        sIot.addView(rowIot)
        sIot.addView(Ui.hint(this, "Home Assistant / MQTT / SSDP 接入配置在电脑端 V5 设置页完成；手机侧只读状态并控制已导入设备（开/关/亮度）。"))
        root.addView(sIot)
        refreshIotStatus(iotStatusText)

        // ---------- 3. 本机设置 ----------
        val sLocal = Ui.section(this, "08 · 本机设置")
        ttsLocalSwitch = Ui.switchRow(this, "手机朗读回复（本机 TTS）", App.ttsLocalEnabled()) { on ->
            App.setTtsLocalEnabled(on)
        }
        sLocal.addView(ttsLocalSwitch)
        sLocal.addView(Ui.hint(this,
            "麦克风：手机使用系统麦克风（首次录音时授权 RECORD_AUDIO）。电脑端麦克风设备在 data/voice/config.json 的 micDevice 配置，本页只读展示。"))
        val rowClear = Ui.row(this)
        rowClear.addView(Ui.button(this, "清空本机记录", true) { clearLocal() })
        rowClear.addView(Ui.button(this, "恢复默认设置") { resetAll() })
        sLocal.addView(rowClear)
        root.addView(sLocal)

        // ---------- 09 悬浮窗 ----------
        val sOverlay = Ui.section(this, "09 · 悬浮窗（一键唤醒 / 24h 开关）")
        sOverlay.addView(Ui.hint(this,
            "悬浮球可拖动：单击=一键唤醒（立即录音说一句），长按=开启/关闭 24 小时录制。" +
            "退出 App 后仍可用（前台服务保活，常驻通知里可关闭）。"))
        overlaySwitch = Ui.switchRow(this, "显示悬浮窗", OverlayService.running) { on ->
            if (suppressSwitch) return@switchRow
            if (on) {
                if (Settings.canDrawOverlays(this)) startOverlay()
                else {
                    overlaySwitch.isChecked = false
                    requestOverlayPermission()
                }
            } else {
                OverlayService.stop(this)
                App.setOverlayEnabled(false)
            }
            overlayStatus.postDelayed({ refreshOverlayStatus() }, 600)
        }
        sOverlay.addView(overlaySwitch)
        val rowOverlay = Ui.row(this)
        rowOverlay.addView(Ui.button(this, "显示悬浮窗", true) {
            if (Settings.canDrawOverlays(this)) startOverlay() else requestOverlayPermission()
        })
        rowOverlay.addView(Ui.button(this, "关闭悬浮窗") {
            OverlayService.stop(this)
            overlayStatus.postDelayed({ refreshOverlayStatus() }, 400)
        })
        sOverlay.addView(rowOverlay)
        val rowOverlay2 = Ui.row(this)
        rowOverlay2.addView(Ui.button(this, "授予悬浮窗权限 / 打开系统设置") { requestOverlayPermission() })
        sOverlay.addView(rowOverlay2)
        overlayStatus = Ui.body(this, "")
        overlayStatus.textSize = 13f
        sOverlay.addView(overlayStatus)
        root.addView(sOverlay)

        // ---------- 10 24 小时录制（手机本机） ----------
        val sAmbient = Ui.section(this, "10 · 24 小时录制（手机本机）")
        sAmbient.addView(Ui.hint(this,
            "开启后手机在后台持续录音，分段 WAV 逐段上传到你自己电脑的 " +
            "/api/v2/voice/ambient-upload（multipart file + x-tenon-token），服务端以 source=ambient 入库，" +
            "在「记录 → 全天录音」可见。只上传电脑本机、不上传第三方；耗电与发热会增加，" +
            "常驻通知和本页都能随时停止。"))
        ambientSwitch = Ui.switchRow(this, "开启 24 小时录制（手机后台录音）", AmbientRecordService.running) { on ->
            if (suppressSwitch) return@switchRow
            if (on) startAmbientRecording() else {
                AmbientRecordService.stop(this)
                ambientStatus.postDelayed({ refreshAmbientStatus() }, 600)
            }
        }
        sAmbient.addView(ambientSwitch)
        val rowAmbient = Ui.row(this)
        rowAmbient.addView(Ui.button(this, "开启 24h 录制", true) { startAmbientRecording() })
        rowAmbient.addView(Ui.button(this, "停止 24h 录制") {
            AmbientRecordService.stop(this)
            ambientStatus.postDelayed({ refreshAmbientStatus() }, 600)
        })
        sAmbient.addView(rowAmbient)
        ambientStatus = Ui.body(this, "")
        ambientStatus.textSize = 13f
        sAmbient.addView(ambientStatus)
        val rowChunkSec = Ui.row(this)
        for (sec in intArrayOf(8, 12, 20, 30)) {
            rowChunkSec.addView(Ui.button(this, sec.toString() + " 秒/段") {
                App.setAmbientChunkSec(sec)
                Toast.makeText(this, "已设为 " + sec + " 秒/段（下次分段生效）", Toast.LENGTH_SHORT).show()
                refreshAmbientStatus()
            })
        }
        sAmbient.addView(rowChunkSec)
        sAmbient.addView(Ui.switchRow(this, "仅 WiFi 上传（移动网络时跳过上传）", App.ambientWifiOnly()) { on ->
            App.setAmbientWifiOnly(on)
            Toast.makeText(this, if (on) "已开启仅 WiFi 上传" else "移动网络也可上传", Toast.LENGTH_SHORT).show()
        })
        sAmbient.addView(Ui.hint(this,
            "说明：24h 录制与「一键唤醒」是两个独立入口；一键唤醒录音时会临时暂停 24h 录制，结束后自动恢复。"))
        root.addView(sAmbient)

        // ---------- 4. 更多（旧页面 / 二级页，保留兼容、不打扰首页） ----------
        val sPages = Ui.section(this, "11 · 更多（旧页面 / 二级页）")
        sPages.addView(Ui.hint(this, "5 页签之外的旧页面都收在这里：功能保留，但不占用首页。"))
        val rowP1 = Ui.row(this)
        rowP1.addView(Ui.button(this, "旧设备页", true) { openWeb("设备（旧）", "/#/devices") })
        rowP1.addView(Ui.button(this, "旧今日页") { openWeb("今日（旧）", "/#/today") })
        sPages.addView(rowP1)
        val rowP2 = Ui.row(this)
        rowP2.addView(Ui.button(this, "旧笔记页") { startActivity(Intent(this, NotesActivity::class.java)) })
        rowP2.addView(Ui.button(this, "手机遥控电脑") { openWeb("手机遥控电脑", "/m/remote") })
        sPages.addView(rowP2)
        val rowP3 = Ui.row(this)
        rowP3.addView(Ui.button(this, "素材库 / 中转站") { openWeb("素材库", "/#/assets") })
        rowP3.addView(Ui.button(this, "旧版互联 / 配对") { openWeb("互联", "/#/link") })
        sPages.addView(rowP3)
        root.addView(sPages)

        // ---------- 5. 关于 / 隐私 ----------
        val sAbout = Ui.section(this, "12 · 关于 / 隐私")
        aboutText = Ui.hint(this, "")
        sAbout.addView(aboutText)
        root.addView(sAbout)

        // ---------- 6. 版本与一键更新 ----------
        val sUpdate = Ui.section(this, "13 · 版本与一键更新")
        sUpdate.addView(Ui.body(this, "当前版本 v" + BuildConfig.VERSION_NAME + "（versionCode " + BuildConfig.VERSION_CODE + "）"))
        val updMsg = Ui.hint(this, "点「检查更新」自动从电脑中枢下载新版 APK；不需要重新发文件。首次更新需允许「安装未知应用」。")
        val rowUpd = Ui.row(this)
        rowUpd.addView(Ui.button(this, "检查更新 / 一键升级", true) { UpdateManager.check(this, false) { msg -> updMsg.text = msg } })
        rowUpd.addView(Ui.button(this, "打开更新信息") {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(App.baseUrl().trimEnd('/') + "/api/v2/update/info?platform=android")))
            } catch (e: Exception) { Toast.makeText(this, "打开失败：" + (e.message ?: ""), Toast.LENGTH_SHORT).show() }
        })
        sUpdate.addView(rowUpd)
        sUpdate.addView(updMsg)
        sUpdate.addView(Ui.hint(this, "中枢需开着（电脑端 App 运行中）；公网访问需路由器把 36996 转发到电脑 7410（你已提供 103.40.14.91:36996）。"))
        root.addView(sUpdate)

        setContentView(Ui.page(this, root, TabNav.SETTINGS))
        loadLocal()
        refreshScreenStatus()
        refreshFromHub()
    }

    override fun onResume() {
        super.onResume()
        refreshScreenStatus()
        refreshOverlayStatus()
        refreshAmbientStatus()
    }

    private fun loadLocal() {
        hubInput.setText(App.hub())
        tokenInput.setText(App.token())
        ttsLocalSwitch.isChecked = App.ttsLocalEnabled()
        wakeEnableSwitch.isChecked = App.wakeEnabledLocal()
        wakeWordsInput.setText(App.wakeWordsLocal())
        screenBlacklistInput.setText(App.screenBlacklist())
        aboutText.text = buildString {
            append("榫卯 Tenon · Android 客户端 v").append(BuildConfig.VERSION_NAME).append("\n")
            append("中枢：").append(App.hub()).append("\n")
            append("本机设备号：").append(App.deviceId()).append(" · ").append(App.deviceName()).append("\n\n")
            append("隐私声明：\n")
            append("· 录音只上传到你自己的中枢（同一 WiFi），本地 ASR 在电脑上完成；\n")
            append("· 语音文本与命令记录保存在你电脑的 data/voice/，可配置保留天数；\n")
            append("· 操作令牌只保存在本机 App 的 SharedPreferences，不写入日志；\n")
            append("· 云端理解走电脑端已配置的 DeepSeek Key，手机不保存该 Key；\n")
            append("· 屏幕采集需你手动在系统弹窗授权，可随时暂停；截图只上传到你自己的中枢。\n")
            append("· 手机 24h 录制约 12 秒一段，只上传到你的中枢，可随时在首页/设置/通知里停止。\n")
            append("· 悬浮窗只用于本机操作，不采集屏幕内容。\n")
            append("· 本 APK 不内置操作令牌，令牌只保存在本机；换手机/重置后需重新填写。")
        }
    }

    // ================= 屏幕内容采集（MediaProjection 前台服务） =================

    private fun onScreenToggle(on: Boolean) {
        if (on) {
            requestScreenCapture()
        } else {
            stopScreenCapture()
        }
    }

    private fun requestScreenCapture() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            Toast.makeText(this, "先授予通知权限（前台服务需要常驻通知）", Toast.LENGTH_SHORT).show()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF_SCREEN)
            return
        }
        App.setScreenBlacklist(screenBlacklistInput.text.toString())
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        Toast.makeText(this, "请在系统弹窗中选择「开始录制 / 共享屏幕」", Toast.LENGTH_LONG).show()
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN_CAPTURE)
    }

    private fun stopScreenCapture() {
        App.setScreenBlacklist(screenBlacklistInput.text.toString())
        ScreenCaptureService.stop(this)
        App.setScreenEnabled(false)
        screenSwitch.isChecked = false
        refreshScreenStatus()
        Toast.makeText(this, "屏幕采集已暂停", Toast.LENGTH_SHORT).show()
    }

    private fun setScreenInterval(sec: Int) {
        App.setScreenInterval(sec)
        refreshScreenStatus()
        Toast.makeText(this, "采集间隔已设为 " + sec + " 秒", Toast.LENGTH_SHORT).show()
    }

    private fun refreshScreenStatus() {
        if (!this::screenStatus.isInitialized) return
        val running = ScreenCaptureService.running
        screenSwitch.isChecked = running
        val last = App.screenLast()
        val err = App.screenLastError()
        screenStatus.text = buildString {
            append("状态：").append(if (running) "运行中" else "未运行")
            append(" · 间隔 ").append(App.screenInterval()).append(" 秒")
            append(" · 本机今日已上报 ").append(App.screenUploadsToday()).append(" 次")
            if (last.isNotBlank()) append("\n最近：").append(last)
            if (err.isNotBlank()) append("\n最近错误：").append(err.take(120))
        }
    }

    // ================= 0.6.8：悬浮窗 =================

    private fun startOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            requestOverlayPermission()
            return
        }
        try {
            OverlayService.start(this)
            App.setOverlayEnabled(true)
            Toast.makeText(this, "悬浮窗已显示，可拖动；退出 App 后仍可用", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "悬浮窗开启失败：" + (e.message ?: ""), Toast.LENGTH_LONG).show()
        }
        overlayStatus.postDelayed({ refreshOverlayStatus() }, 600)
    }

    private fun requestOverlayPermission() {
        Toast.makeText(this, "请在系统页面允许「显示在其他应用上层」", Toast.LENGTH_LONG).show()
        try {
            startActivityForResult(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + packageName)
                ),
                REQ_OVERLAY
            )
        } catch (e: Exception) {
            Toast.makeText(this, "无法打开悬浮窗权限页：" + (e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    private fun refreshOverlayStatus() {
        if (!this::overlayStatus.isInitialized) return
        val allowed = Settings.canDrawOverlays(this)
        val running = OverlayService.running
        suppressSwitch = true
        overlaySwitch.isChecked = running
        suppressSwitch = false
        overlayStatus.text = buildString {
            append("权限：").append(if (allowed) "已授权" else "未授权")
            append(" · 状态：").append(if (running) "运行中" else "未运行")
            append("\n悬浮球可拖动，点一下展开；展开后两个按钮完全分开。退出 App 后仍可用。")
        }
    }

    // ================= 0.6.8：手机本机 24 小时录制 =================

    private fun startAmbientRecording() {
        if (!OneTapVoice.hasMic(this)) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO_AMBIENT)
            return
        }
        try {
            AmbientRecordService.start(this)
            App.setAmbientDesired(true)
            Toast.makeText(this, "24 小时录制已开启（常驻通知可停止）", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "开启失败：" + (e.message ?: "") + "（请保持 App 在前台再试）", Toast.LENGTH_LONG).show()
        }
        ambientStatus.postDelayed({ refreshAmbientStatus() }, 600)
    }

    private fun refreshAmbientStatus() {
        if (!this::ambientStatus.isInitialized) return
        val running = AmbientRecordService.running
        suppressSwitch = true
        ambientSwitch.isChecked = running
        suppressSwitch = false
        ambientStatus.text = buildString {
            append("状态：").append(if (running) "运行中（前台服务）" else "未开启")
            append(" · 今日 ").append(App.ambientSegmentsToday()).append(" 段")
            val last = App.ambientLast()
            if (last.isNotBlank()) append("\n最近：").append(last)
            val err = App.ambientLastError()
            if (err.isNotBlank()) append("\n⚠ ").append(err.take(120))
            append("\n记录位置：记录 → 全天录音（source=ambient）。")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_OVERLAY) {
            refreshOverlayStatus()
            if (Settings.canDrawOverlays(this)) startOverlay()
            else Toast.makeText(this, "未授权悬浮窗权限", Toast.LENGTH_LONG).show()
            return
        }
        if (requestCode != REQ_SCREEN_CAPTURE) return
        if (resultCode == RESULT_OK && data != null) {
            App.setScreenEnabled(true)
            App.setScreenBlacklist(screenBlacklistInput.text.toString())
            ScreenCaptureService.start(this, resultCode, data)
            screenSwitch.isChecked = true
            Toast.makeText(this, "屏幕采集已开启（前台服务运行中）", Toast.LENGTH_LONG).show()
        } else {
            App.setScreenEnabled(false)
            screenSwitch.isChecked = false
            Toast.makeText(this, "未授权屏幕共享，采集未开启", Toast.LENGTH_LONG).show()
        }
        screenStatus.postDelayed({ refreshScreenStatus() }, 600)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_AUDIO_AMBIENT) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted) startAmbientRecording()
            else Toast.makeText(this, "未授予麦克风权限，无法开启 24h 录制", Toast.LENGTH_LONG).show()
            return
        }
        if (requestCode == REQ_NOTIF_SCREEN) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted) requestScreenCapture()
            else Toast.makeText(this, "未授予通知权限，无法开启前台采集", Toast.LENGTH_LONG).show()
        }
    }

    private fun refreshIotStatus(textView: TextView) {
        bg {
            val msg = try {
                val st = TenonClient.iotStatus()
                "IoT 状态：" + st.toString().take(180)
            } catch (e: Exception) {
                if (e is TenonClient.VoiceHttpException && e.code == 404) {
                    "IoT 状态：电脑端接口未就绪（后端并行实现中）"
                } else {
                    "IoT 状态读取失败：" + (e.message ?: "").take(120)
                }
            }
            ui { textView.text = msg }
        }
    }

    /**
     * 0.6.8：「保存并测试」不是只保存 —— 保存后真实 GET /api/v2/voice/status，
     * 把 HTTP 状态、语音状态、ASR/LLM/AI 提供方和令牌状态都显示出来。
     */
    private fun saveConnection() {
        App.setHub(hubInput.text.toString())
        App.setToken(tokenInput.text.toString())
        hubInput.setText(App.hub())
        if (App.baseUrl().isBlank()) {
            statusText.text = "中枢地址为空：请填写，或点下面的「局域网地址 / 公网地址」快捷填入。"
            Toast.makeText(this, "请先填写中枢地址", Toast.LENGTH_SHORT).show()
            return
        }
        statusText.text = "已保存，正在测试 GET /api/v2/voice/status …"
        Toast.makeText(this, "已保存，正在测试…", Toast.LENGTH_SHORT).show()
        bg {
            val msg = try {
                val st = TenonClient.voiceStatus()
                val providers = st.optJSONObject("providers")
                val ai = st.optJSONObject("ai")
                val aiLabel = if (ai?.optBoolean("available", false) == true) ai.optString("model", "deepseek") else "规则引擎"
                "✅ 保存并测试通过 · HTTP 200 · 状态 " + st.optString("state", "?") +
                        " · 本地识别 " + (providers?.optString("asr", "?") ?: "?") +
                        " · 云端理解 " + (providers?.optString("llm", "?") ?: "?") +
                        " · AI " + aiLabel +
                        (if (App.token().isNotBlank()) " · 已带令牌" else " · 未填令牌")
            } catch (e: TenonClient.VoiceHttpException) {
                if (e.isAuth) "⚠ 地址已保存，但 HTTP " + e.code + "：需要操作令牌（新版 GET 也要令牌）"
                else "⚠ 地址已保存，但测试失败 HTTP " + e.code + "：" + bodyError(e.body)
            } catch (e: Exception) {
                "⚠ 地址已保存，但连不上中枢：" + (e.message ?: "") + "\n当前：" + App.baseUrl()
            }
            ui {
                statusText.text = msg
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun refreshFromHub() {
        statusText.text = "正在连接中枢…"
        bg {
            var statusMsg: String
            var cfgObj: JSONObject? = null
            try {
                val st = TenonClient.voiceStatus()
                val providers = st.optJSONObject("providers")
                val ai = st.optJSONObject("ai")
                val aiLabel = if (ai?.optBoolean("available", false) == true) ai.optString("model", "deepseek") else "规则引擎"
                statusMsg = "中枢在线 · 状态 " + st.optString("state", "?") +
                        " · 本地识别 " + (providers?.optString("asr", "?") ?: "?") +
                        " · 云端理解 " + (providers?.optString("llm", "?") ?: "?") +
                        " · AI " + aiLabel +
                        (if (App.token().isNotBlank()) " · 已填写令牌" else " · 未填写令牌（新版 GET 也需要）")
                try { cfgObj = TenonClient.voiceConfig().optJSONObject("config") } catch (_: Exception) {}
            } catch (e: Exception) {
                statusMsg = "中枢离线或地址错误：" + (e.message ?: "") + "\n当前：" + App.baseUrl()
            }
            val finalMsg = statusMsg
            val cfg = cfgObj
            ui { applyStatus(finalMsg, cfg) }
        }
    }

    private fun applyStatus(msg: String, cfg: JSONObject?) {
        statusText.text = msg
        if (cfg == null) {
            configText.text = "未能读取中枢语音配置（离线或未启动语音模块）。"
            return
        }
        alwaysRecordSwitch.isChecked = cfg.optBoolean("enabled", false)
        val wake = cfg.optJSONArray("wakeWords")
        if (wake != null) {
            val list = ArrayList<String>()
            for (i in 0 until wake.length()) list.add(wake.optString(i))
            wakeWordsInput.setText(list.joinToString(","))
        }
        val tts = cfg.optJSONObject("tts")
        ttsSwitch.isChecked = tts?.optBoolean("enabled", true) ?: true
        val diary = cfg.optJSONObject("diary")
        diaryTimeInput.setText(diary?.optString("time", "23:00") ?: "23:00")
        retentionInput.setText(cfg.optInt("retentionDays", 30).toString())
        val mic = cfg.optString("micDevice", "")
        micText.text = "麦克风设备：" + (if (mic.isBlank()) "默认系统麦克风（可在电脑端 data/voice/config.json 的 micDevice 指定）" else mic)
        configText.text = "中枢语音配置 · v" + cfg.optString("version", "?") +
                " · asr=" + cfg.optString("asrProvider", "auto") +
                " · llm=" + cfg.optString("llmProvider", "auto") +
                " · retention=" + cfg.optInt("retentionDays", 30) + "天"
    }

    private fun onAlwaysRecordChanged(on: Boolean) {
        // 先只改本机开关态；点「保存到中枢」后真正 PATCH enabled（避免误触开启电脑麦克风）
        Toast.makeText(this, if (on) "点「保存到中枢」后开启常驻监听" else "点「保存到中枢」后关闭常驻监听", Toast.LENGTH_SHORT).show()
    }

    private fun saveVoiceConfig() {
        val patch = JSONObject()
        patch.put("enabled", alwaysRecordSwitch.isChecked)
        val words = wakeWordsInput.text.toString().split(",", "，").map { it.trim() }.filter { it.isNotBlank() }
        patch.put("wakeWords", JSONArray(words))
        patch.put("tts", JSONObject().put("enabled", ttsSwitch.isChecked))
        val time = diaryTimeInput.text.toString().trim()
        if (time.matches(Regex("^\\d{1,2}:\\d{2}$"))) {
            patch.put("diary", JSONObject().put("enabled", true).put("time", time))
        }
        retentionInput.text.toString().trim().toIntOrNull()?.let { if (it in 1..365) patch.put("retentionDays", it) }
        App.setWakeWordsLocal(words.joinToString(","))
        statusText.text = "正在保存到中枢…"
        bg {
            val msg = try {
                val r = TenonClient.patchVoiceConfig(patch)
                val c = r.optJSONObject("config")
                "已保存到中枢 · 常驻监听=" + (c?.optBoolean("enabled", false) == true) +
                        " · 唤醒词=" + (c?.optJSONArray("wakeWords")?.length() ?: 0) + " 个"
            } catch (e: TenonClient.VoiceHttpException) {
                if (e.isAuth) "保存失败：需要操作令牌（401/403），请在上面填写 operatorToken" else
                    "保存失败 HTTP " + e.code + "：" + bodyError(e.body)
            } catch (e: Exception) {
                "保存失败：" + (e.message ?: "")
            }
            ui {
                statusText.text = msg
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                refreshFromHub()
            }
        }
    }

    private fun bodyError(body: String): String =
        try { JSONObject(body).optString("error", body.take(100)) } catch (_: Exception) { body.take(100) }

    private fun clearLocal() {
        AlertDialog.Builder(this)
            .setTitle("清空本机记录？")
            .setMessage("只清空手机 App 内的最近结果与本地设置，不影响电脑端中枢数据/账本。")
            .setPositiveButton("清空") { _, _ ->
                App.clearLocalRecords()
                Toast.makeText(this, "已清空本机记录", Toast.LENGTH_SHORT).show()
                loadLocal()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun resetAll() {
        AlertDialog.Builder(this)
            .setTitle("恢复默认设置？")
            .setMessage("将清除手机端所有设置（中枢地址恢复内置默认值），不影响电脑端数据。")
            .setPositiveButton("恢复") { _, _ ->
                App.resetAll()
                loadLocal()
                Toast.makeText(this, "已恢复默认设置", Toast.LENGTH_SHORT).show()
                refreshFromHub()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun openWeb(title: String, path: String) {
        if (!App.isConfigured()) {
            Toast.makeText(this, "请先配置中枢地址", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(Intent(this, WebPageActivity::class.java).apply {
            putExtra(WebPageActivity.EXTRA_TITLE, title)
            putExtra(WebPageActivity.EXTRA_URL, App.baseUrl() + path)
        })
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
