package com.minzzj.tenon.service

import android.app.Notification
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import com.minzzj.tenon.net.TenonClient

/**
 * 通知镜像（契约 §5）：读取系统通知的 app/title/text 上报中枢，供电脑端查看。
 * 需要用户在系统设置里手动授予「通知使用权」。
 */
class TenonNotificationListener : NotificationListenerService() {
    companion object {
        @Volatile
        var connected: Boolean = false
            private set

        fun isEnabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            return flat.split(":").any { it.contains(ctx.packageName) }
        }
    }

    private var lastKey = ""
    private var lastAt = 0L

    override fun onListenerConnected() {
        super.onListenerConnected()
        connected = true
        LogBus.log("通知监听已连接")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        connected = false
        LogBus.log("通知监听已断开")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val n = sbn ?: return
        if (n.packageName == packageName) return
        if (!App.notificationsEnabled()) return
        val extras = n.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
        val text = (extras.getCharSequence(Notification.EXTRA_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT))?.toString()?.trim() ?: ""
        if (title.isBlank() && text.isBlank()) return
        val appName = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(n.packageName, 0)).toString()
        } catch (_: Exception) {
            n.packageName
        }
        val key = n.key + "|" + title + "|" + text
        val now = System.currentTimeMillis()
        if (key == lastKey && now - lastAt < 3000) return
        lastKey = key
        lastAt = now
        Thread {
            val ok = TenonClient.relayNotification(appName, title.take(120), text.take(200))
            if (ok) LogBus.log("通知已镜像：$appName · ${title.take(30)}")
            else LogBus.log("通知镜像失败（中枢未提供 POST /api/v2/link/notify）")
        }.start()
    }
}