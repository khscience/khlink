package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class AccountUsageSyncTest {
    private fun claude(id: String?, stamp: Long, observed: Long, state: String = "ready") =
        ClaudeUsage(ClaudeUsageWindow(20, resetsAt = observed + 1000, observedAt = observed),
            accountFingerprint = id, snapshotAt = stamp, accountState = state)

    @Test fun latePreviousAccountCannotReplaceCurrentAccountEvenWhenItsObservationIsNewer() {
        val b = claude("B", 200, 10)
        assertEquals(b, mergeClaudeUsage(b, claude("A", 100, 50)))
        assertEquals(b, mergeClaudeUsage(claude("A", 100, 50), b))
    }

    @Test fun switchingClearsOldWindowsAndLateSwitchingCannotClearTheNewAccount() {
        val a = claude("A", 100, 50)
        val changing = ClaudeUsage(snapshotAt = 150, accountState = "switching")
        val cleared = mergeClaudeUsage(a, changing)
        assertNull(cleared.fiveHour.remainingPercent)
        assertEquals("正在切换账号", cleared.freshnessLabel())
        val b = claude("B", 200, 10)
        assertEquals(b, mergeClaudeUsage(cleared, b))
        assertEquals(b, mergeClaudeUsage(b, changing))
    }

    @Test fun unknownAccountClearsQuotaAndUnstampedReplayCannotRestoreIt() {
        val empty = ClaudeUsage(snapshotAt = 200, accountState = "unavailable")
        assertEquals(empty, mergeClaudeUsage(claude("A", 100, 50), empty))
        assertEquals(empty, mergeClaudeUsage(empty, claude("A", 0, 70)))
    }

    @Test fun codexSwitchReplacesBothQuotaAndResetAndRetainsModels() {
        val a = CapabilityState(models = listOf("model"), weeklyRemainingPercent = 89, weeklyResetAt = 10, quotaSnapshotAt = 100, quotaAccountFingerprint = "A")
        val b = a.withCodexQuota(CodexQuotaUpdate(QuotaSnapshot(95, 20), 200, "B", "ready"))
        assertEquals(95, b.weeklyRemainingPercent); assertEquals(20L, b.weeklyResetAt)
        assertEquals(a.models, b.models)
        assertEquals(b, b.withCodexQuota(CodexQuotaUpdate(QuotaSnapshot(89, 10), 100, "A")))
    }

    @Test fun codexLogoutFailureAndNoWindowAllClearPreviousQuota() {
        val a = CapabilityState(weeklyRemainingPercent = 89, weeklyResetAt = 10, quotaSnapshotAt = 100)
        for (state in listOf("signed_out", "unavailable", "ready")) {
            val cleared = a.withCodexQuota(CodexQuotaUpdate(null, 200, accountState = state))
            assertNull(cleared.weeklyRemainingPercent); assertNull(cleared.weeklyResetAt)
            assertEquals("unavailable", cleared.quotaState)
            assertEquals(cleared, cleared.withCodexQuota(CodexQuotaUpdate(QuotaSnapshot(89, 10))))
        }
    }
}
