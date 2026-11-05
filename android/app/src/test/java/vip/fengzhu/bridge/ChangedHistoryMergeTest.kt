package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class ChangedHistoryMergeTest {
    private fun item(id: String, order: Long, text: String = id) = HistoryItem(id = id, order = order, type = "agentMessage", text = text, status = null, truncated = false)

    @Test
    fun newAndChangedItemsReplaceTheirCopies() {
        val shown = listOf(item("a", 1), item("b", 2, "running"))
        val merged = mergeChangedHistoryItems(shown, listOf(item("b", 2, "done"), item("c", 3)), emptySet())
        assertEquals(listOf("a" to "a", "b" to "done", "c" to "c"), merged.map { it.id to it.text })
    }

    @Test
    fun anItemReplacedAtItsPositionAndAHiddenOneGo() {
        val shown = listOf(item("a", 1), item("live", 2), item("x", 3))
        val merged = mergeChangedHistoryItems(shown, listOf(item("stored", 2)), setOf("x"))
        assertEquals(listOf("a", "stored"), merged.map { it.id })
    }
}
