package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopWaitingTest {
    private fun thread(id: String, cwd: String, at: Long) = ThreadSummary(id, id, cwd, "idle", at, false, "c")

    @Test
    fun recentFoldersFoldWorktreesIntoTheirProjectNewestFirst() {
        val dirs = recentWorkdirs(listOf(
            thread("a", "I:\\qmt5\\code", 1),
            thread("b", "I:\\qmt5\\code\\.claude\\worktrees\\kind-montalcini-635e0d", 5),
            thread("c", "D:\\work", 3),
            thread("d", "", 9),
        ))
        assertEquals(listOf("I:\\qmt5\\code", "D:\\work"), dirs)
        assertEquals("code", folderName("I:\\qmt5\\code\\"))
    }

    @Test
    fun permissionsQuestionsAndPlansCanAllBeAnsweredFromThePhone() {
        val single = DesktopWaiting("question", "AskUserQuestion", "r1", questions = listOf(WaitingQuestion("哪个？", options = listOf(WaitingOption("A")))))
        val multi = single.copy(questions = listOf(WaitingQuestion("哪些？", multiSelect = true, options = listOf(WaitingOption("A")))))
        val permission = DesktopWaiting("permission", "Bash", "r2", summary = "ls")
        assertTrue(single.answerable)
        assertTrue(multi.answerable)
        assertTrue(permission.answerable)
        assertFalse(permission.copy(requestId = "").answerable)
        assertTrue(DesktopWaiting("plan", "ExitPlanMode", "r3", summary = "计划").answerable)
        assertEquals("问你：哪个？", waitingPreview(single))
        assertEquals("等你批准 Bash：ls", waitingPreview(permission))
    }

    @Test
    fun aSingleChoiceTakesExactlyOneAnswerAndAMultiSelectAtLeastOne() {
        val single = WaitingQuestion("哪个？", options = listOf(WaitingOption("A"), WaitingOption("B")))
        val multi = single.copy(multiSelect = true)
        assertFalse(isCompleteAnswer(single, QuestionAnswer(emptyList())))
        assertTrue(isCompleteAnswer(single, QuestionAnswer(listOf("A"))))
        assertTrue(isCompleteAnswer(single, QuestionAnswer(emptyList(), "自己写的")))
        assertFalse(isCompleteAnswer(single, QuestionAnswer(listOf("A"), "还有这个")))
        assertTrue(isCompleteAnswer(multi, QuestionAnswer(listOf("A", "B"), "再加一个")))
        assertFalse(isCompleteAnswer(multi, QuestionAnswer(emptyList(), "  ")))
    }
}
