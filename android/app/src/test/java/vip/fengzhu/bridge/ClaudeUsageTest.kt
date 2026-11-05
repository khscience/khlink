package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClaudeUsageTest {
    private val at = 1_791_417_600_000L

    @Test fun freshUsageShowsTheSourceTimeAndRemainingShare() {
        val usage = ClaudeUsage(ClaudeUsageWindow(96, observedAt = at), ClaudeUsageWindow(2, observedAt = at))
        assertTrue(usage.freshnessLabel(at + 5 * 60_000).matches(Regex("5 分钟前更新（\\d{2}:\\d{2}）")))
        assertEquals("剩余 96%", usage.fiveHour.remainingLabel(at + 5 * 60_000))
    }

    @Test fun expiryWorksWithoutAnotherConnectorUpdate() {
        val window = ClaudeUsageWindow(96, observedAt = at)
        val expired = window.displayAt(at + 31 * 60_000)
        assertNull(expired.remainingPercent)
        assertEquals(96, expired.lastKnownRemainingPercent)
        assertEquals("历史剩余 96%", window.remainingLabel(at + 31 * 60_000))
        assertTrue(ClaudeUsage(window, window).freshnessLabel(at + 31 * 60_000).contains("已过期"))
    }

    @Test fun oldConnectorUpperBoundsAreHistoricalInBothScreens() {
        val window = ClaudeUsageWindow(2, observedAt = at, stale = true, atMost = true)
        assertEquals("历史剩余 2%", window.remainingLabel(at + 40 * 60_000))
        assertNull(window.displayAt(at + 40 * 60_000).remainingPercent)
    }

    @Test fun resetWithoutNewObservationDoesNotMean100PercentAvailable() {
        val window = ClaudeUsageWindow(20, resetsAt = at + 10 * 60_000, observedAt = at)
        val expired = window.displayAt(at + 11 * 60_000)
        assertNull(expired.remainingPercent)
        assertNull(expired.resetsAt)
        assertEquals("历史剩余 20%", expired.remainingLabel(at + 11 * 60_000))
    }

    @Test fun aNewWeeklyValueCannotMakeFiveHourDataLookFresh() {
        val usage = ClaudeUsage(ClaudeUsageWindow(50, observedAt = at), ClaudeUsageWindow(2, observedAt = at + 60 * 60_000))
        assertNull(usage.displayAt(at + 60 * 60_000).fiveHour.remainingPercent)
        assertEquals(2, usage.displayAt(at + 60 * 60_000).sevenDay.remainingPercent)
        assertTrue(usage.freshnessLabel(at + 60 * 60_000).contains("已过期"))
    }

    @Test fun missingOrFutureObservationIsNotCurrentQuota() {
        assertEquals("暂时无法获取", ClaudeUsage().freshnessLabel(at))
        assertNull(ClaudeUsageWindow(96).displayAt(at).remainingPercent)
        assertNull(ClaudeUsageWindow(96, observedAt = at + 6 * 60_000).displayAt(at).remainingPercent)
        val partial = ClaudeUsage(sevenDay = ClaudeUsageWindow(2, observedAt = at))
        assertTrue(partial.freshnessLabel(at).contains("部分额度暂时无法获取"))
    }

    @Test fun oldDataIncludesTheDateAndRefreshExplainsHowToRecover() {
        val usage = ClaudeUsage(ClaudeUsageWindow(null, observedAt = at, stale = true, lastKnownRemainingPercent = 96),
            refreshResultAt = at + 25 * 60 * 60_000, refreshUnavailableReason = "desktop_refresh_required")
        assertTrue(usage.freshnessLabel(at + 25 * 60 * 60_000).matches(Regex("\\d{2}-\\d{2} \\d{2}:\\d{2} 更新（已过期）")))
        assertTrue(usage.refreshHelp(at + 25 * 60 * 60_000).contains("系统托盘"))
        assertEquals(0L, usage.updatedAt)
        assertEquals(at + 25 * 60 * 60_000, usage.refreshResultAt)
    }

    @Test fun freshQuotaReturnsAfterTheDesktopPublishesANewObservation() {
        val before = ClaudeUsageWindow(100, observedAt = at).displayAt(at + 60 * 60_000)
        assertNull(before.remainingPercent)
        val after = ClaudeUsageWindow(96, observedAt = at + 60 * 60_000).displayAt(at + 60 * 60_000)
        assertEquals("剩余 96%", after.remainingLabel(at + 60 * 60_000))
        assertNull(after.lastKnownRemainingPercent)
    }

    @Test fun lateFramesCannotOverwriteNewerQuotaOrRefreshResults() {
        val current = ClaudeUsage(ClaudeUsageWindow(90, observedAt = at + 60_000), ClaudeUsageWindow(2, observedAt = at),
            refreshResultAt = 200, refreshUnavailableReason = "desktop_refresh_required", accountFingerprint = "one")
        val late = ClaudeUsage(ClaudeUsageWindow(100, observedAt = at), ClaudeUsageWindow(1, observedAt = at + 120_000),
            refreshResultAt = 100, accountFingerprint = "one")
        val merged = mergeClaudeUsage(current, late)
        assertEquals(90, merged.fiveHour.remainingPercent)
        assertEquals(1, merged.sevenDay.remainingPercent)
        assertEquals(200L, merged.refreshResultAt)
        assertEquals("desktop_refresh_required", merged.refreshUnavailableReason)
    }

    @Test fun switchingAccountsCannotCarryThePreviousAccountsQuota() {
        val before = ClaudeUsage(ClaudeUsageWindow(90, observedAt = at + 60_000), accountFingerprint = "one")
        val next = ClaudeUsage(ClaudeUsageWindow(40, observedAt = at), accountFingerprint = "two")
        assertEquals(next, mergeClaudeUsage(before, next))
        assertEquals(ClaudeUsage(), mergeClaudeUsage(before, ClaudeUsage()))
    }

    @Test fun officialCacheReplacesOldHistoryWithBothExactResets() {
        val history = ClaudeUsage(ClaudeUsageWindow(null, observedAt = at - 3_600_000, stale = true, lastKnownRemainingPercent = 100),
            ClaudeUsageWindow(null, observedAt = at - 3_600_000, stale = true, lastKnownRemainingPercent = 100), accountFingerprint = "same-account")
        val official = ClaudeUsage(ClaudeUsageWindow(69, resetsAt = at + 4 * 3_600_000, observedAt = at),
            ClaudeUsageWindow(95, resetsAt = at + 6 * 86_400_000, observedAt = at), accountFingerprint = "same-account")
        val merged = mergeClaudeUsage(history, official).displayAt(at)
        assertEquals("剩余 69%", merged.fiveHour.remainingLabel(at))
        assertEquals("剩余 95%", merged.sevenDay.remainingLabel(at))
        assertEquals("4小时0分后重置", fiveHourResetLabel(merged.fiveHour.resetsAt, at, 69, merged.fiveHour.resetEstimated))
        assertEquals(at + 6 * 86_400_000, merged.sevenDay.resetsAt)
        assertEquals(merged, mergeClaudeUsage(merged, history))
    }

    @Test fun switchingToAnOlderObservedAccountStillReplacesBothWindowsAndResets() {
        val first = ClaudeUsage(ClaudeUsageWindow(69, resetsAt = at + 3_600_000, observedAt = at),
            ClaudeUsageWindow(95, observedAt = at), accountFingerprint = "first")
        val second = ClaudeUsage(ClaudeUsageWindow(20, resetsAt = at + 7_200_000, observedAt = at - 60_000),
            ClaudeUsageWindow(30, resetsAt = at + 86_400_000, observedAt = at - 60_000), accountFingerprint = "second")
        assertEquals(second, mergeClaudeUsage(first, second))
        assertEquals("剩余 20%", mergeClaudeUsage(first, second).fiveHour.remainingLabel(at))
    }

    @Test fun ageReadsAsMinutesHoursOrADate() {
        val utc = java.util.TimeZone.getTimeZone("UTC")
        assertEquals("刚刚更新（00:00）", quotaAgeLabel(at, at + 30_000, utc))
        assertEquals("12 分钟前更新（00:00）", quotaAgeLabel(at, at + 12 * 60_000, utc))
        assertEquals("3 小时前更新（00:00）", quotaAgeLabel(at, at + 3 * 60 * 60_000 + 59_000, utc))
        assertTrue(quotaAgeLabel(at, at + 30 * 60 * 60_000, utc).matches(Regex("\\d{2}-\\d{2} 00:00 更新")))
    }

    @Test fun anExpiredRecentFigureSaysSoInsideTheSameBracket() {
        val usage = ClaudeUsage(ClaudeUsageWindow(74, observedAt = at), ClaudeUsageWindow(19, observedAt = at))
        assertTrue(usage.freshnessLabel(at + 70 * 60_000).matches(Regex("1 小时前更新（\\d{2}:\\d{2}，已过期）")))
    }
}
