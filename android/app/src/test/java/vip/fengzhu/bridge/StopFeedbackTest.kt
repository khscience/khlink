package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class StopFeedbackTest {
    @Test fun clickHidesOnlyThatThreadsButtonUntilARealTerminalEvent() {
        val feedback = StopFeedback()
        assertTrue(feedback.begin("a", "req-1"))
        assertFalse(feedback.begin("a", "duplicate"))
        assertTrue(feedback.begin("b", "req-2"))
        assertEquals(setOf("a", "b"), feedback.stopping.value)
        assertFalse(feedback.terminal("a", "running", false))
        assertFalse(feedback.terminal("a", "completed", true))
        assertEquals(setOf("a", "b"), feedback.stopping.value)
        assertTrue(feedback.terminal("a", "interrupted", false))
        assertEquals(setOf("b"), feedback.stopping.value)
        assertEquals(setOf("a"), feedback.confirmed.value)
        assertFalse(feedback.terminal("a", "interrupted", false))
    }

    @Test fun failureRestoresButtonWithoutPretendingTheTurnStopped() {
        val feedback = StopFeedback()
        feedback.begin("a", "req-1")
        assertTrue(feedback.rejected("a", "req-1"))
        assertTrue(feedback.stopping.value.isEmpty())
        assertFalse(feedback.terminal("a", "cancelled", false))
        assertTrue(feedback.confirmed.value.isEmpty())
        feedback.begin("a", "req-2")
        assertFalse(feedback.terminal("a", "failed", false))
        assertTrue(feedback.stopping.value.isEmpty())
    }

    @Test fun timeoutAllowsRetryAndLateTerminalStillConfirmsExactlyOnce() {
        val feedback = StopFeedback()
        feedback.begin("a", "req-1")
        assertTrue(feedback.uncertain("a", "req-1"))
        assertTrue(feedback.stopping.value.isEmpty())
        assertTrue(feedback.begin("a", "req-2"))
        assertFalse(feedback.rejected("a", "req-1"))
        assertFalse(feedback.uncertain("a", "req-1"))
        assertEquals(setOf("a"), feedback.stopping.value)
        assertTrue(feedback.terminal("a", "completed", false))
        assertFalse(feedback.terminal("a", "cancelled", false))
        feedback.newTurn("a")
        assertTrue(feedback.confirmed.value.isEmpty())
        feedback.begin("a", "req-3")
        feedback.clear()
        assertTrue(feedback.stopping.value.isEmpty())
        assertFalse(feedback.terminal("a", "completed", false))
    }
}
