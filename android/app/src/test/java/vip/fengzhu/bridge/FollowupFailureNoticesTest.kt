package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class FollowupFailureNoticesTest {
    @Test fun retriesAndCommandResultsOnlyNotifyOnceForTheSameRequest() {
        val notices = FollowupFailureNotices()
        val failed = QueuedInstruction("one", "hello", 100, "uncertain", stateVersion = 1)
        assertTrue(notices.claim("task", failed, "task"))
        assertFalse(notices.claim("task", failed.copy(stateVersion = 10), "task"))
        assertFalse(notices.claim("task", failed.copy(state = "failed", stateVersion = 20), "task"))
        assertTrue(notices.claim("task", failed.copy(id = "two"), "task"))
    }
    @Test fun backgroundAndHomeReplaysStayInTheReceiptCard() {
        val notices = FollowupFailureNotices()
        val failed = QueuedInstruction("one", "hello", 100, "uncertain")
        assertFalse(notices.claim("task", failed, null))
        assertFalse(notices.claim("task", failed, "other-task"))
        assertFalse(notices.claim("task", failed, "task"))
    }
    @Test fun deduplicationSurvivesRepositoryRecreation() {
        val notices = FollowupFailureNotices()
        val failed = QueuedInstruction("one", "hello", 100, "uncertain")
        assertTrue(notices.claim("task", failed, "task"))
        assertFalse(FollowupFailureNotices(notices.snapshot()).claim("task", failed, "task"))
    }
    @Test fun confirmedReceiptCannotBeUndoneByALaterTimeout() {
        val started = QueuedInstruction("one", "hello", 100, "started", stateVersion = 1, blocking = false)
        val failure = started.copy(state = "uncertain", stateVersion = 10)
        assertEquals(started, mergeQueuedInstruction(started, failure))
        assertFalse(FollowupFailureNotices().claim("task", mergeQueuedInstruction(started, failure), "task"))
    }
    @Test fun lateRealHistoryClearsUncertaintyWithoutAnOlderMessageAcknowledgingIt() {
        val uncertain = QueuedInstruction("one", "hello", 100, "uncertain", historyAfterOrder = 10)
        val old = HistoryItem("old", 10, "userMessage", "hello", null, false, createdAt = 90)
        val fresh = old.copy(id = "new", order = 20, createdAt = 110)
        assertFalse(isQueuedInstructionDelivered(uncertain, listOf(old)))
        assertTrue(isQueuedInstructionDelivered(uncertain, listOf(old, fresh)))
    }
}
