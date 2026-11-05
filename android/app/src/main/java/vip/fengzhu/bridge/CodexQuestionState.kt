package vip.fengzhu.bridge

import org.json.JSONObject

/** Attention to an unanswered question, independent of whether Codex is executing tools. */
data class CodexQuestionState(
    val threadId: String, val questions: List<CodexQuestion>, val itemId: String,
    val askedAt: Long, val updatedAt: Long, val turnId: String? = null,
) {
    val pending: Boolean get() = questions.isNotEmpty()
    fun prompt() = CodexQuestionPrompt(threadId, itemId, questions)
}

internal fun parseCodexQuestionState(threadId: String, payload: JSONObject?): CodexQuestionState? {
    payload ?: return null
    val at = payload.optLong("updatedAt", payload.optLong("askedAt"))
    if (at <= 0) return null
    val questions = if (payload.optBoolean("pending", true)) parseCodexQuestions(payload.optJSONArray("questions")) else emptyList()
    return CodexQuestionState(threadId, questions, payload.optString("itemId"), payload.optLong("askedAt"), at,
        payload.optString("turnId").takeIf { it.isNotBlank() && it != "null" })
}

internal fun mergeCodexQuestionState(previous: CodexQuestionState?, next: CodexQuestionState): CodexQuestionState {
    if (next.updatedAt <= 0) return previous ?: next.copy(questions = emptyList())
    if (previous != null && (next.updatedAt < previous.updatedAt ||
        next.updatedAt == previous.updatedAt && !previous.pending && next.pending)) return previous
    return next
}

internal fun codexQuestionDisplayStatus(executionStatus: String, question: CodexQuestionState?): String =
    if (question?.pending == true && (isTurnBusyStatus(executionStatus) || isCompactingThreadStatus(executionStatus))) "waiting_answer" else executionStatus

internal fun shouldAlertCodexQuestion(askedAt: Long, liveSince: Long, notify: Boolean) = notify && askedAt >= liveSince

internal fun codexQuestionNoticeKey(namespace: String, id: String): String = "codexQuestionNotice:" +
    java.security.MessageDigest.getInstance("SHA-256").digest("$namespace|$id".toByteArray()).joinToString("") { "%02x".format(it) }

internal fun unannouncedCodexQuestions(state: CodexQuestionState, namespace: String, wasAnnounced: (String) -> Boolean): List<CodexQuestion> =
    state.questions.filter { !wasAnnounced(codexQuestionNoticeKey(namespace, it.id)) }

/** Queue acceptance is not an answer receipt. Only real history or a successful
 * steer/start can turn the question into "已回答". Keep uncertain rows blocked
 * until the user checks or removes the existing send, avoiding duplicate replies. */
internal fun confirmedCodexAnswers(history: List<HistoryItem>, outgoing: List<QueuedInstruction>): Map<String, String> =
    (outgoing.filter { it.state in setOf("started", "steered") }.map { it.text } + history.map { it.text })
        .flatMap(::parseQuestionReplies).associate { it.id to it.answer }

internal fun pendingCodexAnswers(outgoing: List<QueuedInstruction>): Map<String, String> =
    outgoing.filter { it.state !in setOf("started", "steered", "cancelled") }.flatMap { item ->
        val label = when (item.state) {
            "uncertain" -> "回答是否送达尚未确认，请检查对话；不会自动重发"
            "failed" -> "回答发送失败，请先处理下方的待发送消息"
            "pending", "desktop_queued" -> "回答仍在电脑队列中，尚未送达当前任务"
            else -> "正在发送回答…"
        }
        parseQuestionReplies(item.text).map { it.id to label }
    }.toMap()

/** An option answer is an explicit send-now action, independent of stale
 * running badges or a live-question snapshot cleared at turn completion. */
internal fun submitCodexQuestionAnswer(question: CodexQuestion, answer: String,
    outgoing: List<QueuedInstruction>, sendNow: (String) -> Boolean): Boolean {
    if (answer.isBlank() || question.id in pendingCodexAnswers(outgoing) ||
        question.id in confirmedCodexAnswers(emptyList(), outgoing)) return false
    return sendNow(questionReplyText(question, answer))
}

/** A desktop prompt answered from the phone stays closed while the computer
 * handles the answer; a different question (another request id) shows again. */
internal fun desktopPromptAnswered(answeredRequestId: String?, waitingRequestId: String?): Boolean =
    answeredRequestId != null && (waitingRequestId == null || waitingRequestId == answeredRequestId)
