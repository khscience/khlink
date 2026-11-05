package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionLinkTest {
    private val id = "local_39fe6718-66e3-42e8-9f94-6181ef625230"

    @Test
    fun readsTheSessionFromDesktopLinks() {
        assertEquals(id, sessionLinkId("#$id"))
        assertEquals(id, sessionLinkId("claude://claude.ai/epitaxy/$id"))
        assertEquals(id, sessionLinkId(id))
        assertEquals(id, sessionLinkId("#" + id.uppercase().replace("LOCAL_", "local_")))
    }

    @Test
    fun leavesOtherLinksAlone() {
        assertNull(sessionLinkId("https://example.com/page"))
        assertNull(sessionLinkId("src/local_file.kt"))
        assertNull(sessionLinkId("#$id-extra"))
    }

    @Test
    fun findsTheConversationByItsIdOrTheDesktopId() {
        fun thread(threadId: String, desktopId: String = "") = ThreadSummary(threadId, "t", "", "idle", 0, false, "pc", backend = "claude", desktopId = desktopId)
        val desktopMade = thread(id)
        val phoneMade = thread("claude-abc", desktopId = "local_00000000-0000-0000-0000-000000000001")
        val threads = listOf(phoneMade, desktopMade)
        assertEquals(desktopMade, linkedThread(threads, id))
        assertEquals(phoneMade, linkedThread(threads, "local_00000000-0000-0000-0000-000000000001"))
        assertNull(linkedThread(threads, "local_00000000-0000-0000-0000-000000000002"))
    }
}
