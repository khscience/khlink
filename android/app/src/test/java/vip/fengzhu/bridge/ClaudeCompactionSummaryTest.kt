package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClaudeCompactionSummaryTest {
    private val intro = "This session is being continued from a previous conversation that ran out of context. " +
        "The summary below covers the earlier portion of the conversation."
    private val envelope = "$intro\n<system-reminder><tools-used-before-summary>Agent, Bash</tools-used-before-summary></system-reminder>\n摘要"

    @Test
    fun hidesThePreviouslyUploadedClaudeSummary() {
        assertTrue(isLegacyClaudeCompactionSummary("userMessage", envelope, "claude"))
        assertTrue(isLegacyClaudeCompactionSummary("userMessage", " \n$envelope", null))
    }

    @Test
    fun keepsNormalMessagesAndAgentResponses() {
        assertFalse(isLegacyClaudeCompactionSummary("agentMessage", envelope, "claude"))
        assertFalse(isLegacyClaudeCompactionSummary("userMessage", envelope, "codex"))
        assertFalse(isLegacyClaudeCompactionSummary("userMessage", "请解释这段记录：$envelope", "claude"))
        assertFalse(isLegacyClaudeCompactionSummary("userMessage", intro, "claude"))
        assertFalse(isLegacyClaudeCompactionSummary("userMessage", "$intro\n<system-reminder>提示</system-reminder>", "claude"))
        assertFalse(isLegacyClaudeCompactionSummary("userMessage", "请继续，并保留真实历史。", "claude"))
    }
}
