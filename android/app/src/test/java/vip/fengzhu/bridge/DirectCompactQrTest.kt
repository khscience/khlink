package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone half of the compact direct QR; the expected values come from the connector's `direct-compact.js`. */
class DirectCompactQrTest {
    @Test fun base32MatchesTheConnector() {
        assertEquals("khLink 直连", String(DirectQr.unbase32("NNUEY2LONMQOPG5U5C7Z4"), Charsets.UTF_8))
    }

    @Test fun rebuiltSdpIsIdenticalToTheConnectorTemplate() {
        val expected = "v=0\r\no=- 1 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic:WMS *\r\n" +
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:b49f\r\n" +
            "a=ice-pwd:496f31cdee49a85a45240b\r\na=fingerprint:sha-256 CA:37\r\na=setup:actpass\r\na=mid:0\r\n" +
            "a=sctp-port:5000\r\na=max-message-size:16384\r\n" +
            "a=candidate:1 1 udp 2130706431 192.168.8.178 61008 typ host\r\n" +
            "a=candidate:2 1 udp 1694498814 61.13.236.178 35961 typ srflx raddr 0.0.0.0 rport 0\r\na=end-of-candidates\r\n"
        val actual = DirectQr.compactSdp("b49f", "496f31cdee49a85a45240b", "CA:37",
            listOf(Triple("host", "192.168.8.178", 61008), Triple("srflx", "61.13.236.178", 35961)))
        assertEquals(expected, actual)
    }

    @Test fun choosesTheTunnelOnlyOffTheComputersNetwork() {
        assertTrue(sameIpv4Network("192.168.8.178", "192.168.8.192", 24))
        assertFalse(sameIpv4Network("192.168.8.178", "10.149.255.252", 29))
        assertFalse(sameIpv4Network("192.168.8.178", "192.168.9.10", 24))
        assertTrue(sameIpv4Network("10.0.3.4", "10.0.200.1", 16))
        assertFalse(sameIpv4Network("bad", "192.168.8.1", 24))
    }

    @Test fun tunnelNamesAreRestrictedToTryCloudflareSubdomains() {
        assertEquals("wss://heater-slide-install-beautiful.trycloudflare.com/khlink/resume", directTunnelUrl("heater-slide-install-beautiful", "resume"))
        assertTrue(validDirectTunnel("abc-123"))
        listOf("evil.com/x", "a.b", "UPPER", "", "x".repeat(81)).forEach { assertFalse(it, validDirectTunnel(it)) }
    }

    @Test fun recognisesBothQrGenerations() {
        assertTrue(DirectQr.isDirect("KHLINK://D/AMBXYZ"))
        assertTrue(DirectQr.isDirect("khlink://direct/offer?data=abc"))
        assertFalse(DirectQr.isDirect("khlink://pair?v=2"))
    }
}
