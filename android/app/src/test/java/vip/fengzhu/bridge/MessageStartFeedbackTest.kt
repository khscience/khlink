package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class MessageStartFeedbackTest {
    private val sentAt = 100_000L

    @Test fun newTaskFirstInstructionRequiresItsSuccessfulStartReceipt() {
        assertTrue(confirmsNewTaskStart(org.json.JSONObject().put("threadId", "new")))
        assertFalse(confirmsNewTaskStart(org.json.JSONObject()))
        for (flag in listOf("queued", "uncertain", "failed", "pending")) {
            assertFalse(confirmsNewTaskStart(org.json.JSONObject().put("threadId", "new").put(flag, true)))
        }
        assertFalse(confirmsNewTaskStart(org.json.JSONObject().put("threadId", "new")
            .put("requiresConfirmation", org.json.JSONObject().put("kind", "workspaceTrust"))))
    }

    @Test fun sendingQueueAckAndBusyHeartbeatsDoNotBuzz() {
        val cues = MessageStartFeedback()
        cues.register("scope:request", sentAt)
        for (state in listOf("sending", "pending", "dispatching", "desktop_queued", "running", "desktop_running", "failed", "uncertain")) {
            assertFalse(cues.confirm("scope:request", state, sentAt + 10, sentAt + 20))
        }
        assertTrue(cues.confirm("scope:request", "started", sentAt + 30, sentAt + 40))
    }

    @Test fun queueStartsLaterAndSteerCountsAsAcceptance() {
        val cues = MessageStartFeedback()
        cues.register("queued", sentAt)
        assertTrue(cues.confirm("queued", "started", sentAt + 3_600_000, sentAt + 3_600_020))
        cues.register("steer", sentAt)
        assertTrue(cues.confirm("steer", "steered", sentAt + 50, sentAt + 60))
    }

    @Test fun duplicateOutOfOrderReceiptAndRepositoryRecreationRemainSilent() {
        val cues = MessageStartFeedback()
        cues.register("one", sentAt)
        assertTrue(cues.confirm("one", "started", sentAt + 10, sentAt + 20))
        assertFalse(cues.confirm("one", "pending", sentAt + 5, sentAt + 21))
        assertFalse(cues.confirm("one", "steered", sentAt + 10, sentAt + 22))
        assertFalse(MessageStartFeedback(cues.snapshot()).confirm("one", "started", sentAt + 10, sentAt + 23))
    }

    @Test fun anotherPhoneDesktopOrAccountCannotClaimThisPhonesRequest() {
        val cues = MessageStartFeedback()
        cues.register("accountA:thread:one", sentAt)
        assertFalse(cues.confirm("accountB:thread:one", "started", sentAt + 10, sentAt + 20))
        assertFalse(cues.confirm("accountA:thread:two", "started", sentAt + 10, sentAt + 20))
        assertTrue(cues.confirm("accountA:thread:one", "started", sentAt + 10, sentAt + 20))
    }

    @Test fun restoredPendingQueueCanStartButHistoricalReplayIsConsumedSilently() {
        val cues = MessageStartFeedback(mapOf("old" to sentAt, "queued" to sentAt))
        assertFalse(cues.confirm("old", "started", sentAt + 1_000, sentAt + 120_000))
        assertFalse(cues.snapshot().containsKey("old"))
        assertTrue(cues.confirm("queued", "started", sentAt + 120_010, sentAt + 120_020))
    }

    @Test fun missingTimestampDoesNotConsumePendingAndSmallClockSkewWorks() {
        val cues = MessageStartFeedback()
        cues.register("one", sentAt)
        assertFalse(cues.confirm("one", "started", null, sentAt + 20))
        assertTrue(cues.confirm("one", "started", sentAt - 5_000, sentAt + 20))
    }

    @Test fun staleUnrelatedTurnAndLargeFutureTimestampCannotBuzz() {
        val cues = MessageStartFeedback()
        cues.register("one", sentAt)
        assertFalse(cues.confirm("one", "started", sentAt - 20_000, sentAt + 20))
        cues.register("two", sentAt)
        assertFalse(cues.confirm("two", "started", sentAt + 30_000, sentAt + 20))
    }

    @Test fun pendingMetadataHasABoundAndAllCuesUseShortLowAmplitudes() {
        val cues = MessageStartFeedback()
        repeat(300) { cues.register("$it", sentAt + it) }
        assertEquals(256, cues.snapshot().size)
        for (cue in GentleCue.entries) {
            assertTrue(cue.durationMs in 1..20)
            assertTrue(cue.amplitude in 1..40)
        }
    }
}
