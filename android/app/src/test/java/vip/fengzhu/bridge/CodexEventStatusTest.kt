package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CodexEventStatusTest {
    @Test fun interruptedCompletionKeepsTheStopStatus() {
        assertEquals("cancelled", codexEventStatus("turn/completed", "interrupted"))
    }
    @Test fun failedCompletionDoesNotBecomeSuccessful() {
        assertEquals("failed", codexEventStatus("turn/completed", "failed"))
    }
    @Test fun normalAndLegacyCompletionRemainSuccessful() {
        assertEquals("completed", codexEventStatus("turn/completed", "completed"))
        assertEquals("completed", codexEventStatus("turn/completed"))
    }
    @Test fun newTurnAndUnrelatedEventsHaveTheirOwnMeaning() {
        assertEquals("mobile_running", codexEventStatus("turn/started", "inProgress"))
        assertNull(codexEventStatus("item/completed", "interrupted"))
    }
}
