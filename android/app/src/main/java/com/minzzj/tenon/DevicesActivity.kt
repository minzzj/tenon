package com.minzzj.tenon

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.minzzj.tenon.net.TenonClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * V4 简化设备页：进入即 GET /api/v2/devices 自动列出设备；
 * 一键「使用这台」= 绑定、「移除」= 解绑；每卡最多 3 个设备动作（来自设备能力列表）；
 * 扫码/配对码等旧流程收进底部「高级」折叠（WebView 打开 #/link）。
 */
class DevicesActivity : Activity() {
    private lateinit var listBox: LinearLayout
    private lateinit var statusText: TextView
    private var loading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)

        val top = Ui.row(this)
        val title = Ui.title(this, "设备")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(title)
        val refresh = Ui.button(this, "刷新") { load() }
        refresh.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 78), ViewGroup.LayoutParams.WRAP_CONTENT)
        top.addView(refresh)
        val back = Ui.button(this, "返回") { finish() }
        back.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 78), ViewGroup.LayoutParams.WRAP_CONTENT)
        top.addView(back)
        root.addView(top)

        statusText = Ui.hint(this, "正在读取设备…")
        root.addView(statusText)

        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(listBox)

        // 高级：旧扫码/配对入口（折叠在底部，不占主流程）
        val advancedTitle = TextView(this).apply {
            text = "高级 ▾"
            textSize = 13f
            setTextColor(Ui.GREY)
            setPadding(0, Ui.dp(this@DevicesActivity, 22), 0, Ui.dp(this@DevicesActivity, 4))
            setOnClickListener { advancedBox.visibility = if (advancedBox.visibility == TextView.VISIBLE) TextView.GONE else TextView.VISIBLE }
        }
        root.addView(advancedTitle)
        advancedBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = TextView.GONE
            addView(Ui.hint(this@DevicesActivity, "旧版扫码 / 6 位配对码 / 信任撤销仍然可用（二级页）；日常绑定请直接用上方「使用这台」。"))
            addView(Ui.button(this@DevicesActivity, "打开旧版互联 / 扫码配对") {
                openWeb("互联 / 扫码配对", "/#/link")
            })
        }
        root.addView(advancedBox)

        setContentView(Ui.scroll(this, root))
        load()
    }

    private lateinit var advancedBox: LinearLayout

    override fun onResume() {
        super.onResume()
        // 从高级/二级页回来时刷新一次
        if (!loading) load()
    }

    private fun load() {
        if (loading) return
        loading = true
        statusText.text = "正在读取设备…"
        bg {
            var msg: String
            var devices: JSONArray? = null
            try {
                val r = TenonClient.devicesList()
                devices = r.optJSONArray("devices")
                msg = "共 " + (devices?.length() ?: 0) + " 台设备 · 点「使用这台」一键绑定"
            } catch (e: Exception) {
                devices = null
                msg = "读取失败：" + readable(e) + "\n检查设置里的中枢地址与令牌"
            }
            ui {
                loading = false
                statusText.text = msg
                listBox.removeAllViews()
                if (devices != null) renderDevices(devices)
            }
        }
    }

    private fun renderDevices(devices: JSONArray) {
        if (devices.length() == 0) {
            listBox.addView(Ui.body(this, "还没有发现设备：确保电脑端节点已启动，且手机与电脑同一 WiFi。"))
            return
        }
        for (i in 0 until devices.length()) {
            val d = devices.optJSONObject(i) ?: continue
            listBox.addView(deviceCard(d))
        }
    }

    private fun deviceCard(d: JSONObject): LinearLayout {
        val id = d.optString("id", "")
        val name = d.optString("name", id)
        val platform = d.optString("platform", "")
        val online = d.optBoolean("online", false)
        val bound = d.optBoolean("bound", false)
        val bindable = d.optBoolean("bindable", true)
        val isHub = d.optString("kind", "") == "hub"

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(Ui.dp(this@DevicesActivity, 14), Ui.dp(this@DevicesActivity, 12),
                Ui.dp(this@DevicesActivity, 14), Ui.dp(this@DevicesActivity, 14))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = Ui.dp(this@DevicesActivity, 10) }
        }
        val head = Ui.row(this)
        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameCol.addView(TextView(this).apply {
            text = (if (online) "● " else "○ ") + name
            textSize = 17f
            setTextColor(if (online) Ui.PAPER else Ui.GREY)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        nameCol.addView(TextView(this).apply {
            text = platform + " · " + (if (bound) "已绑定" else if (bindable) "可绑定" else "中枢") +
                    (if (d.optBoolean("installed", false)) " · 已安装" else "")
            textSize = 11f
            setTextColor(if (bound) Ui.CYAN else Ui.GREY)
        })
        head.addView(nameCol)
        card.addView(head)

        val row1 = Ui.row(this)
        row1.setPadding(0, Ui.dp(this@DevicesActivity, 8), 0, 0)
        if (!isHub) {
            if (bound) {
                row1.addView(Ui.button(this, "移除", true) { unbind(id, name) })
            } else {
                row1.addView(Ui.button(this, "使用这台", true) { bind(id, name) })
            }
        } else {
            row1.addView(Ui.hint(this, "中枢本机 · 无需绑定"))
        }
        card.addView(row1)

        // 每卡最多 3 个一键动作（来自设备 actions）
        val actions = d.optJSONArray("actions")
        if (actions != null && actions.length() > 0) {
            val rowA = Ui.row(this)
            rowA.setPadding(0, Ui.dp(this@DevicesActivity, 6), 0, 0)
            val n = minOf(3, actions.length())
            for (j in 0 until n) {
                val a = actions.optString(j)
                rowA.addView(Ui.button(this, actionLabel(a)) { act(id, name, a) })
            }
            card.addView(rowA)
        }
        return card
    }

    private fun actionLabel(a: String): String = when (a) {
        "hello" -> "打招呼"
        "check" -> "体检"
        "open-console" -> "打开控制台"
        else -> a
    }

    private fun bind(id: String, name: String) {
        statusText.text = "正在绑定 " + name + "…"
        bg {
            val msg = try {
                TenonClient.deviceBind(id)
                "已使用「" + name + "」：一键绑定成功"
            } catch (e: Exception) {
                "绑定失败：" + readable(e)
            }
            ui { statusText.text = msg; Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); load() }
        }
    }

    private fun unbind(id: String, name: String) {
        statusText.text = "正在移除 " + name + "…"
        bg {
            val msg = try {
                TenonClient.deviceUnbind(id)
                "已移除「" + name + "」"
            } catch (e: Exception) {
                "移除失败：" + readable(e)
            }
            ui { statusText.text = msg; Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); load() }
        }
    }

    private fun act(id: String, name: String, action: String) {
        statusText.text = "正在执行「" + actionLabel(action) + "」→ " + name + "…"
        bg {
            val msg = try {
                val r = TenonClient.deviceAction(id, action)
                val detail = r.optString("detail", r.optString("summary", ""))
                if (r.optBoolean("ok", false)) {
                    "「" + actionLabel(action) + "」成功" + (if (detail.isNotBlank()) "：" + detail.take(90) else "")
                } else "「" + actionLabel(action) + "」返回：" + r.toString().take(120)
            } catch (e: Exception) {
                "动作失败：" + readable(e)
            }
            ui { statusText.text = msg; Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    private fun readable(e: Exception): String {
        val m = e.message ?: "网络错误"
        return if (m.contains("Failed to connect") || m.contains("timeout") || m.contains("Connection refused"))
            "连不上中枢（同一 WiFi / 中枢地址 / 端口 7410）" else m.take(140)
    }

    private fun openWeb(title: String, path: String) {
        if (!App.isConfigured()) { Toast.makeText(this, "请先配置中枢地址", Toast.LENGTH_SHORT).show(); return }
        startActivity(Intent(this, WebPageActivity::class.java).apply {
            putExtra(WebPageActivity.EXTRA_TITLE, title)
            putExtra(WebPageActivity.EXTRA_URL, App.baseUrl() + path)
        })
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
