package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GeneratedImagePlacementTest {
    private val generated = HistoryImage("data:image/png;base64,abc1234567890")
    private val ordinary = HistoryImage("data:image/png;base64,ordinary123456")

    @Test
    fun fetchedLightImageIsPlacedAtTheEndOfTheAnswer() {
        val user = HistoryItem("u", 1, "userMessage", "画图", null, false)
        val answer = HistoryItem("a", 2, "agentMessage", "已生成", "completed", false)
        val placeholder = HistoryItem("g", 3, "imageGeneration", "", "completed", false, light = true)
        val fetched = placeholder.copy(light = false, text = "图片已生成", images = listOf(generated))
        val result = hydrateLightDetailsAndPlaceImages(listOf(user, answer, placeholder), mapOf("g" to fetched))
        assertEquals(listOf("u", "a"), result.map { it.id })
        assertEquals(listOf(generated), result.last().generatedImages)
    }

    @Test
    fun movesGeneratedImagesToTheEndOfTheSameAnswer() {
        val result = deferGeneratedImagesToAnswerEnd(listOf(
            HistoryItem("u", 1, "userMessage", "画一张图", null, false),
            HistoryItem("reasoning", 2, "reasoning", "思考", "completed", false, images = listOf(ordinary)),
            HistoryItem("a1", 3, "agentMessage", "这是回答", "completed", false),
            HistoryItem("g", 4, "imageGeneration", "图片已生成", "completed", false, images = listOf(generated)),
        ))

        assertEquals(listOf("u", "reasoning", "a1"), result.map { it.id })
        assertEquals(listOf(generated), result.last().generatedImages)
        assertEquals(listOf(ordinary), result[1].images)
    }

    @Test
    fun doesNotMoveOrdinaryImageViews() {
        val item = HistoryItem("view", 1, "imageView", "查看图片", "completed", false, images = listOf(ordinary))
        val result = deferGeneratedImagesToAnswerEnd(listOf(item))
        assertEquals(listOf(item), result)
        assertTrue(result.single().generatedImages.isEmpty())
    }

    @Test
    fun collectsMultipleGeneratedImagesIntoTheFinalAssistantChunk() {
        val result = deferGeneratedImagesToAnswerEnd(listOf(
            HistoryItem("u", 1, "userMessage", "开始", null, false),
            HistoryItem("a1", 2, "agentMessage", "先说", "completed", false),
            HistoryItem("g1", 3, "imageGeneration", "图片已生成", "completed", false, images = listOf(generated)),
            HistoryItem("a2", 4, "agentMessage", "最后补充", "completed", false),
            HistoryItem("g2", 5, "imageGeneration", "图片已生成", "completed", false, images = listOf(ordinary)),
        ))
        assertEquals(listOf("u", "a1", "a2"), result.map { it.id })
        assertEquals(emptyList<HistoryImage>(), result[1].generatedImages)
        assertEquals(listOf(generated, ordinary), result[2].generatedImages)
    }

    @Test
    fun removesDuplicateGeneratedPayloadsPublishedByTwoDesktopEvents() {
        val result = deferGeneratedImagesToAnswerEnd(listOf(
            HistoryItem("u", 1, "userMessage", "开始", null, false),
            HistoryItem("a", 2, "agentMessage", "完成", "completed", false),
            HistoryItem("event", 3, "imageGeneration", "图片已生成", "completed", false, images = listOf(generated)),
            HistoryItem("tool", 4, "imageGeneration", "图片已生成", "completed", false, images = listOf(generated)),
        ))
        assertEquals(listOf(generated), result.last().generatedImages)
    }
}
