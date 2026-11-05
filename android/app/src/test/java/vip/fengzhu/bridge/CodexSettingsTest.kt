package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CodexSettingsTest {
    // Shaped like Codex 0.166's model/list: fast mode only on some models.
    private val caps = CapabilityState(
        models = listOf("gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "tiny"),
        effortsByModel = mapOf(
            "gpt-5.5" to listOf("low", "medium", "high", "xhigh"),
            "gpt-5.4" to listOf("low", "medium", "high", "xhigh"),
            "gpt-5.3-codex" to listOf("low", "medium", "high", "xhigh"),
            "tiny" to listOf("low", "medium"),
        ),
        defaultModel = "gpt-5.5",
        defaultEffortByModel = mapOf("gpt-5.5" to "medium", "gpt-5.4" to "xhigh", "gpt-5.3-codex" to "medium", "tiny" to "low"),
        tiersByModel = mapOf("gpt-5.5" to listOf("fast"), "gpt-5.4" to listOf("fast"), "gpt-5.3-codex" to emptyList(), "tiny" to emptyList()),
    )

    @Test
    fun defaultsResolveToWhatCodexRuns() {
        assertEquals("gpt-5.5", caps.codexDefaultModel())
        assertEquals("medium", caps.codexEffectiveEffort(null, null))
        assertEquals("xhigh", caps.codexEffectiveEffort("gpt-5.4", null))
        assertEquals("high", caps.codexEffectiveEffort("gpt-5.4", "high"))
    }

    @Test
    fun switchingModelKeepsTheEffortInUse() {
        // Left at the default (medium) on gpt-5.5: gpt-5.4 must not jump to its own xhigh.
        assertEquals("medium", caps.effortAfterModelChange(null, "gpt-5.4", null))
        assertEquals("high", caps.effortAfterModelChange("gpt-5.5", "gpt-5.3-codex", "high"))
        // An effort the new model does not offer falls back to that model's default.
        assertNull(caps.effortAfterModelChange("gpt-5.5", "tiny", "xhigh"))
    }

    @Test
    fun fastModeIsOfferedOnlyWhereTheModelHasIt() {
        assertEquals(listOf("fast"), caps.codexSpeedTiers(null))
        assertEquals(listOf("fast"), caps.codexSpeedTiers("gpt-5.4"))
        assertEquals(emptyList<String>(), caps.codexSpeedTiers("gpt-5.3-codex"))
    }

    @Test
    fun olderConnectorsWithoutPerModelTiersKeepTheFlatList() {
        assertEquals(listOf("priority"), CapabilityState(tiers = listOf("priority")).codexSpeedTiers("any"))
    }
}
