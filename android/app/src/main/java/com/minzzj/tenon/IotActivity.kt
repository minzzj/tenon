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

/** V5 IoT 页：列出 /iot/devices，开/关/亮度控制（POST /iot/devices/:id/control）；顶部显示 HA/MQTT 状态。 */
class IotActivity : Activity() {
    private lateinit var statusText: TextView
    private lateinit var listBox: LinearLayout
    private var loading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)
        val top = Ui.row(this)
        val title = Ui.title(this, "IoT 设备")
        title.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(title)
        top.addView(Ui.button(this, "刷新") { load() })
        top.addView(Ui.button(this, "返回") { finish() })
        root.addView(top)
        root.addView(Ui.hint(this, "设备来自电脑端物联接入（Home Assistant / MQTT / SSDP）；HA/MQTT 配置在电脑端 V5 设置页完成。"))
        statusText = Ui.hint(this, "正在读取 IoT 状态…")
        root.addView(statusText)
        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(listBox)
        setContentView(Ui.scroll(this, root))
        load()
    }

    private fun load() {
        if (loading) return
        loading = true
        bg {
            var devices: JSONArray? = null
            var statusMsg = ""
            try {
                val st = TenonClient.iotStatus()
                statusMsg = "IoT 状态：" + st.toString().take(160)
            } catch (e: Exception) {
                statusMsg = "IoT 状态读取失败：" + readable(e)
            }
            try {
                val r = TenonClient.iotDevices()
                devices = ReminderNotifier.firstArray(r, "items", "devices", "data")
            } catch (e: Exception) {
                if (statusMsg.isNotBlank()) statusMsg += "\n设备：" + readable(e)
            }
            val finalMsg = statusMsg
            ui {
                loading = false
                statusText.text = finalMsg
                listBox.removeAllViews()
                if (devices != null) render(devices)
            }
        }
    }

    private fun render(items: JSONArray) {
        if (items.length() == 0) {
            listBox.addView(Ui.body(this, "还没有接入 IoT 设备：在电脑端设置里配置 Home Assistant / MQTT 或 SSDP 发现后导入。"))
            return
        }
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            listBox.addView(deviceCard(o))
        }
    }

    private fun deviceCard(o: JSONObject): LinearLayout {
        val id = o.optString("id", "")
        val name = o.optString("name", id)
        val type = o.optString("type", o.optString("domain", ""))
        val state = o.optString("state", "?")
        val adapter = o.optString("adapter", o.optString("source", ""))
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(Ui.dp(this@IotActivity, 14), Ui.dp(this@IotActivity, 10),
                Ui.dp(this@IotActivity, 14), Ui.dp(this@IotActivity, 10))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = Ui.dp(this@IotActivity, 8) }
        }
        card.addView(TextView(this).apply {
            text = "🔌 " + name
            textSize = 16f
            setTextColor(Ui.PAPER)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        card.addView(Ui.hint(this, (if (type.isNotBlank()) type + " · " else "") + "状态 " + state +
                (if (adapter.isNotBlank()) " · " + adapter else "")))
        val row = Ui.row(this)
        row.addView(Ui.button(this, "开", true) { control(id, if (type.contains("light")) "turn_on" else "on") })
        row.addView(Ui.button(this, "关") { control(id, if (type.contains("light")) "turn_off" else "off") })
        row.addView(Ui.button(this, "亮度+") { control(id, "brightness", 10) })
        card.addView(row)
        return card
    }

    private fun control(id: String, command: String, brightnessDelta: Int = 0) {
        bg {
            val msg = try {
                val params = JSONObject()
                if (brightnessDelta != 0) params.put("brightness_pct", 60).put("delta", brightnessDelta)
                val r = TenonClient.iotControl(id, command, params)
                "已发送 " + command + (if (r.optBoolean("ok", true)) " ✓" else "：") + r.toString().take(100)
            } catch (e: Exception) { "控制失败：" + readable(e) }
            ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); statusText.text = msg }
        }
    }

    private fun readable(e: Exception): String {
        if (e is TenonClient.VoiceHttpException) {
            return when {
                e.code == 404 -> "电脑端 IoT 接口未就绪（后端并行实现中）"
                e.isAuth -> "需要操作令牌：去设置填写"
                else -> "HTTP " + e.code
            }
        }
        return (e.message ?: "网络错误").take(120)
    }

    private fun bg(block: () -> Unit) { Thread(block).start() }
    private fun ui(block: () -> Unit) { runOnUiThread(block) }
}
