package vip.fengzhu.bridge

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayDeletedThreadsTest {
    private fun thread(id: String, at: Long) = ThreadSummary(id, id, "", "idle", at, false, "c")

    @Test fun deletedConversationsLeaveThePhoneUnlessActiveSince() {
        val deleted = parseDeletedThreads(JSONArray("""[{"id":"old","deletedAt":1000},{"id":"back","deletedAt":1000},{"id":"","deletedAt":5}]"""))
        assertEquals(mapOf("old" to 1000L, "back" to 1000L), deleted)
        val threads = listOf(thread("old", 900), thread("back", 2000), thread("kept", 100))
        assertEquals(setOf("old"), threadsDeletedOnRelay(deleted, threads))
    }

    @Test fun anOlderRelayWithoutTheFieldRemovesNothing() {
        assertTrue(parseDeletedThreads(null).isEmpty())
        assertTrue(threadsDeletedOnRelay(emptyMap(), listOf(thread("a", 1))).isEmpty())
    }
}
