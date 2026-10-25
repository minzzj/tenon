package com.minzzj.tenon.net

import com.minzzj.tenon.App
import com.minzzj.tenon.LogBus
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress

/**
 * 局域网 UDP 发现（契约 §5）：监听并广播 7413 端口上的
 * {"t":"tenon-hello","deviceId":...,"name":...,"platform":"android","port":7410,"v":2}
 * 收到中枢/桌面端的 hello 后回调 onPeer；不可用时用「手输 IP」兜底。
 */
class Discovery(private val onPeer: (Peer) -> Unit) {
    @Volatile private var running = false
    private var socket: DatagramSocket? = null
    private var worker: Thread? = null

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        running = true
        val selfId = App.deviceId()
        worker = Thread {
            var listen: DatagramSocket? = null
            try {
                listen = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress(7413))
                }
                socket = listen
                LogBus.log("发现服务已启动：监听 UDP 7413")
                val sender = Thread {
                    var out: DatagramSocket? = null
                    try {
                        out = DatagramSocket().apply { broadcast = true }
                        val hello = JSONObject()
                            .put("t", "tenon-hello")
                            .put("deviceId", selfId)
                            .put("name", App.deviceName())
                            .put("platform", "android")
                            .put("port", 0)
                            .put("v", 2)
                            .toString()
                        while (running) {
                            try {
                                val data = hello.toByteArray(Charsets.UTF_8)
                                out.send(DatagramPacket(data, data.size, InetAddress.getByName("255.255.255.255"), 7413))
                            } catch (_: Exception) {
                            }
                            try { Thread.sleep(2500) } catch (_: InterruptedException) { break }
                        }
                    } catch (e: Exception) {
                        LogBus.log("发现广播失败：${e.message}")
                    } finally {
                        try { out?.close() } catch (_: Exception) {}
                    }
                }
                sender.isDaemon = true
                sender.start()

                val buf = ByteArray(4096)
                while (running) {
                    val packet = DatagramPacket(buf, buf.size)
                    try {
                        listen.receive(packet)
                    } catch (e: Exception) {
                        if (!running) break else continue
                    }
                    val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    try {
                        val o = JSONObject(text)
                        if (o.optString("t") != "tenon-hello") continue
                        val id = o.optString("deviceId", "")
                        if (id.isBlank() || id == selfId) continue
                        val host = packet.address?.hostAddress ?: continue
                        val p = Peer(id, o.optString("name", ""), o.optString("platform", ""), host, o.optInt("port", 7410))
                        LogBus.log("发现设备：${p.name} (${p.host}:${p.port})")
                        onPeer(p)
                    } catch (_: Exception) {
                        // 非 JSON 广播，忽略
                    }
                }
            } catch (e: Exception) {
                LogBus.log("发现服务失败：${e.message}")
            } finally {
                try { listen?.close() } catch (_: Exception) {}
            }
        }.also { it.isDaemon = true; it.start() }
    }

    fun stop() {
        running = false
        try { socket?.close() } catch (_: Exception) {}
        worker?.interrupt()
        LogBus.log("发现服务已停止")
    }
}