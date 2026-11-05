package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusActivityTest {
    @Test
    fun reannouncedCompletionOfAnOldTaskIsNotActivity() {
        assertFalse(isStatusActivity("completed", "completed"))
        assertFalse(isStatusActivity("idle", "completed"))
        assertFalse(isStatusActivity("", "completed"))
    }

    @Test
    fun startingRunningAndEndingARunAreActivity() {
        assertTrue(isStatusActivity("completed", "desktop_running"))
        assertTrue(isStatusActivity("desktop_running", "completed"))
        assertTrue(isStatusActivity("mobile_running", "failed"))
        assertTrue(isStatusActivity("completed", "desktop_waiting"))
    }

    @Test
    fun sameTurnRunningReplayAfterCompletionIsIgnored() {
        assertTrue(isSameTurnStatusReplay("turn-1", "turn-1"))
        assertFalse(isSameTurnStatusReplay("turn-1", "turn-2"))
        assertFalse(isSameTurnStatusReplay("turn-1", null))
        assertTrue(shouldIgnoreBusyStatusReplay("mobile_running", "turn-1", "turn-1"))
        assertFalse(shouldIgnoreBusyStatusReplay("mobile_running", "turn-1", "turn-2"))
        assertFalse(shouldIgnoreBusyStatusReplay("completed", "turn-1", "turn-1"))
    }
}
