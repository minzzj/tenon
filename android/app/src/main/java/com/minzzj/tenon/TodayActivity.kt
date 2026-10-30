package com.minzzj.tenon

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
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

/**
 * V4 今日页：当天时间线（语音转写 / 屏幕采集 / 执行记录）+「现在总结」+ 历史日期切换。
 * 数据来源：/api/v2/voice/transcripts、/api/v2/voice/screen（未实现则用本机计数提示）、/api/v2/voice/diary。
 */
class TodayActivity : Activity() {
    private lateinit var dateText: TextView
    private lateinit var summaryText: TextView
    private lateinit var timelineText: TextView
    private lateinit var diaryText: TextView
    private val dateFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)
    private val showFmt = SimpleDateFormat("MM-dd EEE", Locale.CHINA)
    private var cursor: Calendar = Calendar.getInstance()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)

        val top = Ui.row(this)
        val title = Ui.title(this, "今日")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(title)
        val back = Ui.button(this, "返回") { finish() }
        back.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 78), ViewGroup.LayoutParams.WRAP_CONTENT)
        top.addView(back)
        root.addView(top)

        val nav = Ui.row(this)
        nav.addView(Ui.button(this, "前一天") { shift(-1) })
        nav.addView(Ui.button(this, "今天", true) { cursor = Calendar.getInstance(); load() })
        nav.addView(Ui.button(this, "后一天") { shift(1) })
        root.addView(nav)

        dateText = Ui.hint(this, "")
        root.addView(dateText)

        summaryText = Ui.body(this, "正在读取…")
        summaryText.textSize = 14f
        root.addView(summaryText)

        val btn = Ui.button(this, "现在总结（生成今日日报）", true) { generate() }
        root.addView(btn)

        val sTimeline = Ui.section(this, "时间线 · 今天做了什么")
        timelineText = Ui.body(this, "（空）")
        timelineText.textSize = 13f
        timelineText.setTextColor(Ui.GREY)
        sTimeline.addView(timelineText)
        root.addView(sTimeline)

        val sDiary = Ui.section(this, "最近总结 / 日记")
        diaryText = Ui.body(this, "（今天还没有总结）")
        diaryText.textSize = 13f
        diaryText.setTextColor(Ui.GREY)
        sDiary.addView(diaryText)
        root.addView(sDiary)

        setContentView(Ui.scroll(this, root))
        load()
    }

    private fun shift(delta: Int) {
        cursor.add(Calendar.DAY_OF_MONTH, delta)
        load()
    }

    private fun load() {
        val key = dateFmt.format(cursor.time)
        dateText.text = showFmt.format(cursor.time) + " · " + key
        summaryText.text = "正在读取…"
        bg {
            var transcripts: JSONArray? = null
            var transcriptTotal = 0
            var diaryMd = ""
            var diaryExists = false
            var screenTotal = -1
            try {
                val tr = TenonClient.voiceTranscripts(key)
                transcripts = tr?.optJSONArray("items")
                transcriptTotal = tr?.optInt("total", 0) ?: 0
            } catch (_: Exception) {}
            try {
                val d = TenonClient.voiceDiary(key)
                diaryExists = d.optBoolean("exists", false)
                diaryMd = d.optString("markdown", "")
            } catch (_: Exception) {}
            try {
                val s = TenonClient.voiceScreenList(key)
                screenTotal = s?.optInt("total", s?.optJSONArray("items")?.length() ?: -1) ?: -1
            } catch (_: Exception) {}
            val finalTranscripts = transcripts
            val finalTotal = transcriptTotal
            val finalDiary = diaryMd
            val finalExists = diaryExists
            val finalScreen = screenTotal
            ui { render(key, finalTranscripts, finalTotal, finalScreen, finalExists, finalDiary) }
        }
    }

    private fun render(
        key: String,
        transcripts: JSONArray?,
        total: Int,
        screenTotal: Int,
        diaryExists: Boolean,
        diaryMd: String
    ) {
        val n = transcripts?.length() ?: 0
        summaryText.text = buildString {
            append("语音 ").append(total).append(" 条")
            append(" · 屏幕采集 ")
            if (screenTotal >= 0) append(screenTotal).append(" 条") else append("本机 ").append(App.screenUploadsToday()).append(" 次（中枢 screen 接口未就绪）")
            append("\n总结：").append(if (diaryExists) "已生成 · 每晚 " + "23:00" else "今天还没有总结")
        }
        val sb = StringBuilder()
        if (transcripts != null) {
            val start = maxOf(0, transcripts.length() - 30)
            for (i in start until transcripts.length()) {
                val o = transcripts.optJSONObject(i) ?: continue
                val at = o.optString("at", "")
                val text = o.optString("text", "")
                val source = o.optString("source", "")
                sb.append(at.replace("T", " ").takeLast(8)).append("  ")
                sb.append(if (source.isNotBlank()) "[" + source + "] " else "")
                sb.append(text).append("\n")
            }
        }
        timelineText.text = if (sb.isBlank()) "（没有语音/执行记录）" else sb.toString().trim()
        diaryText.text = if (diaryMd.isBlank()) "（今天还没有总结；点上方「现在总结」生成）" else diaryMd.take(1500)
    }

    private fun generate() {
        val key = dateFmt.format(cursor.time)
        summaryText.text = "正在生成今日总结（DeepSeek）…"
        bg {
            val msg = try {
                val r = TenonClient.voiceDiaryGenerate()
                if (r.optBoolean("ok", false) || r.optBoolean("already", false)) {
                    val summary = r.optString("summary", "")
                    "总结完成" + (if (summary.isNotBlank()) "：" + summary.take(120) else "") + "（" + key + "）"
                } else "生成失败：" + r.optString("error", r.toString().take(120))
            } catch (e: TenonClient.VoiceHttpException) {
                if (e.isAuth) "需要操作令牌：去设置填写 operatorToken" else "生成失败 HTTP " + e.code
            } catch (e: Exception) {
                "生成失败：" + (e.message ?: "")
            }
            ui { summaryText.text = msg; Toast.makeText(this, msg, Toast.LENGTH_LONG).show(); load() }
        }
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
