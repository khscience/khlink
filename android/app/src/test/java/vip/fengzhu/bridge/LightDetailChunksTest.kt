package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

class LightDetailChunksTest {
    private fun part(offset: Int, chunk: String, eof: Boolean, total: Int = 8, nonce: String = "nonce", token: String? = "token") =
        LightDetailPart("row", offset, total, nonce, token, chunk, eof)

    @Test fun reassemblesOnlyOneConsistentSnapshot() {
        val a = LightDetailAssembler("row")
        a.add(part(0, "abcd", false))
        assertEquals(4, a.offset)
        assertEquals("token", a.transferId)
        a.add(part(4, "efgh", true))
        assertTrue(a.complete)
        assertEquals("abcdefgh", a.ciphertext)
        assertEquals("nonce", a.nonce)
    }

    @Test fun rejectsGapsMixedSnapshotsTruncationAndOversizedRows() {
        fun fails(next: LightDetailPart) {
            val a = LightDetailAssembler("row", maxChars = 10)
            a.add(part(0, "abcd", false))
            try { a.add(next); throw AssertionError("accepted invalid chunk") } catch (_: IllegalArgumentException) { }
        }
        fails(part(5, "efg", true))
        fails(part(4, "efgh", true, nonce = "different"))
        fails(part(4, "efgh", true, token = "different"))
        fails(part(4, "efg", true))
        fails(part(4, "efgh", true, total = 11))
        fails(part(4, "e!gh", true))
    }

    @Test fun legacyFallbackKeepsTextButRequiresUpdateForImages() {
        assertTrue(unsupportedLightDetailParts("Unsupported action: file.historyDetailPart"))
        assertTrue(unsupportedLightDetailParts("Pi 暂不支持这个操作：file.historyDetailPart"))
        assertFalse(unsupportedLightDetailParts("连接中断"))
        val item = HistoryItem("id", 1, "commandExecution", "", null, false)
        assertTrue(legacyLightDetailSafe(item))
        assertFalse(legacyLightDetailSafe(item.copy(type = "imageGeneration")))
        assertFalse(legacyLightDetailSafe(item.copy(type = "imageView")))
    }

    @Test fun pendingScansContinueUntilReadyWithoutLosingTheResult() = runBlocking {
        var requests = 0
        var pauses = 0
        val result = retryPendingLightDetail(maxAttempts = 4, pause = { pauses++ }) {
            requests++
            (requests < 3) to "result-$requests"
        }
        assertEquals("result-3", result)
        assertEquals(3, requests)
        assertEquals(2, pauses)
    }

    @Test fun pendingScansAreBoundedAndRespectCancellation() = runBlocking {
        var requests = 0
        try {
            retryPendingLightDetail(maxAttempts = 3, pause = {}) { requests++; true to "pending" }
            throw AssertionError("unbounded search")
        } catch (error: IllegalStateException) {
            assertTrue(error.message.orEmpty().contains("稍后重试"))
        }
        assertEquals(3, requests)
        try {
            retryPendingLightDetail(maxAttempts = 3, pause = { throw CancellationException("left the conversation") }) { true to "pending" }
            throw AssertionError("cancellation ignored")
        } catch (_: CancellationException) { }
    }

    @Test fun leavingAConversationCancelsOnlyItsOwnFetches() {
        val jobs = LightDetailFetchJobs()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val a = scope.launch(start = CoroutineStart.LAZY) { awaitCancellation() }
        val b = scope.launch(start = CoroutineStart.LAZY) { awaitCancellation() }
        val other = scope.launch(start = CoroutineStart.LAZY) { awaitCancellation() }
        jobs.add("one", a); jobs.add("one", b); jobs.add("two", other)
        a.start(); b.start(); other.start()
        jobs.cancel("one")
        assertTrue(a.isCancelled)
        assertTrue(b.isCancelled)
        assertFalse(other.isCancelled)
        jobs.cancel("two")
        assertTrue(other.isCancelled)
    }
}
