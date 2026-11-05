package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadReadStateTest {
    @Test
    fun sourceUnreadWithoutWatermarkShowsBadge() {
        assertTrue(effectiveUnread(sourceUnread = true, updatedAt = 200, readAt = 0))
    }

    @Test
    fun openingCurrentRevisionClearsBadge() {
        assertFalse(effectiveUnread(sourceUnread = true, updatedAt = 200, readAt = 200))
    }

    @Test
    fun newerRevisionShowsBadgeAgain() {
        assertTrue(effectiveUnread(sourceUnread = true, updatedAt = 201, readAt = 200))
    }

    @Test
    fun desktopReadStateAlwaysWins() {
        assertFalse(effectiveUnread(sourceUnread = false, updatedAt = 300, readAt = 0))
    }

    @Test
    fun markAllClearsEveryLocalBadge() {
        val items = listOf(
            ThreadSummary("one", "One", "", "completed", 1, false, "desktop", unread = true),
            ThreadSummary("two", "Two", "", "completed", 2, false, "desktop", unread = true),
        )
        assertTrue(withAllThreadsRead(items).none { it.unread })
    }
}
