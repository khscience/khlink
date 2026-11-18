package vip.fengzhu.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClaudeModelCatalogTest {
    @Test fun keepsNewObservedModelAndOnlyItsReportedEfforts() {
        val rows = JSONArray()
            .put(JSONObject().put("value", "opus").put("label", "Opus 5.5").put("efforts", JSONArray().put("high")))
            .put(JSONObject().put("value", "claude-fable-5-2").put("label", "Fable 5.2 · 桌面会话").put("source", "desktop-session").put("efforts", JSONArray().put("medium")))
        val models = parseClaudeModelRows(rows)
        assertEquals(listOf("opus", "claude-fable-5-2"), models.map { it.value })
        assertEquals(listOf("medium"), models.last().efforts)
        assertEquals("desktop-session", models.last().source)
    }

    @Test fun rejectsLateOrDifferentComputerSnapshotsButAcceptsLegacyFrames() {
        assertTrue(acceptsClaudeModelSnapshot("pc2", "pc2", "pc2", 30, 20))
        assertFalse(acceptsClaudeModelSnapshot("pc2", "pc1", "pc1", 30, 20))
        assertFalse(acceptsClaudeModelSnapshot("pc2", "pc2", "pc1", 30, 20))
        assertFalse(acceptsClaudeModelSnapshot("pc2", "pc2", "pc2", 19, 20))
        assertFalse(acceptsClaudeModelSnapshot("pc2", null, null, 0, 20))
        assertTrue(acceptsClaudeModelSnapshot("pc2", null, null, 0, 0))
    }
}
