package com.minzzj.tenon

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import com.minzzj.tenon.net.TenonClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** V5 文档页：文档列表（笔记总结/日报）+ 下载 MD/DOCX/PDF + FileProvider 分享 + 系统查看器打开。 */
class DocumentsActivity : Activity() {
    private lateinit var statusText: TextView
    private lateinit var listBox: LinearLayout
    private var loading = false
    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)
        val top = Ui.row(this)
        val title = Ui.title(this, "文档")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(title)
        top.addView(Ui.button(this, "刷新") { load() })
        top.addView(Ui.button(this, "返回") { finish() })
        root.addView(top)

        val row = Ui.row(this)
        row.addView(Ui.button(this, "生成今日总结", true) { generateToday() })
        row.addView(Ui.button(this, "打开记录页") { startActivity(Intent(this, NotesActivity::class.java)) })
        root.addView(row)
        root.addView(Ui.hint(this, "文档来自电脑端生成（AI 总结/日报）；下载后保存在 App 私有目录，可一键分享到微信/QQ/邮件或用系统查看器打开。"))
        statusText = Ui.hint(this, "正在读取文档…")
        root.addView(statusText)
        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(listBox)
        setContentView(Ui.scroll(this, root))
        load()
    }

    override fun onResume() { super.onResume(); if (!loading) load() }

    private fun load() {
        if (loading) return
        loading = true
        statusText.text = "正在读取文档…"
        bg {
            var items: JSONArray? = null
            var msg: String
            try {
                val r = TenonClient.documentsList()
                items = ReminderNotifier.firstArray(r, "items", "documents", "data")
                msg = "共 " + (items?.length() ?: 0) + " 个文档"
            } catch (e: Exception) { msg = "读取失败：" + readable(e) }
            ui {
                loading = false
                statusText.text = msg
                listBox.removeAllViews()
                if (items != null) renderList(items)
            }
        }
    }

    private fun renderList(items: JSONArray) {
        if (items.length() == 0) {
            listBox.addView(Ui.body(this, "还没有文档。点「生成今日总结」或到记录页点「总结这段」。"))
            return
        }
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            listBox.addView(docCard(o))
        }
    }

    private fun docCard(o: JSONObject): LinearLayout {
        val id = o.optString("id", o.optString("docId", ""))
        val title = o.optString("title", "文档 " + id)
        val kind = o.optString("kind", o.optString("type", ""))
        val at = o.optString("createdAt", o.optString("at", "")).replace("T", " ").take(16)
        val size = o.optLong("bytes", o.optLong("size", 0))
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(Ui.dp(this@DocumentsActivity, 14), Ui.dp(this@DocumentsActivity, 10),
                Ui.dp(this@DocumentsActivity, 14), Ui.dp(this@DocumentsActivity, 10))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = Ui.dp(this@DocumentsActivity, 8) }
        }
        card.addView(TextView(this).apply {
            text = "📄 " + title
            textSize = 16f
            setTextColor(Ui.PAPER)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        card.addView(Ui.hint(this, (if (kind.isNotBlank()) kind + " · " else "") + at +
                (if (size > 0) " · " + (size / 1024) + "KB" else "")))
        val row = Ui.row(this)
        row.addView(Ui.button(this, "分享 MD", true) { download(id, "md", Action.SHARE) })
        row.addView(Ui.button(this, "分享 DOCX") { download(id, "docx", Action.SHARE) })
        row.addView(Ui.button(this, "分享 PDF") { download(id, "pdf", Action.SHARE) })
        card.addView(row)
        val row2 = Ui.row(this)
        row2.addView(Ui.button(this, "打开 MD") { download(id, "md", Action.OPEN) })
        row2.addView(Ui.button(this, "仅下载 MD") { download(id, "md", Action.SAVE) })
        card.addView(row2)
        return card
    }

    private enum class Action { SHARE, OPEN, SAVE }

    private fun download(id: String, format: String, action: Action) {
        statusText.text = "正在下载 " + format.uppercase() + "…"
        bg {
            var msg: String
            try {
                val r = TenonClient.documentDownload(id, format)
                if (r.code !in 200..299) {
                    msg = "下载失败 HTTP " + r.code + (if (r.code == 404) "（电脑端文档接口未就绪）" else "")
                } else if (r.bytes.isEmpty()) {
                    msg = "下载失败：返回空文件"
                } else {
                    val name = safeName("tenon-" + id + "." + format)
                    val file = File(App.documentsDir(), name)
                    file.writeBytes(r.bytes)
                    msg = when (action) {
                        Action.SHARE -> { share(file); "已下载并分享：" + name }
                        Action.OPEN -> { open(file, r.contentType); "已下载并打开：" + name }
                        Action.SAVE -> "已保存到 App 私有目录：" + name
                    }
                }
            } catch (e: Exception) { msg = "下载失败：" + readable(e) }
            ui { statusText.text = msg; Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    private fun share(file: File) {
        try {
            val uri: Uri = FileProvider.getUriForFile(this, packageName + ".fileprovider", file)
            val mime = mimeOf(file.name)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, file.nameWithoutExtension)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, "分享文档到…"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败：" + (e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    private fun open(file: File, contentType: String?) {
        try {
            val uri: Uri = FileProvider.getUriForFile(this, packageName + ".fileprovider", file)
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, contentType ?: mimeOf(file.name))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(view)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "没有可打开该格式的应用（可用「分享」发到微信/邮件）", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "打开失败：" + (e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    private fun generateToday() {
        val today = dayFmt.format(Date())
        statusText.text = "正在生成今日总结（DeepSeek）…"
        bg {
            val msg = try {
                val r = TenonClient.documentGenerate("daily-summary", today)
                val id = r.optString("id", r.optJSONObject("document")?.optString("id", "") ?: "")
                "今日总结已生成" + (if (id.isNotBlank()) "（文档 $id）" else "") + " · 可下载分享"
            } catch (e: Exception) { "生成失败：" + readable(e) }
            ui { statusText.text = msg; Toast.makeText(this, msg, Toast.LENGTH_LONG).show(); load() }
        }
    }

    private fun safeName(raw: String): String =
        raw.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)

    private fun mimeOf(name: String): String = when {
        name.endsWith(".docx") -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        name.endsWith(".pdf") -> "application/pdf"
        name.endsWith(".md") -> "text/markdown"
        else -> "application/octet-stream"
    }

    private fun readable(e: Exception): String {
        if (e is TenonClient.VoiceHttpException) {
            return when {
                e.code == 404 -> "电脑端接口未就绪（后端并行实现中），稍后刷新"
                e.isAuth -> "需要操作令牌（401/403）：去设置填写"
                else -> "HTTP " + e.code
            }
        }
        val m = e.message ?: "网络错误"
        return if (m.contains("Failed to connect") || m.contains("timeout")) "连不上中枢（同一 WiFi / 中枢地址）" else m.take(120)
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
