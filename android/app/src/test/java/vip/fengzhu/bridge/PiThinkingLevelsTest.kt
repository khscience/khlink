package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class PiThinkingLevelsTest {
    private val plain = PiModel("openai", "gpt-plain", "Plain", 128_000, reasoning = false)
    private val thinking = PiModel("anthropic", "claude-think", "Think", 200_000, reasoning = true)

    @Test
    fun aModelThatDoesNotReasonOffersOnlyOff() {
        assertEquals(listOf("off"), piThinkingLevelsFor(plain, listOf("off", "low", "high")))
        assertEquals(listOf("off"), piThinkingLevelsFor(plain, emptyList()))
    }

    @Test
    fun aReasoningModelOffersTheLevelsTheSessionReportsInPiOrder() {
        assertEquals(
            listOf("off", "low", "high", "xhigh"),
            piThinkingLevelsFor(thinking, listOf("xhigh", "high", "off", "low", "high")),
        )
    }

    @Test
    fun aReasoningModelFallsBackToTheCommonLevelsWhenTheSessionModelDoesNotReason() {
        assertEquals(listOf("off", "minimal", "low", "medium", "high"), piThinkingLevelsFor(thinking, listOf("off")))
        assertEquals(listOf("off", "minimal", "low", "medium", "high"), piThinkingLevelsFor(null, emptyList()))
    }

    @Test
    fun aModelSwitchKeepsTheLevelWhenTheModelOffersIt() {
        assertEquals("high", piNearestThinkingLevel("high", listOf("off", "low", "high")))
    }

    @Test
    fun aLevelTheModelLacksMovesUpFirstLikePi() {
        // "minimal" is not offered: pi takes the next level up before any lower one.
        assertEquals("low", piNearestThinkingLevel("minimal", listOf("off", "low", "high")))
        // "xhigh" is not offered by a model that stops at "high".
        assertEquals("high", piNearestThinkingLevel("xhigh", listOf("off", "minimal", "low", "medium", "high")))
    }

    @Test
    fun aLevelAboveEverythingOfferedFallsBackDown() {
        assertEquals("high", piNearestThinkingLevel("max", listOf("off", "low", "high")))
    }

    @Test
    fun aModelWithNoOfferedLevelFallsBackToOff() {
        assertEquals("off", piNearestThinkingLevel("low", emptyList()))
        assertEquals("off", piNearestThinkingLevel("unknown", listOf("off")))
    }
}
