package com.minzzj.tenon

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/** 全局配置：中枢地址 / 操作令牌 / 设备身份 / 语音与播报偏好。 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        try { ReminderWorker.schedule(this) } catch (_: Exception) {}
    }

    companion object {
        lateinit var instance: App

        private fun sp(): SharedPreferences =
            instance.getSharedPreferences("tenon", Context.MODE_PRIVATE)

        /** 中枢地址：优先用户设置；首次为空时用 APK 内置默认值（本机体验）。 */
        fun hub(): String {
            val saved = sp().getString("hub", "") ?: ""
            return if (saved.isBlank()) normalize(BuildConfig.DEFAULT_HUB) else saved
        }

        fun setHub(v: String) = sp().edit().putString("hub", normalize(v)).apply()

        /** 操作令牌：优先用户设置；首次为空时用 APK 内置默认值。 */
        fun token(): String {
            val saved = sp().getString("token", "") ?: ""
            return if (saved.isBlank()) BuildConfig.DEFAULT_TOKEN else saved
        }

        fun setToken(v: String) = sp().edit().putString("token", v.trim()).apply()
        fun hasCustomToken(): Boolean = !(sp().getString("token", "") ?: "").isBlank()

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

        // ---- 本机语音/播报偏好 ----
        fun ttsLocalEnabled(): Boolean = sp().getBoolean("ttsLocal", true)
        fun setTtsLocalEnabled(v: Boolean) = sp().edit().putBoolean("ttsLocal", v).apply()

        fun wakeEnabledLocal(): Boolean = sp().getBoolean("wakeEnabledLocal", true)
        fun setWakeEnabledLocal(v: Boolean) = sp().edit().putBoolean("wakeEnabledLocal", v).apply()

        fun wakeWordsLocal(): String = sp().getString("wakeWordsLocal", "榫卯,小榫") ?: "榫卯,小榫"
        fun setWakeWordsLocal(v: String) = sp().edit().putString("wakeWordsLocal", v).apply()

        fun alwaysRecord(): Boolean = sp().getBoolean("alwaysRecord", false)
        fun setAlwaysRecord(v: Boolean) = sp().edit().putBoolean("alwaysRecord", v).apply()

        fun lastResultJson(): String = sp().getString("lastResult", "") ?: ""
        fun setLastResultJson(v: String) = sp().edit().putString("lastResult", v).apply()

        // ---- V0.5：语音来源 / 屏幕内容采集 ----
        /** 语音来源：pc=送电脑识别（默认），local=手机离线（P1，暂未提供）。 */
        fun speechSource(): String = sp().getString("speechSource", "pc") ?: "pc"
        fun setSpeechSource(v: String) = sp().edit().putString("speechSource", v).apply()

        // 0.6.9：24h 录制可配置（设置页可改）
        fun ambientChunkSec(): Int = sp().getInt("ambientChunkSec", 12).coerceIn(6, 30)
        fun setAmbientChunkSec(v: Int) = sp().edit().putInt("ambientChunkSec", v.coerceIn(6, 30)).apply()
        fun ambientWifiOnly(): Boolean = sp().getBoolean("ambientWifiOnly", false)
        fun setAmbientWifiOnly(v: Boolean) = sp().edit().putBoolean("ambientWifiOnly", v).apply()

        fun screenEnabled(): Boolean = sp().getBoolean("screenEnabled", false)
        fun setScreenEnabled(v: Boolean) = sp().edit().putBoolean("screenEnabled", v).apply()

        /** 屏幕采集间隔（秒），默认 5（0.6.11：5 秒一次高清采集），允许 5–600。 */
        fun screenInterval(): Int = sp().getInt("screenInterval", 5).coerceIn(5, 600)
        fun setScreenInterval(v: Int) = sp().edit().putInt("screenInterval", v.coerceIn(5, 600)).apply()

        /**
         * 0.6.12：仅在屏幕画面变化时才解码/压缩/上传（默认 true）。
         * 关闭后回到 0.6.11 行为：每 5 秒无条件上传一帧。
         */
        fun screenChangeOnly(): Boolean = sp().getBoolean("screenChangeOnly", true)
        fun setScreenChangeOnly(v: Boolean) = sp().edit().putBoolean("screenChangeOnly", v).apply()

        fun screenBlacklist(): String = sp().getString("screenBlacklist", "") ?: ""
        fun setScreenBlacklist(v: String) = sp().edit().putString("screenBlacklist", v).apply()

        private fun dayKey(): String =
            java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.CHINA).format(java.util.Date())

        fun bumpScreenUpload() {
            val key = "screenCount_" + dayKey()
            sp().edit().putInt(key, sp().getInt(key, 0) + 1).apply()
        }

        fun screenUploadsToday(): Int = sp().getInt("screenCount_" + dayKey(), 0)

        fun setScreenLast(info: String) {
            sp().edit().putString("screenLast", info).apply()
        }

        fun screenLast(): String = sp().getString("screenLast", "") ?: ""

        fun setScreenLastError(info: String) {
            sp().edit().putString("screenLastError", info).apply()
        }

        fun screenLastError(): String = sp().getString("screenLastError", "") ?: ""

        /** 0.6.10：最近一次上报结果（成功含中枢记录 id，失败含原因），设置页自检行用。 */
        fun setScreenLastResult(info: String) = sp().edit().putString("screenLastResult", info).apply()
        fun screenLastResult(): String = sp().getString("screenLastResult", "") ?: ""

        /** 0.6.10：最近一次成功上报时间（毫秒），0 = 从未成功。 */
        fun setScreenLastOkAt(ms: Long) = sp().edit().putLong("screenLastOkAt", ms).apply()
        fun screenLastOkAt(): Long = sp().getLong("screenLastOkAt", 0L)

        // ---- 0.6.8：手机本机 24 小时录制（AmbientRecordService） ----
        fun ambientDesired(): Boolean = sp().getBoolean("ambientDesired", false)
        fun setAmbientDesired(v: Boolean) = sp().edit().putBoolean("ambientDesired", v).apply()

        fun bumpAmbientSegment() {
            val key = "ambientCount_" + dayKey()
            sp().edit().putInt(key, sp().getInt(key, 0) + 1).apply()
        }

        fun ambientSegmentsToday(): Int = sp().getInt("ambientCount_" + dayKey(), 0)

        fun setAmbientLast(info: String) = sp().edit().putString("ambientLast", info).apply()
        fun ambientLast(): String = sp().getString("ambientLast", "") ?: ""

        fun setAmbientLastError(info: String) = sp().edit().putString("ambientLastError", info).apply()
        fun ambientLastError(): String = sp().getString("ambientLastError", "") ?: ""

        // ---- 0.6.8：悬浮窗开关记忆 ----
        fun overlayEnabled(): Boolean = sp().getBoolean("overlayEnabled", false)
        fun setOverlayEnabled(v: Boolean) = sp().edit().putBoolean("overlayEnabled", v).apply()

        // ---- V0.5/V0.6：提醒开关（本地通知） ----
        fun remindersEnabled(): Boolean = sp().getBoolean("remindersEnabled", true)
        fun setRemindersEnabled(v: Boolean) = sp().edit().putBoolean("remindersEnabled", v).apply()

        // ---- V0.6：文档下载目录（app 私有 files/documents） ----
        fun documentsDir(): java.io.File {
            val d = java.io.File(instance.filesDir, "documents")
            if (!d.exists()) d.mkdirs()
            return d
        }

        fun clearDocuments() {
            try {
                documentsDir().listFiles()?.forEach { it.delete() }
            } catch (_: Exception) {}
        }

        // ---- 旧版功能开关（保留兼容） ----
        fun peerId(): String = sp().getString("peerId", "hub") ?: "hub"
        fun setPeerId(v: String) = sp().edit().putString("peerId", v).apply()
        fun clipboardEnabled(): Boolean = sp().getBoolean("clipboardEnabled", false)
        fun setClipboardEnabled(v: Boolean) = sp().edit().putBoolean("clipboardEnabled", v).apply()
        fun notificationsEnabled(): Boolean = sp().getBoolean("notificationsEnabled", true)
        fun setNotificationsEnabled(v: Boolean) = sp().edit().putBoolean("notificationsEnabled", v).apply()
        fun tiltEnabled(): Boolean = sp().getBoolean("tiltEnabled", true)
        fun setTiltEnabled(v: Boolean) = sp().edit().putBoolean("tiltEnabled", v).apply()
        fun tiltSensitivity(): Int = sp().getInt("tiltSensitivity", 25).coerceIn(15, 45)
        fun setTiltSensitivity(v: Int) = sp().edit().putInt("tiltSensitivity", v.coerceIn(15, 45)).apply()

        /** 清空本机记录（不影响中枢数据/账本）。 */
        fun clearLocalRecords() {
            sp().edit()
                .remove("lastResult")
                .putString("wakeWordsLocal", "榫卯,小榫")
                .putBoolean("ttsLocal", true)
                .putBoolean("wakeEnabledLocal", true)
                .putBoolean("alwaysRecord", false)
                .apply()
        }

        fun resetAll() {
            val keepDevice = deviceId()
            sp().edit().clear().apply()
            sp().edit().putString("deviceId", keepDevice).apply()
        }

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
