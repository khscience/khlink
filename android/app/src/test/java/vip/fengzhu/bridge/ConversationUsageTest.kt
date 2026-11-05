package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class ConversationUsageTest {
    private fun turn(id: String = "turn", finalId: String? = "final", finalAt: Long = 200L) =
        CompletedTurnTokenUsage(id, 100, 300, finalAt, finalId, ConversationTokenCounts(1_000, 100, 1_100))
    private fun answer(id: String, order: Long, at: Long = 200, type: String = "agentMessage", source: String? = null) =
        HistoryItem(id, order, type, "answer", null, false, createdAt = at, sourceMessageId = source)

    @Test fun aFooterNeedsANativeFinishedTurnAndNeverUsesCumulativeOrLatestCall() {
        val usage = ConversationTokenUsage.fromFields(fields())
        assertTrue(completedTurnFooters(listOf(answer("final", 1)), usage).isEmpty())
        val completed = usage.copy(completedTurns = listOf(turn()))
        assertEquals(1_100L, completedTurnFooters(listOf(answer("final", 1)), completed)["final"]!!.usage.total)
    }
    @Test fun onlyTheFinalAnswerGetsAFooterWhileEarlierTurnsRemainVisibleDuringNewWork() {
        val items = listOf(answer("commentary", 1), answer("final", 2), answer("user", 3, type = "userMessage"), answer("new", 4, at = 400))
        val usage = ConversationTokenUsage.fromFields(fields()).copy(turnActive = true, completedTurns = listOf(turn()))
        assertEquals(setOf("final"), completedTurnFooters(items, usage).keys)
    }
    @Test fun nativeIdsWinOverTimestampAndMissingAnswersNeverAttachToOtherMessages() {
        val usage = ConversationTokenUsage.fromFields(fields()).copy(completedTurns = listOf(turn()))
        assertEquals(setOf("final"), completedTurnFooters(listOf(answer("final", 1, 0), answer("same-time", 2)), usage).keys)
        assertTrue(completedTurnFooters(listOf(answer("same-time", 1)), usage).isEmpty())
    }
    @Test fun legacyTimestampFallbackSelectsTheLastTextBlockAndPiBranchesUseSourceIds() {
        val usage = ConversationTokenUsage.fromFields(fields())
        assertEquals(setOf("second"), completedTurnFooters(listOf(answer("first", 1), answer("second", 2)), usage.copy(completedTurns = listOf(turn(finalId = null)))).keys)
        assertEquals(setOf("pi-new-index"), completedTurnFooters(listOf(answer("pi-new-index", 1, at = 0, source = "native")), usage.copy(completedTurns = listOf(turn(finalId = "native")))).keys)
    }
    @Test fun malformedOrUnfinishedTurnMetadataIsRejected() {
        val base = turn().toFields()
        for (bad in listOf(base + ("completedAt" to 0L), base + ("finalMessageAt" to 400L), base + ("turnId" to ""), base + ("usage" to counts(total = 121L)))) {
            assertTrue(ConversationTokenUsage.fromFields(fields() + ("completedTurns" to listOf(bad))).completedTurns.isEmpty())
        }
        assertEquals(1, ConversationTokenUsage.fromFields(fields() + ("completedTurns" to listOf(base))).completedTurns.size)
    }
    @Test fun freshScansKeepFinishedHistoryButOldResultsCannotChangeIt() {
        val previous = ConversationTokenUsage.fromFields(fields(200)).copy(completedTurns = listOf(turn()))
        val fresh = mergeConversationUsage(previous, ConversationTokenUsage.fromFields(fields(300)).copy(completedTurns = listOf(turn("next", "next", 250))))
        assertEquals(2, fresh.completedTurns.size)
        assertEquals(fresh, mergeConversationUsage(fresh, previous))
    }
    @Test fun footerUnitsFollowTheSettingAndPartialUsageIsExplicit() {
        assertEquals("消耗 0.11 万", completedTurnTokenLabel(turn(), TokenDisplayUnit.TenThousands))
        assertEquals("消耗 0.0011 M", completedTurnTokenLabel(turn(), TokenDisplayUnit.Millions))
        assertEquals("已记录 0.11 万", completedTurnTokenLabel(turn().copy(partial = true), TokenDisplayUnit.TenThousands))
    }
    @Test fun aLateTokenSnapshotUpdatesTheSameTerminalTimestampInsteadOfKeepingAnEarlierCount() {
        val previous = ConversationTokenUsage.fromFields(fields(200)).copy(completedTurns = listOf(turn()))
        val corrected = turn().copy(usage = ConversationTokenCounts(1_100, 100, 1_200))
        val merged = mergeConversationUsage(previous, ConversationTokenUsage.fromFields(fields(300)).copy(completedTurns = listOf(corrected)))
        assertEquals(1_200L, merged.completedTurns.single().usage.total)
    }
    private fun counts(input: Number = 100L, output: Number = 20L, total: Number = 120L) =
        mapOf("input" to input, "output" to output, "total" to total, "cacheRead" to 80L, "reasoning" to 10L)
    private fun fields(time: Long = 100L) = mapOf<String, Any?>(
        "schemaVersion" to 1, "backend" to "codex", "status" to "ready", "totals" to counts(),
        "latest" to counts(), "updatedAt" to time, "usageUpdatedAt" to time, "turnActive" to true,
    )

    @Test fun parsesSourceCountsAndUnknownSubcountsWithoutDoubleAdding() {
        val usage = ConversationTokenUsage.fromFields(fields())
        assertEquals("ready", usage.status)
        assertEquals(120L, usage.totals!!.total)
        assertEquals(80L, usage.totals.cacheRead)
        assertEquals(10L, usage.totals.reasoning)
        assertNull(usage.totals.cacheWrite)
        assertNull(usage.turn)
        assertTrue(usage.turnActive)
    }
    @Test fun missingAndUnsupportedDataNeverBecomeZero() {
        val missing = ConversationTokenUsage.fromFields(mapOf("schemaVersion" to 1, "backend" to "antigravity", "status" to "unavailable", "reason" to "暂无来源"))
        assertEquals("unavailable", missing.status); assertNull(missing.totals); assertEquals("暂无来源", missing.reason)
        assertEquals("unavailable", ConversationTokenUsage.fromFields(fields() + ("schemaVersion" to 9)).status)
    }
    @Test fun rejectsFractionsNegativeOverflowAndInconsistentCounters() {
        for (bad in listOf(counts(-1L), counts(1.5), counts(total = 121L), counts(Long.MAX_VALUE))) {
            assertNull(tokenCounts(bad))
            assertEquals("unavailable", ConversationTokenUsage.fromFields(fields() + ("totals" to bad)).status)
        }
    }
    @Test fun cacheAndReasoningMustRemainSubsets() {
        assertNull(tokenCounts(counts() + ("cacheWrite" to 30L)))
        assertNull(tokenCounts(counts() + ("reasoning" to 21L)))
    }
    @Test fun largeTotalsStayLongAndDisplayExactly() {
        val values = mapOf("input" to 554_684_851L, "output" to 2_280_992L, "total" to 556_965_843L)
        assertEquals(556_965_843L, tokenCounts(values)!!.total)
        assertEquals("556,965,843", formatTokenCount(556_965_843L))
        assertEquals("—", formatTokenCount(null)); assertEquals("0", formatTokenCount(0))
    }
    @Test fun ignoresReplayedAndOlderScanResults() {
        val current = ConversationTokenUsage.fromFields(fields(200))
        assertEquals(current, mergeConversationUsage(current, ConversationTokenUsage.fromFields(fields(100))))
        assertEquals(current, mergeConversationUsage(current, current.copy(updatedAt = 300, usageUpdatedAt = 100)))
    }
    @Test fun readFailureOrScanningKeepsLastSuccessfulCountsForOfflineDisplay() {
        val current = ConversationTokenUsage.fromFields(fields(200))
        for (status in listOf("unavailable", "scanning")) {
            val merged = mergeConversationUsage(current, current.copy(status = status, totals = null, reason = "正在读取"))
            assertEquals(current.totals, merged.totals); assertEquals(200L, merged.usageUpdatedAt); assertTrue(merged.fromCache)
        }
    }
    @Test fun aFreshSnapshotClearsTheCachedLabelAndKeepsTurnDistinctFromLatestCall() {
        val previous = ConversationTokenUsage.fromFields(fields(100)).copy(fromCache = true)
        val next = ConversationTokenUsage.fromFields(fields(200) + ("turn" to mapOf("input" to 1_000L, "output" to 100L, "total" to 1_100L)))
        val merged = mergeConversationUsage(previous, next)
        assertFalse(merged.fromCache); assertEquals(1_100L, merged.turn!!.total); assertEquals(120L, merged.latest!!.total)
    }
    @Test fun unitPreferenceDefaultsToWanAndRestoresBothChoices() {
        assertEquals(TokenDisplayUnit.TenThousands, TokenDisplayUnit.fromStored(null))
        assertEquals(TokenDisplayUnit.TenThousands, TokenDisplayUnit.fromStored("invalid"))
        TokenDisplayUnit.entries.forEach { assertEquals(it, TokenDisplayUnit.fromStored(it.id)) }
    }
    @Test fun millionsAndWanUseCorrectDivisors() {
        assertEquals("57.94 M", formatTokenDisplay(57_937_285, TokenDisplayUnit.Millions))
        assertEquals("5,793.73 万", formatTokenDisplay(57_937_285, TokenDisplayUnit.TenThousands))
        assertEquals("1 M", formatTokenDisplay(1_000_000, TokenDisplayUnit.Millions))
        assertEquals("1 万", formatTokenDisplay(10_000, TokenDisplayUnit.TenThousands))
    }
    @Test fun smallPositiveCountsNeverRoundToZeroAndMissingStaysUnknown() {
        assertEquals("0.000001 M", formatTokenDisplay(1, TokenDisplayUnit.Millions))
        assertEquals("0.0001 万", formatTokenDisplay(1, TokenDisplayUnit.TenThousands))
        assertEquals("0 M", formatTokenDisplay(0, TokenDisplayUnit.Millions))
        assertEquals("—", formatTokenDisplay(null, TokenDisplayUnit.TenThousands))
    }
    @Test fun scaledDisplayDoesNotChangeExactCounters() {
        val value = tokenCounts(mapOf("input" to 57_000_000L, "output" to 937_285L, "total" to 57_937_285L))!!
        TokenDisplayUnit.entries.forEach { formatTokenDisplay(value.total, it) }
        assertEquals(57_937_285L, value.total)
        assertEquals("57,937,285", formatTokenCount(value.total))
    }
    @Test fun typicalSmallChatsKeepMoreThanTwoFractionDigitsInScaledUnits() {
        assertEquals("0.0154 M", formatTokenDisplay(15_390, TokenDisplayUnit.Millions))
        assertEquals("0.1539 万", formatTokenDisplay(1_539, TokenDisplayUnit.TenThousands))
    }
}
