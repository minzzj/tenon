package com.minzzj.tenon

import android.app.Activity
import android.app.AlertDialog
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
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 0.6.7 · 记录页（手机 ↔ 电脑记录互通）。
 *
 * 三个分段：
 * - 笔记：GET /api/v2/notes（搜索 / 详情 / AI 总结 / 删除），电脑端「记一下…」的笔记在手机可见；
 * - 全天录音：GET /api/v2/voice/transcripts?limit=100，过滤 source==='ambient'
 *   （电脑端 24h 留痕只记录不执行）；
 * - 屏幕记录：GET /api/v2/voice/screen?limit=50，显示电脑端屏幕/窗口文字（app · title · 摘要）。
 *
 * 所有请求都经 TenonHttp，默认带 x-tenon-token（新版服务端 GET 也需要令牌）。
 */
class VoiceRecordsActivity : Activity() {
    companion object {
        const val EXTRA_TAB = "tab"
        const val TAB_NOTES = 0
        const val TAB_AMBIENT = 1
        const val TAB_SCREEN = 2
    }

    private lateinit var segmentHost: LinearLayout
    private lateinit var contentBox: LinearLayout
    private lateinit var statusText: TextView

    private var selected = TAB_NOTES
    private var day: String = ""
    private var notesQuery = ""
    private var loadSeq = 0
    private var skipResume = true
    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        selected = intent?.getIntExtra(EXTRA_TAB, TAB_NOTES) ?: TAB_NOTES
        if (selected !in TAB_NOTES..TAB_SCREEN) selected = TAB_NOTES
        day = today()

        val root = Ui.column(this)
        val head = Ui.row(this)
        head.addView(Ui.pageHead(this, "记录", "笔记 · 全天录音 · 屏幕记录"))
        head.addView(Ui.action(this, "刷新") { load() })
        head.addView(Ui.action(this, "首页") { TabNav.goHome(this) })
        root.addView(head)

        segmentHost = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, Ui.dp(this@VoiceRecordsActivity, 12), 0, 0)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        root.addView(segmentHost)

        statusText = Ui.hint(this, "正在读取…")
        statusText.setPadding(0, Ui.dp(this, 10), 0, 0)
        root.addView(statusText)

        contentBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        root.addView(contentBox)

        root.addView(Ui.hint(this, "内容来自你电脑的 data/notes 与 data/voice；手机只读展示，不上传第三方。"))

        setContentView(Ui.page(this, root, TabNav.RECORDS))
        renderSegments()
        load()
    }

    override fun onResume() {
        super.onResume()
        if (skipResume) {
            skipResume = false
            return
        }
        load()
    }

    // ================= 分段导航 =================

    private fun renderSegments() {
        segmentHost.removeAllViews()
        segmentHost.addView(
            Ui.segment(this, listOf("笔记", "全天录音", "屏幕记录"), selected) { index ->
                if (index != selected) {
                    selected = index
                    renderSegments()
                    load()
                }
            }
        )
    }

    private fun load() {
        when (selected) {
            TAB_AMBIENT -> loadAmbient()
            TAB_SCREEN -> loadScreen()
            else -> loadNotes()
        }
    }

    private fun newList(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        )
    }

    private fun dayRow(): LinearLayout {
        val row = Ui.row(this)
        row.addView(Ui.button(this, "今天", day == today()) { setDay(today()) })
        row.addView(Ui.button(this, "昨天", day == yesterday()) { setDay(yesterday()) })
        return row
    }

    private fun setDay(d: String) {
        if (d == day) return
        day = d
        load()
    }

    // ================= 笔记 =================

    private fun loadNotes() {
        val seq = ++loadSeq
        contentBox.removeAllViews()
        statusText.text = "正在读取笔记…"

        val searchRow = Ui.row(this)
        val input = Ui.input(this, "搜索笔记（标题 / 正文）", notesQuery)
        input.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            rightMargin = Ui.dp(this@VoiceRecordsActivity, 6)
        }
        searchRow.addView(input)
        val searchBtn = Ui.button(this, "搜索", true) {
            notesQuery = input.text.toString().trim()
            loadNotes()
        }
        searchBtn.layoutParams = LinearLayout.LayoutParams(
            Ui.dp(this, 72), ViewGroup.LayoutParams.WRAP_CONTENT
        )
        searchRow.addView(searchBtn)
        contentBox.addView(searchRow)

        if (notesQuery.isNotBlank()) {
            val clearRow = Ui.row(this)
            clearRow.setPadding(0, Ui.dp(this, 6), 0, 0)
            clearRow.addView(Ui.button(this, "清除搜索：" + notesQuery) {
                notesQuery = ""
                loadNotes()
            })
            contentBox.addView(clearRow)
        }

        val listBox = newList()
        contentBox.addView(listBox)

        bg {
            var items: JSONArray? = null
            var total = 0
            var err: String? = null
            try {
                val r = TenonClient.notesList(q = notesQuery, limit = 100)
                items = ReminderNotifier.firstArray(r, "items", "notes", "data")
                total = r.optInt("total", items?.length() ?: 0)
            } catch (e: Exception) {
                err = failure(e)
            }
            ui {
                if (seq != loadSeq) return@ui
                if (err != null) {
                    statusText.text = "读取笔记失败"
                    listBox.addView(Ui.body(this, err))
                    listBox.addView(Ui.hint(this, "在「设置 → 中枢连接」确认地址和操作令牌后点「刷新」。"))
                    return@ui
                }
                val arr = items ?: JSONArray()
                statusText.text =
                    if (notesQuery.isBlank()) "笔记 · 共 " + total + " 条"
                    else "搜索「" + notesQuery + "」· " + arr.length() + " 条"
                if (arr.length() == 0) {
                    listBox.addView(
                        Ui.body(
                            this,
                            if (notesQuery.isBlank())
                                "还没有笔记。对手机说「记一下…」，或在首页点「📝 记笔记」。"
                            else "没有匹配的笔记，换个关键词试试。"
                        )
                    )
                    return@ui
                }
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    listBox.addView(noteCard(o))
                }
            }
        }
    }

    private fun noteCard(o: JSONObject): LinearLayout {
        val id = o.optString("id", o.optString("noteId", ""))
        val text = noteText(o)
        val title = o.optString("title", "").ifBlank {
            text.lineSequence().firstOrNull()?.take(28) ?: "（无标题笔记）"
        }
        val source = sourceLabel(o.optString("source", ""))
        val at = timeText(o)
        val excerpt = o.optString("excerpt", "").ifBlank { text.replace("\n", " ").take(110) }
        val card = Ui.listCard(this) { if (id.isNotBlank()) showNote(id) }
        card.addView(TextView(this).apply {
            this.text = title.ifBlank { "（无标题笔记）" }
            textSize = 15f
            setTextColor(Ui.PAPER)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        card.addView(Ui.meta(this, source + " · " + at))
        if (excerpt.isNotBlank()) card.addView(Ui.body(this, excerpt))
        return card
    }

    private fun showNote(id: String) {
        statusText.text = "正在读取笔记详情…"
        bg {
            var note: JSONObject? = null
            var msg: String
            try {
                val r = TenonClient.noteDetail(id)
                val n = r.optJSONObject("note") ?: r
                note = n
                msg = buildString {
                    append(n.optString("title", "").ifBlank { "（无标题）" }).append("\n")
                    append(timeText(n)).append("\n\n")
                    append(noteText(n))
                }
            } catch (e: Exception) {
                msg = "读取详情失败：" + failure(e)
            }
            val n = note
            ui {
                statusText.text = "笔记 · 点击条目可看详情 / 总结 / 删除"
                val dlg = AlertDialog.Builder(this)
                    .setTitle("笔记详情")
                    .setMessage(msg)
                    .setPositiveButton("关闭", null)
                    .create()
                if (n != null) {
                    dlg.setButton(AlertDialog.BUTTON_NEUTRAL, "AI 总结这段") { _, _ ->
                        dlg.dismiss()
                        summaryNote(id, n.optString("date", today()))
                    }
                    dlg.setButton(AlertDialog.BUTTON_NEGATIVE, "删除") { _, _ ->
                        dlg.dismiss()
                        confirmDelete(id)
                    }
                }
                dlg.show()
            }
        }
    }

    private fun summaryNote(id: String, date: String) {
        statusText.text = "正在生成总结（DeepSeek）…"
        bg {
            var msg: String
            var ok = false
            try {
                val r = TenonClient.documentGenerate("note-summary", date, id)
                msg = structuredText(r)
                ok = true
            } catch (e: Exception) {
                msg = "生成失败：" + failure(e)
            }
            ui {
                statusText.text = if (ok) "总结完成 · 可在「文档」下载/分享" else "总结失败"
                AlertDialog.Builder(this)
                    .setTitle(if (ok) "AI 结构化总结" else "总结失败")
                    .setMessage(msg)
                    .setPositiveButton("去文档") { _, _ -> TabNav.go(this, TabNav.DOCUMENTS) }
                    .setNegativeButton("关闭", null)
                    .show()
            }
        }
    }

    private fun confirmDelete(id: String) {
        AlertDialog.Builder(this)
            .setTitle("删除这条笔记？")
            .setMessage("删除后不可恢复；电脑端 data/notes 中对应文件也会删除。")
            .setPositiveButton("删除") { _, _ ->
                bg {
                    val msg = try {
                        TenonClient.noteDelete(id)
                        "已删除"
                    } catch (e: Exception) {
                        "删除失败：" + failure(e)
                    }
                    ui {
                        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
                        loadNotes()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ================= 全天录音（电脑端 24h 留痕） =================

    private fun loadAmbient() {
        val seq = ++loadSeq
        contentBox.removeAllViews()
        contentBox.addView(dayRow())
        val listBox = newList()
        contentBox.addView(listBox)
        statusText.text = "正在读取全天录音…"
        val loadDay = day
        bg {
            var items: JSONArray? = null
            var total = 0
            var err: String? = null
            try {
                val first = TenonClient.voiceTranscripts(loadDay, 100)
                items = first?.optJSONArray("items")
                total = first?.optInt("total", items?.length() ?: 0) ?: 0
                if (total > (items?.length() ?: 0)) {
                    // 契约默认 limit=100；当天转写更多时再用同一接口取全量，避免全天留痕被最近 100 条截断
                    val more = TenonClient.voiceTranscripts(loadDay, 1000)
                    if (more != null) {
                        items = more.optJSONArray("items")
                        total = more.optInt("total", total)
                    }
                }
            } catch (e: Exception) {
                err = failure(e)
            }
            ui {
                if (seq != loadSeq) return@ui
                if (err != null) {
                    statusText.text = "读取全天录音失败"
                    listBox.addView(Ui.body(this, err))
                    listBox.addView(Ui.hint(this, "新版服务端 GET 也要令牌：到「设置」填写 operatorToken。"))
                    return@ui
                }
                val arr = items ?: JSONArray()
                val ambient = ArrayList<JSONObject>()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (o.optString("source", "") == "ambient") ambient.add(o)
                }
                val shown =
                    if (ambient.size > 100) ambient.subList(ambient.size - 100, ambient.size) else ambient
                statusText.text = "全天录音 · " + loadDay + " · 留痕 " + ambient.size + " 条" +
                        (if (shown.size < ambient.size) "（显示最近 " + shown.size + " 条）" else "")
                if (shown.isEmpty()) {
                    listBox.addView(
                        Ui.body(
                            this,
                            "这一天还没有全天录音（共 " + total + " 条转写）。\n" +
                                    "打开手机首页「⏺ 24 小时录制」（或设置 → 10 · 24 小时录制），" +
                                    "手机就会约 12 秒一段上传到电脑并以 ambient 入库，只记录、不执行命令。"
                        )
                    )
                    return@ui
                }
                for (i in shown.indices.reversed()) listBox.addView(ambientCard(shown[i]))
            }
        }
    }

    private fun ambientCard(o: JSONObject): LinearLayout {
        val at = clockText(o.optString("at", ""))
        val text = o.optString("text", "")
        val redacted = o.optBoolean("redacted", false)
        val card = Ui.listCard(this)
        card.addView(Ui.meta(this, "🕒 " + at))
        card.addView(
            Ui.body(
                this,
                when {
                    redacted -> "（含敏感信息，已由电脑端过滤）"
                    text.isBlank() -> "（空转写）"
                    else -> text
                }
            )
        )
        return card
    }

    // ================= 屏幕记录（电脑屏幕在手机可见） =================

    private fun loadScreen() {
        val seq = ++loadSeq
        contentBox.removeAllViews()
        contentBox.addView(dayRow())
        val listBox = newList()
        contentBox.addView(listBox)
        statusText.text = "正在读取屏幕记录…"
        val loadDay = day
        bg {
            var items: JSONArray? = null
            var total = 0
            var err: String? = null
            try {
                val r = TenonClient.voiceScreenList(loadDay, 50)
                items = r?.optJSONArray("items")
                total = r?.optInt("total", items?.length() ?: 0) ?: 0
            } catch (e: Exception) {
                err = failure(e)
            }
            ui {
                if (seq != loadSeq) return@ui
                if (err != null) {
                    statusText.text = "读取屏幕记录失败"
                    listBox.addView(Ui.body(this, err))
                    listBox.addView(Ui.hint(this, "新版服务端 GET 也要令牌：到「设置」填写 operatorToken。"))
                    return@ui
                }
                val arr = items ?: JSONArray()
                var pcCount = 0
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (o.optString("source", "") != "phone") pcCount += 1
                }
                statusText.text = "屏幕记录 · " + loadDay + " · 电脑 " + pcCount + " 条 / 手机 " +
                        (arr.length() - pcCount) + " 条" +
                        (if (total > arr.length()) "（当天共 " + total + " 条）" else "")
                if (arr.length() == 0) {
                    listBox.addView(
                        Ui.body(
                            this,
                            "这一天还没有屏幕记录。\n电脑端开启屏幕内容采集后，会按间隔记录窗口文字；手机这里只读展示，可随时回看。"
                        )
                    )
                    return@ui
                }
                for (i in arr.length() - 1 downTo 0) {
                    val o = arr.optJSONObject(i) ?: continue
                    listBox.addView(screenCard(o))
                }
            }
        }
    }

    private fun screenCard(o: JSONObject): LinearLayout {
        val at = clockText(o.optString("at", ""))
        val app = o.optString("app", "").trim()
        val title = o.optString("title", "").trim()
        val redacted = o.optBoolean("redacted", false)
        val source = if (o.optString("source", "") == "phone") "手机" else "电脑"
        val engine = o.optString("engine", "").trim()
        val text = o.optString("text", "").replace("\n", " ").trim()
        val head = listOf(app, title).filter { it.isNotBlank() }.joinToString(" · ").ifBlank { source + "屏幕" }
        val card = Ui.listCard(this)
        card.addView(TextView(this).apply {
            this.text = "🖥 " + head
            textSize = 14f
            setTextColor(Ui.PAPER)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        card.addView(Ui.meta(this, at + " · " + source + (if (engine.isNotBlank()) " · " + engine else "")))
        card.addView(
            Ui.body(
                this,
                when {
                    redacted -> "（含敏感信息，已由电脑端过滤）"
                    text.isBlank() -> "（这一条没有识别到文字）"
                    text.length > 240 -> text.take(240) + "…"
                    else -> text
                }
            )
        )
        return card
    }

    // ================= 格式化 / 错误 =================

    private fun noteText(o: JSONObject): String =
        o.optString("text", o.optString("content", o.optString("body", o.optString("excerpt", ""))))

    private fun timeText(o: JSONObject): String {
        val d = o.optString("date", "")
        val t = o.optString("time", "")
        if (d.isNotBlank() && t.isNotBlank()) return (d + " " + t).take(16)
        return localDateTime(o.optString("createdAt", o.optString("at", ""))).take(16)
    }

    /** ISO 时间 → 本地 HH:mm:ss。 */
    private fun clockText(raw: String): String {
        val local = localDateTime(raw)
        return if (local.length >= 16) local.substring(11) else local
    }

    /** ISO（带 Z 视为 UTC，无 Z 视为本地）→ 本地 yyyy-MM-dd HH:mm，避免手机显示电脑的 UTC 时间。 */
    private fun localDateTime(raw: String): String {
        val s = raw.trim()
        if (s.isBlank()) return "—"
        return try {
            val utc = s.endsWith("Z")
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
                timeZone = TimeZone.getTimeZone(if (utc) "UTC" else TimeZone.getDefault().id)
            }
            val dt = fmt.parse(s.replace("Z", "").take(19))
            if (dt == null) s.take(19)
            else SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(dt)
        } catch (_: Exception) {
            s.take(19)
        }
    }

    private fun sourceLabel(raw: String): String = when (raw) {
        "voice" -> "语音"
        "text" -> "文字"
        "android" -> "手机"
        "" -> "笔记"
        else -> raw
    }

    /** 兼容结构化字段：摘要/重点/待办/回顾/日记（与旧记录页一致）。 */
    private fun structuredText(r: JSONObject): String {
        val src = r.optJSONObject("document") ?: r.optJSONObject("result") ?: r
        val sb = StringBuilder()
        fun section(label: String, keys: Array<String>) {
            for (k in keys) {
                val v = src.opt(k) ?: continue
                val text = when (v) {
                    is JSONArray -> (0 until v.length()).joinToString("；") { v.optString(it) }
                    else -> v.toString()
                }
                if (text.isNotBlank() && text != "null") {
                    sb.append("【").append(label).append("】\n").append(text).append("\n\n")
                    return
                }
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

    private fun failure(e: Exception): String {
        if (e is TenonClient.VoiceHttpException) {
            return when {
                e.isAuth -> "需要操作令牌（HTTP " + e.code + "）：去「设置」填写 operatorToken"
                e.code == 404 -> "电脑端接口未就绪（HTTP 404）"
                else -> "HTTP " + e.code
            }
        }
        val m = e.message ?: "网络错误"
        return if (m.contains("Failed to connect") || m.contains("Connection refused") || m.contains("timeout")) {
            "连不上中枢（同一 WiFi / 中枢地址 / 电脑 App 是否运行）"
        } else m.take(120)
    }

    private fun today(): String = dayFmt.format(Date())

    private fun yesterday(): String {
        val c = Calendar.getInstance()
        c.add(Calendar.DAY_OF_MONTH, -1)
        return dayFmt.format(c.time)
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
