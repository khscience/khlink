package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadOrderingTest {
    @Test
    fun unknownExecutionNeverAppearsAsFinishedOrGetsAFinishedHighlight() {
        val now = 1_800_000_000_000L
        val unseen = thread("uncertain", now - 1000, unread = true).copy(phoneReadAt = now - 2000)
        for (status in listOf("unknown", "unknown_queued", "STATUS_UNKNOWN")) {
            assertTrue(isUnknownThreadStatus(status))
            assertFalse(isCompletedThreadStatus(status))
            assertFalse(isFinishedUnseen(unseen, status, now))
            assertFalse(isFinishedHighlight(unseen, status, now))
        }
        assertTrue(isCompletedThreadStatus("completed"))
        assertFalse(isUnknownThreadStatus("queued"))
    }

    @Test
    fun desktopSnapshotClearsStalePinsAndOverridesOldHistoryWithoutTouchingOtherBackends() {
        val rows = listOf(
            thread("stale", 1, pinned = true, pinOrder = 0),
            thread("first", 2),
            thread("second", 3),
            thread("claude", 4, pinned = true).copy(backend = "claude"),
            thread("other-computer", 5, pinned = true).copy(connectorId = "other"),
        )
        val snapshots = mapOf("desktop" to listOf("second", "first"))
        val corrected = withDesktopCodexPins(rows, snapshots)
        assertEquals(false, corrected[0].pinned)
        assertEquals(1, corrected[1].pinOrder)
        assertEquals(0, corrected[2].pinOrder)
        assertEquals(rows[3], corrected[3])
        assertEquals(rows[4], corrected[4])
        assertEquals(corrected, withDesktopCodexPins(rows, snapshots))
        assertEquals(rows, withDesktopCodexPins(rows, emptyMap()))
        assertEquals(false, withDesktopCodexPins(corrected, mapOf("desktop" to emptyList()))[1].pinned)
    }

    @Test
    fun codexPinnedSectionKeepsDesktopMembershipAcrossActivityChanges() {
        val rows = listOf(
            thread("running-pin", 30, pinned = true, pinOrder = 1, status = "desktop_running"),
            thread("completed-pin", 20, pinned = true, pinOrder = 0, unread = true),
            thread("recent-unpinned", 40),
        )
        val recentIds = setOf("running-pin", "completed-pin", "recent-unpinned")
        assertEquals(listOf("completed-pin", "running-pin"), homePinnedThreads(rows, recentIds, "codex").map { it.id })
        assertEquals(listOf("completed-pin", "running-pin"), homePinnedThreads(rows, emptySet(), "codex").map { it.id })
        assertEquals(listOf("completed-pin", "running-pin"), homePinnedThreads(rows, recentIds, "claude").map { it.id })
        assertEquals(emptyList<String>(), homePinnedThreads(rows, recentIds, "pi").map { it.id })
        assertEquals(listOf("running-pin"), homePinnedThreads(rows.map {
            if (it.id == "completed-pin") it.copy(pinned = false, pinOrder = -1) else it
        }, recentIds, "codex").map { it.id })
    }

    @Test
    fun usageResetLabelsSayWhenTheyAreEstimatesAndNeverWaitForever() {
        val now = 1_790_772_654_000L
        assertEquals("约1小时30分后重置", fiveHourResetLabel(now + 90 * 60_000L, now, 70, estimated = true))
        assertEquals("1小时30分后重置", fiveHourResetLabel(now + 90 * 60_000L, now, 70))
        assertEquals("重置时间未知", fiveHourResetLabel(null, now, 70))
        assertEquals("未开始计时", fiveHourResetLabel(null, now, 100))
        assertEquals("已重置", fiveHourResetLabel(now - 1, now, 70))
        assertEquals("重置时间未知", weeklyResetLabel(null, now))
        assertEquals("约2天3小时后重置", weeklyResetLabel(now + (51 * 3600_000L) + 60_000L, now, estimated = true))
    }

    @Test
    fun aCachedQuotaPastItsResetIsAFreshWindow() {
        val now = 1_790_772_654_000L
        assertEquals(QuotaSnapshot(100, null), QuotaSnapshot(4, now - 1).current(now))
        assertEquals(QuotaSnapshot(64, now + 1), QuotaSnapshot(64, now + 1).current(now))
        assertEquals(QuotaSnapshot(64, null), QuotaSnapshot(64, null).current(now))
    }

    @Test
    fun replayedStatusEventsFromLongAgoAreStale() {
        val now = 1_790_772_654_000L
        assertTrue(isStaleStatusEvent(now - 3L * 24 * 3600 * 1000, now))
        assertTrue(isStaleStatusEvent(now - STALE_STATUS_EVENT_MS - 1, now))
        assertFalse(isStaleStatusEvent(now - 10_000, now))
        assertFalse("computer clock ahead of the phone", isStaleStatusEvent(now + 6_000, now))
        assertFalse("unknown time", isStaleStatusEvent(0, now))
    }

    @Test
    fun claudeDesktopSnapshotSetsOrderAndDropsDeletedPinsWithoutTouchingCodex() {
        val rows = listOf(
            thread("deleted", 1, pinned = true, pinOrder = 8).copy(backend = "claude"),
            thread("c-01", 2, pinned = true, pinOrder = 21).copy(backend = "claude"),
            thread("c-12", 3, pinned = true, pinOrder = 28).copy(backend = "claude"),
            thread("codex", 4, pinned = true, pinOrder = 0),
        )
        val corrected = withDesktopPins(rows, mapOf("desktop" to listOf("c-12", "c-01")), "claude")
        assertEquals(false, corrected[0].pinned)
        assertEquals(-1, corrected[0].pinOrder)
        assertEquals(listOf("c-12", "c-01"), sortPinnedThreadSummaries(corrected.filter { it.backend == "claude" }).map { it.id })
        assertEquals(rows[3], corrected[3])
    }

    @Test
    fun pinnedTasksFollowDesktopOrderThenRecentTasksAreNewestFirst() {
        val rows = listOf(
            thread("recent-old", 10),
            thread("pin-second", 1, pinned = true, pinOrder = 1),
            thread("recent-new", 20),
            thread("pin-first", 2, pinned = true, pinOrder = 0),
        )
        assertEquals(
            listOf("pin-first", "pin-second", "recent-new", "recent-old"),
            sortThreadSummaries(rows).map { it.id },
        )
    }

    @Test
    fun pinnedTasksWithMissingOrdinalDoNotJumpAheadOfDesktopOrderedPins() {
        val rows = listOf(
            thread("pin-missing", 100, pinned = true, pinOrder = -1),
            thread("pin-second", 1, pinned = true, pinOrder = 1),
            thread("pin-first", 2, pinned = true, pinOrder = 0),
        )
        assertEquals(
            listOf("pin-first", "pin-second", "pin-missing"),
            sortPinnedThreadSummaries(rows).map { it.id },
        )
    }

    @Test
    fun recentHighlightsPrioritizeUnreadCompletedThenRunningAndCanRepeatPinnedTasks() {
        val rows = listOf(
            thread("read-completed", 100),
            thread("unread-old", 200, unread = true, status = "idle"),
            thread("unread-new-pinned", 400, pinned = true, pinOrder = 0, unread = true),
            thread("13-running-new", 500, status = "desktop_running"),
            thread("8-running-old-pinned", 300, pinned = true, pinOrder = 1, status = "mobile_running"),
        )

        assertEquals(
            listOf("unread-new-pinned", "unread-old", "8-running-old-pinned", "13-running-new"),
            recentThreadHighlights(rows, 600L).map { it.id },
        )
    }

    @org.junit.Test
    fun waitingSessionsLeadTheRecentSection() {
        val rows = listOf(
            thread("done-unread", 30, unread = true),
            thread("running", 20, status = "desktop_running"),
            thread("waiting-old", 10, status = "desktop_waiting"),
            thread("waiting-new", 40, status = "desktop_waiting"),
            thread("idle", 50),
            thread("queued", 60, status = "desktop_queued"),
        )
        assertEquals(listOf("waiting-new", "waiting-old", "done-unread", "running"), recentThreadHighlights(rows, 600L).map { it.id })
    }

    @Test
    fun finishedSessionsNotYetOpenedOnThePhoneStayInRecent() {
        val now = 1_800_000_000_000L
        val hour = 60 * 60 * 1000L
        val rows = listOf(
            thread("finished-unseen", now - hour).copy(phoneReadAt = now - 2 * hour),
            thread("finished-seen", now - hour).copy(phoneReadAt = now - hour),
            thread("finished-long-ago", now - 20 * hour),
            thread("running-unseen", now - hour, status = "desktop_running"),
        )
        assertEquals(listOf("finished-unseen", "running-unseen"), recentThreadHighlights(rows, now).map { it.id })
        assertEquals(true, isFinishedUnseen(rows[0], "completed", now))
        assertEquals(false, isFinishedUnseen(rows[3], "desktop_running", now))
    }

    @Test
    fun oldUnreadCodexTasksDoNotReappearInRecent() {
        val now = 1_800_000_000_000L
        val rows = listOf(
            thread("old-unread", now - 3 * FINISHED_HIGHLIGHT_MS, unread = true),
            thread("recent-unread", now - 1000, unread = true),
            thread("future", now + 1000, unread = true),
            thread("running", now - 3 * FINISHED_HIGHLIGHT_MS, status = "desktop_running"),
        )
        assertEquals(listOf("recent-unread", "running"), recentThreadHighlights(rows, now).map { it.id })
        listOf("antigravity", "claude", "pi").forEach { backend ->
            assertEquals(listOf("recent-unread", "running"), recentThreadHighlights(rows.map { it.copy(backend = backend) }, now).map { it.id })
        }
    }

    @Test
    fun verifiedActivityRepairsInflatedLegacyTimeButPreservesNewerChatEvents() {
        val legacy = thread("old", 1000)
        val fresh = thread("old", 100).copy(activityAt = 100)
        assertEquals(100L, mergeThreadActivityAt(fresh, legacy))
        assertEquals(200L, mergeThreadActivityAt(fresh, legacy.copy(updatedAt = 200, activityAt = 200)))
        assertEquals(1000L, mergeThreadActivityAt(fresh.copy(activityAt = null), legacy))
    }

    private fun thread(
        id: String,
        updatedAt: Long,
        pinned: Boolean = false,
        pinOrder: Int = -1,
        unread: Boolean = false,
        status: String = "completed",
    ) = ThreadSummary(id, id, "", status, updatedAt, false, "desktop", pinned, pinOrder, unread, phoneReadAt = updatedAt)
}
