package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompactionLiveTest {
    @Test
    fun aRunningCompactionHasItsLineAndAFinishedOneDoesNot() {
        assertTrue(isCompactingThreadStatus("mobile_compacting"))
        assertTrue(isCompactingThreadStatus("compacting"))
        assertFalse(isCompactingThreadStatus("mobile_running"))
        assertFalse(isCompactingThreadStatus("completed"))
    }

    @Test
    fun aFailedCompactionLiftsTheLineButDoesNotFailTheTurn() {
        assertEquals("compacting", compactionLiveStatus("started"))
        assertEquals("mobile_running", compactionLiveStatus("completed"))
        assertEquals("mobile_running", compactionLiveStatus("failed"))
        assertNull(compactionLiveStatus("something-else"))
    }

    @Test
    fun aCompactionThatHeartbeatsStopMentioningIsRetired() {
        val absentSince = mutableMapOf<String, Long>()
        val current = mapOf("thread-1" to "mobile_compacting")
        assertTrue(retireLongAbsentBusyStatuses(current, emptySet(), absentSince, 1_000L, emptyMap(), graceMs = 90_000L).isEmpty())
        assertEquals(setOf("thread-1"), retireLongAbsentBusyStatuses(current, emptySet(), absentSince, 91_000L, emptyMap(), graceMs = 90_000L))
    }
}
