package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class AgentAccountsTest {
    @Test fun claudeRequiresOneLocalDecision() {
        assertTrue(ClaudeConsent.fromStored(null).promptOnFirstUse)
        assertFalse(ClaudeConsent.fromStored(null).enabled)
        assertTrue(ClaudeConsent.fromStored("enabled").enabled)
        assertFalse(ClaudeConsent.fromStored("enabled").promptOnFirstUse)
        assertFalse(ClaudeConsent.fromStored("disabled").promptOnFirstUse)
        assertFalse(ClaudeConsent.fromStored("disabled").enabled)
    }
    @Test fun olderAccountSnapshotCannotUndoSwitchOrReuseQuota() {
        val id = "a".repeat(32)
        val old = parseAgentAccounts(JSONObject("""{"backend":"claude","snapshotAt":10,"configured":true,"profiles":[{"id":"$id","name":"账号","active":true,"quota":{"fiveHour":{"remaining":42,"observedAt":9}}}]}"""))!!
        val next = old.copy(snapshotAt = 20, switching = true, profiles = emptyList())
        assertEquals(next, mergeAgentAccounts(next, old))
        assertEquals(42.0, old.active!!.fiveHour!!.remaining, 0.0)
    }
    @Test fun codexCannotAdvertiseSwitchOrInventFiveHourWindow() {
        val state = parseAgentAccounts(JSONObject("""{"backend":"codex","snapshotAt":10,"readonly":false,"profiles":[{"id":"${"b".repeat(32)}","name":"test@example.com","active":true,"quota":{"week":{"remaining":95,"resetsAt":1000,"observedAt":9}}}]}"""))!!
        assertTrue(state.readonly)
        assertNull(state.active!!.fiveHour)
        assertEquals("账号 1", state.active!!.name)
    }
    @Test fun oldQuestionDoesNotTurnCompletedThreadIntoBusyOrRingAgain() {
        val pending = CodexQuestionState("t", listOf(CodexQuestion("q", "问题", emptyList())), "i", 10, 20)
        assertEquals("completed", codexQuestionDisplayStatus("completed", pending))
        assertEquals("waiting_answer", codexQuestionDisplayStatus("desktop_running", pending))
        assertFalse(shouldAlertCodexQuestion(10, 20, true))
        assertFalse(shouldAlertCodexQuestion(30, 20, false))
        assertTrue(shouldAlertCodexQuestion(30, 20, true))
    }
    private val now = 1_792_060_000_000L
    private val identity = "a".repeat(32)
    private fun accounts(at: Long = now, fingerprint: String? = identity): AgentAccountsState = AgentAccountsState(
        "claude", at, true, false, false,
        listOf(AgentAccountProfile("b".repeat(32), "主账号", true, true,
            AgentQuotaWindow(100.0, null, now - 3_600_000, true, false), null)), null, fingerprint)
    private fun usage(fingerprint: String? = identity) = ClaudeUsage(
        fiveHour = ClaudeUsageWindow(81, now + 3_600_000, observedAt = now),
        sevenDay = ClaudeUsageWindow(71, now + 86_400_000, observedAt = now),
        accountFingerprint = fingerprint, snapshotAt = now, accountState = "ready")

    @Test fun accountDialogUsesNewerHomepageObservationOnlyForTheExactBoundProfile() {
        val merged = accounts().withClaudeUsage(usage())
        assertEquals(81.0, merged.active!!.fiveHour!!.remaining, 0.0)
        assertEquals(71.0, merged.active!!.week!!.remaining, 0.0)
        assertEquals(now, merged.active!!.fiveHour!!.observedAt)
        assertEquals(now + 3_600_000, merged.active!!.fiveHour!!.resetsAt)
        for (sample in listOf(usage("c".repeat(32)), usage(null), usage().copy(accountState = "switching"))) {
            assertEquals(accounts(), accounts().withClaudeUsage(sample))
        }
        assertEquals(accounts(fingerprint = null), accounts(fingerprint = null).withClaudeUsage(usage()))
        assertEquals(accounts().copy(switching = true), accounts().copy(switching = true).withClaudeUsage(usage()))
    }
    @Test fun olderFallbackCannotEraseTheObservedQuotaAndLocalAgeStillExpiresIt() {
        val current = accounts().withClaudeUsage(usage())
        val after = mergeAgentAccounts(current, accounts(now + 1000))
        assertEquals(current.active!!.fiveHour, after.active!!.fiveHour)
        val stale = after.displayAt(now + 31 * 60_000).active!!.fiveHour!!
        assertTrue(stale.historical)
        assertFalse(stale.estimated)
        assertEquals(81.0, stale.remaining, 0.0)
        assertEquals(now, stale.observedAt)
    }
    @Test fun changingAccountBindingNeverRetainsAnotherAccountsQuota() {
        val current = accounts().withClaudeUsage(usage())
        val after = mergeAgentAccounts(current, accounts(now + 1000, "c".repeat(32)))
        assertEquals(100.0, after.active!!.fiveHour!!.remaining, 0.0)
        assertNull(after.active!!.week)
    }
    @Test fun inactiveResetEstimatesAreSeparateFromActiveQuotaAndKeepOriginalTime() {
        val current = accounts().withClaudeUsage(usage())
        val resetTime = now + 4 * 3_600_000
        val active = current.displayAt(resetTime).active!!.fiveHour!!
        assertEquals(81.0, active.remaining, 0.0)
        assertTrue(active.historical); assertFalse(active.estimated)
        val profile = current.active!!.copy(active = false)
        val inactive = current.copy(profiles = listOf(profile)).displayAt(resetTime).profiles.single().fiveHour!!
        assertEquals(100.0, inactive.remaining, 0.0)
        assertTrue(inactive.historical); assertTrue(inactive.estimated)
        assertEquals(now, inactive.observedAt)
    }
    @Test fun inactiveFullEstimateCannotBecomeAnActualActiveAccountObservation() {
        val estimated = accounts().copy(profiles = listOf(accounts().active!!.copy(active = false,
            fiveHour = AgentQuotaWindow(100.0, now - 1000, now - 10_000, true, true))))
        val actual = accounts(now + 1000).copy(profiles = listOf(accounts().active!!.copy(
            fiveHour = AgentQuotaWindow(7.0, null, now - 20_000, true, false))))
        val next = mergeAgentAccounts(estimated, actual)
        assertEquals(7.0, next.active!!.fiveHour!!.remaining, 0.0)
        assertFalse(next.active!!.fiveHour!!.estimated)
    }
    @Test fun malformedQuotaBindingIsRejectedAndCodexQuotaIsUnchanged() {
        val decoded = parseAgentAccounts(JSONObject("""{"backend":"claude","snapshotAt":10,"usageFingerprint":"private@example.test","profiles":[]}"""))!!
        assertNull(decoded.usageFingerprint)
        val codex = accounts().copy(backend = "codex")
        assertEquals(codex, codex.withClaudeUsage(usage()).displayAt(now + 100_000_000))
    }
}
