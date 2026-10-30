package com.minzzj.tenon

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * v0.4 主页面：极简「超级终端」。
 * 顶部连接状态 → 中央大语音按钮（录音 16k WAV → 本地 ASR 转写 → 云端理解执行）→ 最新回复/步骤 → 今日摘要 → 底部设备/遥控/设置。
 * 所有设置集中在 SettingsActivity；远程触控、拍照甩屏、素材等为二级页。
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_AUDIO = 2001
    }

    private lateinit var dot: TextView
    private lateinit var statusLine: TextView
    private lateinit var badgeLine: TextView
    private lateinit var voiceButton: TextView
    private lateinit var stateLabel: TextView
    private lateinit var recognizedLine: TextView
    private lateinit var replyText: TextView
    private lateinit var replyMeta: TextView
    private lateinit var stepsBox: LinearLayout
    private lateinit var errorText: TextView
    private lateinit var todayText: TextView
    private lateinit var textInput: EditText
    private lateinit var logLine: TextView
    private lateinit var confirmRow: LinearLayout
    private val pollHandler = android.os.Handler(android.os.Looper.getMainLooper())
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
    private var lastCommandText: String = ""
    private var lastConfirmId: String = ""

    private lateinit var recorder: VoiceRecorder
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pulse: ObjectAnimator? = null
    private var busy = false
    private var pendingStart = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        recorder = VoiceRecorder(this)

        val root = Ui.column(this)

        // ---------- 顶部：品牌 + 连接状态 ----------
        val top = Ui.row(this)
        dot = TextView(this).apply {
            text = "●"
            textSize = 15f
            setTextColor(Ui.GREY)
            setPadding(0, 0, Ui.dp(this@MainActivity, 8), 0)
        }
        top.addView(dot)
        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        titleCol.addView(TextView(this).apply {
            text = "榫卯 · 超级终端"
            textSize = 21f
            setTextColor(Ui.PAPER)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
        })
        titleCol.addView(TextView(this).apply {
            text = "TENON v" + BuildConfig.VERSION_NAME + " · 语音管家"
            textSize = 11f
            setTextColor(Ui.GREY)
        })
        top.addView(titleCol)
        val settingsBtn = Ui.button(this, "设置") { openSettings() }
        settingsBtn.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 78), ViewGroup.LayoutParams.WRAP_CONTENT)
        top.addView(settingsBtn)
        root.addView(top)

        statusLine = Ui.hint(this, "正在连接中枢…")
        root.addView(statusLine)
        badgeLine = Ui.hint(this, "本地识别 · 云端理解")
        badgeLine.setTextColor(Ui.CYAN)
        root.addView(badgeLine)

        // ---------- 中央：大语音按钮 ----------
        val center = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, Ui.dp(this@MainActivity, 26), 0, Ui.dp(this@MainActivity, 8))
        }
        voiceButton = TextView(this).apply {
            text = "按住\n说话"
            gravity = Gravity.CENTER
            textSize = 24f
            setTextColor(Ui.PAPER)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            setBackgroundResource(R.drawable.bg_voice_ring)
            layoutParams = LinearLayout.LayoutParams(
                Ui.dp(this@MainActivity, 194), Ui.dp(this@MainActivity, 194)
            ).apply { gravity = Gravity.CENTER_HORIZONTAL }
            setOnTouchListener { v, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        startVoice()
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        stopVoice()
                        v.performClick()
                        true
                    }
                    else -> false
                }
            }
        }
        center.addView(voiceButton)
        stateLabel = Ui.body(this, "按住说话，松手发送")
        stateLabel.gravity = Gravity.CENTER
        stateLabel.setTextColor(Ui.CYAN)
        stateLabel.setPadding(0, Ui.dp(this, 14), 0, 0)
        center.addView(stateLabel)
        recognizedLine = Ui.body(this, "最近识别：—")
        recognizedLine.gravity = Gravity.CENTER
        recognizedLine.setTextColor(Ui.GREY)
        recognizedLine.maxLines = 1
        recognizedLine.ellipsize = android.text.TextUtils.TruncateAt.END
        recognizedLine.setPadding(0, Ui.dp(this, 6), 0, 0)
        center.addView(recognizedLine)
        root.addView(center)

        // ---------- 回复卡片 ----------
        val replyCard = Ui.section(this, "管家回复")
        replyText = Ui.body(this, "说一句试试：打开记事本 / 把音量调到 40 / 回家模式")
        replyText.textSize = 19f
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

        // ---------- 文字兜底输入 ----------
        val row = Ui.row(this)
        textInput = Ui.input(this, "也可以打字：打开记事本 / 放首歌")
        textInput.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            topMargin = 0
            rightMargin = Ui.dp(this@MainActivity, 6)
        }
        row.addView(textInput)
        val sendBtn = Ui.button(this, "发送", true) { sendText() }
        sendBtn.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 82), ViewGroup.LayoutParams.WRAP_CONTENT)
        row.addView(sendBtn)
        root.addView(row)

        // ---------- 今日摘要 ----------
        val todayCard = Ui.section(this, "今日 · 本机视角")
        todayText = Ui.body(this, "正在读取…")
        todayText.textSize = 13f
        todayText.setTextColor(Ui.GREY)
        todayCard.addView(todayText)
        root.addView(todayCard)

        // ---------- 底部 5 页签：首页 / 记录 / 提醒 / 文档 / 设置 ----------
        val bottom = Ui.row(this)
        bottom.setPadding(0, Ui.dp(this, 14), 0, 0)
        bottom.addView(Ui.button(this, "首页", true) { })
        bottom.addView(Ui.button(this, "记录") { startActivity(Intent(this, NotesActivity::class.java)) })
        bottom.addView(Ui.button(this, "提醒") { startActivity(Intent(this, RemindersActivity::class.java)) })
        bottom.addView(Ui.button(this, "文档") { startActivity(Intent(this, DocumentsActivity::class.java)) })
        bottom.addView(Ui.button(this, "设置") { openSettings() })
        root.addView(bottom)

        logLine = Ui.hint(this, "")
        root.addView(logLine)

        setContentView(Ui.scroll(this, root))

        initTts()
        restoreLastResult()
        ensureAudioPermission()
        ensureNotificationPermission()
        ReminderNotifier.ensureChannel(this)
        ReminderWorker.schedule(this)
        handleOpenTabIntent(intent)
        LogBus.addListener(logListener)
    }

    private val logListener: (String) -> Unit = { line ->
        if (this::logLine.isInitialized) logLine.text = line
    }

    override fun onResume() {
        super.onResume()
        refreshHub()
        if (App.remindersEnabled()) pollHandler.postDelayed(reminderPoll, 5_000)
        renderStatusAfterChange()
    }

    override fun onPause() {
        pollHandler.removeCallbacksAndMessages(null)
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleOpenTabIntent(intent)
    }

    private fun handleOpenTabIntent(intent: Intent?) {
        if (intent?.getStringExtra("openTab") == "reminders") {
            try { startActivity(Intent(this, RemindersActivity::class.java)) } catch (_: Exception) {}
        }
    }

    private fun ensureNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 2002)
        }
    }

    override fun onDestroy() {
        LogBus.removeListener(logListener)
        pulse?.cancel()
        try { recorder.cancel() } catch (_: Exception) {}
        try { tts?.stop(); tts?.shutdown() } catch (_: Exception) {}
        tts = null
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_AUDIO) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted && pendingStart) {
                pendingStart = false
                startVoice()
            } else if (granted) {
                stateLabel.text = "麦克风已授权，按住说话"
            } else {
                pendingStart = false
                showError("未授权麦克风：可在系统权限里开启；也可以直接在下方打字发送。")
                stateLabel.text = "麦克风未授权 · 可用文字输入"
            }
        }
    }

    // ================= 连接状态 / 今日摘要 =================

    private fun refreshHub() {
        bg {
            var online = false
            var statusObj: JSONObject? = null
            var stateObj: JSONObject? = null
            var transcriptsTotal = 0
            try {
                statusObj = TenonClient.voiceStatus()
                online = true
            } catch (e: Exception) {
                online = false
            }
            var screenTotal = -1
            var diaryBrief = ""
            if (online) {
                try { stateObj = TenonClient.hubState() } catch (_: Exception) {}
                try {
                    val today = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date())
                    transcriptsTotal = TenonClient.voiceTranscripts(today)?.optInt("total", 0) ?: 0
                    val sc = TenonClient.voiceScreenList(today)
                    screenTotal = if (sc == null) -1 else sc.optInt("total", sc.optJSONArray("items")?.length() ?: 0)
                    val d = TenonClient.voiceDiary(today)
                    if (d.optBoolean("exists", false)) {
                        diaryBrief = d.optString("markdown", "").replace("#", "").replace("\n", " ").trim().take(40)
                    }
                } catch (_: Exception) {}
            }
            val finalOnline = online
            val finalStatus = statusObj
            val finalState = stateObj
            val finalTotal = transcriptsTotal
            val finalScreen = screenTotal
            val finalDiary = diaryBrief
            ui { renderStatus(finalOnline, finalStatus, finalState, finalTotal, finalScreen, finalDiary) }
        }
    }

    private fun renderStatus(
        online: Boolean,
        status: JSONObject?,
        hubState: JSONObject?,
        transcriptsTotal: Int,
        screenTotal: Int,
        diaryBrief: String
    ) {
        dot.setTextColor(if (online) Ui.CYAN else 0xFFFF6B6B.toInt())
        if (!online) {
            statusLine.text = "中枢离线 · 检查设置里的中枢地址（需与电脑同一 WiFi）"
            badgeLine.text = "本地识别 · 云端理解（离线时不可用）"
            todayText.text = "离线：连上中枢后显示今日摘要。\n当前中枢：" + App.baseUrl()
            return
        }
        val state = status?.optString("state", "idle") ?: "idle"
        val providers = status?.optJSONObject("providers")
        val asr = providers?.optString("asr", "?") ?: "?"
        val llm = providers?.optString("llm", "?") ?: "?"
        val ai = status?.optJSONObject("ai")
        val aiLabel = if (ai?.optBoolean("available", false) == true) (ai.optString("model", "deepseek")) else "规则引擎"
        val collect = if (App.screenEnabled()) "屏幕采集开" else "屏幕采集关"
        statusLine.text = "中枢在线 · 语音管家 " + stateLabelOf(state) + " · " + collect + " · " + App.deviceName()
        badgeLine.text = "本地识别 " + asr + " · 云端理解 " + llm + " · AI " + aiLabel

        val nodes = hubState?.optJSONObject("nodes")
        val onlineCount = nodes?.length() ?: 0
        val devices = hubState?.optJSONObject("devices")
        val bindings = devices?.optJSONObject("bindings")?.length() ?: 0
        val lastReply = status?.optJSONObject("lastReply")
        val lastText = lastReply?.optString("text", "") ?: ""
        val lastAt = lastReply?.optString("at", "")?.replace("T", " ")?.take(16) ?: "—"
        val diary = status?.optJSONObject("diary")
        val diaryTime = diary?.optString("time", "23:00") ?: "23:00"
        todayText.text = buildString {
            append("今日语音 ").append(transcriptsTotal).append(" 条 · 屏幕 ")
            if (screenTotal >= 0) append(screenTotal).append(" 条") else append(App.screenUploadsToday()).append(" 次（含本机）")
            append(" · 在线节点 ").append(onlineCount).append(" · 已绑定 ").append(bindings).append(" 台\n")
            append("最近回复 ").append(lastAt)
            if (lastText.isNotBlank()) append(" · ").append(lastText.take(36))
            append("\n每晚总结 ").append(diaryTime)
            if (diaryBrief.isNotBlank()) append(" · 今日已总结：").append(diaryBrief)
        }
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
        try { renderResult(JSONObject(raw), "") } catch (_: Exception) {}
    }

    // ================= 语音链路 =================

    private fun ensureAudioPermission() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
        }
    }

    private fun startVoice() {
        if (busy) {
            stateLabel.text = "还在处理上一条，稍等…"
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingStart = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
            return
        }
        if (!recorder.start()) {
            showError("录音启动失败：检查麦克风权限或设备占用")
            return
        }
        errorText.text = ""
        voiceButton.setBackgroundResource(R.drawable.bg_voice_ring_active)
        voiceButton.text = "●\n聆听中"
        stateLabel.text = "正在聆听… 松手发送（16kHz）"
        recognizedLine.text = "最近识别：—"
        startPulse()
    }

    private fun stopVoice() {
        if (!recorder.isRecording) return
        stopPulse()
        voiceButton.setBackgroundResource(R.drawable.bg_voice_ring)
        voiceButton.text = "按住\n说话"
        val wav = recorder.stop()
        if (wav == null) {
            stateLabel.text = "录音太短，按住多说一会儿"
            return
        }
        processWav(wav)
    }

    private fun processWav(file: File) {
        setBusy(true, "正在转写…（本地识别）")
        bg {
            try {
                val tr = TenonClient.voiceTranscribe(file)
                val text = tr.optString("text", "").trim()
                val pinyin = tr.optString("provider", "")
                if (text.isEmpty()) {
                    ui { finishBusy("没听清，再说一次？"); }
                    return@bg
                }
                ui {
                    recognizedLine.text = "最近识别：" + text
                    stateLabel.text = "正在执行…（云端理解）"
                }
                runCommand(text)
            } catch (e: TenonClient.VoiceHttpException) {
                ui { onHttpError(e) }
            } catch (e: Exception) {
                ui { finishBusy("语音转写失败：" + readable(e)) }
            } finally {
                try { file.delete() } catch (_: Exception) {}
            }
        }
    }

    private fun sendText() {
        val text = textInput.text.toString().trim()
        if (text.isEmpty()) { stateLabel.text = "先输入一句话"; return }
        if (busy) { stateLabel.text = "还在处理上一条，稍等…"; return }
        recognizedLine.text = "最近识别：" + text
        textInput.setText("")
        runCommand(text)
    }

    private fun runCommand(text: String) {
        lastCommandText = text
        setBusy(true, "正在执行…（云端理解）")
        errorText.text = ""
        bg {
            try {
                val result = TenonClient.voiceCommand(text)
                ui {
                    renderResult(result, "")
                    setBusy(false, "完成 · 再说一句")
                    refreshHub()
                }
            } catch (e: TenonClient.VoiceHttpException) {
                ui { onHttpError(e) }
            } catch (e: Exception) {
                ui {
                    finishBusy("执行失败：" + readable(e))
                }
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
        val tts = result.optBoolean("tts", result.optJSONObject("tts")?.optBoolean("ok", false) ?: false)
        replyMeta.text = buildString {
            append("provider ").append(provider)
            if (latency > 0) append(" · ").append(latency).append("ms")
            if (needConfirm) append(" · 需要确认")
            if (tts) append(" · 电脑端已播报")
        }
        val p = prefix.ifBlank { "" }
        if (p.isNotBlank()) recognizedLine.text = "最近识别：—"
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
        if (needConfirm) {
            stateLabel.text = "不可逆操作：请确认后执行"
        }
        val err = result.optString("error", "")
        errorText.text = if (err.isNotBlank()) "错误：" + err else ""
        try { App.setLastResultJson(result.toString()) } catch (_: Exception) {}
        if (App.ttsLocalEnabled()) speak(say)
    }

    private fun stepRow(icon: String, label: String, status: String, summary: String): TextView {
        val line = TextView(this).apply {
            text = icon + " " + label + if (status.isNotBlank()) "  [" + status + "]" else "" +
                    if (summary.isNotBlank()) "  " + summary.take(40) else ""
            textSize = 13f
            setTextColor(if (status.contains("fail") || status.contains("error")) Ui.AMBER else Ui.GREY)
            setPadding(0, Ui.dp(this@MainActivity, 3), 0, 0)
        }
        return line
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
        stateLabel.text = message
    }

    private fun setBusy(b: Boolean, message: String) {
        busy = b
        stateLabel.text = message
    }

    private fun onHttpError(e: TenonClient.VoiceHttpException) {
        setBusy(false, "请求失败")
        val msg = bodyError(e.body)
        if (e.isAuth) {
            showError("令牌无效或缺失（HTTP " + e.code + "）：请到「设置 → 中枢连接」填写操作令牌")
            AlertDialog.Builder(this)
                .setTitle("需要操作令牌")
                .setMessage("语音转写/执行需要操作令牌。\n请到「设置 → 中枢连接」填写电脑端 data/secrets.json 里的 operatorToken。")
                .setPositiveButton("去设置") { _, _ -> openSettings() }
                .setNegativeButton("取消", null)
                .show()
        } else {
            showError("请求失败 HTTP " + e.code + "：" + msg)
        }
    }

    private fun bodyError(body: String): String {
        return try { JSONObject(body).optString("error", body.take(120)) } catch (_: Exception) { body.take(120) }
    }

    private fun readable(e: Exception): String {
        val m = e.message ?: "网络错误"
        return if (m.contains("Failed to connect") || m.contains("Connection refused") || m.contains("timeout")) {
            "连不上中枢（检查同一 WiFi / 中枢地址 / 端口 7410）"
        } else m
    }

    // ================= TTS =================

    private fun initTts() {
        try {
            tts = TextToSpeech(this) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    try { tts?.language = Locale.CHINA } catch (_: Exception) {}
                }
            }
        } catch (e: Exception) {
            LogBus.log("TTS 初始化失败：" + e.message)
        }
    }

    private fun speak(text: String) {
        if (!App.ttsLocalEnabled() || !ttsReady || text.isBlank()) return
        try {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "tenon-reply")
        } catch (_: Exception) {}
    }

    // ================= 动画 / 导航 =================

    private fun startPulse() {
        stopPulse()
        pulse = ObjectAnimator.ofPropertyValuesHolder(
            voiceButton,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.06f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.06f)
        ).apply {
            duration = 520
            repeatCount = ObjectAnimator.INFINITE
            repeatMode = ObjectAnimator.REVERSE
            start()
        }
    }

    private fun stopPulse() {
        pulse?.cancel()
        pulse = null
        voiceButton.scaleX = 1f
        voiceButton.scaleY = 1f
    }

    private fun showError(msg: String) {
        errorText.text = msg
        LogBus.log(msg)
    }

    /** needConfirm 确认/取消（V4 确认闭环 /api/v2/voice/confirm）。 */
    private fun confirmLast(yes: Boolean) {
        if (lastCommandText.isBlank() && lastConfirmId.isBlank()) {
            stateLabel.text = "没有待确认的命令"
            return
        }
        confirmRow.visibility = LinearLayout.GONE
        setBusy(true, if (yes) "正在确认并执行…" else "正在取消…")
        bg {
            val msg = try {
                val r = TenonClient.voiceConfirm(lastConfirmId, yes)
                if (r.optBoolean("cancelled", false)) "已取消"
                else if (r.optBoolean("ok", false)) "已确认并执行：" + r.optString("say", "").take(80)
                else "返回：" + r.optString("error", r.toString().take(120))
            } catch (e: TenonClient.VoiceHttpException) {
                if (e.isAuth) "需要操作令牌（401/403）：去设置填写" else "确认失败 HTTP " + e.code
            } catch (e: Exception) {
                "确认失败：" + (e.message ?: "")
            }
            ui {
                setBusy(false, "完成 · 再说一句")
                replyText.text = msg
                renderStatusAfterChange()
            }
        }
    }

    private fun renderStatusAfterChange() {
        refreshHub()
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    private fun openWeb(title: String, path: String) {
        if (!App.isConfigured()) { showError("请先在设置里配置中枢地址"); return }
        startActivity(Intent(this, WebPageActivity::class.java).apply {
            putExtra(WebPageActivity.EXTRA_TITLE, title)
            putExtra(WebPageActivity.EXTRA_URL, App.baseUrl() + path)
        })
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
