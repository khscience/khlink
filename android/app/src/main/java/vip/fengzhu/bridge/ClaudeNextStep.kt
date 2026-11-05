package vip.fengzhu.bridge

import org.json.JSONObject

data class ClaudeNextStepAction(val label: String, val message: String)
data class ClaudeNextStep(val recap: String, val ask: String, val actions: List<ClaudeNextStepAction>, val blocked: Boolean,
    /** The card's heading when it is not the usual next step, e.g. a proposed new session. */
    val title: String = "")

/** A wrap-up may contain only an internal recap, with no user action requested. */
internal fun ClaudeNextStep.isRecapOnly(): Boolean = ask.isBlank() && actions.isEmpty() && !blocked

internal fun claudeNextStepHeading(step: ClaudeNextStep?, active: Boolean): String =
    if (step?.isRecapOnly() == true) "Claude 本轮总结"
    else step?.title?.takeIf { it.isNotBlank() } ?: if (active) "Claude 等你回复" else "Claude 的下一步"

/**
 * Do not show a redundant recap box when Claude also wrote a closing message
 * after it. Keep a standalone recap as a neutral summary so its text is not
 * lost. Never look past a new user message or the next piece of actual work.
 */
internal fun withoutRedundantClaudeRecaps(items: List<HistoryItem>): List<HistoryItem> {
    var answerAhead = false
    val result = ArrayList<HistoryItem>(items.size)
    for (item in items.asReversed()) {
        when (item.type) {
            "agentMessage" -> if (item.text.isNotBlank()) answerAhead = true
            "reasoning", "hidden", "claudeTaskList" -> Unit
            "claudeWrapUp" -> if (answerAhead && item.nextStep?.isRecapOnly() == true) continue
            else -> answerAhead = false
        }
        result.add(item)
    }
    result.reverse()
    return result
}

internal fun parseClaudeNextStep(value: JSONObject?): ClaudeNextStep? {
    if (value == null) return null
    fun string(key: String, max: Int) = (value.opt(key) as? String).orEmpty().trim().take(max)
    val recap = string("recap", 16000)
    val ask = string("ask", 4000)
    val actions = buildList {
        val rows = value.optJSONArray("actions") ?: return@buildList
        for (i in 0 until minOf(rows.length(), 8)) {
            val row = rows.optJSONObject(i) ?: continue
            val label = (row.opt("label") as? String).orEmpty().trim().take(100)
            // A button's label is its reply when no separate message is given.
            val message = if (!row.has("message")) label else row.opt("message") as? String ?: continue
            if (label.isNotEmpty() && message.isNotBlank() && message.length <= 16000) add(ClaudeNextStepAction(label, message))
        }
    }
    return if (recap.isBlank() && ask.isBlank() && actions.isEmpty()) null
    else ClaudeNextStep(recap, ask, actions, value.optBoolean("blocked"), string("title", 100))
}

/**
 * The boxes of the latest turn, in the order the phone shows them. A new user
 * message (including an optimistic send) or new assistant work retires them.
 * Not new work: Claude's closing words after the box (Claude Desktop keeps its
 * buttons; 2026-10-31), and the turn's task list card, checked off by the box
 * and stored after it (connector 0.2.99; 2026-10-26). Hidden rows are not shown
 * at all. A proposed-session card next to the box stays active with it.
 */
internal fun activeClaudeNextSteps(items: List<HistoryItem>): List<HistoryItem> =
    withCardsAtTurnEnd(items).filter { it.type !in setOf("contextCompaction", "claudeTaskList", "hidden") }
        .takeLastWhile { it.type == "claudeWrapUp" }
        .filter { it.status == "completed" && it.nextStep != null && !it.nextStep.isRecapOnly() }

internal fun claudeNextStepDraft(current: String, action: ClaudeNextStepAction): String =
    if (current.isBlank()) action.message else current
