package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class PrefetchCandidatesTest {
    private fun thread(id: String, updatedAt: Long, archived: Boolean = false) =
        ThreadSummary(id = id, title = id, cwd = "", status = "completed", updatedAt = updatedAt, archived = archived, connectorId = "pc")

    @Test
    fun newestActiveConversationsWithNewActivityComeFirst() {
        val threads = listOf(thread("old", 100), thread("new", 500), thread("mid", 300), thread("archived", 900, archived = true))
        val prefetched = mapOf("mid" to 300L)
        assertEquals(listOf("new"), prefetchCandidates(threads, activeId = null, prefetchedAt = { prefetched[it] ?: 0L }, limit = 2))
        assertEquals(listOf("new", "old"), prefetchCandidates(threads, activeId = null, prefetchedAt = { prefetched[it] ?: 0L }, limit = 8))
    }

    @Test
    fun theOpenConversationIsNeverPrefetched() {
        val threads = listOf(thread("open", 500), thread("other", 400))
        assertEquals(listOf("other"), prefetchCandidates(threads, activeId = "open", prefetchedAt = { 0L }, limit = 8))
    }

    @Test
    fun onlyTheMostRecentConversationsAreConsidered() {
        val threads = (1..20).map { thread("t$it", it * 10L) }
        val ids = prefetchCandidates(threads, activeId = null, prefetchedAt = { 0L }, limit = 8)
        assertEquals((20 downTo 13).map { "t$it" }, ids)
    }
}
