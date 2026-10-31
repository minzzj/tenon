package com.minzzj.tenon

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * 轻量内存日志：主界面实时显示最近 200 条，便于真机排障。
 * 0.6.10：同时写入 logcat（tag=Tenon），真机连 USB 时 `adb logcat -s Tenon:V` 就能看到
 * 屏幕采集的关键步骤（授权 / 服务 / 虚拟屏 / 截屏 / 上传），用户反馈问题时可直接抓日志。
 */
object LogBus {
    private val lines = ArrayDeque<String>()
    private val listeners = mutableListOf<(String) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)

    fun log(msg: String) {
        val line = fmt.format(Date()) + "  " + msg
        // 同步到 logcat（adb logcat -s Tenon:V）；任何异常都不影响主流程
        try { Log.i("Tenon", msg) } catch (_: Throwable) {}
        synchronized(lines) {
            lines.addLast(line)
            while (lines.size > 200) lines.removeFirst()
        }
        main.post { listeners.toList().forEach { it(line) } }
    }

    /** 屏幕采集专用：带步骤前缀，便于在 logcat 里 grep「[screen]」。 */
    fun screen(step: String, msg: String = "") {
        log("[screen] " + step + (if (msg.isBlank()) "" else " · " + msg))
    }

    fun snapshot(): String = synchronized(lines) { lines.joinToString("\n") }

    fun clear() = synchronized(lines) { lines.clear() }

    fun addListener(l: (String) -> Unit) { listeners.add(l) }
    fun removeListener(l: (String) -> Unit) { listeners.remove(l) }
}
