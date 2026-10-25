package com.minzzj.tenon.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.IBinder
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import com.minzzj.tenon.MainActivity
import com.minzzj.tenon.R
import com.minzzj.tenon.net.TenonClient

/**
 * 剪贴板同步前台服务（契约 §5「前台服务 + ClipboardManager」）：
 * - 每 3 秒拉取中枢最新剪贴板 → 有变化则写入本机剪贴板 + 更新通知
 * - 本机剪贴板变化 → 上报中枢（Android 10+ 后台读取受限，见 README）
 */
class ClipboardSyncService : Service() {
    companion object {
        @Volatile
        var running: Boolean = false
            private set

        const val CHANNEL_ID = "tenon-sync"
        const val NOTIF_ID = 7410

        fun start(ctx: Context) {
            val i = Intent(ctx, ClipboardSyncService::class.java)
            ctx.startForegroundService(i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, ClipboardSyncService::class.java))
        }
    }

    private var looping = false
    private var worker: Thread? = null
    private var clipboard: ClipboardManager? = null
    private var lastLocal = ""
    private var lastRemote = ""

    private val clipListener = ClipboardManager.OnPrimaryClipChangedListener {
        try {
            val clip = clipboard?.primaryClip
            if (clip != null && clip.itemCount > 0) {
                val text = clip.getItemAt(0).coerceToText(this).toString()
                if (text.isNotBlank() && text != lastLocal && text != lastRemote && text.length <= 20000) {
                    lastLocal = text
                    val kind = if (text.startsWith("http://") || text.startsWith("https://")) "link" else "text"
                    Thread {
                        if (TenonClient.shareClipboard(kind, text)) {
                            LogBus.log("剪贴板已上报（${text.take(36)}）")
                        }
                    }.start()
                }
            }
        } catch (e: Exception) {
            LogBus.log("读取本机剪贴板受限：${e.message}")
        }
    }

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notif_channel_name),
                NotificationManager.IMPORTANCE_LOW
            )
            ch.description = getString(R.string.notif_channel_desc)
            nm.createNotificationChannel(ch)
        }
        startForeground(NOTIF_ID, buildNotification("已开启：双向剪贴板同步"))
        clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard?.addPrimaryClipChangedListener(clipListener)
        running = true
        looping = true
        worker = Thread { pollLoop() }.also { it.isDaemon = true; it.start() }
        LogBus.log("剪贴板同步服务已启动（前台服务）")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun pollLoop() {
        while (looping) {
            try {
                if (App.isConfigured()) {
                    val obj = TenonClient.latestClipboard()
                    val text = obj?.optString("text", "") ?: ""
                    if (text.isNotBlank() && text != lastRemote && text != lastLocal) {
                        lastRemote = text
                        clipboard?.setPrimaryClip(ClipData.newPlainText("榫卯同步", text))
                        lastLocal = text
                        LogBus.log("已同步远端剪贴板到本机（${text.take(36)}）")
                        updateNotification("已同步剪贴板：${text.take(30)}")
                    }
                }
            } catch (e: Exception) {
                LogBus.log("剪贴板轮询失败：${e.message}")
            }
            try {
                Thread.sleep(3000)
            } catch (_: InterruptedException) {
                break
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("榫卯 · 剪贴板同步")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.notify(NOTIF_ID, buildNotification(text))
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        looping = false
        worker?.interrupt()
        try {
            clipboard?.removePrimaryClipChangedListener(clipListener)
        } catch (_: Exception) {
        }
        running = false
        LogBus.log("剪贴板同步服务已停止")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}