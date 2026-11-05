package vip.fengzhu.bridge

import org.json.JSONObject

/** One step of Claude Desktop's task list; [status] is pending, in_progress or completed. */
data class ClaudeTaskStep(val content: String, val status: String)
data class ClaudeTaskList(val steps: List<ClaudeTaskStep>) {
    val done: Int get() = steps.count { it.status == "completed" }
    val current: ClaudeTaskStep? get() = steps.firstOrNull { it.status == "in_progress" }
    val finished: Boolean get() = steps.isNotEmpty() && done == steps.size
}

internal fun parseClaudeTaskList(value: JSONObject?): ClaudeTaskList? {
    val rows = value?.optJSONArray("steps") ?: return null
    val steps = (0 until minOf(rows.length(), 20)).mapNotNull { index ->
        val row = rows.optJSONObject(index) ?: return@mapNotNull null
        val content = (row.opt("content") as? String).orEmpty().trim().take(300)
        val status = row.optString("status").takeIf { it in setOf("pending", "in_progress", "completed") } ?: "pending"
        if (content.isEmpty()) null else ClaudeTaskStep(content, status)
    }
    return if (steps.isEmpty()) null else ClaudeTaskList(steps)
}

/**
 * Claude Desktop pins the task list under the turn's latest output, and draws
 * the next-step box under the closing words Claude writes after it. Both cards
 * keep the order of their first update, so move them to the end of their turn,
 * the box last: the task list then neither splits the turn's activity group nor
 * sits above work done after it, and the box's buttons are at the bottom.
 * The box only moves past closing words: a turn started by the desktop itself
 * (a background task finishing) has no user message, and its work must not
 * pull an older box down.
 */
internal fun withCardsAtTurnEnd(items: List<HistoryItem>): List<HistoryItem> {
    if (items.none { it.type == "claudeTaskList" || it.type == "claudeWrapUp" }) return items
    val result = mutableListOf<HistoryItem>()
    val tasks = mutableListOf<HistoryItem>()
    val boxes = mutableListOf<HistoryItem>()
    fun flush() { result += tasks; result += boxes; tasks.clear(); boxes.clear() }
    for (item in items) {
        when {
            item.type == "claudeTaskList" -> tasks += item
            item.type == "claudeWrapUp" -> boxes += item
            item.type.contains("user", true) -> { flush(); result += item }
            boxes.isNotEmpty() && item.type !in closingWordTypes -> { flush(); result += item }
            else -> result += item
        }
    }
    flush()
    return result
}

private val closingWordTypes = setOf("agentMessage", "reasoning", "hidden")
