package com.minzzj.tenon

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** V5 提醒页：创建（一次性/每天）+ 列表（待触发/已逾期/已完成）+ 完成/删除；前台 30s 刷新。 */
class RemindersActivity : Activity() {
    private lateinit var textInput: EditText
    private lateinit var atInput: EditText
    private lateinit var dailySwitch: Switch
    private lateinit var statusText: TextView
    private lateinit var listBox: LinearLayout
    private val handler = Handler(Looper.getMainLooper())
    private var loading = false
    private val apiFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.CHINA)
    private val showFmt = SimpleDateFormat("MM-dd HH:mm", Locale.CHINA)

    private val poll = object : Runnable {
        override fun run() {
            refreshPending()
            handler.postDelayed(this, 30_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ReminderNotifier.ensureChannel(this)
        val root = Ui.column(this)
        val top = Ui.row(this)
        top.addView(Ui.pageHead(this, "提醒", "待触发 / 已完成 · 到点通知"))
        top.addView(Ui.action(this, "刷新") { load() })
        top.addView(Ui.action(this, "首页") { TabNav.goHome(this) })
        root.addView(top)

        val sNew = Ui.section(this, "新建提醒")
        textInput = Ui.input(this, "提醒内容，如：喝水 / 交周报")
        sNew.addView(textInput)
        atInput = Ui.input(this, "时间（yyyy-MM-dd HH:mm）")
        sNew.addView(atInput)
        val quickAt = Ui.row(this)
        quickAt.addView(Ui.button(this, "10 分钟后") { setAt(10) })
        quickAt.addView(Ui.button(this, "1 小时后") { setAt(60) })
        sNew.addView(quickAt)
        dailySwitch = Ui.switchRow(this, "每天重复", false) { }
        sNew.addView(dailySwitch)
        sNew.addView(Ui.button(this, "添加提醒", true) { create() })
        sNew.addView(Ui.hint(this, "到点手机本地弹通知（channel「提醒」，点击打开 App）；App 在前台每 30 秒检查一次，后台由 WorkManager 每 15 分钟兜底。"))
        root.addView(sNew)

        statusText = Ui.hint(this, "正在读取提醒…")
        root.addView(statusText)
        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(listBox)
        setContentView(Ui.page(this, root, TabNav.REMINDERS))

        val cal = Calendar.getInstance()
        cal.add(Calendar.MINUTE, 10)
        atInput.setText(SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(cal.time))
        load()
    }

    /** 快捷设置提醒时间（10 分钟 / 1 小时后）。 */
    private fun setAt(minutes: Int) {
        val cal = Calendar.getInstance()
        cal.add(Calendar.MINUTE, minutes)
        atInput.setText(SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(cal.time))
    }

    override fun onResume() {
        super.onResume()
        if (App.remindersEnabled()) handler.postDelayed(poll, 30_000)
    }

    override fun onPause() {
        handler.removeCallbacksAndMessages(null)
        super.onPause()
    }

    private fun create() {
        val text = textInput.text.toString().trim()
        if (text.isBlank()) { Toast.makeText(this, "先写提醒内容", Toast.LENGTH_SHORT).show(); return }
        val atRaw = atInput.text.toString().trim().replace(" ", "T")
        if (atRaw.isBlank()) { Toast.makeText(this, "先填时间", Toast.LENGTH_SHORT).show(); return }
        val at = if (atRaw.length == 16) atRaw + ":00" else atRaw
        val recurrence = if (dailySwitch.isChecked) "daily" else "once"
        bg {
            val msg = try {
                TenonClient.reminderCreate(text, at, recurrence)
                "已添加提醒：" + text.take(30) + " · " + at
            } catch (e: Exception) { "添加失败：" + readable(e) }
            ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); textInput.setText(""); load() }
        }
    }

    private fun load() {
        if (loading) return
        loading = true
        statusText.text = "正在读取提醒…"
        bg {
            var items: JSONArray? = null
            var msg: String
            try {
                val r = TenonClient.remindersList()
                items = ReminderNotifier.firstArray(r, "items", "reminders", "data")
                msg = "共 " + (items?.length() ?: 0) + " 条提醒"
            } catch (e: Exception) { msg = "读取失败：" + readable(e) }
            ui {
                loading = false
                statusText.text = msg
                listBox.removeAllViews()
                if (items != null) renderList(items)
            }
        }
    }

    private fun refreshPending() {
        if (!App.remindersEnabled() || !ReminderNotifier.canPost(this)) return
        Thread {
            try {
                val n = ReminderNotifier.pollPending(this)
                ui { if (n > 0) statusText.text = "新提醒 " + n + " 条（已弹通知）；共 " + listBox.childCount + " 条" }
            } catch (_: Exception) {}
        }.start()
    }

    private fun renderList(items: JSONArray) {
        if (items.length() == 0) {
            listBox.addView(Ui.body(this, "还没有提醒。语音说「提醒我 1 分钟后喝水」或在上方新建。"))
            return
        }
        val now = Date()
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            val id = o.optString("id", o.optString("reminderId", ""))
            val text = o.optString("text", o.optString("title", "提醒"))
            val atRaw = o.optString("at", o.optString("when", ""))
            val done = o.optBoolean("done", o.optBoolean("completed", o.optString("status") == "done"))
            val daily = o.optString("recurrence", "once") == "daily" || o.optBoolean("daily", false)
            val atDate = parseAt(atRaw)
            val overdue = !done && atDate != null && atDate.before(now)
            val state = when {
                done -> "已完成"
                overdue -> "已逾期"
                else -> "待触发"
            }
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.bg_card)
                setPadding(Ui.dp(this@RemindersActivity, 14), Ui.dp(this@RemindersActivity, 10),
                    Ui.dp(this@RemindersActivity, 14), Ui.dp(this@RemindersActivity, 10))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = Ui.dp(this@RemindersActivity, 8) }
            }
            card.addView(TextView(this).apply {
                this.text = "⏰ " + text
                textSize = 16f
                setTextColor(if (done) Ui.GREY else Ui.PAPER)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            card.addView(Ui.hint(this, (if (atDate != null) showFmt.format(atDate) else atRaw) + (if (daily) " · 每天" else "") + " · " + state))
            val row = Ui.row(this)
            if (!done) row.addView(Ui.button(this, "完成", true) { done(id) })
            row.addView(Ui.button(this, "删除") { delete(id) })
            card.addView(row)
            listBox.addView(card)
        }
    }

    private fun done(id: String) {
        bg {
            val msg = try { TenonClient.reminderDone(id); "已完成" } catch (e: Exception) { "操作失败：" + readable(e) }
            ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); load() }
        }
    }

    private fun delete(id: String) {
        AlertDialog.Builder(this)
            .setTitle("删除提醒？")
            .setPositiveButton("删除") { _, _ ->
                bg {
                    val msg = try { TenonClient.reminderDelete(id); "已删除" } catch (e: Exception) { "删除失败：" + readable(e) }
                    ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); load() }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun parseAt(raw: String): Date? {
        if (raw.isBlank()) return null
        val s = raw.replace("Z", "").replace("T", " ")
        for (fmt in listOf("yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd")) {
            try { return SimpleDateFormat(fmt, Locale.CHINA).parse(s.take(if (fmt.contains("ss")) 19 else if (fmt.contains("mm")) 16 else 10)) } catch (_: Exception) {}
        }
        return null
    }

    private fun readable(e: Exception): String {
        if (e is TenonClient.VoiceHttpException) {
            return when {
                e.code == 404 -> "电脑端接口未就绪（后端并行实现中）"
                e.isAuth -> "需要操作令牌：去设置填写"
                else -> "HTTP " + e.code
            }
        }
        return (e.message ?: "网络错误").take(120)
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
