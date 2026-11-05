package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class CodexQuestionStateTest {
    private val q1 = CodexQuestion("[\"request_user_input_async\",\"test_call\",0]", "测试颜色？", listOf("蓝色", "绿色"))
    private val q2 = q1.copy(id = "[\"request_user_input_async\",\"test_call\",1]", question = "测试布局？")
    private val pending = CodexQuestionState("test-thread", listOf(q1, q2), "test_call", 1_000, 1_000, "turn-1")

    @Test fun aReopenedQuestionWithoutLiveStateStillDispatchesItsNativeAnswerImmediately() {
        val sent = mutableListOf<String>()
        assertTrue(submitCodexQuestionAnswer(q1, "蓝色", emptyList()) { sent.add(it); true })
        assertEquals(listOf(QuestionReply(q1.id, q1.question, "蓝色")), parseQuestionReplies(sent.single()))
    }

    @Test fun pendingUncertainAndConfirmedAnswersCannotBeSubmittedTwice() {
        for (state in listOf("pending", "desktop_queued", "uncertain", "started", "steered")) {
            val outgoing = listOf(QueuedInstruction("request-1", questionReplyText(q1, "蓝色"), 1_000, state))
            assertFalse(submitCodexQuestionAnswer(q1, "蓝色", outgoing) { fail("duplicate $state"); true })
            assertTrue(submitCodexQuestionAnswer(q2, "绿色", outgoing) { true })
        }
        assertFalse(submitCodexQuestionAnswer(q1, " ", emptyList()) { fail("blank answer"); true })
    }

    @Test fun pendingAttentionWinsOverToolHeartbeatsWithoutChangingExecutionState() {
        for (raw in listOf("desktop_running", "mobile_running", "running", "compacting")) {
            assertEquals("waiting_answer", codexQuestionDisplayStatus(raw, pending))
            assertTrue(isWaitingThreadStatus(codexQuestionDisplayStatus(raw, pending)))
            assertEquals(raw, codexQuestionDisplayStatus(raw, null))
        }
    }

    @Test fun dismissingThePromptIsNotResolvingTheQuestion() {
        val reopened = pending.prompt()
        assertEquals(pending.questions, reopened.questions)
        assertEquals("waiting_answer", codexQuestionDisplayStatus("desktop_running", pending))
        assertEquals("test-thread", reopened.threadId)
    }

    @Test fun partialAnswerKeepsWaitingAndFinalAnswerRestoresActualExecutionStatus() {
        val partial = mergeCodexQuestionState(pending, pending.copy(questions = listOf(q2), updatedAt = 2_000))
        assertEquals(listOf(q2), partial.questions)
        assertEquals("waiting_answer", codexQuestionDisplayStatus("desktop_running", partial))
        val answered = mergeCodexQuestionState(partial, partial.copy(questions = emptyList(), updatedAt = 3_000))
        assertFalse(answered.pending)
        assertEquals("desktop_running", codexQuestionDisplayStatus("desktop_running", answered))
        assertEquals("completed", codexQuestionDisplayStatus("completed", answered))
    }

    @Test fun olderRangesCannotResurrectResolvedQuestionsAndResolutionWinsAtSameTimestamp() {
        val ended = pending.copy(questions = emptyList(), updatedAt = 2_000)
        assertSame(ended, mergeCodexQuestionState(ended, pending))
        assertSame(ended, mergeCodexQuestionState(ended, pending.copy(updatedAt = 2_000)))
        assertFalse(mergeCodexQuestionState(pending, ended).pending)
        assertTrue(mergeCodexQuestionState(ended, pending.copy(askedAt = 3_000, updatedAt = 3_000, turnId = "turn-2")).pending)
    }

    @Test fun persistedNativeQuestionIdsDeduplicateLiveHistoryReplayReconnectionAndPartialReplies() {
        val seen = mutableSetOf<String>()
        val first = unannouncedCodexQuestions(pending, "account-1:connector-1") { it in seen }
        assertEquals(listOf(q1, q2), first)
        first.forEach { seen.add(codexQuestionNoticeKey("account-1:connector-1", it.id)) }
        assertTrue(unannouncedCodexQuestions(pending, "account-1:connector-1") { it in seen }.isEmpty())
        assertTrue(unannouncedCodexQuestions(pending.copy(questions = listOf(q2), updatedAt = 2_000), "account-1:connector-1") { it in seen }.isEmpty())
        val newQuestion = q1.copy(id = "[\"request_user_input_async\",\"new_call\",0]")
        assertEquals(listOf(newQuestion), unannouncedCodexQuestions(pending.copy(questions = listOf(q2, newQuestion)), "account-1:connector-1") { it in seen })
        assertEquals(listOf(q1, q2), unannouncedCodexQuestions(pending, "account-2:connector-1") { it in seen })
    }

    @Test fun unversionedLegacyEventsCannotIntroduceAttentionOrOverwriteAnAuthoritativeState() {
        val legacy = pending.copy(updatedAt = 0)
        assertFalse(mergeCodexQuestionState(null, legacy).pending)
        assertSame(pending, mergeCodexQuestionState(pending, legacy))
        assertEquals("completed", codexQuestionDisplayStatus("completed", null))
    }

    @Test fun queuedOrUncertainAnswerNeverLooksAnsweredAndKeepsDuplicateSubmissionBlocked() {
        for (state in listOf("sending", "dispatching", "pending", "desktop_queued", "uncertain", "failed")) {
            val row = QueuedInstruction("request-1", questionReplyText(q1, "蓝色"), 1_000, state)
            assertTrue(confirmedCodexAnswers(emptyList(), listOf(row)).isEmpty())
            assertTrue(pendingCodexAnswers(listOf(row)).containsKey(q1.id))
            assertFalse(pendingCodexAnswers(listOf(row)).containsKey(q2.id))
        }
    }

    @Test fun onlyARealReceiptOrHistoryConfirmsAnAnswerAndHistoryWinsOverAnOldLocalDraft() {
        val row = QueuedInstruction("request-1", questionReplyText(q1, "蓝色"), 1_000, "steered")
        assertEquals(mapOf(q1.id to "蓝色"), confirmedCodexAnswers(emptyList(), listOf(row)))
        assertTrue(pendingCodexAnswers(listOf(row)).isEmpty())
        val history = listOf(HistoryItem("user-1", 1, "userMessage", questionReplyText(q1, "绿色"), null, false))
        assertEquals(mapOf(q1.id to "绿色"), confirmedCodexAnswers(history, listOf(row.copy(state = "uncertain"))))
        assertTrue(confirmedCodexAnswers(emptyList(), listOf(row.copy(state = "cancelled"))).isEmpty())
    }
}
