package vip.fengzhu.bridge

import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.zip.DeflaterOutputStream
import java.util.zip.InflaterInputStream
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal object DirectQr {
    const val STUN = "stun:stun.l.google.com:19302"
    const val COMPACT_PREFIX = "KHLINK://D/"
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun isDirect(payload: String): Boolean = payload.startsWith("khlink://direct/") || payload.startsWith(COMPACT_PREFIX)

    internal fun unbase32(text: String): ByteArray {
        val out = ByteArrayOutputStream(); var value = 0; var bits = 0
        for (char in text) {
            val index = ALPHABET.indexOf(char); require(index >= 0) { "无效的直连二维码" }
            value = (value shl 5) or index; bits += 5
            if (bits >= 8) { out.write((value ushr (bits - 8)) and 255); bits -= 8 }
        }
        return out.toByteArray()
    }

    /** The SDP rebuilt from a compact QR; must match the connector's `compactSdp`. */
    internal fun compactSdp(ufrag: String, pwd: String, fingerprint: String, candidates: List<Triple<String, String, Int>>): String {
        val lines = mutableListOf("v=0", "o=- 1 0 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0", "a=msid-semantic:WMS *",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
            "a=ice-ufrag:$ufrag", "a=ice-pwd:$pwd", "a=fingerprint:sha-256 $fingerprint", "a=setup:actpass", "a=mid:0",
            "a=sctp-port:5000", "a=max-message-size:16384")
        candidates.forEachIndexed { index, (type, ip, port) ->
            lines += if (type == "host") "a=candidate:${index + 1} 1 udp ${2130706431 - index} $ip $port typ host"
            else "a=candidate:${index + 1} 1 udp ${1694498815 - index} $ip $port typ srflx raddr 0.0.0.0 rport 0"
        }
        lines += "a=end-of-candidates"
        return lines.joinToString("\r\n") + "\r\n"
    }

    /** A compact (v3) QR: the offer's fields packed in base32, returned in the v2 offer's shape. */
    internal fun decodeCompact(payload: String): JSONObject {
        require(payload.length <= 1200) { "无效的直连二维码" }
        val bytes = unbase32(payload.removePrefix(COMPACT_PREFIX)); var at = 0
        fun take(count: Int): ByteArray { require(at + count <= bytes.size) { "直连二维码不完整" }; return bytes.copyOfRange(at, at + count).also { at += count } }
        fun u8() = take(1)[0].toInt() and 255
        fun u16() = take(2).let { ((it[0].toInt() and 255) shl 8) or (it[1].toInt() and 255) }
        fun hex(value: ByteArray) = value.joinToString("") { "%02x".format(it) }
        fun uuid(value: ByteArray) = hex(value).replace(Regex("^(.{8})(.{4})(.{4})(.{4})(.{12})$"), "$1-$2-$3-$4-$5")
        fun ip() = take(4).joinToString(".") { (it.toInt() and 255).toString() }
        require(u8() == 3) { "请更新手机端后重新扫码" }
        val flags = u8()
        val id = uuid(take(16)); val pcId = uuid(take(16)) + if (flags and 2 != 0) ".connector" else ""
        val key = CryptoStore.b64(take(32))
        val fingerprint = hex(take(32)).uppercase().chunked(2).joinToString(":")
        val expiresAt = take(4).fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 255) } * 1000
        val ufrag = String(take(u8()), Charsets.UTF_8); val pwd = String(take(u8()), Charsets.UTF_8)
        val candidates = (0 until u8()).map { val type = if (u8() == 0) "host" else "srflx"; val host = ip(); Triple(type, host, u16()) }
        val endpoints = org.json.JSONArray()
        repeat(u8()) { val host = ip(); endpoints.put(JSONObject().put("host", host).put("port", u16())) }
        val pcName = String(take(u8()), Charsets.UTF_8).trimEnd('�')
        // The cross-network tunnel: the xxx of xxx.trycloudflare.com.
        val tunnel = if (flags and 4 != 0) String(take(u8()), Charsets.US_ASCII).also { require(validDirectTunnel(it)) { "无效的跨网络通道地址" } } else null
        val value = JSONObject().put("v", 2).put("id", id).put("expiresAt", expiresAt).put("pcId", pcId).put("pcName", pcName)
            .put("key", key).put("stun", flags and 1 != 0)
            .put("signaling", JSONObject().put("v", 1).put("transport", "udp").put("endpoints", endpoints))
            .put("sdp", compactSdp(ufrag, pwd, fingerprint, candidates))
        if (tunnel != null) value.put("tunnel", tunnel)
        return value
    }

    fun decode(payload: String): JSONObject {
        if (payload.startsWith(COMPACT_PREFIX)) {
            val value = decodeCompact(payload)
            validateOffer(value)
            require(CryptoStore.unb64(value.getString("key")).size == 32) { "无效的连接密钥" }
            return value
        }
        require(payload.length <= 3000) { "无效的直连二维码" }
        val uri = Uri.parse(payload)
        require(uri.scheme == "khlink" && uri.host == "direct" && uri.path == "/offer") { "这不是电脑直连码" }
        val data = uri.getQueryParameter("data") ?: error("二维码缺少连接信息")
        require(data.matches(Regex("[A-Za-z0-9_-]+"))) { "无效的连接信息" }
        val output = ByteArrayOutputStream()
        InflaterInputStream(Base64.decode(data, Base64.URL_SAFE or Base64.NO_WRAP).inputStream()).use { stream ->
            val buffer = ByteArray(1024)
            while (true) {
                val count = stream.read(buffer); if (count < 0) break
                require(output.size() + count <= 24 * 1024) { "连接信息过大" }; output.write(buffer, 0, count)
            }
        }
        val value = JSONObject(output.toString("UTF-8"))
        validateOffer(value)
        require(CryptoStore.unb64(value.getString("key")).size == 32) { "无效的连接密钥" }
        return value
    }
    /** The parts of an offer shared by a scanned QR and a LAN reconnect. */
    fun validateOffer(value: JSONObject) {
        require(value.optInt("v") == 2 && value.optString("id").matches(Regex("[a-fA-F0-9-]{36}"))) { "请更新电脑端后重新生成直连二维码" }
        DirectSignaling.endpoints(value)
        val remaining = value.optLong("expiresAt") - System.currentTimeMillis()
        require(remaining in 1..360_000) { "电脑连接码已过期，请重新生成" }
        val sdp = value.getString("sdp")
        require(sdp.length <= 18000 && sdp.contains("m=application ") && sdp.contains("a=fingerprint:sha-256 ") && !sdp.contains(" typ relay")) { "仅支持无中继的数据直连" }
    }
    fun answer(offer: JSONObject, deviceId: String, name: String, sdp: String): String {
        val value = JSONObject().put("v", 1).put("id", offer.getString("id"))
            .put("deviceId", deviceId).put("name", name).put("sdp", sdp)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(CryptoStore.unb64(offer.getString("key")), "HmacSHA256"))
        value.put("mac", CryptoStore.b64(mac.doFinal("${value.getString("id")}\n$deviceId\n$name\n$sdp".toByteArray())))
        val output = ByteArrayOutputStream()
        DeflaterOutputStream(output).use { it.write(value.toString().toByteArray()) }
        val encoded = Base64.encodeToString(output.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val result = "khlink://direct/answer?data=$encoded"
        require(result.length <= 2800) { "连接信息过长，请关闭 VPN 或多余网卡后重试" }
        return result
    }
}
