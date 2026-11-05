package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NeedsReplyStatusTest {
    @Test
    fun desktopApprovalIsWaitingRatherThanRunningOrCompleted() {
        assertTrue(isDesktopApprovalStatus("desktop_waiting_approval"))
        assertTrue(isWaitingThreadStatus("desktop_waiting_approval"))
        assertFalse(isRunningThreadStatus("desktop_waiting_approval"))
        assertFalse(isCompletedThreadStatus("desktop_waiting_approval"))
        assertFalse(isDesktopApprovalStatus("desktop_running"))
    }

    @Test
    fun approvalNoticeIgnoresSnapshotsReplaysAndStaleEvents() {
        val now = 1_000_000L
        fun alert(previous: String = "desktop_running", kind: String = "thread.status", applied: Boolean = true, eventAt: Long = now, last: Long = 0L) =
            shouldNotifyDesktopApproval(previous, "desktop_waiting_approval", kind, applied, eventAt, last, now)
        assertTrue(alert())
        assertFalse(alert(previous = "desktop_waiting_approval"))
        assertFalse(alert(kind = "thread.status.snapshot"))
        assertFalse(alert(applied = false))
        assertFalse(alert(last = now))
        assertFalse(alert(eventAt = now - 120_001L))
    }
    @Test
    fun aTurnThatEndedOnAQuestionIsShownAsWaitingButIsNotBusy() {
        assertTrue(isNeedsReplyStatus("needs_reply"))
        assertTrue(isWaitingThreadStatus("needs_reply"))
        // Nothing is running: replies are sent at once, not queued, nothing to stop.
        assertFalse(isTurnBusyStatus("needs_reply"))
        assertFalse(isRunningThreadStatus("needs_reply"))
        assertFalse(isCompletedThreadStatus("needs_reply"))
        assertTrue(isStatusActivity("completed", "needs_reply"))
        // A live prompt is still a busy turn.
        assertTrue(isTurnBusyStatus("desktop_waiting"))
    }

    @Test
    fun aQuestionLeftOutOfEveryHeartbeatIsRetiredLikeABusyTask() {
        val absent = mutableMapOf<String, Long>()
        val current = mapOf("t" to "needs_reply", "done" to "completed")
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, emptySet(), absent, 1_000L, emptyMap()))
        assertEquals(setOf("t"), retireLongAbsentBusyStatuses(current, emptySet(), absent, 1_000L + LIVE_ABSENCE_RETIRE_MS, emptyMap()))
    }
}
