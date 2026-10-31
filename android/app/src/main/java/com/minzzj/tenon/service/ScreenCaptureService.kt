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
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import com.minzzj.tenon.MainActivity
import com.minzzj.tenon.net.TenonClient
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * V4 屏幕内容采集前台服务：
 * 用户授权 MediaProjection 后，每 App.screenInterval() 秒截屏一次 → 缩放到 ≤960px → JPEG(55) →
 * POST /api/v2/voice/screen {source:'phone', app, title, imageBase64}。
 *
 * 0.6.10 修复要点（0.6.9 在 Android 14 上必崩，报 ForegroundServiceDidNotStartInTimeException）：
 *  1. 设置页会因开关监听回环在 startForegroundService 之后立刻 stopService，导致服务来不及
 *     调用 startForeground 就被系统「Bringing down service while still waiting for start foreground」，
 *     随后进程被杀（用户看到「该任务无响应」、开关不亮、零记录）。这里在 onStartCommand 里
 *     **第一件事**就 startForeground，并且即使失败也不让异常逃出去。
 *  2. 没有授权 token 时（START_STICKY 被系统重启）**不要**启动前台服务，直接退出，
 *     避免 Android 14 用 mediaProjection 类型启动 FGS 时抛 SecurityException。
 *  3. 重复授权前先停掉旧 MediaProjection（Android 14 的授权 token 一次性，旧的不停会冲突）。
 *  4. 截屏/压缩/上传全部在后台线程；关键步骤写 LogBus（同时写 logcat，tag=Tenon）。
 *  5. 中枢返回 stored=false（图里没识别到文字）不再当成功：明确显示「已收到但未入库」。
 */
class ScreenCaptureService : Service() {
    companion object {
        const val CHANNEL_ID = "tenon-screen"
        const val NOTIF_ID = 7420
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        /** 真正在采集（虚拟屏已创建、定时器已开跑）。 */
        @Volatile
        var running: Boolean = false
            private set

        /** 已收到授权、正在启动（startForegroundService~虚拟屏创建完成之间）。 */
        @Volatile
        var starting: Boolean = false
            private set

        /** 最近一次服务内部错误，设置页自检行直接显示。 */
        @Volatile
        var serviceError: String = ""
            private set

        /** 是否是用户主动点的「暂停」——此时 MediaProjection.onStop 不该记成错误。 */
        @Volatile
        private var stopRequested: Boolean = false

        /** 开关是否应显示为「开」：启动中也算开，避免设置页把正在启动的服务当成停止。 */
        fun isActive(): Boolean = running || starting

        fun start(ctx: Context, resultCode: Int, resultData: Intent) {
            stopRequested = false
            val i = Intent(ctx, ScreenCaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData)
            LogBus.screen("请求启动前台服务", "resultCode=" + resultCode)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            stopRequested = true
            LogBus.screen("请求停止服务")
            try { ctx.stopService(Intent(ctx, ScreenCaptureService::class.java)) } catch (_: Exception) {}
        }

        internal fun markError(msg: String) {
            serviceError = msg
            starting = false
            running = false
            App.setScreenLastError(msg)
        }
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handler: Handler? = null
    private var workerThread: HandlerThread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var uploads = 0
    private var failures = 0
    private var missStreak = 0
    private var recreates = 0
    private val uploading = AtomicBoolean(false)
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)

    private val tick = object : Runnable {
        override fun run() {
            try {
                captureOnce()
            } catch (e: Exception) {
                LogBus.screen("截屏循环异常", e.message ?: e.javaClass.simpleName)
                serviceError = "截屏失败：" + (e.message ?: "")
                App.setScreenLastError(serviceError)
            }
            val intervalMs = App.screenInterval() * 1000L
            handler?.postDelayed(this, intervalMs)
        }
    }

    override fun onCreate() {
        super.onCreate()
        // 截屏/压缩/上传全部放到后台线程，避免主线程阻塞导致系统弹「应用无响应」
        workerThread = HandlerThread("tenon-screen-capture").also { it.start() }
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

        // 没有授权（典型：START_STICKY 被系统重启，intent 为 null）：
        // 此时绝不能 startForeground(mediaProjection)——Android 14 会抛 SecurityException。
        // 也绝不能 stopSelf() 前先 startForegroundService，否则就是 0.6.9 的崩溃路径。
        if (code == 0 || data == null) {
            val msg = "缺少屏幕授权（服务被系统重启或授权丢失），请在设置里重新点「授权并开启采集」"
            markError(msg)
            LogBus.screen("服务启动被拒：无授权 token", "startId=" + startId)
            notify(msg)
            stopSelf(startId)
            return START_NOT_STICKY
        }

        starting = true
        serviceError = ""

        // 先进入前台（mediaProjection 类型）：必须尽早，系统只给 startForegroundService 后极短的时间窗
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, buildNotification("正在准备屏幕采集…"),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            } else {
                startForeground(NOTIF_ID, buildNotification("正在准备屏幕采集…"))
            }
            LogBus.screen("已进入前台服务", "type=mediaProjection startId=" + startId)
        } catch (e: Exception) {
            val msg = "进入前台服务失败：" + (e.message ?: e.javaClass.simpleName)
            markError(msg)
            LogBus.screen("startForeground 失败", msg)
            notify(msg)
            stopSelf(startId)
            return START_NOT_STICKY
        }

        if (!startCapture(code, data)) {
            LogBus.screen("采集启动失败，停止服务", serviceError)
            stopSelf(startId)
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    private fun startCapture(code: Int, data: Intent): Boolean {
        return try {
            // 0.6.10：重复授权前先停掉旧 MediaProjection（Android 14 授权 token 一次性）
            try { projection?.stop() } catch (_: Exception) {}
            try { virtualDisplay?.release() } catch (_: Exception) {}
            try { imageReader?.close() } catch (_: Exception) {}
            projection = null
            virtualDisplay = null
            imageReader = null
            recreates = 0
            missStreak = 0

            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val proj = mpm.getMediaProjection(code, data)
            if (proj == null) {
                markError("getMediaProjection 返回空：授权 token 可能已失效，请重新授权")
                LogBus.screen("getMediaProjection 返回 null")
                return false
            }
            projection = proj
            // Android 14 要求先注册回调再 createVirtualDisplay
            proj.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    running = false
                    starting = false
                    App.setScreenEnabled(false)
                    if (stopRequested) {
                        // 用户自己点的暂停：正常停止，不要写一条吓人的「错误」
                        serviceError = ""
                        App.setScreenLastError("")
                        LogBus.screen("采集已按用户请求停止")
                        return
                    }
                    LogBus.screen("屏幕采集授权被系统/用户停止")
                    markError("屏幕授权已被系统/用户停止，请重新在设置里授权")
                    stopSelf()
                }
            }, mainHandler)
            LogBus.screen("MediaProjection 已获取")

            val metrics = resources.displayMetrics
            val w = metrics.widthPixels
            val h = metrics.heightPixels
            val dpi = metrics.densityDpi
            imageReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
            virtualDisplay = createDisplay(proj, w, h, dpi)
            if (virtualDisplay == null) {
                markError("创建虚拟屏幕失败（createVirtualDisplay 返回空）")
                LogBus.screen("createVirtualDisplay 返回 null", w.toString() + "x" + h)
                cleanup()
                return false
            }
            LogBus.screen("虚拟屏已创建", w.toString() + "x" + h + " dpi=" + dpi)

            running = true
            starting = false
            serviceError = ""
            App.setScreenEnabled(true)
            App.setScreenLastError("")
            App.setScreenLast("采集已开启 · 每 " + App.screenInterval() + " 秒一次")
            handler = Handler(workerThread?.looper ?: Looper.getMainLooper())
            notify("屏幕采集已开启 · 每 " + App.screenInterval() + " 秒一次")
            LogBus.screen("屏幕采集服务启动", "间隔 " + App.screenInterval() + " 秒")
            // 首次 1.5 秒后就截一帧，便于用户/验收立刻看到记录
            handler?.postDelayed(tick, 1500)
            true
        } catch (e: Exception) {
            val msg = "屏幕采集启动失败：" + (e.message ?: e.javaClass.simpleName)
            markError(msg)
            LogBus.screen("启动异常", msg)
            notify(msg)
            cleanup()
            false
        }
    }

    private fun createDisplay(proj: MediaProjection, w: Int, h: Int, dpi: Int): VirtualDisplay? =
        proj.createVirtualDisplay(
            "tenon-screen", w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface, null, null
        )

    /** 静屏时 mirror 可能长时间不给新帧：连续多次拿不到帧就重建虚拟屏强制出帧。 */
    private fun recoverIfNoFrame() {
        missStreak += 1
        if (missStreak < 3 || recreates >= 5) return
        missStreak = 0
        recreates += 1
        try {
            val proj = projection ?: return
            val metrics = resources.displayMetrics
            virtualDisplay?.release()
            virtualDisplay = createDisplay(proj, metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
            LogBus.screen("连续无新帧，已重建虚拟屏", "第 " + recreates + " 次")
        } catch (e: Exception) {
            LogBus.screen("重建虚拟屏失败", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun captureOnce() {
        val reader = imageReader ?: return
        val image = try {
            reader.acquireLatestImage()
        } catch (e: Exception) {
            null
        }
        if (image == null) {
            recoverIfNoFrame()
            return
        }
        missStreak = 0
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
            val msg = "截屏解码失败：" + (e.message ?: e.javaClass.simpleName)
            serviceError = msg
            App.setScreenLastError(msg)
            LogBus.screen(msg)
            return
        } finally {
            try { image.close() } catch (_: Exception) {}
        }
        val scaled: Bitmap = if (bitmap.width > 960) {
            val w = 960
            val h = (bitmap.height * (960f / bitmap.width)).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(bitmap, w, h, true).also { bitmap.recycle() }
        } else bitmap
        val sw = scaled.width
        val sh = scaled.height
        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 55, baos)
        scaled.recycle()
        val bytes = baos.toByteArray()
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        LogBus.screen("截屏成功", sw.toString() + "x" + sh + " jpeg=" + bytes.size + "B")
        if (!uploading.compareAndSet(false, true)) {
            LogBus.screen("上一张还在上传，跳过本帧")
            return
        }
        Thread {
            try {
                val resp = TenonClient.voiceScreen(
                    imageBase64 = b64,
                    app = "phone",
                    title = "手机屏幕 · " + App.deviceName(),
                    text = "",
                    blacklist = App.screenBlacklist()
                )
                val stored = resp.optBoolean("stored", false)
                val id = resp.optString("id", "")
                val ocrMs = resp.optLong("ocrMs", 0L)
                if (stored && id.isNotBlank()) {
                    uploads += 1
                    App.bumpScreenUpload()
                    App.setScreenLastOkAt(System.currentTimeMillis())
                    val info = timeFmt.format(Date()) + " 已上报 id=" + id +
                            (if (ocrMs > 0) " · OCR " + ocrMs + "ms" else "") +
                            " · 今日第 " + App.screenUploadsToday() + " 次"
                    App.setScreenLast(info)
                    App.setScreenLastResult(info)
                    App.setScreenLastError("")
                    serviceError = ""
                    LogBus.screen("上传成功", "id=" + id + " 今日=" + App.screenUploadsToday())
                    notify("已上报 " + App.screenUploadsToday() + " 次 · 每 " + App.screenInterval() + " 秒采集")
                } else {
                    // 中枢收到了，但 OCR 没抽到文字 → 不入库。0.6.9 把这当成功，用户就「看不到记录」。
                    val why = resp.optString("message", "图片中未识别到文字")
                    val info = timeFmt.format(Date()) + " 中枢已收到但未入库：" + why
                    App.setScreenLast(info)
                    App.setScreenLastResult(info)
                    App.setScreenLastError(info)
                    serviceError = info
                    LogBus.screen("上传未入库", why)
                    notify("中枢未识别到文字，本条未入库")
                }
            } catch (e: TenonClient.VoiceHttpException) {
                failures += 1
                val msg = when {
                    e.isAuth -> "令牌无效或缺失（HTTP " + e.code + "），请在设置里填写操作令牌"
                    e.code == 502 -> "中枢 OCR 失败（HTTP 502），请检查电脑端 OCR 是否可用"
                    else -> "中枢返回 HTTP " + e.code + "：" + e.body.take(120)
                }
                App.setScreenLastError(msg)
                serviceError = msg
                LogBus.screen("上传失败", msg)
                notify("上报失败（" + failures + "）：" + msg.take(80))
            } catch (e: Exception) {
                failures += 1
                val msg = "上报失败：" + (e.message ?: e.javaClass.simpleName)
                App.setScreenLastError(msg)
                serviceError = msg
                LogBus.screen("上传异常", msg)
                notify("上报失败（" + failures + "）：" + msg.take(80))
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
        starting = false
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
        try { workerThread?.quitSafely() } catch (_: Exception) {}
        workerThread = null
        LogBus.screen("屏幕采集服务已停止")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
