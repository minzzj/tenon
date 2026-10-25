package com.minzzj.tenon

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/** 全局配置：中枢地址 / 访问令牌 / 设备身份 / 功能开关，全部落在 SharedPreferences。 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: App

        private fun sp(): SharedPreferences =
            instance.getSharedPreferences("tenon", Context.MODE_PRIVATE)

        fun hub(): String = sp().getString("hub", "") ?: ""
        fun setHub(v: String) = sp().edit().putString("hub", normalize(v)).apply()

        fun token(): String = sp().getString("token", "") ?: ""
        fun setToken(v: String) = sp().edit().putString("token", v.trim()).apply()

        fun peerId(): String = sp().getString("peerId", "hub") ?: "hub"
        fun setPeerId(v: String) = sp().edit().putString("peerId", v).apply()

        fun deviceName(): String {
            val saved = sp().getString("deviceName", "") ?: ""
            return if (saved.isNotBlank()) saved else (android.os.Build.MODEL ?: "Android")
        }

        fun setDeviceName(v: String) = sp().edit().putString("deviceName", v.trim()).apply()

        fun deviceId(): String {
            var id = sp().getString("deviceId", "") ?: ""
            if (id.isBlank()) {
                id = "android-" + UUID.randomUUID().toString().substring(0, 8)
                sp().edit().putString("deviceId", id).apply()
            }
            return id
        }

        fun clipboardEnabled(): Boolean = sp().getBoolean("clipboardEnabled", false)
        fun setClipboardEnabled(v: Boolean) = sp().edit().putBoolean("clipboardEnabled", v).apply()

        fun notificationsEnabled(): Boolean = sp().getBoolean("notificationsEnabled", true)
        fun setNotificationsEnabled(v: Boolean) = sp().edit().putBoolean("notificationsEnabled", v).apply()

        /** 倾斜甩屏开关与灵敏度（v2.1 超级终端）。 */
        fun tiltEnabled(): Boolean = sp().getBoolean("tiltEnabled", true)
        fun setTiltEnabled(v: Boolean) = sp().edit().putBoolean("tiltEnabled", v).apply()
        fun tiltSensitivity(): Int = sp().getInt("tiltSensitivity", 25).coerceIn(15, 45)
        fun setTiltSensitivity(v: Int) = sp().edit().putInt("tiltSensitivity", v.coerceIn(15, 45)).apply()

        /** 规范化中枢地址：补 http://、去尾部 /。 */
        fun normalize(raw: String): String {
            var s = raw.trim()
            if (s.isEmpty()) return ""
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            while (s.endsWith("/")) s = s.substring(0, s.length - 1)
            return s
        }

        fun baseUrl(): String = normalize(hub())
        fun isConfigured(): Boolean = baseUrl().isNotEmpty()
    }
}