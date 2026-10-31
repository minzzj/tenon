package com.minzzj.tenon

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import com.minzzj.tenon.service.AmbientRecordService
import com.minzzj.tenon.service.OverlayService
import com.minzzj.tenon.voice.LocalTts
import com.minzzj.tenon.voice.OneTapVoice
import org.json.JSONArray
import org.json.JSONObject

/**
 * 0.6.8 · 手机端首页（5 页签）。
 *
 * 首页最上面是**两个完全分开**的功能入口（用户最强调）：
 * 1) 🎙 一键唤醒：点一下立即录一句话（不喊唤醒词），再点结束 → 电脑本地 ASR →
 *    `/api/v2/voice/command {text, source:"android"}` → 手机本机 TTS 播报；
 *    界面显示「听到：…」与「榫卯：…」。
 * 2) ⏺ 24 小时录制：独立开关按钮 + 状态，开启后由 AmbientRecordService 后台
 *    约 12 秒一段上传 `/api/v2/voice/ambient-upload`，记录出现在「记录 → 全天录音」。
 *
 * 与录音按钮无关的旧版 24h 电脑端开关保留在设置页，手机本机录制是新增的独立能力。
 */
class MainActivity : Activity(), OneTapVoice.Listener {
    companion object {
        private const val REQ_AUDIO = 2001
        private const val REQ_NOTIFY = 2002
    }

    private lateinit var dot: TextView
    private lateinit var onlineLine: TextView
    private lateinit var hubLine: TextView
    private lateinit var voiceLine: TextView

    // 卡片 A：一键唤醒
    private lateinit var wakeBtn: TextView
    private lateinit var wakeState: TextView
    private lateinit var heardLine: TextView
    private lateinit var wakeReply: TextView

    // 卡片 B：24 小时录制
    private lateinit var ambientBtn: TextView
    private lateinit var ambientState: TextView

    private lateinit var replyText: TextView
    private lateinit var replyMeta: TextView
    private lateinit var stepsBox: LinearLayout
    private lateinit var confirmRow: LinearLayout
    private lateinit var errorText: TextView

    private lateinit var textInput: EditText
    private lateinit var logLine: TextView
    private lateinit var statusLine: TextView

    private val pollHandler = Handler(Looper.getMainLooper())
    private val ambientHandler = Handler(Looper.getMainLooper())

    private var lastCommandText = ""
    private var lastConfirmId = ""
    private var pendingWake = false
    private var pendingAmbient = false
    private var busy = false

    private val reminderPoll = object : Runnable {
        override fun run() {
            if (App.remindersEnabled()) {
                Thread {
                    try { ReminderNotifier.pollPending(this@MainActivity) } catch (_: Exception) {}
                }.start()
            }
            pollHandler.postDelayed(this, 30_000)
        }
    }

    private val ambientTicker = object : Runnable {
        override fun run() {
            refreshAmbientUi()
            ambientHandler.postDelayed(this, 2500)
        }
    }

    private val logListener: (String) -> Unit = { line ->
        if (this::logLine.isInitialized) logLine.text = line
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        LocalTts.init(this)
        val root = Ui.column(this)

        // ---------- 页头 ----------
        val head = Ui.row(this)
        head.addView(
            Ui.pageHead(
                this, "榫卯 · 超级终端",
                "v" + BuildConfig.VERSION_NAME + " · 一键唤醒 / 24h 录制 / 悬浮窗"
            )
        )
        root.addView(head)

        // ---------- 中枢连接 ----------
        val sHub = Ui.section(this, "中枢连接")
        val onlineRow = Ui.row(this)
        dot = TextView(this).apply {
            text = "●"
            textSize = 13f
            setTextColor(Ui.GREY)
            setPadding(0, 0, Ui.dp(this@MainActivity, 8), 0)
        }
        onlineRow.addView(dot)
        onlineLine = Ui.body(this, "正在连接中枢…")
        onlineLine.textSize = 15f
        onlineLine.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        onlineLine.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        onlineRow.addView(onlineLine)
        sHub.addView(onlineRow)
        hubLine = Ui.hint(this, "中枢：" + App.baseUrl().ifBlank { "未配置" })
        voiceLine = Ui.hint(this, "语音：读取中…")
        sHub.addView(hubLine)
        sHub.addView(voiceLine)
        val rowHub = Ui.row(this)
        rowHub.addView(Ui.button(this, "刷新状态", true) { refreshHub() })
        rowHub.addView(Ui.button(this, "打开记录") { TabNav.go(this, TabNav.RECORDS) })
        sHub.addView(rowHub)
        root.addView(sHub)

        // ---------- 卡片 A：一键唤醒（独立入口 1） ----------
        val sWake = Ui.section(this, "🎙 一键唤醒")
        sWake.addView(
            Ui.hint(
                this,
                "不用喊唤醒词：点一下开始录一句话，再点一下结束。识别在电脑本地完成，" +
                        "结果回到手机显示，并由手机本机朗读（电脑端不会重复播报）。"
            )
        )
        wakeBtn = Ui.button(this, "🎙 点一下开始说话", true) { onWakeTap() }
        wakeBtn.textSize = 17f
        wakeBtn.minHeight = Ui.dp(this, 54)
        val wakeRow = Ui.row(this)
        wakeRow.addView(wakeBtn)
        sWake.addView(wakeRow)
        wakeState = Ui.body(this, "待机")
        wakeState.textSize = 14f
        wakeState.setTextColor(Ui.CYAN)
        wakeState.setPadding(0, Ui.dp(this, 10), 0, 0)
        sWake.addView(wakeState)
        heardLine = Ui.body(this, "听到：—")
        heardLine.textSize = 13f
        heardLine.setTextColor(Ui.PAPER)
        sWake.addView(heardLine)
        wakeReply = Ui.body(this, "榫卯：—")
        wakeReply.textSize = 13f
        wakeReply.setTextColor(Ui.PAPER)
        wakeReply.maxLines = 4
        wakeReply.ellipsize = TextUtils.TruncateAt.END
        sWake.addView(wakeReply)
        root.addView(sWake)

        // ---------- 卡片 B：24 小时录制（独立入口 2，和录音按钮完全分开） ----------
        val sAmb = Ui.section(this, "⏺ 24 小时录制")
        ambientBtn = Ui.button(this, "⏺ 开启 24 小时录制", true) { onAmbientTap() }
        ambientBtn.textSize = 16f
        ambientBtn.minHeight = Ui.dp(this, 52)
        val ambRow = Ui.row(this)
        ambRow.addView(ambientBtn)
        sAmb.addView(ambRow)
        ambientState = Ui.body(this, "未开启")
        ambientState.textSize = 13f
        ambientState.setPadding(0, Ui.dp(this, 10), 0, 0)
        sAmb.addView(ambientState)
        sAmb.addView(
            Ui.hint(
                this,
                "手机本机后台录音：约 12 秒一段 WAV，上传到你自己的电脑 " +
                        "/api/v2/voice/ambient-upload，只存电脑本机、不上传第三方。开启后耗电和发热会增加，" +
                        "常驻通知里有「停止 24h 录制」，这里也能随时关闭。"
            )
        )
        val ambRow2 = Ui.row(this)
        ambRow2.addView(Ui.button(this, "查看全天录音") { openAmbientRecords() })
        ambRow2.addView(Ui.button(this, "打开设置") { TabNav.go(this, TabNav.SETTINGS) })
        sAmb.addView(ambRow2)
        root.addView(sAmb)

        // ---------- 最近回复 / 执行结果 ----------
        val replyCard = Ui.section(this, "最近回复 / 执行结果")
        replyText = Ui.body(this, "说一句试试：打开记事本 / 把音量调到 40 / 记一下今天的重点")
        replyText.textSize = 18f
        replyText.setPadding(0, Ui.dp(this, 2), 0, Ui.dp(this, 4))
        replyCard.addView(replyText)
        replyMeta = Ui.hint(this, "")
        replyCard.addView(replyMeta)
        stepsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        replyCard.addView(stepsBox)
        confirmRow = Ui.row(this)
        confirmRow.visibility = LinearLayout.GONE
        confirmRow.setPadding(0, Ui.dp(this, 8), 0, 0)
        confirmRow.addView(Ui.button(this, "✅ 确认执行", true) { confirmLast(true) })
        confirmRow.addView(Ui.button(this, "取消") { confirmLast(false) })
        replyCard.addView(confirmRow)
        errorText = Ui.hint(this, "")
        errorText.setTextColor(Ui.AMBER)
        replyCard.addView(errorText)
        root.addView(replyCard)

        // ---------- 快捷 ----------
        val sQuick = Ui.section(this, "快捷")
        val quickRow = Ui.row(this)
        quickRow.addView(Ui.button(this, "📝 记笔记", true) { quickNote() })
        quickRow.addView(Ui.button(this, "🧠 总结今天") { quickSummary() })
        quickRow.addView(Ui.button(this, "⏰ 提醒") { TabNav.go(this, TabNav.REMINDERS) })
        sQuick.addView(quickRow)
        val quickRow2 = Ui.row(this)
        quickRow2.addView(Ui.button(this, "🪟 显示悬浮窗", true) { showOverlay() })
        quickRow2.addView(Ui.button(this, "⏺ 全天录音记录") { openAmbientRecords() })
        sQuick.addView(quickRow2)
        sQuick.addView(
            Ui.hint(this, "悬浮窗可拖动，展开后「一键唤醒」与「24h 开/关」是两个分开的按钮；退出 App 后仍可用。")
        )
        root.addView(sQuick)

        // ---------- 文字兜底 ----------
        val row = Ui.row(this)
        textInput = Ui.input(this, "也可以打字：打开记事本 / 记一下今天的重点")
        textInput.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            rightMargin = Ui.dp(this@MainActivity, 6)
        }
        row.addView(textInput)
        val sendBtn = Ui.button(this, "发送", true) { sendText() }
        sendBtn.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 78), ViewGroup.LayoutParams.WRAP_CONTENT)
        row.addView(sendBtn)
        root.addView(row)

        statusLine = Ui.meta(this, "")
        root.addView(statusLine)
        logLine = Ui.meta(this, "")
        root.addView(logLine)

        setContentView(Ui.page(this, root, TabNav.HOME))

        restoreLastResult()
        ensureNotificationPermission()
        ReminderNotifier.ensureChannel(this)
        ReminderWorker.schedule(this)
        handleOpenTabIntent(intent)
        LogBus.addListener(logListener)
        OneTapVoice.get(this).addListener(this)
    }

    override fun onResume() {
        super.onResume()
        UpdateManager.autoCheck(this)
        refreshHub()
        refreshAmbientUi()
        ambientHandler.removeCallbacks(ambientTicker)
        ambientHandler.post(ambientTicker)
        if (App.remindersEnabled()) pollHandler.postDelayed(reminderPoll, 5_000)
    }

    override fun onPause() {
        pollHandler.removeCallbacksAndMessages(null)
        ambientHandler.removeCallbacksAndMessages(null)
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleOpenTabIntent(intent)
    }

    override fun onDestroy() {
        LogBus.removeListener(logListener)
        OneTapVoice.get(this).removeListener(this)
        if (!OverlayService.running) {
            try { OneTapVoice.get(this).cancel() } catch (_: Exception) {}
        }
        pollHandler.removeCallbacksAndMessages(null)
        ambientHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun handleOpenTabIntent(intent: Intent?) {
        when (intent?.getStringExtra("openTab")) {
            "reminders" -> TabNav.go(this, TabNav.REMINDERS)
            "records", "notes" -> TabNav.go(this, TabNav.RECORDS)
            "ambient" -> openAmbientRecords()
            "documents" -> TabNav.go(this, TabNav.DOCUMENTS)
            "settings" -> TabNav.go(this, TabNav.SETTINGS)
        }
    }

    private fun ensureNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_AUDIO) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            when {
                pendingAmbient -> {
                    pendingAmbient = false
                    pendingWake = false
                    startAmbient()
                }
                pendingWake -> {
                    pendingWake = false
                    pendingAmbient = false
                    wakeState.text = "麦克风已授权 · 正在准备录音…"
                    OneTapVoice.get(this).toggle()
                }
            }
        } else {
            pendingWake = false
            pendingAmbient = false
            wakeState.text = "麦克风未授权 · 可用下方文字输入，或到系统设置开启"
            showError("未授权麦克风：可在系统权限里开启；也可以直接在下方打字发送。")
        }
    }

    // ================= 卡片 A：一键唤醒 =================

    private fun onWakeTap() {
        if (OneTapVoice.get(this).isRecording) {
            OneTapVoice.get(this).toggle()
            return
        }
        if (!OneTapVoice.hasMic(this)) {
            pendingWake = true
            pendingAmbient = false
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
            return
        }
        OneTapVoice.get(this).toggle()
    }

    override fun onState(state: String, detail: String) {
        wakeState.text = if (detail.isBlank()) state else state + " · " + detail
        wakeState.setTextColor(
            if (state == OneTapVoice.RECORDING || state == OneTapVoice.TRANSCRIBING ||
                state == OneTapVoice.EXECUTING
            ) Ui.AMBER else Ui.CYAN
        )
        wakeBtn.text =
            if (OneTapVoice.get(this).isRecording) "⏹ 点一下结束并识别" else "🎙 点一下开始说话"
    }

    override fun onHeard(text: String) {
        heardLine.text = "听到：" + text
    }

    override fun onReply(say: String, result: JSONObject?) {
        wakeReply.text = "榫卯：" + say.ifBlank { "（没有文字回复）" }
        if (result != null) renderResult(result, "")
    }

    override fun onError(message: String) {
        wakeState.text = "⚠ " + message
        wakeState.setTextColor(Ui.AMBER)
        errorText.text = message
        LogBus.log(message)
    }

    // ================= 卡片 B：24 小时录制 =================

    private fun onAmbientTap() {
        if (AmbientRecordService.running) {
            AmbientRecordService.stop(this)
            Toast.makeText(this, "正在停止 24 小时录制…", Toast.LENGTH_SHORT).show()
            ambientHandler.postDelayed({ refreshAmbientUi() }, 600)
            ambientHandler.postDelayed({ refreshAmbientUi() }, 2000)
            return
        }
        if (!OneTapVoice.hasMic(this)) {
            pendingAmbient = true
            pendingWake = false
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
            return
        }
        startAmbient()
    }

    private fun startAmbient() {
        try {
            AmbientRecordService.start(this)
            Toast.makeText(this, "24 小时录制已开启（常驻通知可停止）", Toast.LENGTH_LONG).show()
            if (android.os.Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                Toast.makeText(this, "通知权限未开：常驻通知可能不显示，建议到设置开启", Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "开启失败：" + (e.message ?: "") + "（请保持 App 在前台再试）", Toast.LENGTH_LONG).show()
        }
        ambientHandler.postDelayed({ refreshAmbientUi() }, 600)
        ambientHandler.postDelayed({ refreshAmbientUi() }, 2200)
    }

    private fun refreshAmbientUi() {
        if (!this::ambientBtn.isInitialized) return
        val running = AmbientRecordService.running
        ambientBtn.text = if (running) "⏹ 关闭 24 小时录制" else "⏺ 开启 24 小时录制"
        ambientBtn.setTextColor(if (running) Ui.AMBER else Ui.CYAN)
        val err = App.ambientLastError()
        ambientState.text = buildString {
            append("状态：").append(if (running) "运行中（手机前台服务持续录制）" else "未开启")
            append(" · 今日 ").append(App.ambientSegmentsToday()).append(" 段")
            val last = App.ambientLast()
            if (last.isNotBlank()) append("\n最近：").append(last)
            if (err.isNotBlank()) append("\n⚠ ").append(err.take(120))
        }
        ambientState.setTextColor(if (err.isNotBlank()) Ui.AMBER else Ui.GREY)
    }

    private fun openAmbientRecords() {
        startActivity(
            Intent(this, VoiceRecordsActivity::class.java)
                .putExtra(VoiceRecordsActivity.EXTRA_TAB, VoiceRecordsActivity.TAB_AMBIENT)
        )
    }

    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            AlertDialog.Builder(this)
                .setTitle("需要悬浮窗权限")
                .setMessage("第一次使用请允许「显示在其他应用上层」。授权后回到 App 再点「显示悬浮窗」，退出 App 也能用。")
                .setPositiveButton("去授权") { _, _ -> openOverlaySettings() }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        if (OverlayService.running) {
            Toast.makeText(this, "悬浮窗已在运行（可拖动，展开后有两个按钮）", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            OverlayService.start(this)
            Toast.makeText(this, "悬浮窗已显示：点球展开「一键唤醒」与「24h 开/关」", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "悬浮窗开启失败：" + (e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    private fun openOverlaySettings() {
        try {
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + packageName)
                )
            )
        } catch (e: Exception) {
            Toast.makeText(this, "无法打开悬浮窗设置：" + (e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    // ================= 连接状态 =================

    private fun refreshHub() {
        if (!this::hubLine.isInitialized) return
        hubLine.text = "中枢：" + App.baseUrl().ifBlank { "未配置（去「设置」填写）" }
        if (!App.isConfigured()) {
            renderOffline("未配置中枢地址：到「设置 → 中枢连接」填写局域网或公网地址。")
            return
        }
        bg {
            var status: JSONObject? = null
            var online = false
            var authNeeded = false
            var err = ""
            try {
                status = TenonClient.voiceStatus()
                online = true
            } catch (e: TenonClient.VoiceHttpException) {
                online = true
                authNeeded = e.isAuth
                err = "HTTP " + e.code
            } catch (e: Exception) {
                err = e.message ?: "网络错误"
            }
            val st = status
            ui {
                if (online) renderOnline(st, authNeeded) else renderOffline(netHint(err))
            }
        }
    }

    private fun renderOnline(status: JSONObject?, authNeeded: Boolean) {
        dot.setTextColor(Ui.CYAN)
        if (authNeeded) {
            onlineLine.text = "中枢在线 · 需要操作令牌"
            voiceLine.text = "到「设置 → 中枢连接」填写 operatorToken 后，录音转写与记录读取才会生效。"
            return
        }
        val state = status?.optString("state", "idle") ?: "idle"
        onlineLine.text = "中枢在线 · 语音" + stateLabelOf(state)
        val providers = status?.optJSONObject("providers")
        val asr = providers?.optString("asr", "?") ?: "?"
        val llm = providers?.optString("llm", "?") ?: "?"
        val ai = status?.optJSONObject("ai")
        val aiLabel = if (ai?.optBoolean("available", false) == true) ai.optString("model", "DeepSeek") else "规则引擎"
        voiceLine.text = "本地识别 " + asr + " · 云端理解 " + llm + " · AI " + aiLabel +
                " · 手机 24h " + (if (AmbientRecordService.running) "开" else "关") +
                " · 屏幕采集" + (if (App.screenEnabled()) "开" else "关")
    }

    private fun renderOffline(reason: String) {
        dot.setTextColor(Ui.RED)
        onlineLine.text = "中枢离线"
        voiceLine.text = reason
    }

    private fun stateLabelOf(state: String): String = when (state) {
        "listening" -> "常驻监听中"
        "thinking" -> "思考中"
        "executing" -> "执行中"
        "reply" -> "刚回复"
        "error" -> "异常"
        else -> "待命"
    }

    private fun restoreLastResult() {
        val raw = App.lastResultJson()
        if (raw.isBlank()) return
        try {
            val result = JSONObject(raw)
            renderResult(result, "")
            val say = result.optString("say", result.optString("reply", ""))
            if (say.isNotBlank()) wakeReply.text = "榫卯：" + say
        } catch (_: Exception) {}
    }

    // ================= 文字指令 / 执行结果 =================

    private fun sendText() {
        val text = textInput.text.toString().trim()
        if (text.isEmpty()) {
            statusLine.text = "先输入一句话"
            return
        }
        if (busy) {
            statusLine.text = "还在处理上一条，稍等…"
            return
        }
        heardLine.text = "听到：" + text
        textInput.setText("")
        runCommand(text)
    }

    private fun runCommand(text: String) {
        lastCommandText = text
        setBusy(true, "执行中…（云端理解）")
        errorText.text = ""
        bg {
            try {
                val result = TenonClient.voiceCommand(text)
                val say = result.optString("say", result.optString("reply", "")).trim()
                ui {
                    renderResult(result, "")
                    setBusy(false, "完成 · 再说一句")
                    refreshHub()
                    if (say.isNotBlank()) LocalTts.speak(say)
                }
            } catch (e: TenonClient.VoiceHttpException) {
                ui { onHttpError(e) }
            } catch (e: Exception) {
                ui { finishBusy("执行失败：" + readable(e)) }
            }
        }
    }

    private fun renderResult(result: JSONObject, prefix: String) {
        val say = result.optString("say", result.optString("reply", "")).trim()
        if (say.isNotBlank()) {
            replyText.text = say
            replyText.setTextColor(Ui.PAPER)
        }
        val provider = result.optString("provider", "—")
        val latency = result.optLong("latencyMs", 0L)
        val needConfirm = result.optBoolean("needConfirm", false)
        val ttsObj = result.optJSONObject("tts")
        val ttsOk = result.optBoolean("tts", ttsObj?.optBoolean("ok", false) ?: false)
        val ttsSkipped = ttsObj?.optBoolean("skipped", false) == true
        replyMeta.text = buildString {
            append("provider ").append(provider)
            if (latency > 0) append(" · ").append(latency).append("ms")
            if (needConfirm) append(" · 需要确认")
            if (ttsSkipped) append(" · 电脑端已跳过播报（手机朗读）")
            else if (ttsOk) append(" · 电脑端已播报")
        }
        if (prefix.isNotBlank()) heardLine.text = "听到：—"
        stepsBox.removeAllViews()
        val steps: JSONArray? = result.optJSONArray("steps") ?: result.optJSONArray("actions")
        if (steps != null) {
            for (i in 0 until steps.length()) {
                val s = steps.optJSONObject(i) ?: continue
                val label = s.optString("label", s.optString("action", "步骤 " + (i + 1)))
                val status = s.optString("status", s.optString("summary", ""))
                val summary = s.optString("summary", "")
                stepsBox.addView(stepRow(iconOf(status), label, status, summary))
            }
        }
        lastConfirmId = result.optString("confirmId", "")
        confirmRow.visibility = if (needConfirm) LinearLayout.VISIBLE else LinearLayout.GONE
        if (needConfirm) statusLine.text = "不可逆操作：请确认后执行"
        val err = result.optString("error", "")
        errorText.text = if (err.isNotBlank()) "错误：" + err else ""
        try { App.setLastResultJson(result.toString()) } catch (_: Exception) {}
    }

    private fun stepRow(icon: String, label: String, status: String, summary: String): TextView =
        TextView(this).apply {
            text = icon + " " + label + if (status.isNotBlank()) "  [" + status + "]" else "" +
                    if (summary.isNotBlank()) "  " + summary.take(40) else ""
            textSize = 13f
            setTextColor(if (status.contains("fail") || status.contains("error")) Ui.AMBER else Ui.GREY)
            setPadding(0, Ui.dp(this@MainActivity, 3), 0, 0)
        }

    private fun iconOf(status: String): String = when {
        status.contains("succeed") || status.contains("dispatched") -> "✅"
        status.contains("fail") || status.contains("error") -> "❌"
        status.contains("pending") || status.contains("queue") -> "⏳"
        status.contains("confirm") -> "⚠️"
        else -> "•"
    }

    private fun finishBusy(message: String) {
        setBusy(false, message)
        statusLine.text = message
    }

    private fun setBusy(b: Boolean, message: String) {
        busy = b
        statusLine.text = message
    }

    // ================= 快捷：笔记 / 总结 =================

    private fun quickNote() {
        val input = Ui.input(this, "记点什么…（会同步到电脑端「记录」）")
        input.isSingleLine = false
        input.minLines = 3
        input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(
                Ui.dp(this@MainActivity, 18), Ui.dp(this@MainActivity, 4),
                Ui.dp(this@MainActivity, 18), 0
            )
        }
        box.addView(input)
        val dlg = AlertDialog.Builder(this)
            .setTitle("记笔记")
            .setView(box)
            .setPositiveButton("保存", null)
            .setNegativeButton("取消", null)
            .create()
        dlg.setOnShowListener {
            dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val text = input.text.toString().trim()
                if (text.isEmpty()) {
                    Toast.makeText(this, "先写点内容", Toast.LENGTH_SHORT).show()
                } else {
                    dlg.dismiss()
                    saveNote(text)
                }
            }
        }
        dlg.show()
    }

    private fun saveNote(text: String) {
        statusLine.text = "正在保存笔记…"
        bg {
            val msg = try {
                TenonClient.noteCreate(text)
                "已记下 · 可在「记录」查看"
            } catch (e: Exception) {
                "保存失败：" + failure(e)
            }
            ui {
                statusLine.text = msg
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun quickSummary() {
        AlertDialog.Builder(this)
            .setTitle("总结今天")
            .setMessage("让电脑端 AI 汇总今天的语音、笔记与屏幕记录，并生成一份可下载的文档？")
            .setPositiveButton("开始总结") { _, _ -> generateSummary() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun generateSummary() {
        setBusy(true, "正在生成今日总结…（电脑端 AI）")
        bg {
            try {
                val r = TenonClient.voiceDiaryGenerate()
                val md = r.optString("markdown", r.optString("text", ""))
                val brief = md.replace("#", "").replace("\n", " ").trim().take(120)
                ui {
                    setBusy(false, "总结完成 · 可在「文档」下载")
                    AlertDialog.Builder(this)
                        .setTitle("今日总结已生成")
                        .setMessage(if (brief.isNotBlank()) brief else "已生成，可到「文档」页下载 MD/DOCX/PDF。")
                        .setPositiveButton("去文档") { _, _ -> TabNav.go(this, TabNav.DOCUMENTS) }
                        .setNegativeButton("关闭", null)
                        .show()
                }
            } catch (e: Exception) {
                ui { finishBusy("总结失败：" + failure(e)) }
            }
        }
    }

    // ================= 错误提示 =================

    private fun onHttpError(e: TenonClient.VoiceHttpException) {
        setBusy(false, "请求失败")
        val msg = bodyError(e.body)
        if (e.isAuth) {
            showError("令牌无效或缺失（HTTP " + e.code + "）：请到「设置 → 中枢连接」填写操作令牌")
            AlertDialog.Builder(this)
                .setTitle("需要操作令牌")
                .setMessage("语音转写/执行需要操作令牌。\n请到「设置 → 中枢连接」填写电脑端 data/secrets.json 里的 operatorToken。")
                .setPositiveButton("去设置") { _, _ -> TabNav.go(this, TabNav.SETTINGS) }
                .setNegativeButton("取消", null)
                .show()
        } else {
            showError("请求失败 HTTP " + e.code + "：" + msg)
        }
    }

    private fun failure(e: Exception): String {
        if (e is TenonClient.VoiceHttpException) {
            return when {
                e.isAuth -> "需要操作令牌（HTTP " + e.code + "）：去「设置」填写 operatorToken"
                e.code == 404 -> "电脑端接口未就绪（HTTP 404）"
                else -> "HTTP " + e.code + " " + bodyError(e.body)
            }
        }
        return readable(e)
    }

    private fun bodyError(body: String): String =
        try {
            JSONObject(body).optString("error", body.take(120))
        } catch (_: Exception) {
            body.take(120)
        }

    private fun readable(e: Exception): String {
        val m = e.message ?: "网络错误"
        return netHint(m)
    }

    private fun netHint(raw: String): String =
        if (raw.contains("Failed to connect") || raw.contains("Connection refused") ||
            raw.contains("timeout") || raw.contains("timed out")
        ) {
            "连不上中枢（检查同一 WiFi / 中枢地址 / 电脑 App 是否运行）"
        } else raw.take(120)

    // ================= 确认 / 工具 =================

    private fun showError(msg: String) {
        errorText.text = msg
        LogBus.log(msg)
    }

    /** needConfirm 确认/取消（/api/v2/voice/confirm）。 */
    private fun confirmLast(yes: Boolean) {
        if (lastCommandText.isBlank() && lastConfirmId.isBlank()) {
            statusLine.text = "没有待确认的命令"
            return
        }
        confirmRow.visibility = LinearLayout.GONE
        setBusy(true, if (yes) "正在确认并执行…" else "正在取消…")
        bg {
            val msg = try {
                val r = TenonClient.voiceConfirm(lastConfirmId, yes)
                when {
                    r.optBoolean("cancelled", false) -> "已取消"
                    r.optBoolean("ok", false) -> "已确认并执行：" + r.optString("say", "").take(80)
                    else -> "返回：" + r.optString("error", r.toString().take(120))
                }
            } catch (e: TenonClient.VoiceHttpException) {
                if (e.isAuth) "需要操作令牌（401/403）：去「设置」填写" else "确认失败 HTTP " + e.code
            } catch (e: Exception) {
                "确认失败：" + (e.message ?: "")
            }
            ui {
                setBusy(false, "完成 · 再说一句")
                replyText.text = msg
                refreshHub()
            }
        }
    }

    private fun bg(block: () -> Unit) {
        Thread(block).start()
    }

    private fun ui(block: () -> Unit) {
        runOnUiThread(block)
    }
}
