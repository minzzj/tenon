package com.minzzj.tenon.net

/** UDP 发现的局域网对端（中枢/桌面端）。 */
data class Peer(
    val deviceId: String,
    val name: String,
    val platform: String,
    val host: String,
    val port: Int
) {
    val address: String get() = "http://$host:$port"
}