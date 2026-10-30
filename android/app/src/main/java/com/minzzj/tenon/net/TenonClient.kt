package com.minzzj.tenon.net

import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * 榫卯 v2 中枢 API 封装（契约 _internal/契约-v2-P0.md §4/§5）。
 * 只用 HttpURLConnection + org.json，不引第三方网络库；所有写操作带 x-tenon-token。
 */
object TenonClient {
    const val API = "/api/v2"

    data class TransferInit(val transferId: String, val chunkSize: Int)
    data class UploadResult(val transferId: String, val bytes: Long, val ms: Long, val sha256: String)
    data class DownloadResult(val path: String, val bytes: Long, val sha256: String)

    // ---------- 发现 / 配对 ----------

    fun peers(): List<Peer> {
        val resp = TenonHttp.json("GET", "$API/link/peers")
        if (!resp.ok) throw IOException("peers HTTP ${resp.code} ${resp.body.take(120)}")
        val body = resp.body.trim()
        val arr: JSONArray = if (body.startsWith("[")) JSONArray(body)
        else (JSONObject(body).optJSONArray("peers") ?: JSONArray())
        val list = mutableListOf<Peer>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            list.add(
                Peer(
                    deviceId = o.optString("deviceId", o.optString("id", "")),
                    name = o.optString("name", ""),
                    platform = o.optString("platform", ""),
                    host = o.optString("ip", o.optString("host", "")),
                    port = o.optInt("port", 7410)
                )
            )
        }
        return list
    }

    /** 6 位配对码配对；成功后记录 peerId（服务端返回）与可选会话 token。 */
    fun pair(code: String): JSONObject {
        val req = JSONObject().put("code", code.trim())
        val resp = TenonHttp.json("POST", "$API/link/pair", req.toString())
        if (!resp.ok) throw IOException(pairError(resp.code, resp.body))
        val obj = JSONObject(resp.body)
        val peer = obj.optString("peerId", obj.optString("deviceId", "hub"))
        if (peer.isNotBlank()) App.setPeerId(peer)
        val token = obj.optString("token", "")
        if (token.isNotBlank()) App.setToken(token)
        return obj
    }

    private fun pairError(code: Int, body: String): String = when (code) {
        0 -> body
        401, 403 -> "配对码错误或已过期（HTTP $code）"
        404 -> "中枢未提供 v2 配对接口（HTTP 404）"
        else -> "配对失败 HTTP $code ${body.take(120)}"
    }

    // ---------- 文件传输（分块 PUT，契约 §4） ----------

    fun initTransfer(peerId: String, direction: String, files: List<Pair<String, Long>>): TransferInit {
        val arr = JSONArray()
        files.forEach { arr.put(JSONObject().put("name", it.first).put("size", it.second)) }
        val req = JSONObject()
            .put("peerId", peerId)
            .put("direction", direction)
            .put("files", arr)
        val resp = TenonHttp.json("POST", "$API/link/transfer/init", req.toString())
        if (!resp.ok) throw IOException("transfer/init HTTP ${resp.code} ${resp.body.take(120)}")
        val obj = JSONObject(resp.body)
        val id = obj.optString("transferId", "")
        if (id.isBlank()) throw IOException("transfer/init 未返回 transferId")
        return TransferInit(id, obj.optInt("chunkSize", 1024 * 1024).coerceIn(64 * 1024, 4 * 1024 * 1024))
    }

    fun putChunk(transferId: String, offset: Long, data: ByteArray) {
        val base = App.baseUrl()
        if (base.isEmpty()) throw IOException("未配置中枢地址")
        val url = "$base$API/link/transfer/$transferId/chunk?offset=$offset"
        val conn = TenonHttp.open("PUT", url, App.token(), 60000)
        try {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setFixedLengthStreamingMode(data.size)
            conn.outputStream.use { it.write(data) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val text = conn.errorStream?.use { s -> TenonHttp.readAll(s) } ?: ""
                throw IOException("chunk offset=$offset HTTP $code ${text.take(120)}")
            }
        } finally {
            try { conn.disconnect() } catch (_: Exception) {}
        }
    }

    fun finishTransfer(transferId: String, sha256: String): JSONObject {
        val req = JSONObject().put("sha256", sha256)
        val resp = TenonHttp.json("POST", "$API/link/transfer/$transferId/finish", req.toString())
        if (!resp.ok) throw IOException("transfer/finish HTTP ${resp.code} ${resp.body.take(120)}")
        return JSONObject(resp.body)
    }

    /** 上传单个文件：init → 分块 PUT → finish(sha256)。 */
    fun uploadFile(file: File, peerId: String, onProgress: (Long, Long) -> Unit): UploadResult {
        val total = file.length()
        val sha = sha256(file)
        val started = System.currentTimeMillis()
        val init = initTransfer(peerId, "upload", listOf(file.name to total))
        RandomAccessFile(file, "r").use { raf ->
            var offset = 0L
            val buf = ByteArray(init.chunkSize)
            while (offset < total) {
                val n = raf.read(buf)
                if (n <= 0) break
                putChunk(init.transferId, offset, buf.copyOf(n))
                offset += n
                onProgress(offset, total)
            }
            if (offset != total) throw IOException("读取文件不完整：$offset/$total")
        }
        val ms = (System.currentTimeMillis() - started).coerceAtLeast(1)
        finishTransfer(init.transferId, sha)
        return UploadResult(init.transferId, total, ms, sha)
    }

    fun getTransfer(transferId: String): JSONObject {
        val resp = TenonHttp.json("GET", "$API/link/transfer/$transferId")
        if (!resp.ok) throw IOException("transfer HTTP ${resp.code} ${resp.body.take(120)}")
        return JSONObject(resp.body)
    }

    /**
     * 下载接收：先按契约扩展 GET .../download?index=0，退化为 GET .../chunk?offset=0。
     * 注意：契约 §4 只定义了分块 PUT，下载端点需 link-core 提供（未实现时给出明确提示，不崩溃）。
     */
    fun downloadTransfer(transferId: String, dir: File): DownloadResult {
        val meta = getTransfer(transferId)
        val files = meta.optJSONArray("files") ?: JSONArray()
        if (files.length() == 0) throw IOException("transfer 没有文件")
        val f0 = files.getJSONObject(0)
        val name = f0.optString("name", "transfer-$transferId.bin")
        val expectSha = f0.optString("sha256", "")
        var resp = TenonHttp.getBytes("$API/link/transfer/$transferId/download?index=0")
        if (!resp.ok) resp = TenonHttp.getBytes("$API/link/transfer/$transferId/chunk?offset=0")
        val raw = resp.bytes
        if (!resp.ok || raw == null) {
            throw IOException("下载端点不可用（HTTP ${resp.code}）；契约 §4 仅定义分块 PUT，需 link-core 提供 GET 下载")
        }
        dir.mkdirs()
        val out = File(dir, name.replace('/', '_').replace("\\", "_"))
        out.writeBytes(raw)
        val sha = sha256(out)
        if (expectSha.isNotBlank() && !expectSha.equals(sha, ignoreCase = true)) {
            LogBus.log("警告：下载文件 sha256 与服务器记录不一致")
        }
        return DownloadResult(out.absolutePath, out.length(), sha)
    }

    // ---------- v3 语音管家（/api/v2/voice/*） ----------

    /** 语音接口 HTTP 异常：区分 401（令牌）与其他错误，便于 UI 引导。 */
    class VoiceHttpException(val code: Int, val body: String) :
        IOException("HTTP " + code + " " + body.take(160)) {
        val isAuth: Boolean get() = code == 401 || code == 403
    }

    private fun asJson(resp: TenonHttp.Resp, what: String): JSONObject {
        if (resp.code !in 200..299) throw VoiceHttpException(resp.code, resp.body)
        if (resp.body.isBlank()) throw IOException(what + " 返回空")
        return try { JSONObject(resp.body) } catch (e: Exception) { throw IOException(what + " 返回非 JSON：" + resp.body.take(120)) }
    }

    /** 中枢语音管家状态（公开读，无需令牌）。 */
    fun voiceStatus(): JSONObject {
        val resp = TenonHttp.json("GET", "$API/voice/status", timeoutMs = 12000)
        return asJson(resp, "voice/status")
    }

    /** 中枢语音管家配置（公开读）。 */
    fun voiceConfig(): JSONObject {
        val resp = TenonHttp.json("GET", "$API/voice/config", timeoutMs = 12000)
        return asJson(resp, "voice/config")
    }

    /** 修改中枢语音管家配置（需要写令牌；PATCH 只允许白名单键）。 */
    fun patchVoiceConfig(patch: JSONObject): JSONObject {
        val resp = TenonHttp.json("PATCH", "$API/voice/config", patch.toString(), timeoutMs = 20000)
        return asJson(resp, "voice/config")
    }

    /** 录音 WAV → 中枢本地 ASR 转写。返回 {text, provider, ms, wake...}。 */
    fun voiceTranscribe(wav: java.io.File): JSONObject {
        val resp = TenonHttp.postMultipart("$API/voice/transcribe", wav, "file", "voice.wav", timeoutMs = 30000)
        return asJson(resp, "voice/transcribe")
    }

    /** 一句话 → 中枢执行（AI 计划 + 步骤）。返回 {say, provider, steps, actions, needConfirm...}。 */
    fun voiceCommand(text: String): JSONObject {
        val req = JSONObject().put("text", text.trim()).put("source", "android")
        val resp = TenonHttp.json("POST", "$API/voice/command", req.toString(), timeoutMs = 30000)
        return asJson(resp, "voice/command")
    }

    /** 今日转写记录（用于主页今日摘要）。 */
    fun voiceTranscripts(date: String): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/voice/transcripts?date=" + java.net.URLEncoder.encode(date, "UTF-8") + "&limit=100", timeoutMs = 12000)
        if (resp.code !in 200..299 || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    /** 中枢汇总状态（在线设备数 / 绑定数）。 */
    fun hubState(): JSONObject? {
        val resp = TenonHttp.json("GET", "/api/state", timeoutMs = 12000)
        if (resp.code !in 200..299 || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    // ---------- v2.1 超级终端（消费级主线：AI 指令 / 流转） ----------

    /** 一句话指令 → AI 计划。POST /api/v2/super/ask {text}，返回 {say, plan, result...}。 */
    fun superAsk(text: String): JSONObject {
        val req = JSONObject().put("text", text.trim())
        val resp = TenonHttp.json("POST", "$API/super/ask", req.toString(), timeoutMs = 90000)
        if (!resp.ok) throw IOException("super/ask HTTP ${resp.code} ${resp.body.take(160)}")
        return try { JSONObject(resp.body) } catch (_: Exception) { JSONObject().put("say", resp.body.take(600)) }
    }

    /** 手机往前一倾 → 把当前页面/内容流转到电脑。POST /api/v2/super/handoff。 */
    fun superHandoff(kind: String, url: String = "", text: String = ""): JSONObject {
        val req = JSONObject()
            .put("kind", kind)
            .put("fromDevice", App.deviceId())
        if (url.isNotBlank()) req.put("url", url)
        if (text.isNotBlank()) req.put("text", text)
        val resp = TenonHttp.json("POST", "$API/super/handoff", req.toString())
        if (!resp.ok) throw IOException("super/handoff HTTP ${resp.code} ${resp.body.take(160)}")
        return try { JSONObject(resp.body) } catch (_: Exception) { JSONObject() }
    }

    fun superState(): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/super/state")
        if (!resp.ok || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    fun superHome(): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/super/home")
        if (!resp.ok || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    fun superPrograms(): JSONArray? {
        val resp = TenonHttp.json("GET", "$API/super/programs")
        if (!resp.ok || resp.body.isBlank()) return null
        return try {
            val body = resp.body.trim()
            if (body.startsWith("[")) JSONArray(body)
            else JSONObject(body).optJSONArray("programs")
        } catch (_: Exception) {
            null
        }
    }

    // ---------- 剪贴板 / 通知（契约 §4 + §5） ----------

    fun shareClipboard(kind: String, text: String): Boolean {
        val req = JSONObject().put("kind", kind).put("text", text)
        val resp = TenonHttp.json("POST", "$API/link/clipboard", req.toString())
        if (!resp.ok) {
            LogBus.log("剪贴板上报失败 HTTP ${resp.code}")
            return false
        }
        return true
    }

    fun latestClipboard(): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/link/clipboard/latest")
        if (!resp.ok || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    /** 通知镜像：契约 §4 未列端点，按 §5 的需求使用 POST /api/v2/link/notify（缺口已记录在报告）。 */
    fun relayNotification(app: String, title: String, preview: String): Boolean {
        val req = JSONObject().put("app", app).put("title", title).put("preview", preview)
        val resp = TenonHttp.json("POST", "$API/link/notify", req.toString())
        return resp.ok
    }

    // ---------- 素材库 / 中转站（契约 §4） ----------

    fun assetsList(q: String = "", limit: Int = 50): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/assets?limit=$limit" + (if (q.isBlank()) "" else "&q=" + java.net.URLEncoder.encode(q, "UTF-8")))
        if (!resp.ok || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    fun assetThumbUrl(id: String, w: Int = 320): String = App.baseUrl() + "$API/assets/$id/thumb?w=$w"

    /** 分享目标：multipart 上传到素材库（契约 §4 `POST /assets/ingest` multipart）。 */
    fun ingestMultipart(file: File, onProgress: (Long) -> Unit = {}): JSONObject {
        val base = App.baseUrl()
        if (base.isEmpty()) throw IOException("未配置中枢地址")
        val boundary = "----Tenon" + System.currentTimeMillis()
        val prefix = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" +
                file.name.replace("\"", "_") + "\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        val suffix = "\r\n--$boundary--\r\n"
        val prefixBytes = prefix.toByteArray(Charsets.UTF_8)
        val suffixBytes = suffix.toByteArray(Charsets.UTF_8)
        val total = prefixBytes.size.toLong() + file.length() + suffixBytes.size.toLong()
        val conn = TenonHttp.open("POST", "$base$API/assets/ingest", App.token(), 120000)
        try {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            conn.setFixedLengthStreamingMode(total)
            conn.outputStream.use { os ->
                os.write(prefixBytes)
                file.inputStream().use { fis ->
                    val buf = ByteArray(64 * 1024)
                    var sent = 0L
                    while (true) {
                        val n = fis.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        sent += n
                        onProgress(sent)
                    }
                }
                os.write(suffixBytes)
                os.flush()
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.use { TenonHttp.readAll(it) } ?: ""
            if (code !in 200..299) throw IOException("assets/ingest HTTP $code ${text.take(160)}")
            return try { JSONObject(text) } catch (_: Exception) { JSONObject().put("raw", text) }
        } finally {
            try { conn.disconnect() } catch (_: Exception) {}
        }
    }

    fun basket(items: JSONArray, to: String = ""): JSONObject {
        val req = JSONObject().put("items", items).put("to", to)
        val resp = TenonHttp.json("POST", "$API/assets/basket", req.toString())
        if (!resp.ok) throw IOException("assets/basket HTTP ${resp.code} ${resp.body.take(120)}")
        return try { JSONObject(resp.body) } catch (_: Exception) { JSONObject() }
    }

    fun stats(): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/assets/stats")
        if (!resp.ok || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    // ---------- V4：设备一键绑定 / 屏幕采集 / 待确认 / 今日 ----------

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    fun devicesList(): JSONObject =
        asJson(TenonHttp.json("GET", "$API/devices", timeoutMs = 15000), "devices")

    fun deviceBind(id: String): JSONObject =
        asJson(TenonHttp.json("POST", "$API/devices/" + enc(id) + "/bind", "{}", timeoutMs = 20000), "device/bind")

    fun deviceUnbind(id: String): JSONObject =
        asJson(TenonHttp.json("POST", "$API/devices/" + enc(id) + "/unbind", "{}", timeoutMs = 20000), "device/unbind")

    fun deviceAction(id: String, action: String): JSONObject {
        val body = JSONObject().put("action", action)
        return asJson(TenonHttp.json("POST", "$API/devices/" + enc(id) + "/action", body.toString(), timeoutMs = 20000), "device/action")
    }

    /** 手机屏幕内容上报（V4）：优先 imageBase64；服务端未就绪时由 UI 显示可读错误。 */
    fun voiceScreen(imageBase64: String, app: String, title: String, text: String, blacklist: String = ""): JSONObject {
        val req = JSONObject()
            .put("app", app)
            .put("title", title)
            .put("text", text)
            .put("source", "phone")
            .put("ts", System.currentTimeMillis())
            .put("imageBase64", imageBase64)
            .put("blacklist", blacklist)
        return asJson(TenonHttp.json("POST", "$API/voice/screen", req.toString(), timeoutMs = 30000), "voice/screen")
    }

    /** needConfirm 确认闭环：yes=true 执行，false 取消。 */
    fun voiceConfirm(confirmId: String, yes: Boolean): JSONObject {
        val req = JSONObject().put("confirmId", confirmId).put("yes", yes)
        return asJson(TenonHttp.json("POST", "$API/voice/confirm", req.toString(), timeoutMs = 30000), "voice/confirm")
    }

    fun voiceDiary(date: String): JSONObject =
        asJson(TenonHttp.json("GET", "$API/voice/diary?date=" + enc(date), timeoutMs = 20000), "voice/diary")

    fun voiceDiaryGenerate(): JSONObject =
        asJson(TenonHttp.json("POST", "$API/voice/diary/generate", "{}", timeoutMs = 120000), "voice/diary/generate")

    /** 屏幕文本记录（服务端未实现时返回 null）。 */
    fun voiceScreenList(date: String): JSONObject? {
        val resp = TenonHttp.json("GET", "$API/voice/screen?date=" + enc(date), timeoutMs = 12000)
        if (resp.code !in 200..299 || resp.body.isBlank()) return null
        return try { JSONObject(resp.body) } catch (_: Exception) { null }
    }

    // ---------- 工具 ----------

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { fis ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = fis.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}