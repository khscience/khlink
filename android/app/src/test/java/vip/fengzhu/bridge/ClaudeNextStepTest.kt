package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ClaudeNextStepTest {
    private val step = ClaudeNextStep("两个周末安排。", "你想怎么安排？", listOf(ClaudeNextStepAction("公园", "去公园吧。")), true)
    private fun card() = HistoryItem("a:0", 1, "claudeWrapUp", "问题", "completed", false, nextStep = step)

    @Test fun questionAndActionsSurviveEncryptedHistoryPayloadDecoding() {
        val parsed = parseClaudeNextStep(JSONObject("""{"recap":"两个周末安排。","ask":"你想怎么安排？","blocked":true,"actions":[{"label":"公园","message":"去公园吧。"}]}"""))
        assertEquals(step, parsed)
        assertTrue(groupHistoryItems(listOf(card()), inlineReasoning = true).single() is HistoryBlock.Single)
    }

    @Test fun onlyTheLatestCompletedBoxIsActive() {
        assertEquals(listOf(card()), activeClaudeNextSteps(listOf(card())))
        assertEquals(emptyList<HistoryItem>(), activeClaudeNextSteps(listOf(card().copy(status = "inProgress"))))
        assertEquals(emptyList<HistoryItem>(), activeClaudeNextSteps(listOf(card().copy(status = "failed"))))
        val reply = HistoryItem("local-draft", 2, "userMessage", "我想去湖边。", "sending", false)
        assertEquals(emptyList<HistoryItem>(), activeClaudeNextSteps(listOf(card(), reply)))
        // New work after the box retires it.
        val work = HistoryItem("a3:0", 3, "commandExecution", "ls", "completed", false)
        assertEquals(emptyList<HistoryItem>(), activeClaudeNextSteps(listOf(card(), work)))
    }

    @Test fun claudesClosingWordsAfterTheBoxKeepItActiveAndBelowThem() {
        // Claude Desktop 2026-10-31: wrap_up, then the closing message; the desktop keeps the buttons.
        val closing = HistoryItem("a2:0", 2, "agentMessage", "写好了，存在 凌晨四点的便利店.md。", "completed", false)
        assertEquals(listOf(card()), activeClaudeNextSteps(listOf(card(), closing)))
        assertEquals(listOf("a2:0", "a:0"), withCardsAtTurnEnd(listOf(card(), closing)).map { it.id })
        val reply = HistoryItem("local-draft", 3, "userMessage", "不用改", "sending", false)
        assertEquals(emptyList<HistoryItem>(), activeClaudeNextSteps(listOf(card(), closing, reply)))
        // A proposed-session card stays active next to the box.
        val session = card().copy(id = "a0:1", order = 0, nextStep = step.copy(title = "Claude 建议新开会话"))
        assertEquals(listOf("a0:1", "a:0"), activeClaudeNextSteps(listOf(session, card(), closing)).map { it.id })
    }

    @Test fun theTurnsTaskListAfterTheBoxKeepsItActive() {
        val tasks = HistoryItem("a1:0:tasks", 3, "claudeTaskList", "任务清单 2/6", "inProgress", false)
        val hidden = HistoryItem("a2:0", 4, "hidden", "", null, false)
        assertEquals(listOf(card()), activeClaudeNextSteps(listOf(card(), tasks)))
        assertEquals(listOf(card()), activeClaudeNextSteps(listOf(card(), tasks, hidden)))
        val reply = HistoryItem("local-draft", 5, "userMessage", "重启吧", "sending", false)
        assertEquals(emptyList<HistoryItem>(), activeClaudeNextSteps(listOf(card(), tasks, reply)))
    }

    @Test fun aRecapWithClosingMessageDoesNotPretendToNeedAReply() {
        val recap = card().copy(nextStep = ClaudeNextStep("整理好了。", "", emptyList(), false))
        val answer = HistoryItem("closing", 2, "agentMessage", "已整理好，剩余事项由你处理。", "completed", false)
        assertTrue(activeClaudeNextSteps(listOf(recap, answer)).isEmpty())
        assertEquals(listOf("closing"), groupHistoryItems(listOf(recap, answer), inlineReasoning = true).map { it.key })
    }

    @Test fun aStandaloneRecapIsPreservedAsANeutralSummary() {
        val recap = card().copy(nextStep = ClaudeNextStep("整理好了。", "", emptyList(), false))
        assertTrue(activeClaudeNextSteps(listOf(recap)).isEmpty())
        assertEquals(listOf(recap.id), groupHistoryItems(listOf(recap), inlineReasoning = true).map { it.key })
        assertEquals("Claude 本轮总结", claudeNextStepHeading(recap.nextStep, false))
        // A reply from a later turn must not hide this summary.
        val nextUser = HistoryItem("user", 2, "userMessage", "继续", null, false)
        val later = HistoryItem("later", 3, "agentMessage", "已继续。", "completed", false)
        assertEquals(listOf("a:0", "user", "later"), groupHistoryItems(listOf(recap, nextUser, later), inlineReasoning = true).map { it.key })
        val newWork = HistoryItem("work", 2, "commandExecution", "查看文件", "completed", false)
        assertTrue(groupHistoryItems(listOf(recap, newWork, later), inlineReasoning = true).any { it.key == recap.id })
    }

    @Test fun realQuestionsActionsAndExplicitBlocksStillRequestAReply() {
        val askOnly = card().copy(nextStep = ClaudeNextStep("", "你想怎么做？", emptyList(), false))
        val actionsOnly = card().copy(nextStep = ClaudeNextStep("", "", listOf(ClaudeNextStepAction("继续", "继续")), false))
        val blocked = card().copy(nextStep = ClaudeNextStep("请确认。", "", emptyList(), true))
        val answer = HistoryItem("closing", 2, "agentMessage", "请看上面的选项。", "completed", false)
        for (item in listOf(askOnly, actionsOnly, blocked)) {
            assertEquals(listOf(item), activeClaudeNextSteps(listOf(item, answer)))
            assertTrue(groupHistoryItems(listOf(item, answer), inlineReasoning = true).any { it.key == item.id })
            assertEquals("Claude 等你回复", claudeNextStepHeading(item.nextStep, true))
        }
    }

    @Test fun suggestionsOnlyFillEmptyDraftsAndNeverRewriteFreeText() {
        val action = step.actions.single()
        assertEquals(action.message, claudeNextStepDraft("", action))
        assertEquals("我想换成下午去湖边。", claudeNextStepDraft("我想换成下午去湖边。", action))
    }

    @Test fun malformedOrOversizedActionsCannotBecomePartialAnswers() {
        val source = JSONObject().put("ask", "去哪？").put("actions", org.json.JSONArray()
            .put(JSONObject().put("label", "公园").put("message", "  下午去公园。  "))
            .put(JSONObject().put("label", "太长").put("message", "字".repeat(16001)))
            .put(JSONObject().put("label", "错误").put("message", 123)))
        assertEquals(listOf(ClaudeNextStepAction("公园", "  下午去公园。  ")), parseClaudeNextStep(source)?.actions)
        assertNull(parseClaudeNextStep(JSONObject()))
        assertNull(parseClaudeNextStep(null))
    }

    @Test
    fun labelOnlyButtonsAndAProposedSessionCardAreShown() {
        val source = JSONObject().put("title", "Claude 建议新开会话").put("ask", "用子代理试迁移评测")
            .put("actions", org.json.JSONArray().put(JSONObject().put("label", "新开会话")).put(JSONObject().put("label", "在这里做").put("message", "就在这里做")))
        val step = parseClaudeNextStep(source)!!
        assertEquals("Claude 建议新开会话", step.title)
        assertEquals(listOf(ClaudeNextStepAction("新开会话", "新开会话"), ClaudeNextStepAction("在这里做", "就在这里做")), step.actions)
    }
}
