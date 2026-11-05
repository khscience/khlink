package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class ApprovalStateTest {
    private val pending = ApprovalRequest("0", "item/tool/requestUserInput", "first", "测试", "", 0,
        questions = listOf(ApprovalQuestion("choice", "请选择", allowCustomInput = true)))

    @Test fun lateOrDifferentThreadAcknowledgementsCannotCloseTheCurrentDialog() {
        assertTrue(matchesApproval(pending, "0", "first"))
        assertFalse(matchesApproval(pending, "0", "second"))
        assertFalse(matchesApproval(pending, "old", "first"))
        assertFalse(matchesApproval(pending, null, null))
        assertTrue(matchesApproval(pending, null, "first"))
        assertFalse(matchesApproval(null, "0", "first"))
    }

    @Test fun replayWhileSubmittingPreservesTheSubmitGuardButANewRequestIsIndependent() {
        val submitting = pending.copy(submitting = true)
        assertTrue(mergeApprovalReplay(submitting, pending).submitting)
        assertEquals(pending.questions, mergeApprovalReplay(submitting, pending).questions)
        assertFalse(mergeApprovalReplay(submitting, pending.copy(threadId = "second")).submitting)
        assertFalse(mergeApprovalReplay(submitting, pending.copy(rpcId = "next")).submitting)
    }
}
