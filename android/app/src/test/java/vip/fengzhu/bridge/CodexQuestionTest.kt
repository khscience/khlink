package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexQuestionTest {
    private val question = CodexQuestion("[\"request_user_input_async\",\"call_A\",0]", "初始资金用多少？/元", listOf("1,000 万元", "100 万元"))

    @Test fun answerIsSentInCodexDesktopsReplyFormatAndReadBack() {
        val text = questionReplyText(question, "1,000 万元")
        assertTrue(text, text.startsWith("<send_user_message_question_reply>\n[{"))
        assertTrue(text, text.endsWith("}]\n</send_user_message_question_reply>"))
        assertTrue(text, text.contains("\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_A\\\",0]\""))
        assertTrue("slashes stay as typed", text.contains("？/元"))
        assertEquals(listOf(QuestionReply(question.id, question.question, "1,000 万元")), parseQuestionReplies(text))
        assertEquals("回答：1,000 万元", questionReplyDisplay(text))
        assertNull(questionReplyDisplay("普通消息"))
    }

    @Test fun desktopEscapedAnswerRendersAndMatchesTheOriginalOutgoingRequest() {
        val raw = questionReplyText(question, "茶 🍵")
        // Codex's rich-text composer serialized the literal XML-looking text
        // this way in a real Desktop-owned answer on 2026-11-16.
        val escaped = raw.replace("\\", "\\\\").replace("<", "\\<").replace("\n", "\\\n")
        assertEquals(listOf(QuestionReply(question.id, question.question, "茶 🍵")), parseQuestionReplies(escaped))
        assertEquals("回答：茶 🍵", questionReplyDisplay(escaped))
        assertNull(questionReplyDisplay("示例 $escaped"))
        val pending = QueuedInstruction("request-1", raw, 1_000, "started", historyAfterOrder = 10)
        val history = HistoryItem("real", 20, "userMessage", escaped, null, false)
        assertTrue(isQueuedInstructionDelivered(pending, listOf(history)))
        assertEquals(listOf(history), mergeTransientUserInstructions(listOf(history), listOf(pending)))
        assertFalse(isQueuedInstructionDelivered(pending, listOf(history.copy(text = escaped.replace("茶 🍵", "咖啡")))))
        assertFalse(isQueuedInstructionDelivered(pending, listOf(history.copy(order = 9))))
    }

    @Test fun invisibleRequestIdIsRemovedFromHistoryText() {
        val marker = "⁣" + "​‌".repeat(32) + "⁣"
        assertEquals("请继续", sanitizeHistoryText("请继续$marker"))
    }

    @Test fun answersStayInTheConversationAndAgentsMdIsHidden() {
        assertTrue(!isInternalContextMessage(questionReplyText(question, "1,000 万元")))
        assertTrue(isInternalContextMessage("# AGENTS.md instructions for I:/qmt5/code\n\n<INSTRUCTIONS>x</INSTRUCTIONS>"))
        assertTrue(isInternalContextMessage("<environment_context>x</environment_context>"))
    }
}
