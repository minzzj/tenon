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
import android.media.Image
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
 * 用户授权 MediaProjection 后，每 App.screenInterval() 秒截屏一次（0.6.11 起默认 5 秒）→
 * 保留高分辨率（最大宽度 1440px，手机 1080 宽原样不放大）→ JPEG(80) → 提升 OCR 精准度 →
 * POST /api/v2/voice/screen {source:'phone', app, title, imageBase64}。
 *
 * 0.6.12（性能优化，节拍不变）：
 *  1. 每 5 秒照常 acquireLatestImage 取帧，但对 image.planes[0].buffer 先做**廉价采样哈希**
 *     （按 HASH_STRIDE≈4096 字节步长绝对读 4 字节 → FNV-1a 64 位混合，不复制整幅图、不解码）。
 *  2. 与上一次**成功上传**的哈希相同且 App.screenChangeOnly()（默认 true）→ 不解码、不压缩、
 *     不上传，日志「画面未变化，跳过上传」；5 秒取帧节拍保持不变。
 *  3. 不同 / 首次 / 关闭变化检测 → 走原链路：解码 → 缩到 ≤1440px → JPEG80 → 上传，成功后更新 lastHash。
 *  4. 网络慢时「上一张还在上传」的判断提前到解码之前，避免白解码一帧。
 *  5. 解码/压缩/上传仍在 HandlerThread + 上传 Thread；任何异常都保证 image.close()。
 *
 * 0.6.11：截图间隔默认 5 秒；压缩上限从 960px/JPEG55 提升到 1440px/JPEG80，
 * 截屏/缩放/压缩/上传仍全部在后台线程（HandlerThread + 上传 Thread），不会退回主线程。
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

        /** 0.6.11：高清采集上限——最大宽度 1440px（1080 宽手机原样不放大，2K 屏缩到 1440）。 */
        private const val MAX_WIDTH = 1440

        /** 0.6.12：JPEG 质量 80（画面变化才上传，80 已足够 OCR，且比 85 少约 25% 字节）。 */
        private const val JPEG_QUALITY = 80

        /** 0.6.12：采样哈希步长（字节）。1080x1729 RGBA（rowStride 4352）约 7.5MB → 约 1800 次读 4 字节。 */
        private const val HASH_STRIDE = 4096

        /**
         * 0.6.12：哈希跳过顶部状态栏 160 行（≈38dp，420dpi）。
         * 状态栏里的时钟（每分钟）、电量、屏幕共享隐私指示器会在「画面其实没变」时改变像素，
         * 不排除就会被时钟每分钟顶一次上传。状态栏不属于需要 OCR 的内容。
         */
        private const val STATUS_BAR_SKIP_ROWS = 160

        /** FNV-1a 64 位常量。offset basis 0xcbf29ce484222325 用负数表示（Kotlin Long 放不下正数）。 */
        private const val HASH_PRIME = 0x100000001b3L
        private const val HASH_SEED = -0x340d631b7bdddcdbL

        /** 0.6.12：上一次**成功上传**那一帧的采样哈希；0 = 还没有成功上传过（首帧必传）。 */
        @Volatile
        var lastHash: Long = 0L
            private set

        /** 0.6.12：本次服务会话里因「画面未变化」跳过的帧数（设置页/通知展示，便于用户确认生效）。 */
        @Volatile
        var skippedStatic: Long = 0L
            private set

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
            missStreak = 0
            // 0.6.12：新一轮授权/服务重启后首帧必须上传（lastHash=0），跳过计数清零
            lastHash = 0L
            skippedStatic = 0L

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

    /**
     * 静屏时 mirror 长时间不给新帧——这本身就是「画面没变」的正常表现，不需要新帧。
     * 0.6.12：**不再重建虚拟屏**。实机（Android 14）复测发现：release 掉当前唯一的 VirtualDisplay
     * 会连带把 MediaProjection 停掉（onStop → 服务直接结束，10:46:19 复现），
     * 之后再 createVirtualDisplay 只会报「Don't re-use the resultData…」。
     * 现在缺帧只记数（第 3 次、之后每 60 次记一条），5 秒节拍照旧；画面一变 ImageReader 会重新给帧。
     */
    private fun recoverIfNoFrame() {
        missStreak += 1
        if (missStreak == 3 || missStreak % 60 == 0) {
            LogBus.screen("静屏暂无新帧", "连续 " + missStreak + " 次 · 画面变化后自动恢复（不重建虚拟屏）")
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

        // 0.6.12：上一张还在上传（网络慢）→ 本帧连解码都省掉（原行为是解码/压缩完再丢弃，白烧 CPU）
        if (uploading.get()) {
            try { image.close() } catch (_: Exception) {}
            LogBus.screen("上一张还在上传，跳过本帧")
            return
        }

        // 0.6.12：廉价采样哈希——只按步长绝对读 buffer，不解码、不复制整幅图（约 1800 次 4 字节读取）
        var hash = 0L
        var hashOk = false
        try {
            hash = sampledHash(image)
            hashOk = hash != 0L
        } catch (e: Exception) {
            LogBus.screen("采样哈希失败，按画面变化处理", e.message ?: e.javaClass.simpleName)
        }

        // 0.6.12：画面没变 → 不解码、不压缩、不上传，只保留 5 秒取帧节拍
        if (hashOk && App.screenChangeOnly() && lastHash != 0L && hash == lastHash) {
            try { image.close() } catch (_: Exception) {}
            skippedStatic += 1
            LogBus.screen(
                "画面未变化，跳过上传",
                "第 " + skippedStatic + " 次 · 仍每 " + App.screenInterval() + " 秒取帧"
            )
            // 通知每 12 次（约 1 分钟）刷一次：避免每 5 秒刷通知本身变成新的负担
            if (skippedStatic == 1L || skippedStatic % 12L == 0L) {
                notify("画面未变化 · 已跳过 " + skippedStatic + " 次 · 仍每 " + App.screenInterval() + " 秒取帧")
            }
            return
        }

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
        val scaled: Bitmap = if (bitmap.width > MAX_WIDTH) {
            val w = MAX_WIDTH
            val h = (bitmap.height * (MAX_WIDTH.toFloat() / bitmap.width)).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(bitmap, w, h, true).also { bitmap.recycle() }
        } else bitmap
        val sw = scaled.width
        val sh = scaled.height
        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, baos)
        scaled.recycle()
        val bytes = baos.toByteArray()
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        LogBus.screen("截屏成功", sw.toString() + "x" + sh + " jpeg=" + bytes.size + "B q=" + JPEG_QUALITY + " maxW=" + MAX_WIDTH)
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
                // 0.6.12：HTTP 200 即上传成功 → 记住这一帧的哈希，之后静止画面不再重复上传。
                // （stored=false 表示图里没识别到文字，同一张图重试也不会有文字，故同样更新。）
                if (hashOk) lastHash = hash
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
                    notify("已上报 " + App.screenUploadsToday() + " 次 · 每 " + App.screenInterval() + " 秒一次")
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

    /**
     * 0.6.12：屏幕内容「廉价采样哈希」。
     * 不创建 Bitmap、不复制 buffer：对 planes[0].buffer 按 HASH_STRIDE 字节步长做绝对读
     * （ByteBuffer.get(index) 不移动 position、不分配内存），每 4 字节 XOR 进 FNV-1a 64 位。
     * 1080x1729 RGBA（rowStride 4352）约 7.5MB → 约 1800 次 4 字节读取，亚毫秒级；
     * 宽/高/rowStride 也混进哈希，分辨率变化一定算「变了」。
     * 返回 0 表示拿不到可用 buffer（调用方按「画面变化」处理：宁可多传一帧，也不漏传）。
     */
    private fun sampledHash(image: Image): Long {
        val plane = image.planes[0]
        val buf = plane.buffer
        val start = buf.position()
        val end = buf.limit()
        if (end - start < HASH_STRIDE) return 0L
        var h = HASH_SEED
        h = (h xor image.width.toLong()) * HASH_PRIME
        h = (h xor image.height.toLong()) * HASH_PRIME
        h = (h xor plane.rowStride.toLong()) * HASH_PRIME
        // 跳过顶部状态栏（时钟/电量/隐私指示器），否则静止画面每分钟会被时钟顶一次上传
        val topSkip = minOf(plane.rowStride.toLong() * STATUS_BAR_SKIP_ROWS, (end - start).toLong() - 4L)
            .coerceAtLeast(0L).toInt()
        var i = start + topSkip
        while (i + 4 <= end) {
            val v = (buf.get(i).toInt() and 0xFF) or
                ((buf.get(i + 1).toInt() and 0xFF) shl 8) or
                ((buf.get(i + 2).toInt() and 0xFF) shl 16) or
                ((buf.get(i + 3).toInt() and 0xFF) shl 24)
            h = (h xor (v.toLong() and 0xFFFFFFFFL)) * HASH_PRIME
            i += HASH_STRIDE
        }
        return h
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
