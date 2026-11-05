package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class RestoredProtocolVersionTest {
    @Test
    fun theSavedVersionWins() {
        assertEquals(1, restoredProtocolVersion(1, null))
        assertEquals(2, restoredProtocolVersion(2, "acct"))
    }

    @Test
    fun anOlderBackupIsReadFromItsAccount() {
        assertEquals(1, restoredProtocolVersion(null, null))
        assertEquals(1, restoredProtocolVersion(null, ""))
        assertEquals(2, restoredProtocolVersion(null, "acct"))
    }

    @Test
    fun anUnknownVersionFallsBackToTheAccount() {
        assertEquals(1, restoredProtocolVersion(0, null))
        assertEquals(2, restoredProtocolVersion(7, "acct"))
    }
}
