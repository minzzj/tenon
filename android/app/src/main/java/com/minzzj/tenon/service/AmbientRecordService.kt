package com.minzzj.tenon.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import com.minzzj.tenon.MainActivity
import com.minzzj.tenon.net.TenonClient
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * 0.6.8 · 手机本机 24 小时录制（前台服务）。
 *
 * 链路：AudioRecord 16kHz/16bit/mono 录制约 12 秒 → 写 WAV → 上传
 * `POST /api/v2/voice/ambient-upload`（multipart，file 字段，带 x-tenon-token）→ 删除临时文件 → 继续下一段。
 *
 * - 前台服务类型 microphone（Android 14 需 FOREGROUND_SERVICE_MICROPHONE 权限 + Manifest 声明）；
 * - 常驻通知带「停止 24h 录制」按钮，App 首页 / 悬浮窗都能开关；
 * - 一键唤醒录音时会临时暂停本服务（麦克风只有一个），结束后自动恢复；
 * - 只上传到用户自己的电脑中枢，不上传第三方。
 */
class AmbientRecordService : Service() {
    companion object {
        const val CHANNEL_ID = "tenon-ambient"
        const val NOTIF_ID = 7430
        const val ACTION_STOP = "com.minzzj.tenon.action.AMBIENT_STOP"

        private const val SAMPLE_RATE = 16000
        private const val SEGMENT_SECONDS = 12

        private val lock = Object()
        @Volatile private var pauseRequested = false
        @Volatile private var micReleased = true
        @Volatile private var stopRequested = false

        @Volatile
        var running: Boolean = false
            private set

        fun start(ctx: Context) {
            val i = Intent(ctx, AmbientRecordService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            try {
                ctx.startService(Intent(ctx, AmbientRecordService::class.java).setAction(ACTION_STOP))
            } catch (_: Exception) {
                try { ctx.stopService(Intent(ctx, AmbientRecordService::class.java)) } catch (_: Exception) {}
            }
        }

        /**
         * 一键唤醒前调用：请求暂停并等待麦克风释放（最多 2.5 秒）。
         * 返回 true 表示本服务原本在跑、已尝试暂停；调用方处理完必须 resumeAfterOneTap()。
         */
        fun pauseForOneTap(): Boolean {
            if (!running) return false
            synchronized(lock) {
                pauseRequested = true
                val deadline = System.currentTimeMillis() + 2500
                while (!micReleased) {
                    val remain = deadline - System.currentTimeMillis()
                    if (remain <= 0) break
                    try { lock.wait(remain) } catch (_: InterruptedException) { break }
                }
            }
            try { Thread.sleep(150) } catch (_: InterruptedException) {}
            return true
        }

        fun resumeAfterOneTap() {
            synchronized(lock) {
                pauseRequested = false
                lock.notifyAll()
            }
        }

        fun hasMic(ctx: Context): Boolean =
            ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED

        private fun markMicBusy() {
            synchronized(lock) { micReleased = false }
        }

        private fun markMicFree() {
            synchronized(lock) {
                micReleased = true
                lock.notifyAll()
            }
        }
    }

    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)
    @Volatile private var lastStatus = "正在启动…"

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "24 小时录制", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "手机后台持续录音并上传到你的电脑中枢"
                    setShowBadge(false)
                }
            )
        }
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tenon:ambient24h").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            LogBus.log("24h 录制唤醒锁失败：" + (e.message ?: ""))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            LogBus.log("24h 录制：收到停止请求")
            stopRequested = true
            pauseRequested = false
            markMicFree()
            stopSelf()
            return START_NOT_STICKY
        }
        if (!hasMic(this)) {
            App.setAmbientLastError("未授权麦克风：请在 App 首页允许录音")
            LogBus.log("24h 录制：未授权麦克风，无法启动")
            stopSelf()
            return START_NOT_STICKY
        }
        if (!startForegroundCompat("正在启动 24 小时录制…")) {
            stopSelf()
            return START_NOT_STICKY
        }
        App.setAmbientDesired(true)
        if (running) {
            notifyStatus(lastStatus)
            return START_STICKY
        }
        running = true
        stopRequested = false
        pauseRequested = false
        markMicFree()
        App.setAmbientLastError("")
        worker = Thread { loop() }.also {
            it.isDaemon = true
            it.name = "tenon-ambient-24h"
            it.start()
        }
        return START_STICKY
    }

    private fun startForegroundCompat(text: String): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(
                    NOTIF_ID, buildNotification(text),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                    NOTIF_ID, buildNotification(text),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, buildNotification(text))
            }
            true
        } catch (e: Exception) {
            LogBus.log("24h 录制前台服务启动失败：" + (e.message ?: ""))
            App.setAmbientLastError("前台服务启动失败：" + (e.message ?: ""))
            false
        }
    }

    private fun loop() {
        val minBuf = try {
            AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
        } catch (_: Exception) {
            -1
        }
        if (minBuf <= 0) {
            fail("本机不支持 16kHz 单声道录音")
            return
        }
        val bufBytes = max(minBuf * 2, 6400)
        val buf = ShortArray(bufBytes / 2)
        val chunkSec = App.ambientChunkSec()
        val targetSamples = SAMPLE_RATE * chunkSec
        LogBus.log("24h 录制开始：每段约 " + chunkSec + " 秒")

        while (!stopRequested) {
            if (pauseRequested) {
                notifyStatus("已暂停（一键唤醒录音中）…")
                while (pauseRequested && !stopRequested) sleep(120)
                continue
            }
            @SuppressLint("MissingPermission")
            val rec = try {
                AudioRecord(
                    MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes
                )
            } catch (e: Exception) {
                LogBus.log("24h 录制创建 AudioRecord 失败：" + (e.message ?: ""))
                null
            }
            if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) {
                try { rec?.release() } catch (_: Exception) {}
                fail("无法打开麦克风（可能被其他应用占用）")
                return
            }
            markMicBusy()
            val pcm = ByteArrayOutputStream()
            var total = 0
            try {
                rec.startRecording()
                while (total < targetSamples && !stopRequested) {
                    if (pauseRequested) break
                    val want = min(buf.size, targetSamples - total)
                    val n = try { rec.read(buf, 0, want) } catch (_: Exception) { -1 }
                    if (n <= 0) continue
                    val bytes = ByteArray(n * 2)
                    for (i in 0 until n) {
                        val v = buf[i].toInt()
                        bytes[i * 2] = (v and 0xFF).toByte()
                        bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
                    }
                    pcm.write(bytes, 0, bytes.size)
                    total += n
                }
            } catch (e: Exception) {
                LogBus.log("24h 录制读取失败：" + (e.message ?: ""))
            } finally {
                try { rec.stop() } catch (_: Exception) {}
                try { rec.release() } catch (_: Exception) {}
                markMicFree()
            }
            if (stopRequested) break
            if (pauseRequested) continue
            if (total < SAMPLE_RATE) continue

            if (App.ambientWifiOnly() && !isWifiConnected()) {
                notifyStatus("仅 WiFi 上传：当前不是 WiFi，本段已跳过")
                sleep(1500)
                continue
            }
            val file = File(cacheDir, "tenon-ambient-" + System.currentTimeMillis() + ".wav")
            try {
                FileOutputStream(file).use { fos ->
                    fos.write(wavHeader(total * 2))
                    pcm.writeTo(fos)
                }
                val r = TenonClient.voiceAmbientUpload(file)
                val text = r.optString("text", "").trim()
                App.bumpAmbientSegment()
                val stamp = timeFmt.format(Date())
                App.setAmbientLast(
                    stamp + " 已上传第 " + App.ambientSegmentsToday() + " 段" +
                            (if (text.isNotBlank()) " · " + text.take(30) else "")
                )
                App.setAmbientLastError("")
                notifyStatus("已录 " + App.ambientSegmentsToday() + " 段 · 最近 " + stamp + " 上传成功")
                LogBus.log("24h 录制：第 " + App.ambientSegmentsToday() + " 段上传成功")
            } catch (e: TenonClient.VoiceHttpException) {
                val msg = when {
                    e.isAuth -> "需要操作令牌（HTTP " + e.code + "）"
                    e.code == 404 -> "电脑端接口未就绪（HTTP 404）"
                    else -> "上传失败 HTTP " + e.code
                }
                App.setAmbientLastError(msg)
                App.setAmbientLast("上传失败 · " + timeFmt.format(Date()) + " · " + msg)
                notifyStatus(msg)
                LogBus.log("24h 录制：" + msg)
                if (e.isAuth || e.code == 404) sleep(20_000)
            } catch (e: Exception) {
                val msg = (e.message ?: "网络错误").take(120)
                App.setAmbientLastError(msg)
                App.setAmbientLast("上传失败 · " + timeFmt.format(Date()) + " · " + msg)
                notifyStatus("上传失败：" + msg.take(60))
                LogBus.log("24h 录制上传失败：" + msg)
                sleep(5_000)
            } finally {
                try { file.delete() } catch (_: Exception) {}
            }
        }
        LogBus.log("24h 录制循环结束")
    }

    private fun fail(message: String) {
        App.setAmbientLastError(message)
        LogBus.log("24h 录制停止：" + message)
        stopRequested = true
        markMicFree()
        stopSelf()
    }

    private fun isWifiConnected(): Boolean {
        return try {
            val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return false
            val net = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(net) ?: return false
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
        } catch (_: Exception) { false }
    }

    private fun sleep(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) {}
    }

    private fun notifyStatus(text: String) {
        lastStatus = text
        try {
            val nm = getSystemService(NotificationManager::class.java) ?: return
            nm.notify(NOTIF_ID, buildNotification(text))
        } catch (_: Exception) {}
    }

    private fun buildNotification(text: String): Notification {
        val content = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, AmbientRecordService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("榫卯 · 24 小时录制")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
        try {
            builder.addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.ic_media_pause),
                    "停止 24h 录制",
                    stop
                ).build()
            )
        } catch (_: Exception) {}
        return builder.build()
    }

    private fun wavHeader(dataSize: Int): ByteArray {
        val totalSize = dataSize + 36
        val byteRate = SAMPLE_RATE * 2
        val h = ByteArray(44)
        fun putStr(off: Int, s: String) { for (i in s.indices) h[off + i] = s[i].code.toByte() }
        fun putInt(off: Int, v: Int) {
            h[off] = (v and 0xFF).toByte()
            h[off + 1] = ((v shr 8) and 0xFF).toByte()
            h[off + 2] = ((v shr 16) and 0xFF).toByte()
            h[off + 3] = ((v shr 24) and 0xFF).toByte()
        }
        fun putShort(off: Int, v: Int) {
            h[off] = (v and 0xFF).toByte()
            h[off + 1] = ((v shr 8) and 0xFF).toByte()
        }
        putStr(0, "RIFF"); putInt(4, totalSize); putStr(8, "WAVE")
        putStr(12, "fmt "); putInt(16, 16); putShort(20, 1); putShort(22, 1)
        putInt(24, SAMPLE_RATE); putInt(28, byteRate); putShort(32, 2); putShort(34, 16)
        putStr(36, "data"); putInt(40, dataSize)
        return h
    }

    override fun onDestroy() {
        stopRequested = true
        pauseRequested = false
        markMicFree()
        running = false
        try { worker?.join(2000) } catch (_: InterruptedException) {}
        worker = null
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {}
        wakeLock = null
        App.setAmbientDesired(false)
        LogBus.log("24h 录制已停止")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
