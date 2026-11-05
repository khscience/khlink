package vip.fengzhu.bridge

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.UUID

internal fun validDirectSignalEndpoint(host: String, port: Int): Boolean {
    if (port !in 1024..65535 || !host.matches(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}"))) return false
    val values = host.split('.').map { it.toInt() }
    return values.all { it in 0..255 } && values.joinToString(".") == host && values[0] in 1..223 && values[0] != 127
        && !(values[0] == 169 && values[1] == 254) && !(values[0] == 198 && values[1] in 18..19)
}

/** The broadcast address of an IPv4 network, e.g. 192.168.8.192/24 -> 192.168.8.255. */
internal fun ipv4Broadcast(address: String, prefix: Int): String? {
    if (prefix !in 8..30) return null
    val parts = address.split('.').mapNotNull { it.toIntOrNull() }
    if (parts.size != 4 || parts.any { it !in 0..255 }) return null
    val value = parts.fold(0L) { acc, part -> (acc shl 8) or part.toLong() }
    val mask = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
    val broadcast = (value and mask) or (mask.inv() and 0xFFFFFFFFL)
    return (3 downTo 0).joinToString(".") { ((broadcast shr (it * 8)) and 0xFF).toString() }
}

/** Whether two IPv4 addresses are on the same network for the given prefix length. */
internal fun sameIpv4Network(a: String, b: String, prefix: Int): Boolean {
    if (prefix !in 8..32) return false
    fun value(ip: String): Long? {
        val parts = ip.split('.').mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return null
        return parts.fold(0L) { acc, part -> (acc shl 8) or part.toLong() }
    }
    val left = value(a) ?: return false; val right = value(b) ?: return false
    val mask = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
    return (left and mask) == (right and mask)
}

/** Where a paired phone asks again: the computer's last LAN addresses, then every broadcast. */
internal fun directResumeTargets(hosts: List<String>, port: Int, broadcasts: List<String>): List<DirectSignaling.Endpoint> {
    if (port !in 1024..65535) return emptyList()
    val known = hosts.filter { validDirectSignalEndpoint(it, port) }
    val wide = broadcasts.filter { it == "255.255.255.255" || validDirectSignalEndpoint(it, port) }
    return (known + wide + "255.255.255.255").distinct().take(12).map { DirectSignaling.Endpoint(it, port) }
}

// The return path only carries an encrypted, one-use WebRTC answer. It never
// receives an account token, password, master key, Agent command or file.
internal object DirectSignaling {
    data class Endpoint(val host: String, val port: Int)

    fun endpoints(offer: JSONObject): List<Endpoint> {
        val value = offer.optJSONObject("signaling") ?: error("电脑直连码版本较旧，请更新电脑端后重新生成")
        require(value.optInt("v") == 1 && value.optString("transport") == "udp") { "不支持的自动连接方式" }
        val rows = value.getJSONArray("endpoints")
        require(rows.length() in 1..8) { "电脑未提供可用连接地址" }
        return (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            val host = row.getString("host"); val port = row.getInt("port")
            require(validDirectSignalEndpoint(host, port)) { "无效的电脑连接地址" }
            Endpoint(host, port)
        }.distinct()
    }

    suspend fun submit(offer: JSONObject, answer: String, crypto: CryptoStore, cancelled: () -> Boolean) {
        val targets = endpoints(offer).map { InetAddress.getByName(it.host) to it.port }
        val id = offer.getString("id"); val packetId = UUID.randomUUID().toString()
        val key = CryptoStore.unb64(offer.getString("key"))
        val encrypted = crypto.encryptWithKey(key, "direct.answer", null, id, JSONObject().put("payload", answer))
        val raw = JSONObject().put("id", id).put("kind", "direct.answer")
            .put("nonce", encrypted.first).put("ciphertext", encrypted.second).toString().toByteArray(Charsets.UTF_8)
        require(raw.size in 1..16 * 1024) { "握手信息过大" }
        val total = (raw.size + 799) / 800
        val packets = (0 until total).map { index ->
            JSONObject().put("v", 1).put("id", id).put("packet", packetId).put("index", index).put("total", total)
                .put("data", CryptoStore.b64(raw.copyOfRange(index * 800, minOf(raw.size, (index + 1) * 800))))
                .toString().toByteArray(Charsets.UTF_8)
        }
        val job = currentCoroutineContext()
        val deadline = minOf(offer.getLong("expiresAt"), System.currentTimeMillis() + 15_000)
        DatagramSocket().use { socket ->
            socket.soTimeout = 350
            var nextSend = 0L
            while (System.currentTimeMillis() < deadline) {
                job.ensureActive()
                check(!cancelled()) { "直连已取消" }
                if (System.currentTimeMillis() >= nextSend) {
                    for ((host, port) in targets) for (bytes in packets) {
                        runCatching { socket.send(DatagramPacket(bytes, bytes.size, host, port)) }
                    }
                    nextSend = System.currentTimeMillis() + 700
                }
                val received = DatagramPacket(ByteArray(2048), 2048)
                try { socket.receive(received) } catch (_: SocketTimeoutException) { continue }
                if (targets.none { it.first == received.address && it.second == received.port }) continue
                val ack = runCatching {
                    val frame = JSONObject(String(received.data, 0, received.length, Charsets.UTF_8))
                    require(frame.optInt("v") == 1 && frame.optString("id") == id && frame.optString("kind") == "direct.ack")
                    crypto.decryptWithKey(key, "direct.ack", null, id, frame.getString("nonce"), frame.getString("ciphertext"))
                        .also { require(it.optString("packet") == packetId) }
                }.getOrNull() ?: continue
                check(ack.optBoolean("accepted")) { ack.optString("error", "电脑未接受本次连接，请重新生成二维码") }
                return
            }
        }
        error("无法自动回传握手信息，请换用同一 Wi-Fi／热点或账户连接后重试")
    }

    /**
     * A paired phone asks its computer for a fresh offer on the LAN, sealed
     * with the pairing key. Only a reply that opens with the same key counts,
     * so a broadcast cannot be answered by anyone else.
     */
    suspend fun resume(pcId: String, deviceId: String, key: ByteArray, targets: List<Endpoint>, crypto: CryptoStore, timeoutMs: Long = 4_000): JSONObject {
        require(targets.isNotEmpty()) { "没有可用的电脑地址，请重新扫码" }
        val id = UUID.randomUUID().toString()
        val encrypted = crypto.encryptWithKey(key, "direct.resume", null, id,
            JSONObject().put("pcId", pcId).put("deviceId", deviceId).put("sentAt", System.currentTimeMillis()))
        val raw = JSONObject().put("v", 1).put("kind", "direct.resume").put("id", id).put("deviceId", deviceId)
            .put("nonce", encrypted.first).put("ciphertext", encrypted.second).toString().toByteArray(Charsets.UTF_8)
        val job = currentCoroutineContext()
        val deadline = System.currentTimeMillis() + timeoutMs
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            var nextSend = 0L
            while (System.currentTimeMillis() < deadline) {
                job.ensureActive()
                if (System.currentTimeMillis() >= nextSend) {
                    for (target in targets) runCatching { socket.send(DatagramPacket(raw, raw.size, InetAddress.getByName(target.host), target.port)) }
                    nextSend = System.currentTimeMillis() + 1_000
                }
                val received = DatagramPacket(ByteArray(16 * 1024), 16 * 1024)
                try { socket.receive(received) } catch (_: SocketTimeoutException) { continue }
                val reply = runCatching {
                    val frame = JSONObject(String(received.data, 0, received.length, Charsets.UTF_8))
                    require(frame.optInt("v") == 1 && frame.optString("kind") == "direct.resume.offer" && frame.optString("id") == id)
                    crypto.decryptWithKey(key, "direct.resume.offer", null, id, frame.getString("nonce"), frame.getString("ciphertext"))
                }.getOrNull() ?: continue
                check(reply.optBoolean("ok")) { reply.optString("error", "电脑拒绝了重连，请重新扫码") }
                val offer = reply.getJSONObject("offer")
                require(offer.optString("pcId") == pcId) { "电脑身份与配对记录不匹配" }
                DirectQr.validateOffer(offer)
                return offer
            }
        }
        error("局域网里没有找到这台电脑")
    }
}
