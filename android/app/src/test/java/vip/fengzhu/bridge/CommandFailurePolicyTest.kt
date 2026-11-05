package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class CommandFailurePolicyTest {
    @Test
    fun onlyKnownUnsentCodexQueueItemsCanBePromotedDuringATurn() {
        assertTrue(canSteerQueuedInstruction("codex", "pending", "mobile", true))
        assertFalse(canSteerQueuedInstruction("codex", "pending", "mobile", false))
        listOf("uncertain", "dispatching", "started", "failed").forEach {
            assertFalse(it, canSteerQueuedInstruction("codex", it, "mobile", true))
        }
        assertFalse(canSteerQueuedInstruction("codex", "pending", "desktop", true))
        assertFalse(canSteerQueuedInstruction("claude", "pending", "mobile", true))
        assertFalse(canSteerQueuedInstruction("antigravity", "desktop_queued", "mobile", true))
        assertTrue(canSteerQueuedInstruction("claude", "desktop_queued", "mobile", true))
    }
    @Test
    fun pausedQueueExplanationIsVisibleWithoutMarkingTheMessageFailed() {
        val paused = "电脑端队列因中断而暂停，请在电脑上处理；消息仍在队列中"
        assertEquals(paused, visibleQueuedInstructionReason("desktop_queued", paused))
        assertEquals(null, visibleQueuedInstructionReason("desktop_queued", "等当前这一轮结束后发送"))
        assertEquals("请检查", visibleQueuedInstructionReason("uncertain", "请检查"))
        assertEquals(null, visibleQueuedInstructionReason("failed", ""))
    }
    @Test
    fun missingAcknowledgementDoesNotProveAMessageFailedForAnyAgent() {
        listOf("turn.start", "turn.steer", "followup.enqueue").forEach {
            assertEquals(it, "uncertain", instructionAckTimeoutState(it))
        }
        assertEquals("failed", instructionAckTimeoutState("thread.settings.read"))
        assertEquals("failed", instructionAckTimeoutState(null))
    }
    @Test
    fun backgroundReadsNeverRaiseTheDialog() {
        listOf("thread.settings.read", "history.sync", "followup.list", "capabilities", "backends.capabilities", "claude.usage", "thread.ownership.read", "file.upload.chunk", "accounts.read")
            .forEach { assertFalse(it, shouldShowCommandFailure(it)) }
    }

    @Test
    fun aFileTheDialogAlreadyExplainsIsNotRepeated() {
        assertFalse(shouldShowCommandFailure("file.read"))
        assertFalse(shouldShowCommandFailure("file.historyDetailPart"))
        assertFalse(shouldShowCommandFailure("history.details"))
    }

    @Test
    fun aResultThisPhoneDidNotAskForIsNotShown() {
        assertFalse(shouldShowCommandFailure(null))
    }

    @Test
    fun whatTheUserAskedForStillSaysWhyItFailed() {
        listOf("turn.start", "turn.steer", "settings.set", "pi.start", "thread.rename", "turn.stop", "file.list")
            .forEach { assertTrue(it, shouldShowCommandFailure(it)) }
    }

    @Test
    fun piAndAntigravityThreadsHaveNoSettingsToRead() {
        assertFalse(backendHasThreadSettings("pi"))
        assertFalse(backendHasThreadSettings("antigravity"))
        assertTrue(backendHasThreadSettings("codex"))
        assertTrue(backendHasThreadSettings("claude"))
        assertTrue(backendHasThreadSettings(null))
    }

    @Test
    fun archiveIsReportedOnlyOnceTheComputerDidIt() {
        assertEquals("已归档「Acknowledgment」，要恢复请在电脑端的归档里取消归档", archiveDoneMessage(true, " Acknowledgment ", null))
        assertEquals("已取消归档「Acknowledgment」", archiveDoneMessage(false, "Acknowledgment", ""))
        assertEquals("已取消归档（电脑端侧边栏的筛选停在了「已归档」，请在电脑上切回）", archiveDoneMessage(false, "", "电脑端侧边栏的筛选停在了「已归档」，请在电脑上切回"))
        assertEquals("已取消归档", archiveDoneMessage(false, "", "null"))
    }
}
