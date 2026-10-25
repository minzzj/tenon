package com.minzzj.tenon

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.minzzj.tenon.service.ClipboardSyncService
import com.minzzj.tenon.service.TenonNotificationListener
import com.minzzj.tenon.voice.VoiceRecognizer

/** 设置页：中枢地址 / 访问令牌 / 设备名 / 权限状态 / 关于与限制。 */
class SettingsActivity : Activity() {
    private lateinit var hubInput: android.widget.EditText
    private lateinit var tokenInput: android.widget.EditText
    private lateinit var nameInput: android.widget.EditText
    private lateinit var statusText: TextView
    private lateinit var tiltInfo: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)

        val header = Ui.row(this)
        val t = Ui.title(this, "设置")
        t.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        header.addView(t)
        val close = Ui.button(this, "返回") { finish() }
        close.layoutParams = LinearLayout.LayoutParams(Ui.dp(this, 84), ViewGroup.LayoutParams.WRAP_CONTENT)
        header.addView(close)
        root.addView(header)

        val sHub = Ui.section(this, "中枢与身份")
        hubInput = Ui.input(this, "中枢地址，如 192.168.1.10:7410")
        tokenInput = Ui.input(this, "访问令牌 x-tenon-token（写操作需要，可留空）")
        nameInput = Ui.input(this, "设备名（局域网发现时显示）")
        sHub.addView(hubInput)
        sHub.addView(tokenInput)
        sHub.addView(nameInput)
        val saveBtn = Ui.button(this, "保存设置", true) { save() }
        saveBtn.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = Ui.dp(this@SettingsActivity, 10) }
        sHub.addView(saveBtn)
        root.addView(sHub)

        val sPerm = Ui.section(this, "权限与状态")
        statusText = Ui.body(this, "")
        sPerm.addView(statusText)
        val row1 = Ui.row(this)
        row1.addView(Ui.button(this, "通知监听设置") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })
        row1.addView(Ui.button(this, "应用详情") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.parse("package:$packageName")))
        })
        sPerm.addView(row1)
        val row2 = Ui.row(this)
        row2.addView(Ui.button(this, "剪贴板同步") {
            if (ClipboardSyncService.running) ClipboardSyncService.stop(this) else ClipboardSyncService.start(this)
            refreshPerm()
        })
        row2.addView(Ui.button(this, "刷新状态") { refreshPerm() })
        sPerm.addView(row2)
        root.addView(sPerm)

        val sSuper = Ui.section(this, "超级终端（v0.2.0）")
        tiltInfo = Ui.hint(this, "")
        sSuper.addView(tiltInfo)
        sSuper.addView(Ui.body(this, "倾斜甩屏灵敏度（手机往前一倾的触发角度）"))
        val rowTilt = Ui.row(this)
        rowTilt.addView(Ui.button(this, "低 20°") { setTilt(20) })
        rowTilt.addView(Ui.button(this, "中 25°") { setTilt(25) })
        rowTilt.addView(Ui.button(this, "高 30°") { setTilt(30) })
        sSuper.addView(rowTilt)
        sSuper.addView(Ui.button(this, "刷新权限 / 配对状态", true) { refreshPerm() })
        root.addView(sSuper)

        val sAbout = Ui.section(this, "关于 / 限制")
        sAbout.addView(Ui.body(this, "榫卯 Tenon · Android 原生端 0.2.0（v2.1 消费级超级终端）"))
        sAbout.addView(Ui.hint(this,
            "设备号：" + App.deviceId() + "\n" +
            "peerId：" + App.peerId() + "\n" +
            "· 局域网直连 HTTP（同 WiFi，不出公网），目标中枢端口默认 7410\n" +
            "· UDP 发现端口 7413；发现失败请手输 IP\n" +
            "· Android 10+ 后台读取剪贴板受限：请保持 App 可见\n" +
            "· 通知镜像需要系统「通知使用权」，由用户手动授予\n" +
            "· 语音指令需要 RECORD_AUDIO 权限 + 系统语音识别引擎；无引擎自动降级文字输入\n" +
            "· 倾斜甩屏用加速度计检测「1 秒内快速前倾」，灵敏度可调；无传感器时用首页手动按钮\n" +
            "· v2.1 super 服务（/api/v2/super/*）未就绪时，各功能会显示明确失败原因，不崩溃"))
        root.addView(sAbout)

        setContentView(Ui.scroll(this, root))
        hubInput.setText(App.hub())
        tokenInput.setText(App.token())
        nameInput.setText(App.deviceName())
        refreshPerm()
    }

    private fun save() {
        App.setHub(hubInput.text.toString())
        App.setToken(tokenInput.text.toString())
        App.setDeviceName(nameInput.text.toString())
        hubInput.setText(App.hub())
        statusText.text = "已保存。中枢：${App.baseUrl().ifBlank { "（未配置）" }}"
    }

    private fun setTilt(deg: Int) {
        App.setTiltSensitivity(deg)
        refreshPerm()
    }

    private fun refreshPerm() {
        val notif = if (Build.VERSION.SDK_INT >= 33)
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        else true
        val nl = TenonNotificationListener.isEnabled(this) || TenonNotificationListener.connected
        val voicePerm = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val voiceEngine = VoiceRecognizer.isAvailable(this)
        statusText.text = buildString {
            append("中枢：").append(if (App.isConfigured()) App.baseUrl() else "未配置").append("\n")
            append("配对状态：peerId=").append(App.peerId())
            append(if (App.token().isNotBlank()) " · 令牌已填" else " · 令牌未填").append("\n")
            append("语音权限（RECORD_AUDIO）：").append(if (voicePerm) "已授权" else "未授权").append("\n")
            append("语音识别引擎：").append(if (voiceEngine) "可用" else "不可用（将降级为文字输入）").append("\n")
            append("倾斜甩屏：").append(if (App.tiltEnabled()) "开" else "关")
            append(" · 灵敏度 ").append(App.tiltSensitivity()).append("°").append("\n")
            append("通知权限（POST_NOTIFICATIONS）：").append(if (notif) "已授权" else "未授权").append("\n")
            append("通知使用权：").append(if (nl) "已授权" else "未授权").append("\n")
            append("剪贴板前台服务：").append(if (ClipboardSyncService.running) "运行中" else "未运行")
        }
        if (::tiltInfo.isInitialized) {
            tiltInfo.text = "当前倾斜灵敏度：${App.tiltSensitivity()}° · 倾斜甩屏开关在 App 首页「流转」区；语音权限/引擎状态见上。"
        }
    }
}