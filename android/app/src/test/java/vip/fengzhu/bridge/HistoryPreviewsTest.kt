package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class HistoryPreviewsTest {
    private fun key(id: String, pc: String = "work", updated: Long = 1) = HistoryPreviewKey(id, pc, updated)
    private fun item(i: Int) = HistoryItem("m$i", i.toLong(), "agentMessage", "answer $i", null, false)

    @Test fun visibleRowsSkipHeadersResolveSectionKeysAndDeduplicate() {
        val keys = listOf("a", "b", "c", "d", "e", "recent-a").associateWith { key(it) }
        assertEquals(listOf("recent-a", "b", "a", "c"),
            visibleHistoryPreviews(listOf(0, "pinned-sort-hint", "recent-a", "archived-b", "a", "b", "c", "d"), keys).map { it.threadId })
    }

    @Test fun legacySummariesFollowTheSelectedComputer() {
        val thread = ThreadSummary("a", "chat", "", "idle", 1L, false, "")
        assertNotEquals(thread.historyPreviewKey("laptop"), thread.historyPreviewKey("desktop"))
        val owned = thread.copy(connectorId = "work")
        assertEquals(owned.historyPreviewKey("laptop"), owned.historyPreviewKey("desktop"))
    }

    @Test fun memoryIsBoundedAndRequiresTheSameComputerAndRevision() {
        val previews = HistoryPreviews()
        val rows = (1..40).map(::item)
        previews.put(key("a"), rows)
        assertEquals(rows.takeLast(24), previews.get(key("a")))
        assertNull(previews.get(key("a", pc = "home")))
        assertNull(previews.get(key("a", updated = 2)))
        for (id in listOf("b", "c", "d", "e")) previews.put(key(id), rows)
        assertNull(previews.get(key("a")))
        previews.put(key("b"), emptyList())
        assertNull(previews.get(key("b")))
        previews.remove(key("c"))
        assertNull(previews.get(key("c")))
        previews.clear()
        assertNull(previews.get(key("d")))
    }

    @Test fun coldRequestsBoundDownloadsWhenChangingTabsOrScrolling() {
        val previews = HistoryPreviews()
        assertTrue(previews.reserveMissing("a", 10))
        assertFalse(previews.reserveMissing("a", 11))
        for (id in listOf("b","c","d")) assertTrue(previews.reserveMissing(id, 15))
        assertFalse(previews.reserveMissing("e", 60_009))
        assertTrue(previews.reserveMissing("e", 60_010))
        assertFalse(previews.reserveMissing("a", 60_010))
        previews.clear()
        assertTrue(previews.reserveMissing("a", 60_010))
    }
}
