package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopPromptAnsweredTest {
    @Test
    fun answeredPromptStaysClosedUntilANewQuestion() {
        assertTrue(desktopPromptAnswered("req-1", "req-1"))
        assertTrue(desktopPromptAnswered("req-1", null))
        assertFalse(desktopPromptAnswered("req-1", "req-2"))
        assertFalse(desktopPromptAnswered(null, "req-1"))
    }
}
