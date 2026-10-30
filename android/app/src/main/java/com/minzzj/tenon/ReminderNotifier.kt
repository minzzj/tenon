package com.minzzj.tenon

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.minzzj.tenon.net.TenonClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * V5 提醒本地通知：
 * - 频道「提醒」（channel id = tenon-reminders，IMPORTANCE_HIGH）
 * - 拉取 GET /api/v2/reminders/pending，去重后在手机本地弹通知（不依赖电脑端推送）
 * - 点击通知打开 App；前台每 30s 由 MainActivity 调用，后台每 15 分钟由 WorkManager 兜底。
 */
object ReminderNotifier {
    const val CHANNEL_ID = "tenon-reminders"
    const val CHANNEL_NAME = "提醒"
    private const val PREFS = "tenon-notify"
    private const val KEY_NOTIFIED = "notifiedIds"
    private const val KEY_LAST_POLL = "lastPollAt"

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "榫卯提醒：到点在本机弹通知（点击打开 App）"
                    enableVibration(true)
                }
            )
        }
    }

    fun canPost(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            return ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    fun notifiedIds(ctx: Context): MutableSet<String> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_NOTIFIED, "") ?: ""
        return raw.split(",").filter { it.isNotBlank() }.toMutableSet()
    }

    private fun saveNotified(ctx: Context, ids: MutableSet<String>) {
        // 只保留最近 200 个 id，避免无限增长
        val list = ids.toList().takeLast(200)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_NOTIFIED, list.joinToString(",")).apply()
    }

    /** 轮询 pending 并弹通知；返回本次新通知条数（-1 = 请求失败）。 */
    fun pollPending(ctx: Context): Int {
        ensureChannel(ctx)
        val resp = try {
            TenonClient.remindersPending()
        } catch (e: Exception) {
            LogBus.log("提醒轮询失败：" + (e.message ?: ""))
            return -1
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_LAST_POLL, System.currentTimeMillis()).apply()
        val items = firstArray(resp, "items", "pending", "reminders", "data") ?: return 0
        if (!canPost(ctx)) {
            LogBus.log("提醒轮询：无通知权限，暂不弹通知")
            return 0
        }
        val already = notifiedIds(ctx)
        var fresh = 0
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            val id = o.optString("id", o.optString("reminderId", "")).ifBlank { "idx-" + o.hashCode() }
            if (already.contains(id)) continue
            val text = o.optString("text", o.optString("title", "提醒"))
            val at = o.optString("at", o.optString("when", ""))
            notify(ctx, id, text, at)
            already.add(id)
            fresh += 1
        }
        saveNotified(ctx, already)
        if (fresh > 0) LogBus.log("提醒轮询：新提醒 " + fresh + " 条")
        return fresh
    }

    fun notify(ctx: Context, id: String, text: String, at: String = "") {
        ensureChannel(ctx)
        if (!canPost(ctx)) return
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openTab", "reminders")
        }
        val pi = PendingIntent.getActivity(
            ctx, id.hashCode() and 0xFFFF, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val sub = if (at.isNotBlank()) "时间：" + at else "榫卯提醒"
        val n = Notification.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("⏰ " + text.take(60))
            .setContentText(sub)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            ctx.getSystemService(NotificationManager::class.java).notify(
                ("reminder:" + id).hashCode() and 0x0FFFFFFF, n
            )
        } catch (e: Exception) {
            LogBus.log("通知发送失败：" + (e.message ?: ""))
        }
    }

    /** 兼容不同后端字段：取第一个数组字段。 */
    fun firstArray(o: JSONObject?, vararg keys: String): JSONArray? {
        if (o == null) return null
        for (k in keys) {
            val a = o.optJSONArray(k)
            if (a != null) return a
        }
        return null
    }
}
