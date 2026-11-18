package vip.fengzhu.bridge

import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class ComputerFileTransfersTest {
    @Test fun leavingAndReopeningJoinsTheSameTransferAndReceivesProgress() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transfers = SharedFileTransfers(scope)
            val started = CompletableDeferred<Unit>()
            val finish = CompletableDeferred<Unit>()
            val observed = CompletableDeferred<Long>()
            val starts = AtomicInteger()
            val load: suspend ((Long, Long) -> Unit) -> File = { progress ->
                starts.incrementAndGet(); progress(512, 2048); started.complete(Unit); finish.await(); File("finished.bin")
            }
            val first = async { transfers.await("same-file", { _, _ -> }, load) }
            withTimeout(2_000) { started.await() }
            first.cancelAndJoin() // Leaving the page does not cancel the repository task.
            assertEquals(512L, transfers.progress.value["same-file"]?.received)
            val reopened = async {
                transfers.await("same-file", { received, _ -> if (received > 0) observed.complete(received) }, load)
            }
            assertEquals(512L, withTimeout(2_000) { observed.await() })
            finish.complete(Unit)
            assertEquals("finished.bin", withTimeout(2_000) { reopened.await() }.name)
            assertEquals(1, starts.get())
        } finally { scope.cancel() }
    }

    @Test fun explicitCancelStopsTheSharedTransfer() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transfers = SharedFileTransfers(scope)
            val started = CompletableDeferred<Unit>()
            val wait = CompletableDeferred<Unit>()
            val result = async {
                try {
                    transfers.await("file", { _, _ -> }) { started.complete(Unit); wait.await(); File("unused") }
                    false
                } catch (_: CancellationException) { true }
            }
            withTimeout(2_000) { started.await() }
            transfers.cancel("file")
            assertTrue(withTimeout(2_000) { result.await() })
        } finally { scope.cancel() }
    }

    @Test fun immediateRetryDoesNotJoinTheCancelledTransfer() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transfers = SharedFileTransfers(scope)
            val started = CompletableDeferred<Unit>(); val cleanup = CompletableDeferred<Unit>(); val waiting = CompletableDeferred<Unit>()
            val old = async {
                try {
                    transfers.await("file", { _, _ -> }) {
                        started.complete(Unit)
                        try { waiting.await() } finally { withContext(NonCancellable) { cleanup.await() } }
                        File("old")
                    }
                    false
                } catch (_: CancellationException) { true }
            }
            withTimeout(2_000) { started.await() }
            transfers.cancel("file")
            val newStarted = CompletableDeferred<Unit>(); val finishNew = CompletableDeferred<Unit>()
            val retry = async { transfers.await("file", { _, _ -> }) { newStarted.complete(Unit); finishNew.await(); File("new") } }
            withTimeout(2_000) { newStarted.await() }
            cleanup.complete(Unit)
            assertTrue(withTimeout(2_000) { old.await() })
            assertTrue("the old completion must not erase the new transfer", transfers.progress.value.containsKey("file"))
            finishNew.complete(Unit)
            assertEquals("new", withTimeout(2_000) { retry.await() }.name)
        } finally { scope.cancel() }
    }

    @Test fun separateComputerScopesNeverShareAnActiveTransfer() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transfers = SharedFileTransfers(scope)
            val firstStarted = CompletableDeferred<Unit>(); val secondStarted = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
            val account = fetchedAccountScope("server", "account")
            val one = fetchedFileKey(fetchedFileScope(account, "pc-one")!!, "/video.mp4")
            val two = fetchedFileKey(fetchedFileScope(account, "pc-two")!!, "/video.mp4")
            val a = async { transfers.await(one, { _, _ -> }) { firstStarted.complete(Unit); finish.await(); File("one") } }
            val b = async { transfers.await(two, { _, _ -> }) { secondStarted.complete(Unit); finish.await(); File("two") } }
            withTimeout(2_000) { firstStarted.await(); secondStarted.await() }
            assertEquals(2, transfers.progress.value.size)
            finish.complete(Unit)
            assertEquals("one", a.await().name); assertEquals("two", b.await().name)
        } finally { scope.cancel() }
    }

    @Test fun endingTheAccountSessionCancelsEveryTransfer() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transfers = SharedFileTransfers(scope)
            val firstStarted = CompletableDeferred<Unit>()
            val secondStarted = CompletableDeferred<Unit>()
            val wait = CompletableDeferred<Unit>()
            suspend fun observe(key: String, started: CompletableDeferred<Unit>): Boolean = try {
                transfers.await(key, { _, _ -> }) { started.complete(Unit); wait.await(); File("unused") }
                false
            } catch (_: CancellationException) { true }
            val first = async { observe("account-one", firstStarted) }
            val second = async { observe("account-two", secondStarted) }
            withTimeout(2_000) { firstStarted.await(); secondStarted.await() }
            transfers.cancelAll()
            assertTrue(withTimeout(2_000) { first.await() })
            assertTrue(withTimeout(2_000) { second.await() })
            assertTrue(transfers.progress.value.isEmpty())
        } finally { scope.cancel() }
    }

    @Test fun adaptiveWindowProtectsSlowLinksAndUsesFasterLinks() {
        assertEquals(3, computerFetchParallelism(512 * 1024L, 7_000))
        assertEquals(3, computerFetchParallelism(512 * 1024L, 1_000))
        assertEquals(6, computerFetchParallelism(512 * 1024L, 500))
        assertEquals(8, computerFetchParallelism(512 * 1024L, 200))
        assertEquals(3, computerFetchParallelism(0, 1))
    }

    @Test fun chunkSchedulerIsBoundedAndHandlesLargeOffsets() {
        assertEquals(listOf(512L, 1024L, 1536L), computerChunkOffsets(512, 2200, 512, 3))
        assertEquals(listOf(2048L), computerChunkOffsets(2048, 2200, 512, 8))
        assertEquals(listOf(Long.MAX_VALUE - 1), computerChunkOffsets(Long.MAX_VALUE - 1, Long.MAX_VALUE, 512, 8))
        assertTrue(computerChunkOffsets(0, Long.MAX_VALUE, 512 * 1024, 8).size <= 8)
    }
}
