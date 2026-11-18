package vip.fengzhu.bridge

import okhttp3.Dns
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random

/**
 * Uses the phone's own DNS first and asks Alibaba's public DNS only when that
 * fails. Some networks' resolvers (114 DNS, DNSPod, routers forwarding to them)
 * intermittently answer SERVFAIL for khsci.vip, whose nameservers sit abroad,
 * while 223.5.5.5 keeps resolving it (2026-11-14, the test phone on a home router).
 */
class FallbackDns(
    private val primary: Dns = Dns.SYSTEM,
    private val servers: List<String> = listOf("223.5.5.5", "223.6.6.6"),
    private val query: (server: String, host: String) -> List<InetAddress> = { server, host -> udpQuery(server, host) },
    private val now: () -> Long = System::currentTimeMillis,
) : Dns {
    private class Cached(val addresses: List<InetAddress>, val expiresAt: Long)
    private val cache = ConcurrentHashMap<String, Cached>()

    override fun lookup(hostname: String): List<InetAddress> {
        val failure = try {
            return primary.lookup(hostname)
        } catch (error: UnknownHostException) { error }
        if (isIpLiteral(hostname)) throw failure
        val key = hostname.lowercase().trimEnd('.')
        cache[key]?.takeIf { it.expiresAt > now() }?.let { return it.addresses }
        for (server in servers) {
            val addresses = try { query(server, key) } catch (_: Exception) { emptyList() }
            if (addresses.isNotEmpty()) {
                cache[key] = Cached(addresses, now() + CACHE_MS)
                return addresses
            }
        }
        throw failure
    }

    companion object {
        private const val CACHE_MS = 5 * 60_000L

        private fun isIpLiteral(host: String) = host.contains(':') || host.matches(Regex("""\d{1,3}(\.\d{1,3}){3}"""))

        /** One A query over UDP (3 s); a CNAME chain in the answer is followed by taking every A record in it. */
        fun udpQuery(server: String, host: String, timeoutMs: Int = 3000): List<InetAddress> {
            val id = Random.nextInt(0, 0x10000)
            val request = buildQuery(id, host)
            DatagramSocket().use { socket ->
                socket.soTimeout = timeoutMs
                socket.send(DatagramPacket(request, request.size, InetSocketAddress(server, 53)))
                val buffer = ByteArray(1500)
                val packet = DatagramPacket(buffer, buffer.size)
                socket.receive(packet)
                return parseAnswer(buffer.copyOf(packet.length), id, host)
            }
        }

        fun buildQuery(id: Int, host: String): ByteArray {
            val out = ByteArrayOutputStream()
            out.write(byteArrayOf((id shr 8).toByte(), id.toByte(), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0))
            for (label in host.trimEnd('.').split('.')) {
                val bytes = label.toByteArray(Charsets.US_ASCII)
                require(bytes.size in 1..63) { "invalid host" }
                out.write(bytes.size); out.write(bytes)
            }
            out.write(byteArrayOf(0, 0, 1, 0, 1))
            return out.toByteArray()
        }

        /** The A records of a reply to [buildQuery], or empty for an error reply or one for another query. */
        fun parseAnswer(reply: ByteArray, id: Int, host: String): List<InetAddress> {
            if (reply.size < 12) return emptyList()
            fun u16(at: Int) = ((reply[at].toInt() and 0xff) shl 8) or (reply[at + 1].toInt() and 0xff)
            if (u16(0) != id || (reply[2].toInt() and 0x80) == 0 || (reply[3].toInt() and 0x0f) != 0) return emptyList()
            val questions = u16(4); val answers = u16(6)
            var at = 12
            fun skipName() {
                while (at < reply.size) {
                    val length = reply[at].toInt() and 0xff
                    if (length == 0) { at++; return }
                    if (length and 0xc0 == 0xc0) { at += 2; return }
                    at += length + 1
                }
            }
            repeat(questions) { skipName(); at += 4 }
            val addresses = mutableListOf<InetAddress>()
            repeat(answers) {
                if (at >= reply.size) return addresses
                skipName()
                if (at + 10 > reply.size) return addresses
                val type = u16(at); val klass = u16(at + 2); val length = u16(at + 8)
                at += 10
                if (at + length > reply.size) return addresses
                if (type == 1 && klass == 1 && length == 4) {
                    addresses += InetAddress.getByAddress(host, reply.copyOfRange(at, at + 4)) as Inet4Address
                }
                at += length
            }
            return addresses
        }
    }
}
