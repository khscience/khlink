package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UserInputModelTest {
    @Test
    fun customAndMultipleChoiceRetainSemanticValues() {
        val answer = UserInputAnswer(selected = setOf("desktop", "__custom__"), customText = "tablet")
        assertEquals(setOf("desktop", "__custom__"), answer.selected)
        assertEquals("tablet", answer.customText)
    }

    @Test
    fun inputQuestionCanDescribeItsRequiredSelectionRules() {
        val question = ApprovalQuestion(
            id = "target",
            text = "Choose devices",
            options = listOf(ApprovalChoice("desktop", "Desktop"), ApprovalChoice("__custom__", "Other", custom = true)),
            multiple = true,
            allowCustomInput = true,
        )
        assertTrue(question.required)
        assertTrue(question.multiple)
        assertTrue(question.options.last().custom)
        assertFalse(question.detail.isNotEmpty())
    }
}
