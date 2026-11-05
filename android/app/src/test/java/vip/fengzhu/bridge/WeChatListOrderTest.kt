package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WeChatListOrderTest {
    private fun t(id: String, at: Long, pinned: Boolean = false, unread: Boolean = false, status: String = "completed") =
        ThreadSummary(id, id, "", status, at, unread, "c", pinned = pinned)

    @Test fun whatIsGoingOnLeadsTheWholeListThenPinsThenTheRest() {
        val oldPin = t("oldPin", 100, pinned = true)
        val newPin = t("newPin", 500, pinned = true)
        val runningPin = t("runningPin", 50, pinned = true)
        val chat = t("chat", 900)
        val older = t("older", 200)
        val waiting = t("waiting", 10)
        val order = wechatListOrder(listOf(oldPin, newPin, runningPin, chat, older, waiting), listOf(waiting, runningPin))
        assertEquals(listOf("waiting", "runningPin", "newPin", "oldPin", "chat", "older"), order.map { it.id })
    }

    @Test fun pinsFollowTheDesktopSidebarOrderBelowWhatIsGoingOn() {
        val first = t("01", 100, pinned = true).copy(pinOrder = 0)
        val second = t("02", 50, pinned = true).copy(pinOrder = 1)
        val third = t("21", 900, pinned = true, status = "running").copy(pinOrder = 2)
        val fourth = t("24", 10, pinned = true).copy(pinOrder = 3)
        val noOrder = t("noOrder", 999, pinned = true)
        val doneUnseen = t("done", 800)
        val order = wechatListOrder(listOf(third, noOrder, fourth, second, doneUnseen, first), listOf(doneUnseen, third))
        assertEquals(listOf("done", "21", "01", "02", "24", "noOrder"), order.map { it.id })
    }

    @Test fun aGreenDotIsExactlyAFinishedRowThatLeadsTheList() {
        val now = 10 * FINISHED_HIGHLIGHT_MS
        val fresh = t("fresh", now - 60_000, unread = true)
        val old = t("old", now - FINISHED_HIGHLIGHT_MS - 1, unread = true)
        assertTrue(isFinishedHighlight(fresh, "completed", now))
        assertFalse(isFinishedHighlight(old, "completed", now))
        assertEquals(listOf("fresh"), recentThreadHighlights(listOf(fresh, old), now).map { it.id })
    }

    @Test fun redDotOnlyForWhatChangedLatelyAndIsNotWaitingOrRunning() {
        val now = 10 * RED_DOT_MS
        assertTrue(wantsRedDot(t("fresh", now - 60_000, unread = true), "completed", now))
        assertFalse(wantsRedDot(t("old", now - RED_DOT_MS - 1, unread = true), "completed", now))
        assertFalse(wantsRedDot(t("read", now - 60_000).copy(phoneReadAt = now), "completed", now))
        assertFalse(wantsRedDot(t("running", now - 60_000, unread = true), "running", now))
    }
}
