package com.minzzj.tenon.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * 语音指令（v2.1 超级终端）：SpeechRecognizer + zh-CN。
 * 无引擎 / 无权限 / 识别失败时通过 onError 返回文案，由界面降级为文字输入。
 */
class VoiceRecognizer(
    private val context: Context,
    private val onResult: (String) -> Unit,
    private val onError: (String) -> Unit,
    private val onState: (String) -> Unit = {}
) {

    companion object {
        fun isAvailable(context: Context): Boolean =
            try {
                SpeechRecognizer.isRecognitionAvailable(context)
            } catch (_: Exception) {
                false
            }
    }

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    val isListening: Boolean get() = listening

    fun start(lang: String = "zh-CN") {
        if (listening) return
        if (!isAvailable(context)) {
            onError("本机没有可用的语音识别引擎")
            return
        }
        try {
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer?.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    onState("请说话…")
                }

                override fun onBeginningOfSpeech() {
                    onState("正在听…")
                }

                override fun onRmsChanged(rmsdB: Float) {}

                override fun onBufferReceived(buffer: ByteArray?) {}

                override fun onEndOfSpeech() {
                    onState("识别中…")
                }

                override fun onError(error: Int) {
                    listening = false
                    onError(errorText(error))
                }

                override fun onResults(results: Bundle?) {
                    listening = false
                    val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val text = list?.firstOrNull { it.isNotBlank() } ?: ""
                    if (text.isBlank()) onError("没有识别到内容") else onResult(text)
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val text = list?.firstOrNull { it.isNotBlank() } ?: ""
                    if (text.isNotBlank()) onState("识别中：$text")
                }

                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            }
            listening = true
            recognizer?.startListening(intent)
        } catch (e: Exception) {
            listening = false
            onError("语音识别启动失败：${e.message}")
        }
    }

    fun stop() {
        if (!listening) return
        try {
            recognizer?.stopListening()
        } catch (_: Exception) {
        }
    }

    fun cancel() {
        listening = false
        try {
            recognizer?.cancel()
        } catch (_: Exception) {
        }
    }

    fun destroy() {
        listening = false
        try {
            recognizer?.destroy()
        } catch (_: Exception) {
        }
        recognizer = null
    }

    private fun errorText(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "录音出错"
        SpeechRecognizer.ERROR_CLIENT -> "语音客户端出错"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "没有麦克风权限，已降级为文字输入"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别需要网络（或本地引擎离线包）"
        SpeechRecognizer.ERROR_NO_MATCH -> "没有听清，再说一次？"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "语音识别忙，稍后再试"
        SpeechRecognizer.ERROR_SERVER -> "语音服务出错"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有检测到说话声"
        else -> "语音识别失败（错误码 $error）"
    }
}
