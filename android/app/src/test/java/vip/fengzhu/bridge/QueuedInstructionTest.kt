package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QueuedInstructionTest {
    @Test fun explicitQueueSurvivesAnOlderConnectorsNonblockingReceiptAndSnapshotReplay() {
        val local = QueuedInstruction("queued", "等上一轮结束再做", 100, "pending", queueRequested = true)
        val receipt = local.copy(state = "desktop_queued", blocking = false, queueRequested = false, stateVersion = 1)
        for (item in listOf(mergeQueuedInstruction(local, receipt), mergeQueuedInstruction(receipt, local))) {
            assertTrue(showInstructionInQueue(item))
            assertTrue(mergeTransientUserInstructions(emptyList(), listOf(item)).isEmpty())
        }
    }
    @Test fun actualExecutionReceiptMovesOneExplicitQueueItemInlineAndReplayCannotMoveItBack() {
        val waiting = QueuedInstruction("queued", "下一轮", 100, "desktop_queued", queueRequested = true)
        val started = mergeQueuedInstruction(waiting, waiting.copy(state = "started", startedAt = 200, stateVersion = 2))
        assertFalse(showInstructionInQueue(started))
        assertEquals("sent", mergeTransientUserInstructions(emptyList(), listOf(started)).single().status)
        val replay = mergeQueuedInstruction(started, waiting.copy(stateVersion = 3))
        assertFalse(showInstructionInQueue(replay)); assertEquals("started", replay.state)
    }
    @Test fun queueIntentDoesNotLeakToAnotherRequestOrHideFailureRecovery() {
        val queue = QueuedInstruction("one", "先排队", 100, queueRequested = true)
        val other = QueuedInstruction("two", "立即引导", 101, "sending", blocking = false)
        assertFalse(showInstructionInQueue(mergeQueuedInstruction(queue, other)))
        assertTrue(showInstructionInQueue(other.copy(state = "uncertain")))
        assertTrue(showInstructionInQueue(other.copy(state = "failed")))
        assertFalse(showInstructionInQueue(queue.copy(state = "cancelled")))
        assertTrue(mergeTransientUserInstructions(emptyList(), listOf(queue.copy(state = "cancelled"))).isEmpty())
    }
    @Test fun attachmentReceiptsAcceptBothVisibleBrandNamesFromOlderAndNewerConnectors() {
        val queued = QueuedInstruction("image", "", 100, "desktop_queued", attachments = listOf(QueuedAttachment("截图.png", attachmentId = "known-id")))
        for (brand in listOf("KH Link", "khLink")) {
            val real = HistoryItem("image-row", 122000, "userMessage", "[$brand 图片附件] 截图.png", null, false, createdAt = 122)
            assertTrue(isQueuedInstructionDelivered(queued, listOf(real)))
            assertFalse(isQueuedInstructionDelivered(queued, listOf(real.copy(text = "[$brand 图片附件] 另一张.png"))))
        }
    }
    @Test fun picturesSentAloneMatchClaudesImageOnlyMessageAndNeverShowAnEmptyBubble() {
        val sent = QueuedInstruction("pic", "", 100, "started", attachments = listOf(QueuedAttachment("IMG_2031.jpg", attachmentId = "a1")), historyAfterOrder = 50)
        assertEquals("[图片]", mergeTransientUserInstructions(emptyList(), listOf(sent)).single().text)
        assertEquals("[图片] ×2", outboundBubbleText(sent.copy(attachments = sent.attachments + QueuedAttachment("b.jpg"))))
        // With the picture still on the phone, the bubble shows it instead of the words.
        val local = sent.copy(attachments = listOf(QueuedAttachment("IMG_2031.jpg", mimeType = "image/jpeg", localUri = "content://media/1")))
        val shown = mergeTransientUserInstructions(emptyList(), listOf(local)).single()
        assertEquals("", shown.text); assertEquals(listOf("content://media/1"), shown.localImages)
        assertEquals(emptyList<String>(), outboundLocalImages(local.copy(attachments = listOf(QueuedAttachment("report.pdf", localUri = "content://x")))))
        // As the phone really sends it: the words "图片附件", and the computer's receipt without the phone's URI.
        val real = local.copy(text = "图片附件", state = "sending", attachments = listOf(QueuedAttachment("IMG_2031.jpg", mimeType = "image/jpeg", attachmentId = "a1", localUri = "content://media/1")))
        val acked = mergeQueuedInstruction(real, real.copy(state = "started", attachments = listOf(QueuedAttachment("IMG_2031.jpg", mimeType = "image/jpeg", attachmentId = "a1"))))
        val bubble = mergeTransientUserInstructions(emptyList(), listOf(acked)).single()
        assertEquals("", bubble.text); assertEquals(listOf("content://media/1"), bubble.localImages)
        assertEquals("[图片]", outboundBubbleText(real.copy(attachments = listOf(QueuedAttachment("IMG_2031.jpg")))))
        assertTrue(isQueuedInstructionDelivered(acked, listOf(HistoryItem("u0", 60, "userMessage", "", null, false))))
        val claude = HistoryItem("u1", 60, "userMessage", "", null, false, images = listOf(HistoryImage("AAAA", "image/jpeg")))
        assertTrue(isQueuedInstructionDelivered(sent, listOf(claude)))
        assertTrue(mergeTransientUserInstructions(listOf(claude), listOf(sent)).none { it.id.startsWith("outbound:") })
        assertTrue(isQueuedInstructionDelivered(sent, listOf(claude.copy(text = "图片附件", images = emptyList()))))
        // Only a message after the request counts, and one with words is another message.
        assertFalse(isQueuedInstructionDelivered(sent, listOf(claude.copy(order = 40))))
        assertFalse(isQueuedInstructionDelivered(sent, listOf(claude.copy(text = "看看这张图"))))
    }
    @Test fun steeringAcceptanceLeavesTheQueueImmediatelyAndAnOldSnapshotCannotAddItBack() {
        val queued = QueuedInstruction("promote", "change direction", 100, "pending", blocking = true, stateVersion = 10)
        val accepted = mergeQueuedInstruction(queued, queued.copy(state = "steered", startedAt = 150))
        assertFalse(accepted.blocking)
        assertEquals("steered", mergeTransientUserInstructions(emptyList(), listOf(accepted)).single().status)
        val replay = mergeQueuedInstruction(accepted, queued.copy(stateVersion = 20))
        assertFalse(replay.blocking); assertEquals("steered", replay.state)
    }

    @Test fun aLateAckWithoutANewVersionResolvesWatchdogUncertainty() {
        val uncertain = QueuedInstruction("late", "hello", 100, "uncertain", "ACK timeout", blocking = true, stateVersion = 20)
        val accepted = mergeQueuedInstruction(uncertain, uncertain.copy(state = "started", startedAt = 150))
        assertEquals("started", accepted.state); assertFalse(accepted.blocking); assertEquals(null, accepted.reason)
        assertEquals("sent", mergeTransientUserInstructions(emptyList(), listOf(accepted)).single().status)
    }
    @Test fun confirmedReceiptResolvesAnOlderUncertainState() {
        val uncertain = QueuedInstruction("receipt", "hello", 100, "uncertain", "需要确认", stateVersion = 200)
        val confirmed = uncertain.copy(state = "started", reason = null, stateVersion = 300, blocking = false)
        assertEquals(confirmed, mergeQueuedInstruction(uncertain, confirmed))
        assertEquals(confirmed, mergeQueuedInstruction(confirmed, uncertain))
    }

    @Test
    fun followsLatestOnlyWhenListIsSettledNearBottom() {
        assertTrue(shouldFollowLatestMessage(0, 0, false))
        assertTrue(shouldFollowLatestMessage(1, 40, false))
        assertFalse(shouldFollowLatestMessage(2, 0, false))
        assertFalse(shouldFollowLatestMessage(0, 160, false))
        assertFalse(shouldFollowLatestMessage(0, 0, true))
    }

    @Test
    fun latestAnchorOnlyHidesAtTheLatestMessage() {
        assertTrue(isAtLatestContent(0, 0))
        assertTrue(isAtLatestContent(0, 20))
        assertFalse(isAtLatestContent(0, 24))
        assertFalse(isAtLatestContent(1, 0))
    }

    @Test
    fun serverQueueStateSurvivesAndroidRecreation() {
        val queued = QueuedInstruction("request-1", "下一条", 100, "desktop_queued")
        assertEquals("request-1", queued.id)
        assertEquals("desktop_queued", queued.state)
    }

    @Test
    fun uncertainDeliveryKeepsItsReason() {
        val queued = QueuedInstruction("request-2", "调整方向", 200, "uncertain", "需要电脑确认")
        assertEquals("uncertain", queued.state)
        assertEquals("需要电脑确认", queued.reason)
    }

    @Test
    fun startedInstructionAppearsInlineUntilRealHistoryArrives() {
        val started = QueuedInstruction("request-3", "已经发出", 100, "started", startedAt = 120, blocking = false)
        val optimistic = mergeTransientUserInstructions(emptyList(), listOf(started))
        assertEquals(1, optimistic.size)
        assertEquals("outbound:request-3", optimistic.single().id)
        assertEquals("sent", optimistic.single().status)

        val real = HistoryItem("real-1", 121000, "userMessage", "已经发出", null, false, createdAt = 121)
        assertEquals(listOf(real), mergeTransientUserInstructions(listOf(real), listOf(started)))
    }

    @Test
    fun deliveredInstructionMatchingIgnoresWhitespaceFormatting() {
        val started = QueuedInstruction("request-4", "第一行\n\n第二行", 100, "started", startedAt = 120, blocking = false)
        val real = HistoryItem("real-2", 121000, "userMessage", "第一行  第二行", null, false, createdAt = 121)
        assertEquals(listOf(real), mergeTransientUserInstructions(listOf(real), listOf(started)))
        assertEquals("第一行 第二行", normalizeInstructionText(started.text))
    }

    @Test
    fun pendingInstructionIsRemovedOnlyAfterRealUserHistoryAppears() {
        val real = HistoryItem("real-3", 122000, "userMessage", "已送达", null, false, createdAt = 122)
        assertTrue(isQueuedInstructionDelivered(QueuedInstruction("request-5", "已送达", 100, "pending"), listOf(real)))
        assertFalse(isQueuedInstructionDelivered(QueuedInstruction("request-6", "未送达", 100, "pending"), listOf(real)))
        assertFalse(isQueuedInstructionDelivered(QueuedInstruction("request-7", "已送达", 100, "failed"), listOf(real)))
    }

    @Test
    fun deliveredInstructionMatchesDesktopContextPrefix() {
        val queued = QueuedInstruction("request-context", "请继续处理这个任务并给出结论", 100, "desktop_queued")
        val real = HistoryItem(
            "real-context", 122000, "userMessage",
            "<environment_context>desktop metadata</environment_context> 请继续处理这个任务并给出结论",
            null, false, createdAt = 122,
        )
        assertTrue(isQueuedInstructionDelivered(queued, listOf(real)))
        assertEquals(listOf(real), mergeTransientUserInstructions(listOf(real), listOf(queued.copy(state = "started", blocking = false))))
    }

    @Test
    fun nonBlockingDesktopQueuedInstructionAppearsInlineAsSending() {
        // A message routed through the Desktop-owned enqueue/dispatch path for
        // writer-conflict safety, but not actually waiting behind a busy turn,
        // must render as an inline "发送中" bubble, not the bottom "待发送" box.
        val item = QueuedInstruction("request-fast", "你好", 100, "desktop_queued", blocking = false)
        val optimistic = mergeTransientUserInstructions(emptyList(), listOf(item))
        assertEquals(1, optimistic.size)
        assertEquals("sending", optimistic.single().status)
    }

    @Test fun olderIdenticalMessageCannotAcknowledgeANewRequest() {
        val pending = QueuedInstruction("new", "继续", 200, "sending", blocking = false)
        val old = HistoryItem("old", 10, "userMessage", "继续", null, false, createdAt = 100)
        val fresh = old.copy(id = "fresh", order = 20, createdAt = 210)
        assertFalse(isQueuedInstructionDelivered(pending, listOf(old)))
        assertTrue(isQueuedInstructionDelivered(pending, listOf(old, fresh)))
        assertFalse(isQueuedInstructionDelivered(pending, listOf(old.copy(createdAt = 0))))
    }

    @Test fun knownHistoryBoundarySurvivesReceiptsAndProtectsRepeatedMessages() {
        val pending = QueuedInstruction("new", "继续", 200, "sending", blocking = false, historyAfterOrder = 10)
        val received = mergeQueuedInstruction(pending, pending.copy(state = "started", historyAfterOrder = null))
        val old = HistoryItem("old", 10, "userMessage", "继续", null, false)
        assertEquals(10L, received.historyAfterOrder)
        assertFalse(isQueuedInstructionDelivered(received, listOf(old)))
        assertTrue(isQueuedInstructionDelivered(received, listOf(old.copy(id = "new", order = 20))))
        assertFalse(isQueuedInstructionDelivered(received, listOf(old.copy(id = "outbound:new", order = 20))))
    }

    @Test fun confirmedEmptyHistoryUsesAnOrderBoundaryEvenWhenTheComputerClockIsBehind() {
        val loaded = HistoryLoadState(threadId = "test", loading = false, loadedPages = 1, hasMore = false)
        val boundary = queuedInstructionHistoryBoundary("test", emptyList(), loaded, syncing = false)
        assertEquals(-1L, boundary)
        val sent = QueuedInstruction("first", "你好", 10_000L, "started", blocking = false, historyAfterOrder = boundary)
        val actual = HistoryItem("real", 9_700L, "userMessage", "你好", null, false, createdAt = 9_700L)
        assertTrue(isQueuedInstructionDelivered(sent, listOf(actual)))
        assertEquals(listOf(actual), mergeTransientUserInstructions(listOf(actual), listOf(sent)))
    }

    @Test fun unknownHistoryNeverPretendsAnOldIdenticalMessageIsNew() {
        val loaded = HistoryLoadState(threadId = "test", loading = false, loadedPages = 1, hasMore = false)
        assertNull(queuedInstructionHistoryBoundary("test", emptyList(), loaded.copy(loadedPages = 0), syncing = false))
        assertNull(queuedInstructionHistoryBoundary("test", emptyList(), loaded.copy(hasMore = true), syncing = false))
        assertNull(queuedInstructionHistoryBoundary("test", emptyList(), loaded, syncing = true))
        assertNull(queuedInstructionHistoryBoundary("different", emptyList(), loaded, syncing = false))
        val previous = HistoryItem("old", 100L, "agentMessage", "旧回答", null, false, createdAt = 100L)
        val boundary = queuedInstructionHistoryBoundary("test", listOf(previous), loaded, syncing = false)
        assertEquals(100L, boundary)
        val sent = QueuedInstruction("new", "继续", 10_000L, "started", blocking = false, historyAfterOrder = boundary)
        assertFalse(isQueuedInstructionDelivered(sent, listOf(previous.copy(id = "older-user", order = 99L, type = "userMessage", text = "继续"))))
        assertTrue(isQueuedInstructionDelivered(sent, listOf(previous.copy(id = "new-user", order = 101L, type = "userMessage", text = "继续", createdAt = 9_700L))))
    }

    @Test
    fun aMessageSentNowStaysInTheConversationUnlessItReallyWaitsBehindATurn() {
        val sentAt = 1_000_000L
        // On its way: a "发送中" bubble in the conversation.
        val sending = QueuedInstruction("request-blocked", "你好", 100, "sending", blocking = false, sentAt = sentAt)
        assertFalse(showInstructionInQueue(sending, sentAt))
        assertEquals("sending", mergeTransientUserInstructions(emptyList(), listOf(sending), sentAt).single().status)
        assertTrue(isOutboundInFlight("sending")); assertFalse(isOutboundInFlight("sent"))
        // The computer passes it through its queue (its receipt carries no send time):
        // for the first moment it stays a "发送中" bubble, never flashing through the panel.
        val queued = mergeQueuedInstruction(sending, sending.copy(state = "desktop_queued", blocking = true, stateVersion = 1, sentAt = 0L))
        assertEquals(sentAt, queued.sentAt)
        assertFalse(showInstructionInQueue(queued, sentAt + 1_500))
        assertEquals("sending", mergeTransientUserInstructions(emptyList(), listOf(queued), sentAt + 1_500).single().status)
        // Still queued after the settle time: it is really waiting behind a turn.
        assertTrue(showInstructionInQueue(queued, sentAt + QUEUE_SETTLE_MS))
        assertTrue(mergeTransientUserInstructions(emptyList(), listOf(queued), sentAt + QUEUE_SETTLE_MS).isEmpty())
        // A steer the computer could not put into the running turn says why: the panel at once.
        assertTrue(showInstructionInQueue(queued.copy(reason = "当前阶段不能调整方向"), sentAt + 100))
        // Queued on purpose, or read back without a send time: the panel at once.
        assertTrue(showInstructionInQueue(queued.copy(queueRequested = true), sentAt + 100))
        assertTrue(showInstructionInQueue(queued.copy(sentAt = 0L), sentAt + 100))
        // Really sent: in the conversation, and a replay cannot pull it out again.
        val started = mergeQueuedInstruction(queued, queued.copy(state = "started", startedAt = 200, stateVersion = 2))
        assertFalse(showInstructionInQueue(started, sentAt + QUEUE_SETTLE_MS))
        assertFalse(showInstructionInQueue(mergeQueuedInstruction(started, queued.copy(stateVersion = 3)), sentAt + QUEUE_SETTLE_MS))
    }

    @Test
    fun replayedQueuedStateCannotRegressStartedInstruction() {
        val started = QueuedInstruction("request-order", "已开始", 100, "started", startedAt = 120)
        val replayed = started.copy(state = "desktop_queued", reason = null)
        val merged = mergeQueuedInstruction(started, replayed)
        assertEquals("started", merged.state)
        assertEquals(120L, merged.startedAt)
    }

    @Test
    fun internalContextIsNotRenderedAsAUserMessage() {
        assertEquals(true, isInternalContextMessage("<environment_context>hidden</environment_context>"))
        assertEquals(false, isInternalContextMessage("请解释 environment_context"))
    }

    @Test
    fun connectorPresenceMustBeRecent() {
        val now = 100_000L
        assertTrue(isFreshConnectorPresence(99_000L, now))
        assertFalse(isFreshConnectorPresence(79_999L, now))
        assertFalse(isFreshConnectorPresence(106_000L, now))
        assertFalse(isFreshConnectorPresence(0L, now))
    }
}
