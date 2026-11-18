package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinnedCompletionSortTest {
    private fun row(id: String, order: Int, pinned: Boolean = true, status: String = "completed") =
        ThreadSummary(id, id, "", status, 99_000L, false, "pc", pinned = pinned, pinOrder = order)

    @Test fun onlyProvenTerminalsUpdateTheCompletionTime() {
        assertTrue(isConfirmedCompletionForSort("completed", false, 123, "turn", false))
        assertTrue(isConfirmedCompletionForSort("completed", false, 123, null, true))
        assertFalse(isConfirmedCompletionForSort("completed", true, 123, "turn", true))
        assertFalse(isConfirmedCompletionForSort("completed", false, 123, null, false))
        assertFalse(isConfirmedCompletionForSort("completed", false, 0, "turn", true))
        assertFalse(isConfirmedCompletionForSort("running", false, 123, "turn", true))
    }

    @Test fun replayingTheSameCompletedTurnCannotMoveItToTheFront() {
        assertFalse(isNewCompletionForSort(200, "turn-a", 100, "turn-a"))
        assertFalse(isNewCompletionForSort(90, "turn-b", 100, "turn-a"))
        assertTrue(isNewCompletionForSort(200, "turn-b", 100, "turn-a"))
        assertTrue(isNewCompletionForSort(200, null, 100, "turn-a"))
    }

    @Test fun completionSortUsesEndTimeAndKeepsTiesAndUnknownsInDesktopOrder() {
        val rows = listOf(row("old", 0), row("new", 1, status = "running"), row("tie", 2), row("unknown", 3))
        val desktop = sortPinnedThreadSummaries(rows)
        val sorted = sortPinsByCompletion(desktop, mapOf("old" to 100L, "new" to 200L, "tie" to 200L, "unknown" to -1L))
        assertEquals(listOf("new", "tie", "old", "unknown"), sorted.map { it.id })
        assertEquals(listOf("old", "new", "tie", "unknown"), sortPinnedThreadSummaries(rows).map { it.id })
    }

    @Test fun actualHistoryAndLiveCompletionAreMergedWithoutUsingActivityTime() {
        val counts = ConversationTokenCounts(1, 1, 2)
        val finished = CompletedTurnTokenUsage("t", 10, 50, 40, null, counts)
        val usage = mapOf("a" to ConversationTokenUsage("codex", "ready", completedTurns = listOf(finished)))
        assertEquals(mapOf("a" to 50L, "b" to 70L), knownCompletionTimes(mapOf("a" to 20L, "b" to 70L, "bad" to 0L), usage))
        assertEquals(mapOf("a" to 80L), knownCompletionTimes(mapOf("a" to 80L), usage))
    }

    @Test fun chatLayoutKeepsPinnedAndUnpinnedHighlightsAboveSortedPins() {
        val a = row("a", 0)
        val b = row("b", 1, status = "running")
        val other = row("other", 0, pinned = false)
        val rest = row("rest", 0, pinned = false)
        val rows = listOf(a, b, other, rest)
        val highlights = listOf(other, b)
        assertEquals(listOf("other", "b", "a", "rest"), wechatListOrder(rows, highlights).map { it.id })
        assertEquals(listOf("other", "b", "a", "rest"), wechatListOrderByCompletion(rows, highlights, mapOf("a" to 20L, "b" to 10L)).map { it.id })
        assertEquals(listOf("other", "b", "a", "rest"), wechatListOrder(rows, highlights).map { it.id })
    }

    @Test fun completionSortPreservesAllAttentionStatesAndSortsOnlyTheOtherPins() {
        val waiting = row("waiting", 4, status = "waiting")
        val unread = row("unread", 5, status = "completed")
        val running = row("running", 6, status = "running")
        val unpinnedRunning = row("unpinned-running", 0, pinned = false, status = "running")
        val old = row("old", 0)
        val new = row("new", 1)
        val tied = row("tied", 2)
        val unknown = row("unknown", 3)
        val restOld = row("rest-old", 0, pinned = false).copy(updatedAt = 10L)
        val restNew = row("rest-new", 0, pinned = false).copy(updatedAt = 20L)
        val rows = listOf(old, new, tied, unknown, waiting, unread, running, restOld, restNew, unpinnedRunning)
        val highlights = listOf(waiting, unread, running, unpinnedRunning)
        val completions = mapOf("old" to 100L, "new" to 200L, "tied" to 200L, "unread" to 1L, "running" to 1L)

        assertEquals(
            listOf("waiting", "unread", "running", "unpinned-running", "new", "tied", "old", "unknown", "rest-new", "rest-old"),
            wechatListOrderByCompletion(rows, highlights, completions).map { it.id },
        )
        assertEquals(
            listOf("waiting", "unread", "running", "unpinned-running", "old", "new", "tied", "unknown", "rest-new", "rest-old"),
            wechatListOrder(rows, highlights).map { it.id },
        )
    }

    @Test fun completionSortIgnoresOtherTabsAndDoesNotDuplicateHighlights() {
        val pin = row("pin", 0)
        val running = row("running", 0, pinned = false, status = "running")
        val absent = row("absent", 2)
        assertEquals(
            listOf("running", "pin"),
            wechatListOrderByCompletion(listOf(pin, running), listOf(absent, running, running), emptyMap()).map { it.id },
        )
    }
}
