package com.minzzj.tenon.voice

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import com.minzzj.tenon.VoiceRecorder
import com.minzzj.tenon.net.TenonClient
import com.minzzj.tenon.service.AmbientRecordService
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 0.6.8 · 一键唤醒（首页卡片与悬浮窗共用的一条链路）。
 *
 * 点一下开始录一句话（不喊唤醒词）→ 再点一下结束 → 上传 WAV 到电脑本地 ASR
 * `/api/v2/voice/transcribe` → 拿到文字 → `POST /api/v2/voice/command {text, source:"android"}`
 * → 手机本地 TextToSpeech 播报回复（电脑端对 android 来源跳过播报）。
 *
 * 与 24h 录制的关系：两个入口完全分开，但麦克风只有一个。若 24h 录制正在跑，
 * 一键唤醒会先临时暂停它，录完/处理完自动恢复；状态里会明确写出来。
 */
class OneTapVoice private constructor(private val app: Context) {
    interface Listener {
        /** state 取值：待机 / 正在录音… / 识别中… / 执行中… / 已执行。 */
        fun onState(state: String, detail: String)
        fun onHeard(text: String)
        fun onReply(say: String, result: JSONObject?)
        fun onError(message: String)
    }

    companion object {
        const val IDLE = "待机"
        const val RECORDING = "正在录音…"
        const val TRANSCRIBING = "识别中…"
        const val EXECUTING = "执行中…"
        const val DONE = "已执行"

        @Volatile private var singleton: OneTapVoice? = null

        fun get(ctx: Context): OneTapVoice =
            singleton ?: synchronized(this) {
                singleton ?: OneTapVoice(ctx.applicationContext).also { singleton = it }
            }

        fun hasMic(ctx: Context): Boolean =
            ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
    }

    private val main = Handler(Looper.getMainLooper())
    private val partialHandler = Handler(Looper.getMainLooper())
    @Volatile private var partialBusy = false
    private val listeners = CopyOnWriteArrayList<Listener>()
    /** 处理中（保存/识别/执行），防止连点重入。 */
    private val gate = AtomicBoolean(false)
    @Volatile private var starting = false
    @Volatile private var recorder: VoiceRecorder? = null
    @Volatile private var pausedAmbient = false

    @Volatile var state: String = IDLE
        private set
    @Volatile var lastHeard: String = ""
        private set
    @Volatile var lastReply: String = ""
        private set

    init {
        LocalTts.init(app)
    }

    val isRecording: Boolean get() = recorder?.isRecording == true

    fun addListener(l: Listener) {
        if (!listeners.contains(l)) listeners.add(l)
        LocalTts.init(app)
        main.post {
            l.onState(state, "")
            if (lastHeard.isNotBlank()) l.onHeard(lastHeard)
            if (lastReply.isNotBlank()) l.onReply(lastReply, null)
        }
    }

    fun removeListener(l: Listener) {
        listeners.remove(l)
    }

    /** 首页/悬浮窗按钮统一入口：正在录音就结束并识别，否则开始录一句。 */
    fun toggle() {
        if (isRecording) stopAndProcess() else start()
    }

    fun start() {
        if (gate.get()) {
            emitError("还在处理上一条，稍等…")
            return
        }
        if (starting) return
        if (!hasMic(app)) {
            emitError("未授权麦克风：请先在 App 里允许录音")
            return
        }
        starting = true
        state = RECORDING
        pushState(RECORDING, "准备麦克风…")
        Thread {
            val paused = try {
                AmbientRecordService.pauseForOneTap()
            } catch (_: Exception) {
                false
            }
            val rec = VoiceRecorder(app)
            val ok = rec.start()
            main.post {
                starting = false
                if (!ok) {
                    if (paused) AmbientRecordService.resumeAfterOneTap()
                    state = IDLE
                    pushState(IDLE, "")
                    emitError("录音启动失败：检查麦克风是否被其他应用占用")
                } else {
                    recorder = rec
                    pausedAmbient = paused
                    state = RECORDING
                    pushState(
                        RECORDING,
                        if (paused) "24h 录制已临时暂停，再点一下结束" else "再点一下结束并识别"
                    )
                    LogBus.log("一键唤醒：开始录音")
                    startPartialLoop()
                }
            }
        }.start()
    }

    private fun stopPartialLoop() {
        partialHandler.removeCallbacksAndMessages(null)
        partialBusy = false
    }

    private fun startPartialLoop() {
        stopPartialLoop()
        partialHandler.postDelayed(object : Runnable {
            override fun run() {
                val rec = recorder
                if (rec == null || !rec.isRecording || gate.get()) return
                if (partialBusy) { partialHandler.postDelayed(this, 1200); return }
                val snap = try { rec.snapshotWav() } catch (_: Exception) { null }
                if (snap == null) { partialHandler.postDelayed(this, 1200); return }
                partialBusy = true
                Thread {
                    try {
                        val tr = TenonClient.voiceTranscribe(snap)
                        val text = tr.optString("text", "").trim()
                        if (text.isNotBlank() && text != lastHeard) {
                            lastHeard = text
                            emit { it.onHeard(text) }
                        }
                    } catch (_: Exception) {
                    } finally {
                        try { snap.delete() } catch (_: Exception) {}
                        partialBusy = false
                    }
                }.start()
                // 如果还在录音继续下一轮
                partialHandler.postDelayed(this, 2400)
            }
        }, 2400)
    }

    private fun stopAndProcess() {
        val rec = recorder ?: return
        stopPartialLoop()
        recorder = null
        gate.set(true)
        state = TRANSCRIBING
        pushState(TRANSCRIBING, "正在保存录音…")
        Thread {
            try {
                val file = rec.stop()
                resumeAmbient()
                if (file == null) {
                    idle("录音太短，点一下再说一句")
                    return@Thread
                }
                process(file)
            } catch (e: Exception) {
                idle("")
                emitError(failure(e))
            } finally {
                gate.set(false)
            }
        }.start()
    }

    /** 放弃当前录音（退出首页时调用；不会上传）。 */
    fun cancel() {
        stopPartialLoop()
        starting = false
        val rec = recorder
        recorder = null
        if (rec != null) {
            try { rec.cancel() } catch (_: Exception) {}
        }
        resumeAmbient()
        gate.set(false)
        state = IDLE
        pushState(IDLE, "")
    }

    private fun process(file: File) {
        try {
            val tr = TenonClient.voiceTranscribe(file)
            val text = tr.optString("text", "").trim()
            if (text.isEmpty()) {
                idle("没听清，再说一次？")
                return
            }
            lastHeard = text
            emit { it.onHeard(text) }
            LogBus.log("一键唤醒：听到「" + text.take(40) + "」")
            state = EXECUTING
            pushState(EXECUTING, "电脑端理解并执行")
            val result = TenonClient.voiceCommand(text)
            val say = result.optString("say", result.optString("reply", "")).trim()
            lastReply = say
            try { App.setLastResultJson(result.toString()) } catch (_: Exception) {}
            state = DONE
            pushState(DONE, "回复已在本机朗读")
            emit { it.onReply(say, result) }
            LogBus.log("一键唤醒：回复「" + say.take(40) + "」")
            if (say.isNotBlank()) LocalTts.speak(say)
        } catch (e: Exception) {
            idle("")
            emitError(failure(e))
        } finally {
            try { file.delete() } catch (_: Exception) {}
        }
    }

    private fun resumeAmbient() {
        if (pausedAmbient) {
            pausedAmbient = false
            try { AmbientRecordService.resumeAfterOneTap() } catch (_: Exception) {}
        }
    }

    private fun idle(detail: String) {
        state = IDLE
        pushState(IDLE, detail)
    }

    private fun pushState(s: String, detail: String) {
        state = s
        emit { it.onState(s, detail) }
    }

    private fun emitError(message: String) {
        LogBus.log("一键唤醒：" + message)
        emit { it.onError(message) }
    }

    /** 所有回调切到主线程，界面与悬浮窗都安全。 */
    private fun emit(block: (Listener) -> Unit) {
        main.post {
            for (l in listeners) {
                try { block(l) } catch (e: Exception) { Log.e("TenonOneTap", "listener", e) }
            }
        }
    }

    private fun failure(e: Exception): String {
        if (e is TenonClient.VoiceHttpException) {
            return when {
                e.isAuth -> "需要操作令牌（HTTP " + e.code + "）：到「设置 → 中枢连接」填写"
                e.code == 404 -> "电脑端接口未就绪（HTTP 404）"
                else -> "HTTP " + e.code + "：" + bodyError(e.body)
            }
        }
        val m = e.message ?: "网络错误"
        return if (m.contains("Failed to connect") || m.contains("Connection refused") ||
            m.contains("timeout") || m.contains("timed out")
        ) {
            "连不上中枢（同一 WiFi / 中枢地址 / 电脑 App 是否运行）"
        } else m.take(120)
    }

    private fun bodyError(body: String): String =
        try {
            JSONObject(body).optString("error", body.take(100))
        } catch (_: Exception) {
            body.take(100)
        }
}
