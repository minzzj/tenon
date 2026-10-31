package com.minzzj.tenon.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.App
import com.minzzj.tenon.MainActivity
import com.minzzj.tenon.Ui
import com.minzzj.tenon.voice.LocalTts
import com.minzzj.tenon.voice.OneTapVoice
import kotlin.math.abs
import kotlin.math.max

/**
 * 0.6.8 · 悬浮窗（SYSTEM_ALERT_WINDOW）。
 *
 * 悬浮球可拖动；点一下展开，展开后两个**完全分开**的按钮：
 * 「🎙 一键唤醒」与「⏺/⏹ 24h 开/关」，另有「收起 / 关闭」。状态、听到的文字、
 * 榫卯的回复都显示在气泡面板里；一键唤醒走与首页相同的录音→识别→执行→本机播报链路。
 *
 * 用前台服务保活：退出 App 后仍可用（常驻通知里有「关闭悬浮窗」）。
 */
class OverlayService : Service(), OneTapVoice.Listener {
    companion object {
        const val CHANNEL_ID = "tenon-overlay"
        const val NOTIF_ID = 7440
        const val ACTION_STOP = "com.minzzj.tenon.action.OVERLAY_STOP"

        @Volatile
        var running: Boolean = false
            private set

        fun start(ctx: Context) {
            if (!Settings.canDrawOverlays(ctx)) return
            val i = Intent(ctx, OverlayService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, OverlayService::class.java)) } catch (_: Exception) {}
        }
    }

    private lateinit var wm: WindowManager
    private var ball: TextView? = null
    private var panel: LinearLayout? = null
    private var panelHeader: View? = null
    private var params: WindowManager.LayoutParams? = null
    private var expanded = false

    private var stateText: TextView? = null
    private var heardText: TextView? = null
    private var replyText: TextView? = null
    private var wakeBtn: TextView? = null
    private var ambientBtn: TextView? = null
    private var ambientLine: TextView? = null

    private val main = Handler(Looper.getMainLooper())
    private val ambientTick = object : Runnable {
        override fun run() {
            refreshAmbient()
            main.postDelayed(this, 2500)
        }
    }

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val nm = getSystemService(NotificationManager::class.java)
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "悬浮窗", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "榫卯悬浮窗常驻，退出 App 后也能一键唤醒 / 开关 24h 录制"
                    setShowBadge(false)
                }
            )
        }
        LocalTts.init(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        if (!Settings.canDrawOverlays(this)) {
            toast("未授权悬浮窗：请到「设置 → 显示悬浮窗」授权")
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        OneTapVoice.get(this).addListener(this)
        if (ball == null && panel == null) showBall()
        main.removeCallbacks(ambientTick)
        main.post(ambientTick)
        return START_STICKY
    }

    private fun startForegroundCompat() {
        val text = "悬浮窗运行中 · 一键唤醒 / 24h 开关"
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                if (OneTapVoice.hasMic(this)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                try {
                    startForeground(NOTIF_ID, buildNotification(text), type)
                } catch (_: Exception) {
                    startForeground(NOTIF_ID, buildNotification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                }
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, buildNotification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, buildNotification(text))
            }
        } catch (e: Exception) {
            // 极端情况下前台服务类型不被允许：仍尝试普通保活，失败就让悬浮窗结束，不崩溃
            try { startForeground(NOTIF_ID, buildNotification(text)) } catch (_: Exception) {
                toast("悬浮窗保活失败：" + (e.message ?: ""))
                stopSelf()
            }
        }
    }

    // ================= 悬浮球 / 面板 =================

    private fun screenWidth(): Int = resources.displayMetrics.widthPixels
    private fun screenHeight(): Int = resources.displayMetrics.heightPixels

    private fun baseParams(w: Int, h: Int): WindowManager.LayoutParams =
        WindowManager.LayoutParams(
            w, h,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = max(0, screenWidth() - w - Ui.dp(this@OverlayService, 12))
            y = Ui.dp(this@OverlayService, 150)
        }

    private fun removeCurrent() {
        try {
            ball?.let { if (it.parent != null) wm.removeView(it) }
        } catch (_: Exception) {}
        try {
            panel?.let { if (it.parent != null) wm.removeView(it) }
        } catch (_: Exception) {}
    }

    private fun showBall() {
        expanded = false
        removeCurrent()
        val v = ball ?: buildBall().also { ball = it }
        val size = Ui.dp(this, 58)
        val p = baseParams(size, size)
        params?.let { old -> p.x = old.x; p.y = old.y }
        p.x = p.x.coerceIn(0, max(0, screenWidth() - size))
        p.y = p.y.coerceIn(0, max(0, screenHeight() - size))
        params = p
        try {
            wm.addView(v, p)
        } catch (e: Exception) {
            toast("悬浮窗显示失败：" + (e.message ?: ""))
            stopSelf()
            return
        }
        attachDrag(v, p, { onWakeTap() }, { onAmbientTap() })
        updateBallState()
    }

    private fun showPanel() {
        expanded = true
        removeCurrent()
        val v = panel ?: buildPanel().also { panel = it }
        val width = Ui.dp(this, 254)
        val p = baseParams(width, WindowManager.LayoutParams.WRAP_CONTENT)
        params?.let { old -> p.x = old.x; p.y = old.y }
        p.x = p.x.coerceIn(0, max(0, screenWidth() - width))
        p.y = p.y.coerceIn(0, max(0, screenHeight() - Ui.dp(this, 340)))
        params = p
        try {
            wm.addView(v, p)
        } catch (e: Exception) {
            toast("悬浮窗展开失败：" + (e.message ?: ""))
            stopSelf()
            return
        }
        panelHeader?.let { attachDrag(it, p, null) }
        refreshAll()
        refreshAmbient()
    }

    private fun buildBall(): TextView = TextView(this).apply {
        text = "榫"
        textSize = 20f
        gravity = Gravity.CENTER
        setTextColor(Ui.CYAN)
        typeface = Typeface.create("sans-serif", Typeface.BOLD)
        background = Ui.rounded(this@OverlayService, 0xF20D1524.toInt(), Ui.CYAN, 29)
        elevation = Ui.dp(this@OverlayService, 10).toFloat()
    }

    private fun buildPanel(): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.rounded(this@OverlayService, 0xF70D1524.toInt(), Ui.CYAN, 14)
            setPadding(Ui.dp(this@OverlayService, 12), Ui.dp(this@OverlayService, 10),
                Ui.dp(this@OverlayService, 12), Ui.dp(this@OverlayService, 12))
            elevation = Ui.dp(this@OverlayService, 12).toFloat()
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(this).apply {
            text = "榫卯 · 悬浮窗"
            textSize = 13f
            setTextColor(Ui.CYAN)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        header.addView(smallAction("收起") { showBall() })
        header.addView(smallAction("✕") {
            toast("悬浮窗已关闭")
            stopSelf()
        })
        root.addView(header)

        stateText = TextView(this).apply {
            text = "状态：待机"
            textSize = 12f
            setTextColor(Ui.GREY)
            setPadding(0, Ui.dp(this@OverlayService, 8), 0, 0)
        }
        root.addView(stateText)

        heardText = lineText("听到：—", Ui.PAPER, 12f)
        root.addView(heardText)
        replyText = lineText("榫卯：—", Ui.PAPER, 12f).apply {
            maxLines = 4
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        root.addView(replyText)

        wakeBtn = actionButton("🎙 一键唤醒", true) { onWakeTap() }
        root.addView(wakeBtn)
        ambientBtn = actionButton("⏺ 开启 24h 录制", false) { onAmbientTap() }
        root.addView(ambientBtn)

        ambientLine = lineText("24h：未开启", Ui.GREY, 11f)
        root.addView(ambientLine)
        root.addView(lineText("退出 App 后仍可用；常驻通知可关闭。", Ui.DIM, 10f))

        // 面板顶部空白区可拖动（真正的 params 在 showPanel 里 addView 后绑定）
        panelHeader = header
        return root
    }

    private fun lineText(text: String, color: Int, size: Float): TextView = TextView(this).apply {
        this.text = text
        textSize = size
        setTextColor(color)
        setPadding(0, Ui.dp(this@OverlayService, 6), 0, 0)
        setLineSpacing(Ui.dp(this@OverlayService, 2).toFloat(), 1f)
    }

    private fun smallAction(text: String, onClick: () -> Unit): TextView = TextView(this).apply {
        this.text = text
        textSize = 11f
        setTextColor(Ui.GREY)
        setPadding(Ui.dp(this@OverlayService, 8), Ui.dp(this@OverlayService, 2),
            Ui.dp(this@OverlayService, 2), Ui.dp(this@OverlayService, 2))
        isClickable = true
        setOnClickListener { onClick() }
    }

    private fun actionButton(text: String, primary: Boolean, onClick: () -> Unit): TextView = TextView(this).apply {
        this.text = text
        textSize = 15f
        gravity = Gravity.CENTER
        typeface = Typeface.create("sans-serif", Typeface.BOLD)
        setTextColor(if (primary) Ui.CYAN else Ui.PAPER)
        background = Ui.rounded(
            this@OverlayService,
            if (primary) 0xFF103532.toInt() else 0xFF152238.toInt(),
            if (primary) Ui.CYAN else Ui.LINE,
            10
        )
        setPadding(0, Ui.dp(this@OverlayService, 12), 0, Ui.dp(this@OverlayService, 12))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = Ui.dp(this@OverlayService, 8) }
        isClickable = true
        setOnClickListener { onClick() }
    }

    private fun attachDrag(v: View, lp: WindowManager.LayoutParams, onClick: (() -> Unit)?, onLongClick: (() -> Unit)? = null) {
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        var downAt = 0L
        v.setOnTouchListener { view, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startX = lp.x
                    startY = lp.y
                    moved = false
                    downAt = android.os.SystemClock.elapsedRealtime()
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (e.rawX - downRawX).toInt()
                    val dy = (e.rawY - downRawY).toInt()
                    if (!moved && (abs(dx) > Ui.dp(this, 5) || abs(dy) > Ui.dp(this, 5))) moved = true
                    if (moved) {
                        val w = if (view === panel) Ui.dp(this, 254) else Ui.dp(this, 58)
                        lp.x = (startX + dx).coerceIn(0, max(0, screenWidth() - w))
                        lp.y = (startY + dy).coerceIn(0, max(0, screenHeight() - Ui.dp(this, 80)))
                        params = lp
                        try { wm.updateViewLayout(view, lp) } catch (_: Exception) {}
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (e.actionMasked == MotionEvent.ACTION_UP && !moved) {
                        val held = android.os.SystemClock.elapsedRealtime() - downAt
                        if (onLongClick != null && held >= 600L) onLongClick.invoke() else onClick?.invoke()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun updateBallState() {
        val v = ball ?: return
        val rec = OneTapVoice.get(this)
        when (rec.state) {
            OneTapVoice.RECORDING -> {
                v.text = "●"
                v.setTextColor(Ui.RED)
            }
            OneTapVoice.TRANSCRIBING, OneTapVoice.EXECUTING -> {
                v.text = "…"
                v.setTextColor(Ui.AMBER)
            }
            OneTapVoice.DONE -> {
                v.text = "✓"
                v.setTextColor(Ui.CYAN)
                main.postDelayed({
                    if (OneTapVoice.get(this).state != OneTapVoice.DONE) return@postDelayed
                    ball?.text = "榫"
                    ball?.setTextColor(Ui.CYAN)
                }, 2500)
            }
            else -> {
                v.text = "榫"
                v.setTextColor(Ui.CYAN)
            }
        }
    }

    // ================= 两个分开的入口 =================

    private fun onWakeTap() {
        if (!OneTapVoice.hasMic(this)) {
            toast("请先在 App 首页允许麦克风，再回来点一键唤醒")
            openMain()
            return
        }
        try {
            OneTapVoice.get(this).toggle()
        } catch (e: Exception) {
            toast("一键唤醒失败：" + (e.message ?: ""))
        }
    }

    private fun onAmbientTap() {
        if (!OneTapVoice.hasMic(this)) {
            toast("请先在 App 首页允许麦克风，再开启 24h 录制")
            openMain()
            return
        }
        if (AmbientRecordService.running) {
            AmbientRecordService.stop(this)
            toast("已请求停止 24 小时录制")
        } else {
            try {
                AmbientRecordService.start(this)
                toast("24 小时录制已开启（常驻通知里可停止）")
            } catch (e: Exception) {
                toast("无法开启 24h 录制：" + (e.message ?: "") + "，请打开 App 首页再试")
                openMain()
            }
        }
        main.postDelayed({ refreshAmbient() }, 800)
        main.postDelayed({ refreshAmbient() }, 2200)
    }

    // ================= 状态刷新 =================

    private fun refreshAll() {
        val rec = OneTapVoice.get(this)
        stateText?.text = when (rec.state) {
            OneTapVoice.RECORDING -> "状态：正在录音…"
            OneTapVoice.TRANSCRIBING -> "状态：识别中…"
            OneTapVoice.EXECUTING -> "状态：执行中…"
            OneTapVoice.DONE -> "状态：已执行"
            else -> "状态：待机"
        }
        heardText?.text = "听到：" + (rec.lastHeard.ifBlank { "—" })
        replyText?.text = "榫卯：" + (rec.lastReply.ifBlank { "—" })
        wakeBtn?.text = if (rec.isRecording) "⏹ 点一下结束并识别" else "🎙 一键唤醒"
    }

    private fun refreshAmbient() {
        val runningNow = AmbientRecordService.running
        ambientBtn?.text = if (runningNow) "⏹ 关闭 24h 录制" else "⏺ 开启 24h 录制"
        ambientBtn?.setTextColor(if (runningNow) Ui.AMBER else Ui.PAPER)
        val segments = App.ambientSegmentsToday()
        val last = App.ambientLast()
        val err = App.ambientLastError()
        ambientLine?.text = buildString {
            append("24h：").append(if (runningNow) "运行中" else "未开启")
            append(" · 今日 ").append(segments).append(" 段")
            if (last.isNotBlank()) append("\n").append(last.take(48))
            if (err.isNotBlank()) append("\n⚠ ").append(err.take(48))
        }
        updateBallState()
    }

    // ================= OneTapVoice 回调 =================

    override fun onState(state: String, detail: String) {
        main.post {
            if (expanded) {
                stateText?.text = "状态：" + state + (if (detail.isNotBlank()) " · " + detail else "")
                stateText?.setTextColor(
                    if (state == OneTapVoice.RECORDING || state == OneTapVoice.TRANSCRIBING ||
                        state == OneTapVoice.EXECUTING
                    ) Ui.AMBER else Ui.CYAN
                )
                wakeBtn?.text = if (OneTapVoice.get(this).isRecording) "⏹ 点一下结束并识别" else "🎙 一键唤醒"
            }
            updateBallState()
        }
    }

    override fun onHeard(text: String) {
        main.post {
            if (expanded) heardText?.text = "听到：" + text
        }
    }

    override fun onReply(say: String, result: org.json.JSONObject?) {
        main.post {
            if (expanded) replyText?.text = "榫卯：" + (say.ifBlank { "（没有文字回复）" })
            if (!expanded && say.isNotBlank()) {
                toast("榫卯：" + say.take(70))
            }
            updateBallState()
        }
    }

    override fun onError(message: String) {
        main.post {
            if (expanded) {
                stateText?.text = "状态：出错 · " + message.take(80)
                stateText?.setTextColor(Ui.AMBER)
            } else {
                toast(message.take(80))
            }
            updateBallState()
        }
    }

    // ================= 通知 / 工具 =================

    private fun buildNotification(text: String): Notification {
        val content = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, OverlayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("榫卯 · 悬浮窗")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
        try {
            builder.addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                    "关闭悬浮窗",
                    stop
                ).build()
            )
        } catch (_: Exception) {}
        return builder.build()
    }

    private fun toast(text: String) {
        try { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() } catch (_: Exception) {}
    }

    private fun openMain() {
        try {
            startActivity(
                Intent(this, MainActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                )
            )
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        running = false
        main.removeCallbacks(ambientTick)
        OneTapVoice.get(this).removeListener(this)
        try { LocalTts.stop() } catch (_: Exception) {}
        removeCurrent()
        ball = null
        panel = null
        panelHeader = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
