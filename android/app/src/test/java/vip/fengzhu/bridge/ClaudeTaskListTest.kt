package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ClaudeTaskListTest {
    private fun item(id: String, order: Long, type: String) = HistoryItem(id, order, type, id, null, false)

    @Test fun stepsSurviveTheEncryptedPayload() {
        val list = parseClaudeTaskList(JSONObject("""{"steps":[{"content":"看公园","status":"completed"},{"content":"定路线","status":"in_progress"},{"content":"","status":"pending"},{"content":"查天气","status":"odd"}]}"""))!!
        assertEquals(listOf("看公园", "定路线", "查天气"), list.steps.map { it.content })
        assertEquals("pending", list.steps.last().status)
        assertEquals(1, list.done); assertEquals("定路线", list.current?.content); assertFalse(list.finished)
        assertNull(parseClaudeTaskList(JSONObject("""{"steps":[]}""")))
    }

    @Test fun theCardMovesToTheEndOfItsTurnAboveTheNextStepBox() {
        val items = listOf(
            item("u1", 1, "userMessage"), item("tasks", 2, "claudeTaskList"), item("cmd", 3, "commandExecution"),
            item("edit", 4, "fileChange"), item("reply", 5, "agentMessage"), item("wrap", 6, "claudeWrapUp"), item("u2", 7, "userMessage"),
        )
        assertEquals(listOf("u1", "cmd", "edit", "reply", "tasks", "wrap", "u2"), withCardsAtTurnEnd(items).map { it.id })
        // The turn's tool calls stay in one group.
        val blocks = groupHistoryItems(items, inlineReasoning = true)
        assertEquals(1, blocks.count { it is HistoryBlock.ActivityGroup })
        // A turn still running: the card stays at the bottom.
        val running = items.take(4)
        assertEquals("tasks", withCardsAtTurnEnd(running).last().id)
    }

    @Test fun theBoxGoesBelowTheClosingWordsButNotBelowLaterWork() {
        // Claude Desktop writes its closing message after the box (2026-10-31).
        val closing = listOf(
            item("u1", 1, "userMessage"), item("edit", 2, "fileChange"), item("tasks", 3, "claudeTaskList"),
            item("wrap", 4, "claudeWrapUp"), item("reply", 5, "agentMessage"),
        )
        assertEquals(listOf("u1", "edit", "reply", "tasks", "wrap"), withCardsAtTurnEnd(closing).map { it.id })
        // A turn the desktop started itself has no user message: its work stays below the older box.
        val later = listOf(item("wrap", 1, "claudeWrapUp"), item("note", 2, "agentMessage"), item("cmd", 3, "commandExecution"), item("done", 4, "agentMessage"))
        assertEquals(listOf("note", "wrap", "cmd", "done"), withCardsAtTurnEnd(later).map { it.id })
    }
}
