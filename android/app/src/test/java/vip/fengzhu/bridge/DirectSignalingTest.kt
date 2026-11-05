package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectSignalingTest {
    @Test fun acceptsLanAndPublicReturnEndpoints() {
        listOf("192.168.1.20", "10.1.2.3", "172.16.5.8", "203.0.113.7").forEach {
            assertTrue(it, validDirectSignalEndpoint(it, 45000))
        }
    }
    @Test fun rejectsDnsLocalhostVirtualAndAmbiguousAddresses() {
        listOf("localhost", "example.com", "127.0.0.1", "169.254.1.2", "198.18.0.1", "198.19.1.2",
            "224.0.0.1", "0.0.0.0", "256.1.2.3", "01.2.3.4", "::1", "192.168.0.1/24").forEach {
            assertFalse(it, validDirectSignalEndpoint(it, 45000))
        }
    }
    @Test fun computesTheLanBroadcastAddress() {
        assertEquals("192.168.8.255", ipv4Broadcast("192.168.8.192", 24))
        assertEquals("10.0.255.255", ipv4Broadcast("10.0.3.4", 16))
        assertEquals("172.20.10.15", ipv4Broadcast("172.20.10.2", 28))
        assertEquals(null, ipv4Broadcast("192.168.8.192", 32))
        assertEquals(null, ipv4Broadcast("not-an-ip", 24))
    }
    @Test fun resumeAsksKnownAddressesFirstThenBroadcasts() {
        val targets = directResumeTargets(listOf("192.168.8.178", "127.0.0.1", "192.168.8.178"), 47820, listOf("192.168.8.255"))
        assertEquals(listOf("192.168.8.178", "192.168.8.255", "255.255.255.255"), targets.map { it.host })
        assertTrue(targets.all { it.port == 47820 })
        assertTrue(directResumeTargets(listOf("192.168.8.178"), 80, emptyList()).isEmpty())
    }
    @Test fun rejectsPrivilegedAndOutOfRangePorts() {
        listOf(-1, 0, 80, 1023, 65536).forEach { assertFalse(validDirectSignalEndpoint("192.168.1.10", it)) }
        listOf(1024, 65535).forEach { assertTrue(validDirectSignalEndpoint("192.168.1.10", it)) }
    }
}
