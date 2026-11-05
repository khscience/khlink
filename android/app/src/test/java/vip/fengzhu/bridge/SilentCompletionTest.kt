package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SilentCompletionTest {
    @Test fun onlyQuietUnknownClearsAnAbandonedTurnTimer() {
        assertTrue(shouldClearUnknownTurnTracking("unknown", quiet = true))
        assertTrue(shouldClearUnknownTurnTracking("UNKNOWN", quiet = true))
        assertFalse(shouldClearUnknownTurnTracking("unknown", quiet = false))
        assertFalse(shouldClearUnknownTurnTracking("completed", quiet = true))
        assertFalse(shouldClearUnknownTurnTracking("desktop_running", quiet = true))
    }
    @Test
    fun aCompletionReadFromSilenceClearsTheBadgeButEndsNoTurn() {
        assertTrue(isSilentCompletion("completed", quiet = true))
        assertTrue(isSilentCompletion("Completed", quiet = true))
    }

    @Test
    fun aRealEndAndEveryOtherStatusStayTurnEvents() {
        assertFalse(isSilentCompletion("completed", quiet = false))
        assertFalse(isSilentCompletion("failed", quiet = true))
        assertFalse(isSilentCompletion("cancelled", quiet = true))
        assertFalse(isSilentCompletion("mobile_running", quiet = true))
    }
}
