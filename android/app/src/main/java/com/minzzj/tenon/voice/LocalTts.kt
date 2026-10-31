package com.minzzj.tenon.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import java.util.Locale

/**
 * 0.6.8 · 手机本地 TTS（App 级单例）。
 *
 * 为什么单独抽出来：
 * - 首页「一键唤醒」卡片与悬浮窗走同一条链路，回复都由手机本机朗读；
 * - 电脑端对 source=android 的指令会跳过扬声器播报，手机不能依赖电脑出声；
 * - TTS 用 Application Context 初始化，退出页面后仍可播报（悬浮窗场景）。
 */
object LocalTts {
    private var tts: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile private var initializing = false
    @Volatile private var pending: String? = null

    /** 幂等初始化；主线程调用。 */
    fun init(ctx: Context) {
        if (tts != null || initializing) return
        initializing = true
        try {
            tts = TextToSpeech(ctx.applicationContext) { status ->
                ready = status == TextToSpeech.SUCCESS
                if (ready) {
                    try { tts?.language = Locale.CHINA } catch (_: Exception) {}
                    val p = pending
                    pending = null
                    if (!p.isNullOrBlank()) speakNow(p)
                } else {
                    LogBus.log("本机 TTS 初始化失败（status=$status），回复只用文字显示")
                }
            }
        } catch (e: Exception) {
            initializing = false
            LogBus.log("本机 TTS 初始化异常：" + (e.message ?: ""))
        }
    }

    /** 朗读一句回复（受「设置 → 手机朗读回复」开关控制）。 */
    fun speak(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        if (!App.ttsLocalEnabled()) return
        init(App.instance)
        if (ready) speakNow(t) else pending = t
    }

    private fun speakNow(text: String) {
        try {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "tenon-reply")
        } catch (e: Exception) {
            LogBus.log("本机 TTS 播报失败：" + (e.message ?: ""))
        }
    }

    /** 停止当前播报（退出/关闭悬浮窗时用，避免声音一直留在后台）。 */
    fun stop() {
        try { tts?.stop() } catch (_: Exception) {}
    }
}
