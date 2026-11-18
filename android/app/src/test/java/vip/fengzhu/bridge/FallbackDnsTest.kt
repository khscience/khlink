package vip.fengzhu.bridge

import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

class FallbackDnsTest {
    private val relay = InetAddress.getByAddress("www.khsci.vip", byteArrayOf(45, 59, 131.toByte(), 171.toByte()))
    private fun dns(block: (String) -> List<InetAddress>) = object : Dns { override fun lookup(hostname: String) = block(hostname) }
    private val failing = dns { throw UnknownHostException(it) }

    @Test
    fun usesTheSystemResolverWhenItWorks() {
        var asked = 0
        val dns = FallbackDns(primary = dns { listOf(relay) }, query = { _, _ -> asked++; emptyList() })
        assertEquals(listOf(relay), dns.lookup("www.khsci.vip"))
        assertEquals(0, asked)
    }

    @Test
    fun asksTheBackupServersInOrderAndCachesTheAnswer() {
        val asked = mutableListOf<String>()
        var time = 0L
        val dns = FallbackDns(primary = failing, servers = listOf("223.5.5.5", "223.6.6.6"),
            query = { server, host -> asked += "$server $host"; if (server == "223.5.5.5") throw java.net.SocketTimeoutException() else listOf(relay) },
            now = { time })
        assertEquals(listOf(relay), dns.lookup("WWW.khsci.vip."))
        assertEquals(listOf("223.5.5.5 www.khsci.vip", "223.6.6.6 www.khsci.vip"), asked)
        time = 60_000; dns.lookup("www.khsci.vip")
        assertEquals(2, asked.size)
        time = 6 * 60_000; dns.lookup("www.khsci.vip")
        assertEquals(4, asked.size)
    }

    @Test
    fun keepsTheOriginalErrorWhenNothingResolves() {
        val original = UnknownHostException("www.khsci.vip")
        val dns = FallbackDns(primary = dns { throw original }, query = { _, _ -> emptyList() })
        val thrown = runCatching { dns.lookup("www.khsci.vip") }.exceptionOrNull()
        assertSame(original, thrown)
        var asked = false
        val literal = FallbackDns(primary = failing, query = { _, _ -> asked = true; listOf(relay) })
        assertTrue(runCatching { literal.lookup("10.0.0.1") }.isFailure)
        assertTrue(!asked)
    }

    @Test
    fun buildsAQueryAndReadsACnameChain() {
        val query = FallbackDns.buildQuery(0x1234, "www.khsci.vip")
        assertEquals(listOf(0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 3), query.take(13).map { it.toInt() and 0xff })
        // Reply: question, then CNAME www.khsci.vip -> khsci.vip, then A 45.59.131.171.
        val name = query.copyOfRange(12, query.size - 4)
        val reply = byteArrayOf(0x12, 0x34, 0x81.toByte(), 0x80.toByte(), 0, 1, 0, 2, 0, 0, 0, 0) + name + byteArrayOf(0, 1, 0, 1) +
            byteArrayOf(0xc0.toByte(), 12, 0, 5, 0, 1, 0, 0, 2, 0x58, 0, 2, 0xc0.toByte(), 16) +
            byteArrayOf(0xc0.toByte(), 16, 0, 1, 0, 1, 0, 0, 2, 0x58, 0, 4, 45, 59, 131.toByte(), 171.toByte())
        assertEquals(listOf("45.59.131.171"), FallbackDns.parseAnswer(reply, 0x1234, "www.khsci.vip").map { it.hostAddress })
        val servfail = reply.copyOf().also { it[3] = 0x82.toByte() }
        assertEquals(emptyList<InetAddress>(), FallbackDns.parseAnswer(servfail, 0x1234, "www.khsci.vip"))
        assertEquals(emptyList<InetAddress>(), FallbackDns.parseAnswer(reply, 0x4321, "www.khsci.vip"))
        assertEquals(emptyList<InetAddress>(), FallbackDns.parseAnswer(reply.copyOf(20), 0x1234, "www.khsci.vip"))
    }
}
