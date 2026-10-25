package com.minzzj.tenon

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/** 轻量内存日志：主界面实时显示最近 200 条，便于真机排障。 */
object LogBus {
    private val lines = ArrayDeque<String>()
    private val listeners = mutableListOf<(String) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)

    fun log(msg: String) {
        val line = fmt.format(Date()) + "  " + msg
        synchronized(lines) {
            lines.addLast(line)
            while (lines.size > 200) lines.removeFirst()
        }
        main.post { listeners.toList().forEach { it(line) } }
    }

    fun snapshot(): String = synchronized(lines) { lines.joinToString("\n") }

    fun clear() = synchronized(lines) { lines.clear() }

    fun addListener(l: (String) -> Unit) { listeners.add(l) }
    fun removeListener(l: (String) -> Unit) { listeners.remove(l) }
}