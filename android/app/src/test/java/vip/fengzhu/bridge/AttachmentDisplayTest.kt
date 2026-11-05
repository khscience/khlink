package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentDisplayTest {
    private val id = "3c1c407c-2155-4b43-a761-ed68203b1b0f"
    private val windowsPath = "C:\\Users\\test\\Temp\\FengzhuAgentBridge\\uploads\\thread\\$id-说明.txt"
    private val linuxPath = "/tmp/FengzhuAgentBridge/uploads/thread/$id-说明.txt"

    @Test fun hidesGeneratedPathsAndOpaqueIdsButKeepsTheFilename() {
        val heading = "[风筑附件] 说明.txt (27 bytes)"
        assertEquals("请处理\n\n$heading", displayUploadReferences("请处理\n\n$heading\n路径：$windowsPath"))
        assertEquals(heading, displayUploadReferences("$heading\r\n路径：$linuxPath"))
        assertEquals(heading, displayUploadReferences("$heading\n附件编号：$id"))
        assertEquals("$heading\n\n$heading", displayUploadReferences("$heading\n路径：$windowsPath\n\n$heading\n附件编号：$id"))
    }

    @Test fun preservesUserTextAndUnrelatedPaths() {
        val inputs = listOf(
            "我的路径：$windowsPath",
            "[风筑附件] 说明.txt\n路径：C:\\Users\\test\\说明.txt",
            "[附件] 说明.txt\n路径：/tmp/其他目录/说明.txt",
            "[附件] 说明.txt\n附件编号：not-an-id",
            "[附件] 说明.txt\n附件编号：$id-自定义后缀",
        )
        inputs.forEach { assertEquals(it, displayUploadReferences(it)) }
    }

    @Test fun attachmentOnlyQueueRowsRemainIdentifiable() {
        val item = QueuedInstruction("q", "", 1, attachments = listOf(QueuedAttachment("说明.txt")))
        assertEquals("附件：说明.txt", queuedInstructionDisplay(item))
        assertEquals("[风筑附件] 说明.txt", queuedInstructionDisplay(item.copy(text = "[风筑附件] 说明.txt\n路径：$windowsPath")))
    }

    @Test fun opaqueIdStillReconcilesAttachmentOnlyQueueWithoutMatchingAnotherFile() {
        val item = QueuedInstruction("q", "", 100, attachments = listOf(QueuedAttachment("说明.txt", attachmentId = id)), historyAfterOrder = 10)
        val history = HistoryItem("real", 20, "userMessage", "[风筑附件] 说明.txt\n附件编号：$id", null, false)
        assertTrue(isQueuedInstructionDelivered(item, listOf(history)))
        assertFalse(isQueuedInstructionDelivered(item, listOf(history.copy(text = history.text.replace(id, "other-id")))))
    }
}
