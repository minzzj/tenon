package com.minzzj.tenon

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** V5 记录页：笔记列表/搜索/详情/删除 +「总结这段」（POST /documents/generate）。 */
class NotesActivity : Activity() {
    private lateinit var searchInput: EditText
    private lateinit var statusText: TextView
    private lateinit var listBox: LinearLayout
    private var loading = false
    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)
        val top = Ui.row(this)
        val title = Ui.title(this, "记录")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(title)
        top.addView(Ui.button(this, "刷新") { load() })
        top.addView(Ui.button(this, "返回") { finish() })
        root.addView(top)

        val row = Ui.row(this)
        searchInput = Ui.input(this, "搜索笔记（标题/内容）")
        searchInput.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(searchInput)
        row.addView(Ui.button(this, "搜索", true) { load() })
        root.addView(row)

        root.addView(Ui.hint(this, "语音说「记一下…」会出现在这里；点笔记可看详情、删除或让 AI 总结这段。"))
        statusText = Ui.hint(this, "正在读取笔记…")
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
        statusText.text = "正在读取笔记…"
        val q = searchInput.text.toString().trim()
        bg {
            var items: JSONArray? = null
            var msg: String
            try {
                val r = TenonClient.notesList(q = q)
                items = ReminderNotifier.firstArray(r, "items", "notes", "data")
                msg = "共 " + (items?.length() ?: 0) + " 条笔记" + (if (q.isNotBlank()) "（搜索：$q）" else "")
            } catch (e: Exception) {
                msg = "读取失败：" + readable(e)
            }
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
            listBox.addView(Ui.body(this, "还没有笔记。对手机说「记一下：…」或在电脑端记录后刷新。"))
            return
        }
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            listBox.addView(noteCard(o))
        }
    }

    private fun noteCard(o: JSONObject): LinearLayout {
        val id = o.optString("id", o.optString("noteId", ""))
        val title = o.optString("title", "").ifBlank { firstLine(textOf(o)).take(30) }
        val source = o.optString("source", o.optString("from", "文字"))
        val at = timeText(o)
        val summary = o.optString("summary", "").ifBlank { textOf(o).replace("\n", " ").take(90) }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(Ui.dp(this@NotesActivity, 14), Ui.dp(this@NotesActivity, 10),
                Ui.dp(this@NotesActivity, 14), Ui.dp(this@NotesActivity, 12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = Ui.dp(this@NotesActivity, 8) }
            setOnClickListener { showDetail(id) }
        }
        card.addView(TextView(this).apply {
            text = title.ifBlank { "（无标题笔记）" }
            textSize = 16f
            setTextColor(Ui.PAPER)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        card.addView(Ui.hint(this, (if (source.isNotBlank()) "[" + source + "] " else "") + at))
        card.addView(Ui.body(this, summary))
        return card
    }

    private fun showDetail(id: String) {
        bg {
            var text: String
            var note: JSONObject?
            try {
                val r = TenonClient.noteDetail(id)
                note = r.optJSONObject("note") ?: r
                text = buildDetail(note)
            } catch (e: Exception) {
                note = null
                text = "读取详情失败：" + readable(e)
            }
            ui {
                val d = AlertDialog.Builder(this)
                    .setTitle("笔记详情")
                    .setMessage(text)
                    .setPositiveButton("关闭", null)
                    .create()
                if (note != null) {
                    d.setButton(AlertDialog.BUTTON_NEUTRAL, "总结这段") { _, _ ->
                        d.dismiss(); generateSummary(id, note.optString("date", dayFmt.format(Date())))
                    }
                    d.setButton(AlertDialog.BUTTON_NEGATIVE, "删除") { _, _ -> confirmDelete(id) }
                }
                d.show()
            }
        }
    }

    private fun buildDetail(n: JSONObject): String = buildString {
        append(n.optString("title", "").ifBlank { "（无标题）" }).append("\n")
        append(timeText(n)).append("\n\n")
        append(textOf(n))
    }

    private fun generateSummary(noteId: String, date: String) {
        statusText.text = "正在生成总结（DeepSeek）…"
        bg {
            var msg: String
            try {
                val r = TenonClient.documentGenerate("note-summary", date, noteId)
                msg = formatStructured(r)
            } catch (e: Exception) {
                msg = "生成失败：" + readable(e)
            }
            ui {
                statusText.text = "总结完成（可在文档页下载分享）"
                AlertDialog.Builder(this)
                    .setTitle("AI 结构化总结")
                    .setMessage(msg)
                    .setPositiveButton("去文档页") { _, _ -> startActivity(Intent(this, DocumentsActivity::class.java)) }
                    .setNegativeButton("关闭", null)
                    .show()
                load()
            }
        }
    }

    /** 兼容结构化字段：摘要/重点/待办/回顾/日记。 */
    private fun formatStructured(r: JSONObject): String {
        val src = r.optJSONObject("document") ?: r.optJSONObject("result") ?: r
        val sb = StringBuilder()
        fun section(label: String, keys: Array<String>) {
            for (k in keys) {
                val v = src.opt(k) ?: continue
                val text = when (v) {
                    is JSONArray -> (0 until v.length()).joinToString("；") { v.optString(it) }
                    else -> v.toString()
                }
                if (text.isNotBlank() && text != "null") { sb.append("【").append(label).append("】\n").append(text).append("\n\n"); return }
            }
        }
        section("摘要", arrayOf("summary", "abstract", "摘要", "overview"))
        section("重点", arrayOf("highlights", "keyPoints", "重点", "points"))
        section("待办", arrayOf("todos", "todo", "tasks", "待办"))
        section("回顾", arrayOf("review", "retrospective", "回顾"))
        section("日记", arrayOf("diary", "journal", "日记"))
        if (sb.isBlank()) sb.append(src.toString().take(1500))
        val doc = src.optString("id", "")
        if (doc.isNotBlank()) sb.append("\n文档 ID：").append(doc)
        return sb.toString().trim()
    }

    private fun confirmDelete(id: String) {
        AlertDialog.Builder(this)
            .setTitle("删除这条笔记？")
            .setMessage("删除后不可恢复（电脑端 data/notes 中对应文件也会删除）。")
            .setPositiveButton("删除") { _, _ ->
                bg {
                    val msg = try { TenonClient.noteDelete(id); "已删除" } catch (e: Exception) { "删除失败：" + readable(e) }
                    ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); load() }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun timeText(o: JSONObject): String {
        val raw = o.optString("createdAt", o.optString("at", o.optString("date", "")))
        return raw.replace("T", " ").take(16)
    }

    private fun textOf(o: JSONObject): String =
        o.optString("text", o.optString("content", o.optString("body", o.optString("summary", ""))))

    private fun firstLine(s: String): String = s.replace("\r", "").split("\n").firstOrNull() ?: ""

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
