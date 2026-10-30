package com.minzzj.tenon

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import com.minzzj.tenon.service.ScreenCaptureService
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)

        // 顶部
        val top = Ui.row(this)
        val title = Ui.title(this, "设置")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(title)
        val back = Ui.button(this, "返回") { finish() }
        back.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 78), ViewGroup.LayoutParams.WRAP_CONTENT)
        top.addView(back)
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
        sHub.addView(rowHub)
        statusText = Ui.body(this, "尚未测试")
        statusText.textSize = 13f
        sHub.addView(statusText)
        sHub.addView(Ui.hint(this, "默认已内置本机中枢地址与体验令牌（仅本机 APK）；更换网络后在此修改。"))
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

        // ---------- 3. 本机设置 ----------
        val sLocal = Ui.section(this, "05 · 本机设置")
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

        // ---------- 4. 二级页入口 ----------
        val sPages = Ui.section(this, "06 · 设备与二级页")
        sPages.addView(Ui.hint(this, "主页只保留「超级终端」；以下能力在二级页打开。"))
        val rowP1 = Ui.row(this)
        rowP1.addView(Ui.button(this, "设备绑定 / 一键安装", true) { openWeb("我的设备", "/#/devices") })
        rowP1.addView(Ui.button(this, "手机遥控电脑") { openWeb("手机遥控电脑", "/m/remote") })
        sPages.addView(rowP1)
        val rowP2 = Ui.row(this)
        rowP2.addView(Ui.button(this, "素材库 / 中转站") { openWeb("素材库", "/#/assets") })
        rowP2.addView(Ui.button(this, "旧版互联 / 配对") { openWeb("互联", "/#/link") })
        sPages.addView(rowP2)
        root.addView(sPages)

        // ---------- 5. 关于 / 隐私 ----------
        val sAbout = Ui.section(this, "07 · 关于 / 隐私")
        aboutText = Ui.hint(this, "")
        sAbout.addView(aboutText)
        root.addView(sAbout)

        setContentView(Ui.scroll(this, root))
        loadLocal()
        refreshScreenStatus()
        refreshFromHub()
    }

    override fun onResume() {
        super.onResume()
        refreshScreenStatus()
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
            append("· 本 APK 内置的默认中枢/令牌仅用于本机体验，正式分发请重新构建。")
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

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
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
        if (requestCode == REQ_NOTIF_SCREEN) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted) requestScreenCapture()
            else Toast.makeText(this, "未授予通知权限，无法开启前台采集", Toast.LENGTH_LONG).show()
        }
    }

    private fun saveConnection() {
        App.setHub(hubInput.text.toString())
        App.setToken(tokenInput.text.toString())
        hubInput.setText(App.hub())
        Toast.makeText(this, "已保存（中枢：" + App.baseUrl() + "）", Toast.LENGTH_SHORT).show()
        refreshFromHub()
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
                        (if (App.hasCustomToken()) " · 已自定义令牌" else " · 使用内置体验令牌")
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
