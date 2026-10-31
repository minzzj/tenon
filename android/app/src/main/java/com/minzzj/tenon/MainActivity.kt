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
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.text.InputType
import android.text.TextUtils
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
import java.util.Locale

/**
 * 0.6.7 · 手机端首页（与电脑端 super.html 同样的清爽 5 页签）。
 *
 * 结构：页头 → 中枢连接状态 → 大录音按钮（按住/点击，显示录音/识别/执行状态）
 * → 最近回复/执行结果 → 快捷入口（记笔记/总结今天/提醒）→ 文字兜底 → 底部 5 页签。
 * 录音仍走原链路：VoiceRecorder 16k WAV → /voice/transcribe（电脑本地 ASR）→ /voice/command。
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_AUDIO = 2001
        private const val REQ_NOTIFY = 2002
    }

    private lateinit var dot: TextView
    private lateinit var onlineLine: TextView
    private lateinit var hubLine: TextView
    private lateinit var voiceLine: TextView

    private lateinit var voiceButton: TextView
    private lateinit var stateLabel: TextView
    private lateinit var liveLine: TextView
    private lateinit var recognizedLine: TextView

    private lateinit var replyText: TextView
    private lateinit var replyMeta: TextView
    private lateinit var stepsBox: LinearLayout
    private lateinit var confirmRow: LinearLayout
    private lateinit var errorText: TextView

    private lateinit var textInput: EditText
    private lateinit var logLine: TextView

    private val pollHandler = Handler(Looper.getMainLooper())
    private val tickerHandler = Handler(Looper.getMainLooper())

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

    private var lastCommandText = ""
    private var lastConfirmId = ""

    private lateinit var recorder: VoiceRecorder
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pulse: ObjectAnimator? = null
    private var busy = false
    private var pendingStart = false
    private var recordStartAt = 0L
    private var recordTapMode = false
    private var downAt = 0L

    private val ticker = object : Runnable {
        override fun run() {
            if (!recorder.isRecording) return
            val sec = ((SystemClock.elapsedRealtime() - recordStartAt) / 1000L).toInt()
            if (this@MainActivity::liveLine.isInitialized) {
                liveLine.text = "正在录音 " + sec + "s · 音量 " + levelBar(recorder.maxAmplitude)
            }
            tickerHandler.postDelayed(this, 250)
        }
    }

    private val logListener: (String) -> Unit = { line ->
        if (this::logLine.isInitialized) logLine.text = line
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        recorder = VoiceRecorder(this)

        val root = Ui.column(this)

        // ---------- 页头 ----------
        val head = Ui.row(this)
        head.addView(Ui.pageHead(this, "榫卯 · 超级终端",
            "v" + BuildConfig.VERSION_NAME + " · 语音管家"))
        root.addView(head)

        // ---------- 顶部：连接状态（中枢地址 / 在线 / 语音状态） ----------
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

        // ---------- 中央：大录音按钮（按住/点击都可） ----------
        val center = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, Ui.dp(this@MainActivity, 22), 0, Ui.dp(this@MainActivity, 4))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        voiceButton = TextView(this).apply {
            text = "按住说话\n或点一下"
            gravity = Gravity.CENTER
            textSize = 21f
            setTextColor(Ui.PAPER)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            setBackgroundResource(R.drawable.bg_voice_ring)
            layoutParams = LinearLayout.LayoutParams(
                Ui.dp(this@MainActivity, 176), Ui.dp(this@MainActivity, 176)
            ).apply { gravity = Gravity.CENTER_HORIZONTAL }
            isClickable = true
            setOnTouchListener { v, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        downAt = SystemClock.elapsedRealtime()
                        if (busy) {
                            stateLabel.text = "还在处理上一条，稍等…"
                            return@setOnTouchListener true
                        }
                        if (recorder.isRecording) stopVoice() else startVoice()
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        val held = SystemClock.elapsedRealtime() - downAt
                        if (recorder.isRecording) {
                            if (held < 600) {
                                recordTapMode = true
                                stateLabel.text = "正在录音… 再点一下结束"
                            } else {
                                stopVoice()
                            }
                        }
                        v.performClick()
                        true
                    }
                    else -> false
                }
            }
        }
        center.addView(voiceButton)
        stateLabel = Ui.body(this, "点一下开始录音，再点一下结束；也可以按住说话")
        stateLabel.gravity = Gravity.CENTER
        stateLabel.setTextColor(Ui.CYAN)
        stateLabel.textSize = 13f
        stateLabel.setPadding(0, Ui.dp(this, 12), 0, 0)
        center.addView(stateLabel)
        liveLine = Ui.meta(this, "")
        liveLine.gravity = Gravity.CENTER
        liveLine.setTextColor(Ui.AMBER)
        liveLine.visibility = LinearLayout.GONE
        center.addView(liveLine)
        recognizedLine = Ui.body(this, "最近识别：—")
        recognizedLine.gravity = Gravity.CENTER
        recognizedLine.setTextColor(Ui.GREY)
        recognizedLine.textSize = 13f
        recognizedLine.maxLines = 2
        recognizedLine.ellipsize = TextUtils.TruncateAt.END
        recognizedLine.setPadding(0, Ui.dp(this, 6), 0, 0)
        center.addView(recognizedLine)
        root.addView(center)

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

        // ---------- 快捷入口：记笔记 / 总结今天 / 提醒 ----------
        val sQuick = Ui.section(this, "快捷")
        val quickRow = Ui.row(this)
        quickRow.addView(Ui.button(this, "📝 记笔记", true) { quickNote() })
        quickRow.addView(Ui.button(this, "🧠 总结今天") { quickSummary() })
        quickRow.addView(Ui.button(this, "⏰ 提醒") { TabNav.go(this, TabNav.REMINDERS) })
        sQuick.addView(quickRow)
        sQuick.addView(Ui.hint(this, "笔记会出现在「记录」的笔记分段；总结会生成文档，可在「文档」下载/分享。"))
        root.addView(sQuick)

        // ---------- 文字兜底输入 ----------
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

        logLine = Ui.meta(this, "")
        root.addView(logLine)

        // 底部固定 5 页签（首页 / 记录 / 提醒 / 文档 / 设置）
        setContentView(Ui.page(this, root, TabNav.HOME))

        initTts()
        restoreLastResult()
        ensureAudioPermission()
        ensureNotificationPermission()
        ReminderNotifier.ensureChannel(this)
        ReminderWorker.schedule(this)
        handleOpenTabIntent(intent)
        LogBus.addListener(logListener)
    }

    override fun onResume() {
        super.onResume()
        UpdateManager.autoCheck(this)
        refreshHub()
        if (App.remindersEnabled()) pollHandler.postDelayed(reminderPoll, 5_000)
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
        when (intent?.getStringExtra("openTab")) {
            "reminders" -> TabNav.go(this, TabNav.REMINDERS)
            "records", "notes", "ambient" -> TabNav.go(this, TabNav.RECORDS)
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

    override fun onDestroy() {
        LogBus.removeListener(logListener)
        pulse?.cancel()
        tickerHandler.removeCallbacksAndMessages(null)
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
        if (requestCode != REQ_AUDIO) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted && pendingStart) {
            pendingStart = false
            startVoice()
            recordTapMode = true
            stateLabel.text = "麦克风已授权 · 正在录音，再点一下结束"
        } else if (granted) {
            stateLabel.text = "麦克风已授权，点一下开始录音"
        } else {
            pendingStart = false
            showError("未授权麦克风：可在系统权限里开启；也可以直接在下方打字发送。")
            stateLabel.text = "麦克风未授权 · 可用文字输入"
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
            voiceLine.text = "到「设置」填写 operatorToken 后，录音转写与记录读取才会生效。"
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
            stateLabel.text = "录音启动失败"
            return
        }
        errorText.text = ""
        recordStartAt = SystemClock.elapsedRealtime()
        recordTapMode = false
        voiceButton.setBackgroundResource(R.drawable.bg_voice_ring_active)
        voiceButton.text = "●\n录音中"
        stateLabel.text = "正在录音… 松手发送，或再点一下结束"
        liveLine.visibility = LinearLayout.VISIBLE
        liveLine.text = "正在录音 0s · 音量 " + levelBar(0)
        recognizedLine.text = "最近识别：—"
        tickerHandler.removeCallbacks(ticker)
        tickerHandler.post(ticker)
        startPulse()
    }

    private fun stopVoice() {
        if (!recorder.isRecording) return
        stopPulse()
        tickerHandler.removeCallbacks(ticker)
        recordTapMode = false
        voiceButton.setBackgroundResource(R.drawable.bg_voice_ring)
        voiceButton.text = "按住说话\n或点一下"
        liveLine.visibility = LinearLayout.GONE
        val wav = recorder.stop()
        if (wav == null) {
            stateLabel.text = "录音太短，按住多说一会儿"
            return
        }
        processWav(wav)
    }

    private fun processWav(file: File) {
        recognizedLine.text = "识别中…"
        setBusy(true, "识别中…（上传到电脑本地 ASR）")
        bg {
            try {
                val tr = TenonClient.voiceTranscribe(file)
                val text = tr.optString("text", "").trim()
                if (text.isEmpty()) {
                    ui {
                        recognizedLine.text = "最近识别：—"
                        finishBusy("没听清，再说一次？")
                    }
                    return@bg
                }
                ui {
                    recognizedLine.text = "最近识别：" + text
                    stateLabel.text = "执行中…（云端理解）"
                }
                runCommand(text)
            } catch (e: TenonClient.VoiceHttpException) {
                ui { onHttpError(e) }
            } catch (e: Exception) {
                ui { finishBusy("识别失败：" + readable(e)) }
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
        setBusy(true, "执行中…（云端理解）")
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
        val ttsOk = result.optBoolean("tts", result.optJSONObject("tts")?.optBoolean("ok", false) ?: false)
        replyMeta.text = buildString {
            append("provider ").append(provider)
            if (latency > 0) append(" · ").append(latency).append("ms")
            if (needConfirm) append(" · 需要确认")
            if (ttsOk) append(" · 电脑端已播报")
        }
        if (prefix.isNotBlank()) recognizedLine.text = "最近识别：—"
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
        if (needConfirm) stateLabel.text = "不可逆操作：请确认后执行"
        val err = result.optString("error", "")
        errorText.text = if (err.isNotBlank()) "错误：" + err else ""
        try { App.setLastResultJson(result.toString()) } catch (_: Exception) {}
        if (App.ttsLocalEnabled()) speak(say)
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
        stateLabel.text = message
    }

    private fun setBusy(b: Boolean, message: String) {
        busy = b
        stateLabel.text = message
    }

    private fun levelBar(amp: Int): String {
        val n = (amp / 3500).coerceIn(0, 8)
        return "▮".repeat(n) + "▯".repeat(8 - n)
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
        stateLabel.text = "正在保存笔记…"
        bg {
            val msg = try {
                TenonClient.noteCreate(text)
                "已记下 · 可在「记录」查看"
            } catch (e: Exception) {
                "保存失败：" + failure(e)
            }
            ui {
                stateLabel.text = msg
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
        try { JSONObject(body).optString("error", body.take(120)) } catch (_: Exception) { body.take(120) }

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

    // ================= 动画 / 确认 / 工具 =================

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

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
