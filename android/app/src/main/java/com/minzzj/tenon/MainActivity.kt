package com.minzzj.tenon

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Switch
import android.widget.TextView
import com.minzzj.tenon.net.Discovery
import com.minzzj.tenon.net.Peer
import com.minzzj.tenon.net.TenonClient
import com.minzzj.tenon.service.ClipboardSyncService
import com.minzzj.tenon.sensor.TiltDetector
import com.minzzj.tenon.service.TenonNotificationListener
import com.minzzj.tenon.voice.VoiceRecognizer
import java.io.File
import java.io.FileOutputStream

/**
 * 主界面：一个 Activity + 若干分区（发现 / 配对 / 文件互传 / 剪贴板 / 通知 / 素材 / 日志）。
 * 视觉沿用深空底 + 核对青；所有耗时操作走后台线程，进度回主线程。
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_FILE = 1001
        private const val REQ_SCAN = 1002
        private const val REQ_NOTIF_PERM = 1003
        private const val REQ_AUDIO = 1004
    }

    private lateinit var hubInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView
    private lateinit var peerList: TextView
    private lateinit var pairCodeInput: EditText
    private lateinit var pairResult: TextView
    private lateinit var fileLabel: TextView
    private lateinit var uploadProgress: ProgressBar
    private lateinit var uploadStatus: TextView
    private lateinit var clipSwitch: Switch
    private lateinit var clipStatus: TextView
    private lateinit var notifyStatus: TextView
    private lateinit var assetStatus: TextView
    private lateinit var logText: TextView

    // ---- v2.1 超级终端：语音 / 快捷面板 / 倾斜甩屏 ----
    private lateinit var askInput: EditText
    private lateinit var voiceButton: Button
    private lateinit var voiceHint: TextView
    private lateinit var askReply: TextView
    private lateinit var tiltStatus: TextView
    private lateinit var tiltSwitch: Switch
    private var tiltDetector: TiltDetector? = null
    private var voice: VoiceRecognizer? = null
    private var pendingVoiceStart = false

    private var discovery: Discovery? = null
    private val peers = mutableListOf<Peer>()
    private var pickedUri: Uri? = null
    private var pickedName: String = ""

    private val logListener: (String) -> Unit = { logText.text = LogBus.snapshot() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)

        // ---------- 头部 ----------
        val header = Ui.row(this)
        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        titleCol.addView(Ui.title(this, "榫卯 TENON"))
        titleCol.addView(Ui.hint(this, "v2 P0 · Android 原生端 · com.minzzj.tenon 0.1.0"))
        header.addView(titleCol)
        val settingsBtn = Ui.button(this, "设置") {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        settingsBtn.layoutParams = LinearLayout.LayoutParams(dp(84), ViewGroup.LayoutParams.WRAP_CONTENT)
        header.addView(settingsBtn)
        root.addView(header)
        statusText = Ui.body(this, "")
        root.addView(statusText)

        // ---------- 00 超级终端（v2.1 消费级主线）----------
        val sSuper = Ui.section(this, "00 · 超级终端 · 一句话调动家里设备与程序")
        sSuper.addView(Ui.hint(this, "按住说话（中文），或直接输入一句话；AI 会拆成计划，在电脑上执行。"))
        askInput = Ui.input(this, "例如：打开微信 / 把这张照片甩到电脑 / 放首歌 / 回家模式")
        sSuper.addView(askInput)
        val rowAsk = Ui.row(this)
        voiceButton = Ui.button(this, "🎤 按住说话", true) { /* 触摸由 OnTouchListener 处理 */ }
        voiceButton.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startVoice()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    stopVoice()
                    v.performClick()
                    true
                }
                else -> false
            }
        }
        rowAsk.addView(voiceButton)
        rowAsk.addView(Ui.button(this, "发送") { ask(askInput.text.toString()) })
        sSuper.addView(rowAsk)
        voiceHint = Ui.hint(this, "语音引擎检查中…")
        sSuper.addView(voiceHint)
        sSuper.addView(Ui.hint(this, "快捷程序面板（点一下 = 发一句指令）："))
        val quickRow1 = Ui.row(this)
        quickRow1.addView(quickTile("打开微信", "打开微信"))
        quickRow1.addView(quickTile("打开Chrome", "打开 Chrome"))
        quickRow1.addView(quickTile("打开记事本", "打开记事本"))
        sSuper.addView(quickRow1)
        val quickRow2 = Ui.row(this)
        quickRow2.addView(quickTile("放首歌", "放首歌"))
        quickRow2.addView(quickTile("回家模式", "回家模式"))
        val filler = android.view.View(this)
        filler.layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        quickRow2.addView(filler)
        sSuper.addView(quickRow2)
        askReply = Ui.body(this, "")
        askReply.setTextIsSelectable(true)
        sSuper.addView(askReply)
        root.addView(sSuper)

        // ---------- 流转：手机往前一倾，页面滑到电脑 ----------
        val sTilt = Ui.section(this, "流转 · 手机往前一倾，页面自动滑到电脑")
        tiltSwitch = Ui.switchRow(this, "开启倾斜甩屏", App.tiltEnabled()) { on -> toggleTilt(on) }
        sTilt.addView(tiltSwitch)
        tiltStatus = Ui.body(this, "")
        sTilt.addView(tiltStatus)
        val rowTilt = Ui.row(this)
        rowTilt.addView(Ui.button(this, "甩到电脑（手动）", true) { triggerHandoff("manual") })
        rowTilt.addView(Ui.button(this, "拉取流转状态") { pollSuperState() })
        sTilt.addView(rowTilt)
        sTilt.addView(Ui.hint(this, "检测到 1 秒内快速前倾超过 ${App.tiltSensitivity()}° 时自动甩屏；灵敏度可在设置页调整。"))
        root.addView(sTilt)

        // ---------- 01 中枢 ----------
        val sHub = Ui.section(this, "01 · 中枢连接")
        hubInput = Ui.input(this, "中枢地址，如 192.168.1.10:7410")
        tokenInput = Ui.input(this, "访问令牌 x-tenon-token（可留空；写操作需要）")
        sHub.addView(hubInput)
        sHub.addView(tokenInput)
        val rowHub = Ui.row(this)
        rowHub.addView(Ui.button(this, "保存并测试", true) { saveAndTest() })
        rowHub.addView(Ui.button(this, "打开素材库") { openAssets() })
        sHub.addView(rowHub)
        root.addView(sHub)

        // ---------- 02 UDP 发现 ----------
        val sDisc = Ui.section(this, "02 · 局域网发现（UDP 7413）")
        val rowDisc = Ui.row(this)
        rowDisc.addView(Ui.button(this, "开始发现", true) { startDiscovery() })
        rowDisc.addView(Ui.button(this, "停止") { stopDiscovery() })
        sDisc.addView(rowDisc)
        peerList = Ui.body(this, "尚未发现设备（需与中枢处于同一 WiFi）")
        sDisc.addView(peerList)
        sDisc.addView(Ui.hint(this, "发现失败时可手输 IP 兜底：把电脑 IP:7410 填到 01 中枢地址。"))
        root.addView(sDisc)

        // ---------- 03 配对 ----------
        val sPair = Ui.section(this, "03 · 配对（扫码 / 6 位码）")
        pairCodeInput = Ui.input(this, "6 位配对码")
        sPair.addView(pairCodeInput)
        val rowPair = Ui.row(this)
        rowPair.addView(Ui.button(this, "用配对码配对", true) { doPair(pairCodeInput.text.toString()) })
        rowPair.addView(Ui.button(this, "扫码配对") { scanQr() })
        sPair.addView(rowPair)
        pairResult = Ui.body(this, "")
        sPair.addView(pairResult)
        sPair.addView(Ui.hint(this, "二维码内容：tenon://pair?host=IP:PORT&code=XXXX（电脑端配对页显示）。"))
        root.addView(sPair)

        // ---------- 04 文件互传 ----------
        val sFile = Ui.section(this, "04 · 文件互传（分块 PUT + SHA-256）")
        val rowPick = Ui.row(this)
        rowPick.addView(Ui.button(this, "选择文件", true) { pickFile() })
        rowPick.addView(Ui.button(this, "下载接收") { showDownloadDialog() })
        sFile.addView(rowPick)
        fileLabel = Ui.body(this, "未选择文件")
        sFile.addView(fileLabel)
        uploadProgress = Ui.progress(this)
        sFile.addView(uploadProgress)
        val uploadBtn = Ui.button(this, "上传到电脑") { uploadPicked() }
        uploadBtn.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) }
        sFile.addView(uploadBtn)
        uploadStatus = Ui.body(this, "")
        sFile.addView(uploadStatus)
        sFile.addView(Ui.hint(this, "契约 §4：POST /link/transfer/init → PUT /chunk?offset= → POST /finish 校验 sha256。"))
        root.addView(sFile)

        // ---------- 05 剪贴板 ----------
        val sClip = Ui.section(this, "05 · 剪贴板同步（前台服务）")
        clipSwitch = Ui.switchRow(this, "开启双向剪贴板同步", ClipboardSyncService.running) { on ->
            toggleClipboard(on)
        }
        sClip.addView(clipSwitch)
        clipStatus = Ui.body(this, "")
        sClip.addView(clipStatus)
        val rowClip = Ui.row(this)
        rowClip.addView(Ui.button(this, "立即上报当前剪贴板", true) { pushClipboard() })
        rowClip.addView(Ui.button(this, "拉取远端最新") { pullClipboard() })
        sClip.addView(rowClip)
        sClip.addView(Ui.hint(this, "Android 10+ 后台读取剪贴板受限：前台服务只能尽力读取；稳定同步请保持 App 可见，或由电脑端主动推送。"))
        root.addView(sClip)

        // ---------- 06 通知 ----------
        val sNotify = Ui.section(this, "06 · 通知镜像")
        notifyStatus = Ui.body(this, "")
        sNotify.addView(notifyStatus)
        val rowNotify = Ui.row(this)
        rowNotify.addView(Ui.button(this, "打开通知监听设置", true) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })
        rowNotify.addView(Ui.button(this, "测试上报") { testNotify() })
        sNotify.addView(rowNotify)
        root.addView(sNotify)

        // ---------- 07 素材 / 分享 ----------
        val sAsset = Ui.section(this, "07 · 素材库 / 分享目标")
        val rowAsset = Ui.row(this)
        rowAsset.addView(Ui.button(this, "浏览素材库", true) { openAssets() })
        rowAsset.addView(Ui.button(this, "刷新统计") { loadStats() })
        sAsset.addView(rowAsset)
        assetStatus = Ui.body(this, "")
        sAsset.addView(assetStatus)
        sAsset.addView(Ui.hint(this, "从相册/文件管理器「分享到榫卯」可直接上传；素材库用 WebView 打开 Web 端 #/assets。"))
        root.addView(sAsset)

        // ---------- 日志 ----------
        val sLog = Ui.section(this, "日志（真机排障）")
        logText = Ui.hint(this, LogBus.snapshot())
        logText.setTextIsSelectable(true)
        sLog.addView(logText)
        val rowLog = Ui.row(this)
        rowLog.addView(Ui.button(this, "清空日志") {
            LogBus.clear()
            logText.text = ""
        })
        rowLog.addView(Ui.button(this, "刷新状态") { refreshStatus() })
        sLog.addView(rowLog)
        root.addView(sLog)

        setContentView(Ui.scroll(this, root))
        loadSettings()
        refreshStatus()
        LogBus.addListener(logListener)
        ensureNotificationPermission()
    }

    // ================= 生命周期 =================

    override fun onResume() {
        super.onResume()
        refreshStatus()
        setupTilt()
    }

    override fun onPause() {
        super.onPause()
        tiltDetector?.stop()
        voice?.stop()
    }

    override fun onDestroy() {
        LogBus.removeListener(logListener)
        discovery?.stop()
        tiltDetector?.stop()
        tiltDetector = null
        voice?.destroy()
        voice = null
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) return
        when (requestCode) {
            REQ_FILE -> {
                val uri = data?.data ?: return
                pickedUri = uri
                pickedName = queryDisplayName(uri)
                val size = querySize(uri)
                fileLabel.text = "已选择：$pickedName（${fmtSize(size)}）"
                uploadProgress.progress = 0
            }
            REQ_SCAN -> {
                val qr = data?.getStringExtra("qr") ?: return
                handleQr(qr)
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF_PERM) refreshStatus()
        if (requestCode == REQ_AUDIO) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted && pendingVoiceStart) {
                pendingVoiceStart = false
                startVoice()
            } else {
                voiceHint.text = "麦克风权限被拒绝 → 已降级为文字输入，可直接输入一句话后点「发送」"
                askInput.requestFocus()
            }
        }
    }

    // ================= 状态 =================

    private fun loadSettings() {
        hubInput.setText(App.hub())
        tokenInput.setText(App.token())
    }

    private fun refreshStatus() {
        statusText.text = if (App.isConfigured()) {
            "中枢：${App.baseUrl()}\n设备号：${App.deviceId()} · peerId：${App.peerId()}"
        } else {
            "未配置中枢：请填写电脑 IP:7410 后点「保存并测试」"
        }
        clipStatus.text = if (ClipboardSyncService.running) "剪贴板同步：运行中（前台服务）" else "剪贴板同步：未开启"
        clipSwitch.isChecked = ClipboardSyncService.running
        val nl = TenonNotificationListener.isEnabled(this) || TenonNotificationListener.connected
        notifyStatus.text = if (nl) "通知监听：已授权（镜像开启）" else "通知监听：未授权 —— 点下方按钮去系统设置开启"
        fileLabel.invalidate()
    }

    // ================= 中枢 =================

    private fun saveAndTest() {
        App.setHub(hubInput.text.toString())
        App.setToken(tokenInput.text.toString())
        hubInput.setText(App.hub())
        refreshStatus()
        if (!App.isConfigured()) {
            uploadStatus.text = "请先填写中枢地址"
            return
        }
        uploadStatus.text = "正在测试连接…"
        bg {
            val msg = try {
                val list = TenonClient.peers()
                "连接成功（HTTP 200）· 中枢可见对端 ${list.size} 个"
            } catch (e: Exception) {
                "连接失败：${e.message}"
            }
            ui { uploadStatus.text = msg; refreshStatus() }
        }
    }

    // ================= UDP 发现 =================

    private fun startDiscovery() {
        if (discovery?.isRunning == true) {
            peerList.text = peerText()
            return
        }
        peers.clear()
        peerList.text = "正在发现（UDP 7413 广播，5 秒内…）"
        val d = Discovery { peer -> runOnUiThread { addPeer(peer) } }
        discovery = d
        d.start()
    }

    private fun stopDiscovery() {
        discovery?.stop()
        peerList.text = peerText()
    }

    private fun addPeer(peer: Peer) {
        if (peers.none { it.deviceId == peer.deviceId }) peers.add(peer)
        peerList.text = peerText()
        if (hubInput.text.isBlank() && peers.isNotEmpty()) {
            hubInput.setText(peers[0].address)
            LogBus.log("已自动填入发现地址：${peers[0].address}")
        }
    }

    private fun peerText(): String =
        if (peers.isEmpty()) "尚未发现设备" else peers.joinToString("\n") { "· ${it.name}（${it.platform}）${it.host}:${it.port}" }

    // ================= 配对 =================

    private fun doPair(code: String) {
        val c = code.trim()
        if (c.length != 6 || c.any { !it.isDigit() }) {
            pairResult.text = "配对码应为 6 位数字"
            return
        }
        if (!App.isConfigured()) {
            pairResult.text = "请先填写并保存中枢地址"
            return
        }
        pairResult.text = "正在配对…"
        bg {
            val msg = try {
                val resp = TenonClient.pair(c)
                "配对成功 · peerId=${App.peerId()} · ${resp.toString().take(120)}"
            } catch (e: Exception) {
                "配对失败：${e.message}"
            }
            ui { pairResult.text = msg; refreshStatus() }
        }
    }

    private fun scanQr() {
        startActivityForResult(Intent(this, ScanActivity::class.java), REQ_SCAN)
    }

    private fun handleQr(qr: String) {
        val text = qr.trim()
        if (text.startsWith("tenon://")) {
            try {
                val uri = Uri.parse(text)
                val host = uri.getQueryParameter("host") ?: ""
                val code = uri.getQueryParameter("code") ?: ""
                if (host.isNotBlank()) hubInput.setText(host)
                if (code.isNotBlank()) pairCodeInput.setText(code)
                LogBus.log("已解析二维码：host=$host code=$code")
                App.setHub(host)
                doPair(code)
            } catch (e: Exception) {
                pairResult.text = "二维码解析失败：${e.message}"
            }
        } else if (text.length == 6 && text.all { it.isDigit() }) {
            pairCodeInput.setText(text)
            doPair(text)
        } else {
            pairResult.text = "不是榫卯配对二维码：${text.take(80)}"
        }
    }

    // ================= 文件互传 =================

    private fun pickFile() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        startActivityForResult(i, REQ_FILE)
    }

    private fun uploadPicked() {
        val uri = pickedUri ?: run { uploadStatus.text = "请先选择文件"; return }
        if (!App.isConfigured()) { uploadStatus.text = "请先配置中枢地址"; return }
        uploadStatus.text = "准备上传…"
        bg {
            try {
                val tmp = copyToCache(uri, pickedName.ifBlank { "upload.bin" })
                val result = TenonClient.uploadFile(tmp, App.peerId()) { sent, total ->
                    val pct = if (total > 0) ((sent * 100) / total).toInt() else 0
                    ui {
                        uploadProgress.progress = pct
                        uploadStatus.text = "上传中 $pct%（${fmtSize(sent)} / ${fmtSize(total)}）"
                    }
                }
                val sec = result.ms / 1000.0
                val speed = if (sec > 0) result.bytes / sec else 0.0
                ui {
                    uploadProgress.progress = 100
                    uploadStatus.text = "上传完成：${fmtSize(result.bytes)} / ${"%.1f".format(sec)}s / ${fmtSize(speed.toLong())}/s\nsha256=${result.sha256}\ntransferId=${result.transferId}"
                }
            } catch (e: Exception) {
                ui { uploadStatus.text = "上传失败：${e.message}" }
            }
        }
    }

    private fun showDownloadDialog() {
        val input = Ui.input(this, "transferId，例如 tr_xxxxxxxx")
        AlertDialog.Builder(this)
            .setTitle("下载接收")
            .setView(input)
            .setPositiveButton("开始") { _, _ -> downloadTransfer(input.text.toString().trim()) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun downloadTransfer(transferId: String) {
        if (transferId.isBlank()) { uploadStatus.text = "请填写 transferId"; return }
        if (!App.isConfigured()) { uploadStatus.text = "请先配置中枢地址"; return }
        uploadStatus.text = "正在下载 $transferId…"
        bg {
            val msg = try {
                val dir = File(getExternalFilesDir(null), "tenon-downloads")
                val r = TenonClient.downloadTransfer(transferId, dir)
                "下载完成：${r.path}（${fmtSize(r.bytes)}）\nsha256=${r.sha256}"
            } catch (e: Exception) {
                "下载失败：${e.message}"
            }
            ui { uploadStatus.text = msg }
        }
    }

    // ================= 剪贴板 =================

    private fun toggleClipboard(on: Boolean) {
        App.setClipboardEnabled(on)
        if (on) {
            try {
                ClipboardSyncService.start(this)
                LogBus.log("已请求启动剪贴板前台服务")
            } catch (e: Exception) {
                LogBus.log("启动前台服务失败：${e.message}")
            }
        } else {
            ClipboardSyncService.stop(this)
        }
        uiLater { refreshStatus() }
    }

    private fun pushClipboard() {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip
            val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this).toString() else ""
            if (text.isBlank()) { clipStatus.text = "本机剪贴板为空"; return }
            bg {
                val ok = TenonClient.shareClipboard(if (text.startsWith("http")) "link" else "text", text)
                ui { clipStatus.text = if (ok) "已上报剪贴板：${text.take(40)}" else "上报失败（检查中枢/令牌）" }
            }
        } catch (e: Exception) {
            clipStatus.text = "读取剪贴板失败：${e.message}"
        }
    }

    private fun pullClipboard() {
        bg {
            try {
                val obj = TenonClient.latestClipboard()
                val text = obj?.optString("text", "") ?: ""
                if (text.isBlank()) {
                    ui { clipStatus.text = "远端没有剪贴板内容" }
                } else {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("榫卯同步", text))
                    ui { clipStatus.text = "已写入本机剪贴板：${text.take(40)}" }
                }
            } catch (e: Exception) {
                ui { clipStatus.text = "拉取失败：${e.message}" }
            }
        }
    }

    // ================= 通知 / 素材 =================

    private fun testNotify() {
        bg {
            val ok = TenonClient.relayNotification("TenonAndroid", "测试通知", "来自 Android 端的通知镜像测试")
            ui { notifyStatus.text = if (ok) "测试上报成功" else "测试上报失败（中枢未提供 /api/v2/link/notify）" }
        }
    }

    private fun openAssets() {
        if (!App.isConfigured()) { assetStatus.text = "请先配置中枢地址"; return }
        startActivity(Intent(this, AssetsActivity::class.java))
    }

    private fun loadStats() {
        if (!App.isConfigured()) { assetStatus.text = "请先配置中枢地址"; return }
        assetStatus.text = "正在刷新素材统计…"
        bg {
            val msg = try {
                val stats = TenonClient.stats()
                if (stats == null) "素材统计不可用（v2 素材模块未就绪）" else "素材统计：${stats.toString().take(200)}"
            } catch (e: Exception) {
                "刷新失败：${e.message}"
            }
            ui { assetStatus.text = msg }
        }
    }

    // ================= 文件工具 =================

    private fun copyToCache(uri: Uri, name: String): File {
        val safe = name.replace("/", "_").replace("\\", "_").ifBlank { "upload.bin" }
        val f = File(cacheDir, safe)
        contentResolver.openInputStream(uri).use { input ->
            if (input == null) throw IllegalStateException("无法读取所选文件")
            FileOutputStream(f).use { out -> input.copyTo(out) }
        }
        return f
    }

    private fun queryDisplayName(uri: Uri): String {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) return c.getString(idx) ?: ""
                }
            }
        } catch (_: Exception) {
        }
        return "file"
    }

    private fun querySize(uri: Uri): Long {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.SIZE)
                    if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx)
                }
            }
        } catch (_: Exception) {
        }
        return 0L
    }

    private fun fmtSize(bytes: Long): String = when {
        bytes >= 1024L * 1024 * 1024 -> "%.2f GB".format(bytes / 1024.0 / 1024.0 / 1024.0)
        bytes >= 1024L * 1024 -> "%.2f MB".format(bytes / 1024.0 / 1024.0)
        bytes >= 1024L -> "%.1f KB".format(bytes / 1024.0)
        else -> "$bytes B"
    }

    // ================= 线程/权限工具 =================

    private fun bg(block: () -> Unit) {
        Thread(block).start()
    }

    private fun ui(block: () -> Unit) {
        runOnUiThread(block)
    }

    private fun uiLater(block: () -> Unit) {
        window.decorView.postDelayed(block, 300)
    }

    private fun dp(v: Int): Int = Ui.dp(this, v)

    // ================= v2.1 超级终端：语音 / 快捷面板 / 倾斜甩屏 =================

    private fun quickTile(label: String, command: String): Button {
        val b = Ui.button(this, label) { ask(command) }
        b.textSize = 13f
        b.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            rightMargin = dp(6)
        }
        return b
    }

    private fun ask(text: String) {
        val q = text.trim()
        if (q.isEmpty()) {
            askReply.text = "先说一句话，或点上面的快捷按钮"
            return
        }
        if (!App.isConfigured()) {
            askReply.text = "请先在 01 中枢连接 配置电脑地址（IP:7410）"
            return
        }
        voiceHint.text = "AI 正在理解：$q"
        askReply.text = "思考中…"
        bg {
            val msg = try {
                formatAskReply(TenonClient.superAsk(q))
            } catch (e: Exception) {
                "请求失败：${e.message}\n（v2.1 super 服务未就绪时属预期；中枢合入 /api/v2/super/ask 后可用）"
            }
            ui { askReply.text = msg; voiceHint.text = "指令已发送：$q" }
        }
    }

    private fun formatAskReply(resp: org.json.JSONObject): String {
        val sb = StringBuilder()
        val say = resp.optString("say", resp.optString("reply", ""))
        if (say.isNotBlank()) sb.append(say).append("\n")
        val plan = resp.optJSONArray("plan")
        if (plan != null && plan.length() > 0) {
            sb.append("\n计划：\n")
            for (i in 0 until plan.length()) {
                val step = plan.optJSONObject(i) ?: continue
                val label = step.optString("label", step.optString("capabilityId", "第 ${i + 1} 步"))
                sb.append("  ${i + 1}. $label\n")
            }
        }
        val result = resp.optJSONObject("result")
        if (result != null) sb.append("\n结果：").append(result.toString().take(300)).append("\n")
        if (sb.isBlank()) sb.append(resp.toString().take(600))
        return sb.toString().trim()
    }

    private fun ensureVoiceReady(): Boolean {
        if (!VoiceRecognizer.isAvailable(this)) {
            voiceHint.text = "本机没有可用的语音识别引擎 → 已降级为文字输入"
            askInput.requestFocus()
            return false
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingVoiceStart = true
            voiceHint.text = "正在申请麦克风权限…"
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
            return false
        }
        return true
    }

    private fun startVoice() {
        if (!ensureVoiceReady()) return
        if (voice == null) {
            voice = VoiceRecognizer(
                this,
                onResult = { text ->
                    runOnUiThread {
                        voiceHint.text = "识别到：$text"
                        askInput.setText(text)
                        ask(text)
                    }
                },
                onError = { msg ->
                    runOnUiThread {
                        voiceHint.text = "$msg → 已降级为文字输入"
                        askInput.requestFocus()
                    }
                },
                onState = { state -> runOnUiThread { voiceHint.text = state } }
            )
        }
        voiceButton.text = "🎤 正在听…（松开结束）"
        voice?.start("zh-CN")
    }

    private fun stopVoice() {
        voiceButton.text = "🎤 按住说话"
        voice?.stop()
    }

    private fun setupTilt() {
        tiltDetector?.stop()
        tiltDetector = null
        if (!App.tiltEnabled()) {
            tiltSwitch.isChecked = false
            tiltStatus.text = "倾斜甩屏：已关闭（可用下方按钮手动甩到电脑）"
            return
        }
        tiltSwitch.isChecked = true
        val detector = TiltDetector(this, App.tiltSensitivity()) { angle ->
            runOnUiThread {
                tiltStatus.text = "检测到前倾 ${"%.0f".format(angle)}° → 正在甩到电脑…"
                triggerHandoff("tilt")
            }
        }
        if (!detector.available) {
            tiltStatus.text = "倾斜甩屏：本机没有加速度计，请用「甩到电脑（手动）」"
            return
        }
        tiltDetector = detector
        detector.start()
        tiltStatus.text = "倾斜甩屏：已开启（阈值 ${App.tiltSensitivity()}°，前倾 1 秒内触发）"
    }

    private fun toggleTilt(on: Boolean) {
        App.setTiltEnabled(on)
        if (on) setupTilt() else {
            tiltDetector?.stop()
            tiltDetector = null
            tiltStatus.text = "倾斜甩屏：已关闭"
        }
    }

    private fun triggerHandoff(reason: String) {
        if (!App.isConfigured()) {
            tiltStatus.text = "请先配置中枢地址"
            return
        }
        val why = if (reason == "tilt") "手机前倾甩屏" else "手动甩屏"
        tiltStatus.text = "正在甩到电脑…"
        bg {
            val msg = try {
                val resp = TenonClient.superHandoff(
                    kind = "page",
                    url = "tenon://android/page",
                    text = "手机页面（$why）"
                )
                val id = resp.optString("handoffId", "")
                val dispatched = resp.optBoolean("dispatched", true)
                "已甩到电脑：$why" + (if (id.isNotBlank()) "（handoffId=$id）" else "") +
                    (if (!dispatched) " · 电脑节点离线，已记录待取" else "")
            } catch (e: Exception) {
                "甩屏失败：${e.message}\n（v2.1 super/handoff 未就绪时属预期）"
            }
            ui { tiltStatus.text = msg }
        }
    }

    private fun pollSuperState() {
        if (!App.isConfigured()) {
            tiltStatus.text = "请先配置中枢地址"
            return
        }
        tiltStatus.text = "正在拉取流转状态…"
        bg {
            val msg = try {
                val obj = TenonClient.superState()
                if (obj == null) "流转状态不可用（/api/v2/super/state 未就绪）"
                else "流转状态：${obj.toString().take(320)}"
            } catch (e: Exception) {
                "拉取失败：${e.message}"
            }
            ui { tiltStatus.text = msg }
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF_PERM)
        }
    }
}