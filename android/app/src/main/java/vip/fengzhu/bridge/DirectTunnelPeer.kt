package vip.fengzhu.bridge

import android.util.Base64
import android.util.Log
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit

/** A direct link to one computer: WebRTC on the same network, or the cross-network tunnel. */
internal interface DirectTransport {
    fun send(raw: String): Boolean
    fun close()
}

/** A tunnel name from the computer: the xxx of xxx.trycloudflare.com. */
internal fun validDirectTunnel(name: String?): Boolean = name != null && name.matches(Regex("[a-z0-9-]{1,80}"))

internal fun directTunnelUrl(name: String, target: String): String {
    require(validDirectTunnel(name)) { "无效的跨网络通道地址" }
    return "wss://$name.trycloudflare.com/khlink/$target"
}

/**
 * The cross-network direct link. The computer forwards a Cloudflare quick
 * tunnel to its connector, so a phone on mobile data reaches it without a
 * khLink server. Frames are the same sealed frames as over WebRTC, chunked the
 * same way; the tunnel only ever sees ciphertext.
 */
internal class DirectTunnelPeer(
    client: OkHttpClient,
    private val url: String,
    private val receive: (String) -> Unit,
    private val opened: () -> Unit,
    private val failed: (String) -> Unit,
) : DirectTransport {
    // Mobile networks often hand out IPv6 that cannot reach the tunnel: each
    // IPv6 address then waited a full connect timeout (23 s before IPv4 won).
    // Try IPv4 first and give up on a dead address quickly.
    private val client = client.newBuilder()
        .dns(object : Dns { override fun lookup(hostname: String) = Dns.SYSTEM.lookup(hostname).sortedBy { it is java.net.Inet6Address } })
        .connectTimeout(5, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var closed = false
    @Volatile private var open = false
    private data class Assembly(val total: Int, val at: Long, var next: Int = 0, val bytes: ByteArrayOutputStream = ByteArrayOutputStream())
    private val assemblies = mutableMapOf<String, Assembly>()

    private val startedAt = System.currentTimeMillis()
    private fun elapsed() = System.currentTimeMillis() - startedAt

    fun connect() {
        Log.i("FengzhuBridge", "direct tunnel connecting")
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { Log.i("FengzhuBridge", "direct tunnel open after ${elapsed()} ms"); if (!closed) { open = true; opened() } }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (closed) return
                runCatching { accept(text) }.onFailure { failed(it.message ?: "直连数据无效") }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { Log.i("FengzhuBridge", "direct tunnel closed $code after ${elapsed()} ms"); if (!closed) failed("跨网络直连已断开") }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w("FengzhuBridge", "direct tunnel failed after ${elapsed()} ms: ${response?.code} ${t.javaClass.simpleName} ${t.message}")
                if (closed) return
                failed(if (response?.code == 404 || response?.code == 530) "电脑的跨网络通道已关闭，请重新扫码" else "跨网络直连失败：${t.message ?: "网络错误"}")
            }
        })
    }

    override fun send(raw: String): Boolean {
        val current = socket ?: return false
        if (closed || !open) return false
        val bytes = raw.toByteArray(); if (bytes.size > 8 * 1024 * 1024) return false
        val packets = if (bytes.size <= 12000) listOf(raw) else {
            val id = UUID.randomUUID().toString(); val total = (bytes.size + 8191) / 8192
            (0 until total).map { index -> JSONObject().put("type", "chunk").put("id", id).put("index", index).put("total", total)
                .put("data", Base64.encodeToString(bytes.copyOfRange(index * 8192, minOf((index + 1) * 8192, bytes.size)), Base64.NO_WRAP)).toString() }
        }
        if (current.queueSize() + packets.sumOf { it.length.toLong() } > 16L * 1024 * 1024) return false
        return packets.all { current.send(it) }
    }

    @Synchronized private fun accept(raw: String) {
        require(raw.length <= 64 * 1024) { "无效的直连数据帧" }
        val packet = JSONObject(raw)
        if (packet.optString("type") != "chunk") { receive(raw); return }
        val id = packet.getString("id"); val index = packet.getInt("index"); val total = packet.getInt("total"); val data = packet.getString("data")
        require(id.matches(Regex("[a-fA-F0-9-]{36}")) && total in 2..1024 && index in 0 until total && data.length <= 11000) { "无效的直连分片" }
        assemblies.entries.removeAll { System.currentTimeMillis() - it.value.at > 30000 }
        val entry = assemblies[id] ?: run { require(index == 0 && assemblies.size < 4); Assembly(total, System.currentTimeMillis()).also { assemblies[id] = it } }
        require(entry.total == total && entry.next == index) { "直连分片顺序错误" }
        val bytes = Base64.decode(data, Base64.NO_WRAP)
        require(bytes.size <= 8192 && entry.bytes.size() + bytes.size <= 8 * 1024 * 1024) { "直连消息过大" }
        entry.bytes.write(bytes); entry.next++
        if (entry.next == total) { assemblies.remove(id); receive(entry.bytes.toString("UTF-8")) }
    }

    override fun close() {
        if (closed) return
        closed = true; open = false
        socket?.close(1000, "close"); socket = null
    }
}
