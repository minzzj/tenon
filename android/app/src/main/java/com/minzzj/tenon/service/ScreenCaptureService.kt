package com.minzzj.tenon.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import com.minzzj.tenon.MainActivity
import com.minzzj.tenon.R
import com.minzzj.tenon.net.TenonClient
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/**
 * V4 屏幕内容采集前台服务：
 * 用户授权 MediaProjection 后，每 App.screenInterval() 秒截屏一次 → 缩放到 ≤960px → JPEG(55) →
 * POST /api/v2/voice/screen {source:'phone', app, title, imageBase64}。
 * Android 14 需 manifest 声明 foregroundServiceType=mediaProjection + FOREGROUND_SERVICE_MEDIA_PROJECTION 权限。
 */
class ScreenCaptureService : Service() {
    companion object {
        const val CHANNEL_ID = "tenon-screen"
        const val NOTIF_ID = 7420
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        @Volatile
        var running: Boolean = false
            private set

        fun start(ctx: Context, resultCode: Int, resultData: Intent) {
            val i = Intent(ctx, ScreenCaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, ScreenCaptureService::class.java))
        }
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handler: Handler? = null
    private var uploads = 0
    private var failures = 0
    private var lastError = ""
    private val uploading = AtomicBoolean(false)
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)

    private val tick = object : Runnable {
        override fun run() {
            try {
                captureOnce()
            } catch (e: Exception) {
                lastError = "截屏失败：" + (e.message ?: "")
                LogBus.log(lastError)
            }
            val intervalMs = App.screenInterval() * 1000L
            handler?.postDelayed(this, intervalMs)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "屏幕内容采集", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val code = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        // 先进入前台（mediaProjection 类型），再创建 MediaProjection
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, buildNotification("正在准备屏幕采集…"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, buildNotification("正在准备屏幕采集…"))
        }
        if (code == 0 || data == null) {
            lastError = "缺少屏幕授权，请重新在设置里点「授权并开启」"
            notify(lastError)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!startCapture(code, data)) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    private fun startCapture(code: Int, data: Intent): Boolean {
        return try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = mpm.getMediaProjection(code, data)
            val metrics = resources.displayMetrics
            val w = metrics.widthPixels
            val h = metrics.heightPixels
            imageReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
            virtualDisplay = projection?.createVirtualDisplay(
                "tenon-screen", w, h, metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader?.surface, null, null
            )
            projection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    LogBus.log("屏幕采集授权被系统/用户停止")
                    stopSelf()
                }
            }, Handler(Looper.getMainLooper()))
            running = true
            handler = Handler(Looper.getMainLooper())
            notify("屏幕采集已开启 · 每 " + App.screenInterval() + " 秒一次")
            LogBus.log("屏幕采集服务启动，间隔 " + App.screenInterval() + " 秒")
            handler?.postDelayed(tick, 2500)
            true
        } catch (e: Exception) {
            lastError = "屏幕采集启动失败：" + (e.message ?: "")
            LogBus.log(lastError)
            notify(lastError)
            cleanup()
            false
        }
    }

    private fun captureOnce() {
        val reader = imageReader ?: return
        val image = try {
            reader.acquireLatestImage()
        } catch (e: Exception) {
            null
        } ?: return
        val bitmap: Bitmap
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val raw = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888
            )
            raw.copyPixelsFromBuffer(buffer)
            bitmap = Bitmap.createBitmap(raw, 0, 0, image.width, image.height)
            if (raw !== bitmap) raw.recycle()
        } catch (e: Exception) {
            lastError = "截屏解码失败：" + (e.message ?: "")
            return
        } finally {
            try { image.close() } catch (_: Exception) {}
        }
        val scaled: Bitmap = if (bitmap.width > 960) {
            val w = 960
            val h = (bitmap.height * (960f / bitmap.width)).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(bitmap, w, h, true).also { bitmap.recycle() }
        } else bitmap
        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 55, baos)
        scaled.recycle()
        val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        if (!uploading.compareAndSet(false, true)) return
        Thread {
            try {
                TenonClient.voiceScreen(
                    imageBase64 = b64,
                    app = "phone",
                    title = "手机屏幕 · " + App.deviceName(),
                    text = "",
                    blacklist = App.screenBlacklist()
                )
                uploads += 1
                App.bumpScreenUpload()
                App.setScreenLast(timeFmt.format(Date()) + " 已上报（第 " + App.screenUploadsToday() + " 次）")
                notify("已上报 " + uploads + " 次 · 每 " + App.screenInterval() + " 秒采集")
            } catch (e: Exception) {
                failures += 1
                lastError = e.message ?: "上报失败"
                App.setScreenLastError(lastError)
                notify("上报失败（" + failures + "）：" + lastError.take(80))
                LogBus.log("屏幕上报失败：" + lastError)
            } finally {
                uploading.set(false)
            }
        }.start()
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("榫卯 · 屏幕内容采集")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun notify(text: String) {
        try {
            getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
        } catch (_: Exception) {
        }
    }

    private fun cleanup() {
        running = false
        handler?.removeCallbacksAndMessages(null)
        handler = null
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
    }

    override fun onDestroy() {
        cleanup()
        LogBus.log("屏幕采集服务已停止")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
