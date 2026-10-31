package com.minzzj.tenon

import android.app.Activity
import android.content.Intent

/**
 * 0.6.7 · 手机端 5 页签导航（与电脑端 super.html 一致）：
 * 首页（MainActivity） / 记录（VoiceRecordsActivity） / 提醒（RemindersActivity）
 * / 文档（DocumentsActivity） / 设置（SettingsActivity）。
 *
 * 设计：
 * - 首页常驻返回栈底，二级页之间切换时先启动目标页再 finish 自己，
 *   返回栈始终保持「首页 → 当前页」两层，不会越堆越深；
 * - 「首页」用 CLEAR_TOP + SINGLE_TOP 回到已存在的 MainActivity（保留录音/TTS 状态）。
 */
object TabNav {
    const val HOME = "home"
    const val RECORDS = "records"
    const val REMINDERS = "reminders"
    const val DOCUMENTS = "documents"
    const val SETTINGS = "settings"

    fun go(from: Activity, tab: String) {
        when (tab) {
            HOME -> goHome(from)
            RECORDS -> open(from, VoiceRecordsActivity::class.java)
            REMINDERS -> open(from, RemindersActivity::class.java)
            DOCUMENTS -> open(from, DocumentsActivity::class.java)
            SETTINGS -> open(from, SettingsActivity::class.java)
        }
    }

    private fun open(from: Activity, target: Class<*>) {
        if (from::class.java == target) return
        from.startActivity(Intent(from, target))
        if (from !is MainActivity) {
            // 从另一个页签切过来：关闭当前页，保持两层栈
            from.finish()
        }
    }

    fun goHome(from: Activity) {
        if (from is MainActivity) return
        from.startActivity(
            Intent(from, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
        )
        from.finish()
    }
}
