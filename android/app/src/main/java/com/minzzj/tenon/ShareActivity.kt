package com.minzzj.tenon

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import com.minzzj.tenon.net.TenonClient
import java.io.File
import java.io.FileOutputStream

/**
 * 分享目标（契约 §5）：相册/文件管理器 → 分享到「榫卯」→
 * 优先 multipart 上传素材库（POST /api/v2/assets/ingest）；
 * 若中枢未实现该端点，降级走文件传输分块上传（POST /api/v2/link/transfer/init 等）。
 */
class ShareActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)
        val header = Ui.row(this)
        val title = Ui.title(this, "分享到榫卯")
        title.layoutParams = LinearLayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        header.addView(title)
        val close = Ui.button(this, "关闭") { finish() }
        close.layoutParams = LinearLayoutParams(Ui.dp(this, 84), ViewGroup.LayoutParams.WRAP_CONTENT)
        header.addView(close)
        root.addView(header)
        status = Ui.body(this, "正在准备…")
        root.addView(status)
        progress = Ui.progress(this)
        root.addView(progress)
        root.addView(Ui.hint(this, "上传目标：素材库（失败时降级为文件传输）；只发文件本体，不发正文。"))
        setContentView(Ui.scroll(this, root))

        if (!App.isConfigured()) {
            status.text = "未配置中枢：请先打开「榫卯 Tenon」App，在主界面填写中枢地址并保存"
            return
        }
        val uris = collectUris(intent)
        if (uris.isEmpty()) {
            status.text = "没有收到可上传的文件"
            return
        }
        uploadAll(uris)
    }

    private fun LinearLayoutParams(w: Int, h: Int, weight: Float = 0f): android.widget.LinearLayout.LayoutParams =
        android.widget.LinearLayout.LayoutParams(w, h, weight)

    private fun uploadAll(uris: List<Uri>) {
        Thread {
            val sb = StringBuilder()
            var okCount = 0
            uris.forEachIndexed { index, uri ->
                val name = queryName(uri)
                runOnUiThread {
                    status.text = "上传 ${index + 1}/${uris.size}：$name"
                    progress.progress = 0
                }
                try {
                    // 1) 优先素材库 multipart
                    val tmp = copyToCache(uri, name)
                    val resp = TenonClient.ingestMultipart(tmp) { sent ->
                        val pct = if (tmp.length() > 0) ((sent * 100) / tmp.length()).toInt() else 0
                        runOnUiThread {
                            progress.progress = pct
                            status.text = "上传 ${index + 1}/${uris.size}：$name $pct%"
                        }
                    }
                    val id = resp.optString("assetId", resp.optString("id", ""))
                    okCount++
                    sb.append("· ").append(name).append(" → 素材库")
                    if (id.isNotBlank()) sb.append("（").append(id).append("）")
                    sb.append("\n")
                } catch (e: Exception) {
                    // 2) 降级：文件传输分块上传
                    try {
                        val tmp = copyToCache(uri, name)
                        var lastPct = -1
                        val r = TenonClient.uploadFile(tmp, App.peerId()) { sent, total ->
                            val pct = if (total > 0) ((sent * 100) / total).toInt() else 0
                            if (pct != lastPct) {
                                lastPct = pct
                                runOnUiThread {
                                    progress.progress = pct
                                    status.text = "上传 ${index + 1}/${uris.size}：$name $pct%（文件传输）"
                                }
                            }
                        }
                        okCount++
                        sb.append("· ").append(name).append(" → 文件传输 transferId=").append(r.transferId).append("\n")
                    } catch (e2: Exception) {
                        sb.append("· ").append(name).append(" 失败：").append(e2.message).append("\n")
                    }
                }
            }
            runOnUiThread {
                progress.progress = 100
                status.text = "完成 $okCount/${uris.size}\n$sb"
            }
        }.start()
    }

    private fun collectUris(intent: Intent?): List<Uri> {
        val list = mutableListOf<Uri>()
        if (intent == null) return list
        if (Intent.ACTION_SEND == intent.action) {
            val u: Uri? = if (Build.VERSION.SDK_INT >= 33)
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else
                @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
            if (u != null) list.add(u)
        } else if (Intent.ACTION_SEND_MULTIPLE == intent.action) {
            val us: ArrayList<Uri>? = if (Build.VERSION.SDK_INT >= 33)
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else
                @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
            if (us != null) list.addAll(us)
        }
        if (list.isEmpty()) {
            val clip = intent.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) list.add(clip.getItemAt(i).uri)
            }
        }
        return list
    }

    private fun copyToCache(uri: Uri, name: String): File {
        val safe = name.replace("/", "_").replace("\\", "_").ifBlank { "share.bin" }
        val f = File(cacheDir, safe)
        contentResolver.openInputStream(uri).use { input ->
            if (input == null) throw IllegalStateException("无法读取分享文件")
            FileOutputStream(f).use { out -> input.copyTo(out) }
        }
        return f
    }

    private fun queryName(uri: Uri): String {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) return c.getString(idx) ?: ""
                }
            }
        } catch (_: Exception) {
        }
        return "share-file"
    }
}