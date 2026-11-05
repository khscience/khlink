package vip.fengzhu.bridge

import android.content.Context
import android.os.PowerManager
import android.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.webrtc.*
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class DirectPeer(context: Context, private val receive: (String) -> Unit, private val opened: () -> Unit, private val failed: (String) -> Unit) : DirectTransport {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val factory: PeerConnectionFactory
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null
    private val gathering = CompletableDeferred<Unit>()
    private val queue = ArrayDeque<String>()
    private var queueBytes = 0
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val incoming = Channel<String>(256)
    @Volatile private var closed = false
    private val wakeLock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KHLink:DirectConnection").apply { setReferenceCounted(false) }
    private data class Assembly(val total: Int, val at: Long, var next: Int = 0, val bytes: ByteArrayOutputStream = ByteArrayOutputStream())
    private val assemblies = mutableMapOf<String, Assembly>()

    init {
        synchronized(DirectPeer::class.java) {
            if (!initialized) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
                initialized = true
            }
        }
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        scope.launch { for (raw in incoming) runCatching { accept(raw) }.onFailure { failed(it.message ?: "直连数据无效") } }
        scope.launch {
            for (signal in wake) {
                while (!closed) {
                    val current = channel ?: break
                    if (current.state() != DataChannel.State.OPEN) break
                    if (current.bufferedAmount() > 256 * 1024) { delay(20); continue }
                    val raw = synchronized(queue) {
                        if (queue.isEmpty()) null else queue.removeFirst().also { queueBytes -= it.toByteArray().size }
                    } ?: break
                    if (!current.send(DataChannel.Buffer(ByteBuffer.wrap(raw.toByteArray()), false))) { failed("直连发送失败，请重新扫码"); break }
                }
            }
        }
    }

    suspend fun answer(offer: JSONObject): String = withTimeout(35_000) {
        // ICE consent checks must keep running when the screen/app is backgrounded.
        // Bound and renew the CPU-only lock; close() always releases it.
        synchronized(wakeLock) { if (!closed) wakeLock.acquire(10 * 60_000L) }
        scope.launch {
            while (!closed) {
                delay(5 * 60_000L)
                synchronized(wakeLock) { if (!closed) wakeLock.acquire(10 * 60_000L) }
            }
        }
        // Never a STUN server: it would learn this phone's real public address
        // outside any VPN. Across networks the tunnel carries the link instead.
        val servers = emptyList<PeerConnection.IceServer>()
        val config = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
        }
        val connection = factory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                if (!closed && state == PeerConnection.IceConnectionState.FAILED) failed("当前网络无法穿透，请换用同一 Wi-Fi／热点或服务器模式")
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) gathering.complete(Unit)
            }
            override fun onIceCandidate(candidate: IceCandidate?) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onAddStream(stream: MediaStream?) {}
            override fun onRemoveStream(stream: MediaStream?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
            override fun onDataChannel(value: DataChannel?) {
                if (value == null || value.label() != "khlink-direct-v1" || closed) { value?.close(); return }
                channel = value
                value.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(previous: Long) { wake.trySend(Unit) }
                    override fun onStateChange() {
                        when (value.state()) {
                            DataChannel.State.OPEN -> { opened(); wake.trySend(Unit) }
                            DataChannel.State.CLOSED -> if (!closed) failed("直连已断开，请重新扫描电脑二维码")
                            else -> Unit
                        }
                    }
                    override fun onMessage(buffer: DataChannel.Buffer?) {
                        if (buffer == null || buffer.data.remaining() > 16 * 1024) { failed("无效的直连数据帧"); return }
                        val bytes = ByteArray(buffer.data.remaining()); buffer.data.get(bytes)
                        if (incoming.trySend(String(bytes, Charsets.UTF_8)).isFailure) failed("直连接收队列已满，请重新连接")
                    }
                })
                if (value.state() == DataChannel.State.OPEN) { opened(); wake.trySend(Unit) }
            }
        }) ?: error("无法创建直连通道")
        peer = connection
        setDescription(connection, SessionDescription(SessionDescription.Type.OFFER, offer.getString("sdp")), false)
        val answer = suspendCancellableCoroutine<SessionDescription> { continuation ->
            connection.createAnswer(object : SdpObserver {
                override fun onCreateSuccess(value: SessionDescription?) { if (continuation.isActive) { if (value != null) continuation.resume(value) else continuation.resumeWithException(IllegalStateException("未返回连接信息")) } }
                override fun onCreateFailure(error: String?) { if (continuation.isActive) continuation.resumeWithException(IllegalStateException(error ?: "无法生成确认码")) }
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) {}
            }, MediaConstraints())
        }
        setDescription(connection, answer, true)
        gathering.await()
        connection.localDescription?.description ?: error("无法读取确认信息")
    }

    private suspend fun setDescription(connection: PeerConnection, value: SessionDescription, local: Boolean) = suspendCancellableCoroutine<Unit> { continuation ->
        val observer = object : SdpObserver {
            override fun onSetSuccess() { if (continuation.isActive) continuation.resume(Unit) }
            override fun onSetFailure(error: String?) { if (continuation.isActive) continuation.resumeWithException(IllegalStateException(error ?: "无法建立直连")) }
            override fun onCreateSuccess(value: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }
        if (local) connection.setLocalDescription(observer, value) else connection.setRemoteDescription(observer, value)
    }

    override fun send(raw: String): Boolean {
        if (closed || channel?.state() != DataChannel.State.OPEN) return false
        val bytes = raw.toByteArray(); if (bytes.size > 8 * 1024 * 1024) return false
        val packets = if (bytes.size <= 12000) listOf(raw) else {
            val id = UUID.randomUUID().toString(); val total = (bytes.size + 8191) / 8192
            (0 until total).map { index -> JSONObject().put("type", "chunk").put("id", id).put("index", index).put("total", total)
                .put("data", Base64.encodeToString(bytes.copyOfRange(index * 8192, minOf((index + 1) * 8192, bytes.size)), Base64.NO_WRAP)).toString() }
        }
        val size = packets.sumOf { it.toByteArray().size }
        synchronized(queue) {
            if (queueBytes + size > 16 * 1024 * 1024) return false
            queue.addAll(packets); queueBytes += size
        }
        wake.trySend(Unit); return true
    }

    @Synchronized private fun accept(raw: String) {
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
        closed = true; gathering.cancel(); scope.cancel(); wake.close(); incoming.close()
        synchronized(wakeLock) { if (wakeLock.isHeld) wakeLock.release() }
        // WebRTC must not be disposed on its own callback thread.
        CoroutineScope(Dispatchers.IO).launch { channel?.unregisterObserver(); channel?.close(); peer?.close(); peer?.dispose(); factory.dispose() }
    }
    companion object { @Volatile private var initialized = false }
}
