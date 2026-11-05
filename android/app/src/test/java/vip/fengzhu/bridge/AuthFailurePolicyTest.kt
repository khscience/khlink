package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class AuthFailurePolicyTest {
    @Test
    fun `expired websocket access token is refreshed without clearing pairing`() {
        assertEquals(AuthFailureAction.REFRESH_ACCESS, websocketAuthFailureAction(401))
    }

    @Test
    fun `websocket permission and network failures keep the local session`() {
        assertEquals(AuthFailureAction.KEEP_SESSION, websocketAuthFailureAction(403))
        assertEquals(AuthFailureAction.KEEP_SESSION, websocketAuthFailureAction(null))
    }

    @Test
    fun `only a rejected refresh token requires reauthentication`() {
        assertEquals(AuthFailureAction.REQUIRE_REAUTH, refreshAuthFailureAction(401))
        assertEquals(AuthFailureAction.REQUIRE_REAUTH, refreshAuthFailureAction(403))
        assertEquals(AuthFailureAction.KEEP_SESSION, refreshAuthFailureAction(500))
        assertEquals(AuthFailureAction.KEEP_SESSION, refreshAuthFailureAction(null))
    }

    @Test
    fun `pairing polling tolerates transport and server failures but not expired codes`() {
        assertEquals(true, shouldRetryPairingPoll(null))
        assertEquals(true, shouldRetryPairingPoll(503))
        assertEquals(false, shouldRetryPairingPoll(400))
        assertEquals(false, shouldRetryPairingPoll(401))
    }
}
