package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryGroupingTest {
    @Test
    fun runningStateTargetsTheLatestActivityGroupEvenWhenAReplyFollowsIt() {
        val blocks = groupHistoryItems(listOf(
            item("command-1", "commandExecution"),
            item("reply", "assistantMessage"),
        ))

        assertEquals("activity:command-1", latestActivityGroupKey(blocks))
    }

    @Test
    fun aToolGroupFromAnEarlierTurnIsNotTheRunningOne() {
        val blocks = groupHistoryItems(listOf(
            item("command-1", "commandExecution"),
            item("reply", "assistantMessage"),
            item("next", "userMessage"),
        ))

        assertEquals(null, latestActivityGroupKey(blocks))
    }

    @Test
    fun consecutiveActivitiesBecomeOneGroup() {
        val blocks = groupHistoryItems(
            listOf(
                item("user", "userMessage"),
                item("command-1", "commandExecution"),
                item("command-2", "commandExecution"),
                item("file", "fileChange"),
                item("reply", "agentMessage"),
            ),
        )

        assertEquals(3, blocks.size)
        assertTrue(blocks[0] is HistoryBlock.Single)
        val group = blocks[1] as HistoryBlock.ActivityGroup
        assertEquals(listOf("command-1", "command-2", "file"), group.items.map { it.id })
        assertTrue(blocks[2] is HistoryBlock.Single)
    }

    @Test
    fun reasoningAndActivitiesShareOneWorkGroup() {
        val blocks = groupHistoryItems(
            listOf(
                item("command", "commandExecution"),
                item("thought", "reasoning"),
                item("search-1", "webSearch"),
                item("search-2", "webSearch"),
            ),
        )

        assertEquals(1, blocks.size)
        assertEquals(listOf("command", "thought", "search-1", "search-2"), (blocks[0] as HistoryBlock.ActivityGroup).items.map { it.id })
    }

    @Test
    fun emptyReasoningAndPlanSummariesAreNotRendered() {
        val blocks = groupHistoryItems(
            listOf(
                item("command", "commandExecution"),
                item("empty-reasoning", "reasoning", "[]"),
                item("blank-plan", "plan", "  "),
                item("visible-reasoning", "reasoning", "检查连接状态"),
                item("empty-reasoning-2", "reasoning", "{}"),
                item("reply", "agentMessage"),
            ),
        )

        assertEquals(2, blocks.size)
        assertEquals(
            listOf("command", "visible-reasoning"),
            (blocks[0] as HistoryBlock.ActivityGroup).items.map { it.id },
        )
        assertEquals("reply", (blocks[1] as HistoryBlock.Single).item.id)
    }

    @Test
    fun activityGroupContainingOnlyEmptyReasoningDisappears() {
        val blocks = groupHistoryItems(
            listOf(item("empty-1", "reasoning", "[]"), item("empty-2", "reasoning", "")),
        )

        assertTrue(blocks.isEmpty())
    }

    @Test
    fun contextCompactionIsShownOnItsOwnAcrossTheConversation() {
        val blocks = groupHistoryItems(
            listOf(item("thought", "reasoning"), item("compact", "contextCompaction"), item("reply", "agentMessage")),
        )

        assertEquals(3, blocks.size)
        assertEquals("compact", (blocks[1] as HistoryBlock.Single).item.id)
    }

    @Test
    fun workGroupStopsAtVisibleTextOutput() {
        val blocks = groupHistoryItems(
            listOf(
                item("thought", "reasoning"),
                item("command", "commandExecution"),
                item("reply-1", "agentMessage"),
                item("thought-2", "reasoning"),
                item("reply-2", "agentMessage"),
            ),
        )

        assertEquals(4, blocks.size)
        assertEquals(listOf("thought", "command"), (blocks[0] as HistoryBlock.ActivityGroup).items.map { it.id })
        assertTrue(blocks[1] is HistoryBlock.Single)
        assertEquals(listOf("thought-2"), (blocks[2] as HistoryBlock.ActivityGroup).items.map { it.id })
        assertTrue(blocks[3] is HistoryBlock.Single)
    }

    @Test
    fun activeGroupKeepsItsIdentityWhenNewActivityArrives() {
        val initial = groupHistoryItems(listOf(item("command-1", "commandExecution"), item("command-2", "commandExecution"))).single()
        val updated = groupHistoryItems(listOf(item("command-1", "commandExecution"), item("command-2", "commandExecution"), item("command-3", "commandExecution"))).single()

        assertEquals(initial.key, updated.key)
    }

    @Test
    fun commandOutputIsNestedUnderItsCommand() {
        val entries = activityEntries(
            listOf(
                item("command", "commandExecution", "Get-ChildItem"),
                item("output", "commandExecution", "Script completed\nOutput:\nfile.txt"),
                item("search", "webSearch", "Compose docs"),
            ),
        )

        assertEquals(2, entries.size)
        assertEquals("command", entries[0].primary.id)
        assertEquals(listOf("output"), entries[0].outputs.map { it.id })
        assertEquals("search", entries[1].primary.id)
    }

    @Test
    fun reasoningEffortsUseStableBackendOrder() {
        assertEquals(
            listOf("minimal", "low", "medium", "high", "xhigh", "max", "ultra"),
            orderedReasoningEfforts(listOf("ultra", "high", "low", "max", "minimal", "xhigh", "medium")),
        )
        assertEquals("极高", reasoningEffortLabel("xhigh"))
    }

    @Test
    fun filtersOnlyLegacyRealtimeErrorsAndKeepsRealErrorItems() {
        assertTrue(isLegacyMisclassifiedRolloutError("error", 1_780_000_000_000_000L))
        assertEquals(false, isLegacyMisclassifiedRolloutError("turnError", 1_780_000_000_000_000L))
        assertEquals(false, isLegacyMisclassifiedRolloutError("error", 42L))
    }

    @Test
    fun latestHistoryKeepsDisconnectedCacheUntilTheMiddlePageIsRecovered() {
        val merged = mergeLatestHistoryPage(
            existing = listOf(orderedItem("old-1", 1), orderedItem("old-2", 2)),
            latest = listOf(orderedItem("new-31", 31), orderedItem("new-32", 32)),
        )

        assertEquals(false, merged.resetToLatest)
        assertEquals(listOf("old-1", "old-2", "new-31", "new-32"), merged.items.map { it.id })
        assertTrue(historyNeedsForwardRecovery(merged.items.take(2), merged.items.takeLast(2)))
    }

    @Test
    fun latestHistoryKeepsCachedPagesWhenTheRangesOverlap() {
        val merged = mergeLatestHistoryPage(
            existing = listOf(orderedItem("old", 1), orderedItem("shared", 2)),
            latest = listOf(orderedItem("shared", 2), orderedItem("new", 3)),
        )

        assertEquals(false, merged.resetToLatest)
        assertEquals(listOf("old", "shared", "new"), merged.items.map { it.id })
        assertEquals(false, historyNeedsForwardRecovery(merged.items, latest = listOf(orderedItem("latest", 3))))
    }

    @Test
    fun claudeThreadsKeepThinkingInlineButStillFoldTools() {
        val items = listOf(item("u", "userMessage"), item("r1", "reasoning"), item("c1", "commandExecution"), item("c2", "fileChange"), item("r2", "reasoning"), item("a", "agentMessage"))
        val claude = groupHistoryItems(items, inlineReasoning = true)
        assertEquals(listOf("u", "r1", "activity:c1", "r2", "a"), claude.map { it.key })
        val codex = groupHistoryItems(items)
        assertEquals(listOf("u", "activity:r1", "a"), codex.map { it.key })
    }

    @Test
    fun lastTurnDurationIsReadFromTheConversation() {
        fun at(id: String, type: String, ms: Long) = HistoryItem(id, 0, type, id, "completed", false, createdAt = ms)
        val items = listOf(at("u1", "userMessage", 1_000), at("a1", "agentMessage", 5_000), at("u2", "userMessage", 10_000), at("c", "commandExecution", 12_000), at("a2", "agentMessage", 17_500))
        assertEquals(7_500L, lastTurnDurationFromHistory(items))
        assertEquals(null, lastTurnDurationFromHistory(items.take(3)))
    }

    private fun item(id: String, type: String, text: String = id) = HistoryItem(id, 0, type, text, "completed", false)
    private fun orderedItem(id: String, order: Long) = HistoryItem(id, order, "agentMessage", id, "completed", false)
}
