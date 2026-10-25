package com.minzzj.tenon.net

import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** 极简 HTTP 客户端（不引 okhttp：P0 只依赖 HttpURLConnection + org.json）。 */
object TenonHttp {
    const val UA = "TenonAndroid/0.1.0"

    data class Resp(val code: Int, val body: String, val bytes: ByteArray?) {
        val ok: Boolean get() = code in 200..299
    }

    fun open(method: String, url: String, token: String, timeoutMs: Int = 20000): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("User-Agent", UA)
        conn.setRequestProperty("Accept", "application/json")
        if (token.isNotEmpty()) conn.setRequestProperty("x-tenon-token", token)
        return conn
    }

    fun json(
        method: String,
        path: String,
        body: String? = null,
        token: String = App.token(),
        timeoutMs: Int = 20000
    ): Resp {
        val base = App.baseUrl()
        if (base.isEmpty()) return Resp(0, "未配置中枢地址", null)
        val conn = open(method, base + path, token, timeoutMs)
        return try {
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream: InputStream? = if (code in 200..299) conn.inputStream else conn.errorStream
            Resp(code, stream?.use { readAll(it) } ?: "", null)
        } catch (e: Exception) {
            LogBus.log("HTTP $method $path 失败：${e.message}")
            Resp(-1, e.message ?: "网络错误", null)
        } finally {
            try { conn.disconnect() } catch (_: Exception) {}
        }
    }

    fun getBytes(path: String, offset: Long = 0L, token: String = App.token()): Resp {
        val base = App.baseUrl()
        if (base.isEmpty()) return Resp(0, "未配置中枢地址", null)
        val conn = open("GET", base + path, token, 60000)
        return try {
            if (offset > 0) conn.setRequestProperty("Range", "bytes=$offset-")
            val code = conn.responseCode
            val bytes = if (code in 200..299) conn.inputStream.use { it.readBytes() } else null
            Resp(code, "", bytes)
        } catch (e: Exception) {
            LogBus.log("下载失败：${e.message}")
            Resp(-1, e.message ?: "网络错误", null)
        } finally {
            try { conn.disconnect() } catch (_: Exception) {}
        }
    }

    fun readAll(input: InputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray().toString(Charsets.UTF_8)
    }

    fun errorOf(code: Int, body: String): IOException =
        IOException("HTTP $code ${body.take(200)}")
}