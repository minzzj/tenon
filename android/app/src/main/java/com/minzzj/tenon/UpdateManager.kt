package com.minzzj.tenon

import android.app.Activity
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import com.minzzj.tenon.net.TenonHttp
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * v0.6.5 一键更新：手机端自动检查中枢上的新 APK → 下载 → 校验 → 拉起安装。
 * - 启动时自动检查（6 小时内不重复），发现新版本弹窗；
 * - 设置页「检查更新」手动触发；
 * - 首次安装需允许「安装未知应用」（跳系统设置，用户点一下即可）。
 */
object UpdateManager {
    private const val PREFS = "tenon_update"
    private const val KEY_LAST = "lastCheckMs"
    private const val TAG = "TenonUpdate"
    @Volatile private var running = false

    data class Info(
        val versionName: String,
        val versionCode: Int,
        val size: Long,
        val sha256: String,
        val url: String,
        val notes: String
    )

    fun autoCheck(activity: Activity) {
        try {
            val sp = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
            val last = sp.getLong(KEY_LAST, 0L)
            if (System.currentTimeMillis() - last < 6 * 3600_000L) return
            sp.edit().putLong(KEY_LAST, System.currentTimeMillis()).apply()
            check(activity, silent = true, onResult = null)
        } catch (_: Exception) {}
    }

    fun check(activity: Activity, silent: Boolean, onResult: ((String) -> Unit)? = null) {
        if (running) return
        running = true
        Thread {
            var msg = "已是最新版本 v" + BuildConfig.VERSION_NAME
            try {
                val info = fetchInfo()
                if (info != null && info.versionCode > BuildConfig.VERSION_CODE) {
                    msg = "发现新版本 v" + info.versionName
                    activity.runOnUiThread { prompt(activity, info) }
                }
            } catch (e: Exception) {
                msg = "检查更新失败：" + (e.message ?: "网络错误")
                LogBus.log("update check: " + (e.message ?: ""))
            } finally {
                running = false
            }
            if (!silent) activity.runOnUiThread {
                Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
                onResult?.invoke(msg)
            }
        }.start()
    }

    private fun fetchInfo(): Info? {
        val base = App.baseUrl().trimEnd('/')
        if (base.isEmpty()) throw IllegalStateException("未配置中枢地址")
        val path = "/api/v2/update/info?platform=android&versionCode=" + BuildConfig.VERSION_CODE
        val resp = TenonHttp.json("GET", path, null, "", 20000)
        if (!resp.ok) throw IllegalStateException("HTTP " + resp.code + " " + resp.body.take(120))
        val o = JSONObject(resp.body)
        if (!o.optBoolean("ok", false)) throw IllegalStateException(o.optString("error", "中枢返回错误"))
        val latest = o.optJSONObject("latest") ?: return null
        val urlRaw = latest.optString("downloadUrl", o.optString("downloadUrl", ""))
        val url = if (urlRaw.startsWith("http")) urlRaw else base + (if (urlRaw.startsWith("/")) urlRaw else "/" + urlRaw)
        return Info(
            versionName = latest.optString("versionName", "?"),
            versionCode = latest.optInt("versionCode", 0),
            size = latest.optLong("size", 0L),
            sha256 = latest.optString("sha256", "").lowercase(),
            url = url,
            notes = latest.optString("notes", "")
        )
    }

    private fun prompt(activity: Activity, info: Info) {
        val sizeMb = if (info.size > 0) String.format("%.1f MB", info.size / 1048576.0) else ""
        AlertDialog.Builder(activity)
            .setTitle("发现新版本 v" + info.versionName)
            .setMessage("当前版本 v" + BuildConfig.VERSION_NAME + " → 新版本 v" + info.versionName +
                    (if (sizeMb.isNotEmpty()) "（" + sizeMb + "）" else "") +
                    (if (info.notes.isNotBlank()) "\n\n" + info.notes.take(300) else "") +
                    "\n\n点「一键更新」下载并安装，数据不会丢失。")
            .setPositiveButton("一键更新") { _, _ -> downloadAndInstall(activity, info) }
            .setNegativeButton("稍后", null)
            .show()
    }

    fun downloadAndInstall(activity: Activity, info: Info) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setTitle("需要允许安装应用")
                .setMessage("首次更新需允许「榫卯」安装未知来源应用。点「去设置」打开开关，再回来点「一键更新」。")
                .setPositiveButton("去设置") { _, _ ->
                    try {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
                    } catch (_: Exception) {}
                }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        val dialog = ProgressDialog(activity)
        dialog.setTitle("正在下载更新 v" + info.versionName)
        dialog.setMessage("0%")
        dialog.setCancelable(false)
        dialog.show()
        Thread {
            var ok = false
            var err = ""
            val target = File(activity.cacheDir, "tenon-update.apk")
            try {
                val conn = URL(info.url).openConnection() as HttpURLConnection
                conn.connectTimeout = 20000
                conn.readTimeout = 120000
                conn.setRequestProperty("User-Agent", "TenonAndroid/" + BuildConfig.VERSION_NAME)
                conn.instanceFollowRedirects = true
                val total = conn.contentLengthLong.takeIf { it > 0 } ?: info.size
                var read = 0L
                conn.inputStream.use { input ->
                    FileOutputStream(target).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            read += n
                            if (total > 0) {
                                val pct = (read * 100 / total).toInt().coerceIn(0, 100)
                                activity.runOnUiThread { dialog.setMessage(pct.toString() + "%") }
                            }
                        }
                    }
                }
                if (info.size > 0 && target.length() != info.size) throw IllegalStateException("下载大小不符")
                if (info.sha256.isNotBlank()) {
                    val sha = sha256(target)
                    if (!sha.equals(info.sha256, ignoreCase = true)) throw IllegalStateException("校验失败（SHA256）")
                }
                ok = true
            } catch (e: Exception) {
                err = e.message ?: "下载失败"
            }
            activity.runOnUiThread {
                try { dialog.dismiss() } catch (_: Exception) {}
                if (ok) install(activity, target)
                else Toast.makeText(activity, "更新失败：" + err, Toast.LENGTH_LONG).show()
            }
        }.start()
    }

    private fun install(activity: Activity, file: File) {
        try {
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            Toast.makeText(activity, "已下载完成，请在系统安装界面点「安装」", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(activity, "拉起安装失败：" + (e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
