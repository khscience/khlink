package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HistoryTimestampTest {
    @Test
    fun prefersServerCreatedAt() {
        val item = HistoryItem("id", 1_700_000_000_000_001L, "userMessage", "hello", null, false, createdAt = 1_700_000_123_000L)
        assertEquals(1_700_000_123_000L, historyItemTimestamp(item))
    }

    @Test
    fun cachedRowsRecoverTimestampFromOrder() {
        val item = HistoryItem("id", 1_700_000_000_000_001L, "agentMessage", "reply", null, false)
        assertEquals(1_700_000_000_000L, historyItemTimestamp(item))
    }

    @Test
    fun syntheticTestOrdersDoNotRenderAsDates() {
        val item = HistoryItem("id", 42L, "agentMessage", "reply", null, false)
        assertNull(historyItemTimestamp(item))
    }
}
