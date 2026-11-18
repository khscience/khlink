package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class ConversationUsageTest {
    private fun turn(id: String = "turn", finalId: String? = "final", finalAt: Long = 200L) =
        CompletedTurnTokenUsage(id, 100, 300, finalAt, finalId, ConversationTokenCounts(1_000, 100, 1_100))
    private fun answer(id: String, order: Long, at: Long = 200, type: String = "agentMessage", source: String? = null) =
        HistoryItem(id, order, type, "answer", null, false, createdAt = at, sourceMessageId = source)

    @Test fun textSpeedUsesVisibleUnicodeOnlyAndDoesNotBorrowAnotherTurn() {
        val prompt = answer("u", 1, 1000, "userMessage")
        val reply = answer("r", 2, 2000).copy(text = "好🙂")
        assertEquals("正文均速 2 字符/秒", visibleTurnSpeeds(listOf(prompt, reply), false)["r"])
        assertTrue(visibleTurnSpeeds(listOf(prompt, reply.copy(createdAt = 1006)), false, "hermes").isEmpty())
        assertEquals("正文均速 0.5 字符/秒", visibleTurnSpeeds(listOf(prompt, reply.copy(createdAt = 1006)), false, "hermes", mapOf("r" to 4000L))["r"])
        assertTrue(visibleTurnSpeeds(listOf(prompt, reply), true).isEmpty())
        assertTrue(visibleTurnSpeeds(listOf(reply), false).isEmpty())
        assertTrue(visibleTurnSpeeds(listOf(prompt, reply.copy(truncated = true)), false).isEmpty())
        assertTrue(visibleTurnSpeeds(listOf(prompt, reply.copy(createdAt = 1000)), false).isEmpty())
        assertEquals(setOf("r"), visibleTurnSpeeds(listOf(prompt, reply, prompt.copy(id = "next", createdAt = 3000)), true).keys)
    }
    @Test fun streamingSpeedRequiresNewTextAcrossTwoObservations() {
        val meter = LiveTextSpeed()
        assertNull(meter.observe("旧正文", 1000))
        assertEquals("正文输出 1 字符/秒", meter.observe("旧正文🙂", 2000))
        assertNull(meter.observe("重写", 3000))
        assertEquals("正文输出 2 字符/秒", meter.observe("重写完成", 4000))
    }
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
        assertEquals("本轮 0.11 万 · 整轮均速 500 Token/秒", MessageUsageFooter(turn()).summary(TokenDisplayUnit.TenThousands))
        assertEquals("本轮 0.0011 M · 整轮均速 500 Token/秒", MessageUsageFooter(turn()).summary(TokenDisplayUnit.Millions))
        assertEquals("本轮已记录 0.11 万", MessageUsageFooter(turn().copy(partial = true)).summary(TokenDisplayUnit.TenThousands))
    }
    @Test fun latestReplyShowsTheSeparateConversationTotalOnlyAfterTheTurn() {
        val items = listOf(answer("old", 1), answer("user", 2, type = "userMessage"), answer("final", 3))
        val usage = ConversationTokenUsage.fromFields(fields()).copy(
            totals = ConversationTokenCounts(2_000, 200, 2_200),
            completedTurns = listOf(turn("old-turn", "old"), turn()),
        )
        val footers = messageUsageFooters(items, usage, busy = false)
        assertFalse(footers.getValue("old").latestReply)
        assertEquals("本轮 0.11 万 · 整轮均速 500 Token/秒", footers.getValue("old").summary(TokenDisplayUnit.TenThousands))
        assertEquals("本轮 0.11 万 · 累计 0.22 万 · 整轮均速 500 Token/秒", footers.getValue("final").summary(TokenDisplayUnit.TenThousands))
        assertEquals("本轮 1,100 Token，累计 2,200 Token，整轮均速 500 Token/秒",
            footers.getValue("final").summary(TokenDisplayUnit.TenThousands, exact = true))
        assertTrue(messageUsageFooters(items, usage, busy = true).values.none { it.latestReply })
        assertTrue(messageUsageFooters(items + answer("new-prompt", 4, type = "userMessage"), usage, busy = false).values.none { it.latestReply })
    }
    @Test fun unmatchedRepliesOnlyShowAvailableCachedPartialTotals() {
        val usage = ConversationTokenUsage.fromFields(fields()).copy(completedTurns = listOf(turn()), partial = true, fromCache = true)
        val item = answer("other", 1)
        val footer = messageUsageFooters(listOf(item), usage, busy = false).getValue(item.id)
        assertNull(footer.turn)
        assertEquals("累计（已记录，缓存） 0.012 万", footer.summary(TokenDisplayUnit.TenThousands))
        assertEquals("", messageUsageFooters(listOf(item), null, busy = false).getValue(item.id).summary(TokenDisplayUnit.TenThousands))
    }
    @Test fun aLatestRequestSpeedCanOnlySupplementTheReplyWithTheMatchingSourceId() {
        val speed = outputSpeedSample(speedFields())
        val usage = ConversationTokenUsage(backend = "pi", status = "ready", latestOutputSpeed = speed)
        val match = messageUsageFooters(listOf(answer("replayed", 1, source = "final")), usage, busy = false).getValue("replayed")
        assertEquals(speed, match.replySpeed)
        val other = messageUsageFooters(listOf(answer("other", 1)), usage, busy = false).getValue("other")
        assertNull(other.replySpeed)
    }
    @Test fun wholeTurnSpeedUsesOutputAndCompleteElapsedTimeWhileRequestTimingTakesPrecedence() {
        val complete = turn().copy(startedAt = 1_000, completedAt = 5_000)
        assertEquals("整轮均速 25 Token/秒", wholeTurnSpeedLabel(complete))
        assertNull(wholeTurnSpeedLabel(complete.copy(partial = true)))
        assertNull(wholeTurnSpeedLabel(complete.copy(startedAt = 0)))
        assertNull(wholeTurnSpeedLabel(complete.copy(completedAt = complete.startedAt)))
        assertNull(wholeTurnSpeedLabel(complete.copy(usage = ConversationTokenCounts(100, 0, 100))))
        val request = outputSpeedSample(speedFields())!!
        assertEquals("本轮 0.11 万 · 输出约 20 Token/秒",
            MessageUsageFooter(complete, latestReply = true, replySpeed = request).summary(TokenDisplayUnit.TenThousands))
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

    private fun speedFields() = mapOf<String, Any?>("method" to "pi_request_elapsed_v1", "outputTokens" to 400L,
        "durationMs" to 20_000L, "completedAt" to 1_800_000_020_000L, "turnId" to "turn", "messageId" to "final")

    @Test fun requestSpeedUsesOnlyValidatedPerRequestTokensAndElapsedTime() {
        val speed = outputSpeedSample(speedFields())!!
        assertEquals("输出速度约 20 Token/秒", outputSpeedLabel(speed))
        assertEquals(speed, outputSpeedSample(speed.toFields()))
        assertTrue(outputSpeedLabel(speed.copy(outputTokens = 1, durationMs = 1_000_000)).contains("<0.01"))
        for (bad in listOf(speedFields() + ("method" to "turn_elapsed"), speedFields() + ("outputTokens" to -1),
            speedFields() + ("durationMs" to 0), speedFields() + ("durationMs" to 1_000_000_000_000L),
            speedFields() + ("outputTokens" to 1.5), speedFields() + ("messageId" to ""))) {
            assertNull(outputSpeedSample(bad))
        }
    }

    @Test fun speedCannotBeBorrowedFromAnotherAgentTurnOrAnOldCachedSample() {
        val speed = speedFields()
        val raw = fields(1_800_000_020_000L) + mapOf("backend" to "pi", "turnId" to "turn", "latestOutputSpeed" to speed,
            "latest" to mapOf("input" to 10L, "output" to 400L, "total" to 410L))
        val pi = ConversationTokenUsage.fromFields(raw)
        assertNotNull(liveOutputSpeed(pi, true, true, 1_800_000_010_000L))
        assertNull(liveOutputSpeed(pi.copy(turnId = "new"), true, true, null))
        assertNull(liveOutputSpeed(pi.copy(status = "scanning"), true, true, null))
        assertNull(liveOutputSpeed(pi.copy(fromCache = true), true, true, null))
        assertNull(liveOutputSpeed(pi, false, true, null))
        assertNull(liveOutputSpeed(pi, true, false, null))
        assertNull(liveOutputSpeed(pi, true, true, 1_800_000_020_001L))
        assertNull(ConversationTokenUsage.fromFields(raw + ("backend" to "codex")).latestOutputSpeed)
        assertNull(ConversationTokenUsage.fromFields(raw + ("usageUpdatedAt" to 1_800_000_020_001L)).latestOutputSpeed)
        assertNull(ConversationTokenUsage.fromFields(raw + ("latest" to counts())).latestOutputSpeed)
    }

    @Test fun firstTokenTimingBelongsToTheSelectedCompletedCodexTurn() {
        val row = CompletedTurnTokenUsage("one", 1000L, 5670L, 5650L, "final",
            ConversationTokenCounts(10, 6, 16), durationMs = 4672L, firstTokenMs = 4458L)
        fun decode(data: Map<String, Any?>, backend: String = "codex") = ConversationTokenUsage.fromFields(
            fields() + mapOf("backend" to backend, "completedTurns" to listOf(data))).completedTurns.single()
        assertEquals(4458L, decode(row.toFields()).firstTokenMs)
        assertEquals(4672L, decode(row.toFields()).elapsedMs)
        assertNull(decode(row.toFields() + ("firstTokenMs" to 4673L)).firstTokenMs)
        assertNull(decode(row.toFields(), "pi").firstTokenMs)
        assertEquals(4670L, decode(row.toFields() - "durationMs" - "firstTokenMs").elapsedMs)
    }

    @Test fun aCompletedFooterAcceptsOnlyTheMatchingRequest() {
        val final = CompletedTurnTokenUsage("turn", 1_800_000_000_000L, 1_800_000_020_000L,
            1_800_000_000_000L, "final", ConversationTokenCounts(10, 400, 410), finalOutputSpeed = outputSpeedSample(speedFields()))
        val raw = fields() + mapOf("backend" to "pi", "completedTurns" to listOf(final.toFields()))
        assertNotNull(ConversationTokenUsage.fromFields(raw).completedTurns.single().finalOutputSpeed)
        val mismatched = final.copy(finalMessageId = "another")
        assertNull(ConversationTokenUsage.fromFields(raw + ("completedTurns" to listOf(mismatched.toFields()))).completedTurns.single().finalOutputSpeed)
        val mismatchedStart = final.copy(finalMessageAt = final.finalMessageAt + 1)
        assertNull(ConversationTokenUsage.fromFields(raw + ("completedTurns" to listOf(mismatchedStart.toFields()))).completedTurns.single().finalOutputSpeed)
        assertNull(ConversationTokenUsage.fromFields(raw + ("backend" to "claude")).completedTurns.single().finalOutputSpeed)
    }

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
