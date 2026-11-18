package vip.fengzhu.bridge

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

internal data class ComputerTransferProgress(val received: Long = 0, val total: Long = 0)

/** A page observes a transfer; it does not own the transfer's lifetime. */
internal class SharedFileTransfers(private val scope: CoroutineScope) {
    private data class Entry(val task: Deferred<File>, val updates: MutableStateFlow<ComputerTransferProgress>)
    private val lock = Any()
    private val entries = mutableMapOf<String, Entry>()
    private val _progress = MutableStateFlow<Map<String, ComputerTransferProgress>>(emptyMap())
    val progress: StateFlow<Map<String, ComputerTransferProgress>> = _progress

    suspend fun await(key: String, listener: (Long, Long) -> Unit,
        fetch: suspend ((Long, Long) -> Unit) -> File): File = coroutineScope {
        val entry = synchronized(lock) {
            entries[key] ?: run {
                val updates = MutableStateFlow(ComputerTransferProgress())
                lateinit var created: Entry
                val task = scope.async(start = CoroutineStart.LAZY) {
                    fetch { received, total ->
                        synchronized(lock) {
                            if (entries[key] === created) {
                                val next = ComputerTransferProgress(received, total)
                                updates.value = next
                                _progress.value = _progress.value + (key to next)
                            }
                        }
                    }
                }
                created = Entry(task, updates)
                entries[key] = created
                _progress.value = _progress.value + (key to updates.value)
                task.invokeOnCompletion {
                    synchronized(lock) {
                        if (entries[key] === created) {
                            entries.remove(key)
                            _progress.value = _progress.value - key
                        }
                    }
                }
                created
            }
        }
        entry.task.start()
        val observer = launch { entry.updates.collect { listener(it.received, it.total) } }
        try { entry.task.await() } finally { observer.cancel() }
    }

    fun cancel(key: String) {
        val task = synchronized(lock) {
            val removed = entries.remove(key)
            if (removed != null) _progress.value = _progress.value - key
            removed?.task
        }
        task?.cancel()
    }

    fun cancelAll() {
        val tasks = synchronized(lock) {
            val old = entries.values.map { it.task }
            entries.clear(); _progress.value = emptyMap()
            old
        }
        tasks.forEach { it.cancel() }
    }
}

/** Keep the old three-chunk limit on slow links; widen only when the last batch was fast. */
internal fun computerFetchParallelism(bytes: Long, elapsedMs: Long): Int {
    if (bytes <= 0) return 3
    val bytesPerSecond = bytes.toDouble() * 1_000 / elapsedMs.coerceAtLeast(1)
    return when {
        bytesPerSecond >= 2 * 1024 * 1024 -> 8
        bytesPerSecond >= 768 * 1024 -> 6
        else -> 3
    }
}

/** Only allocate one small batch, even for multi-gigabyte files. */
internal fun computerChunkOffsets(start: Long, total: Long, step: Long, count: Int): List<Long> {
    require(start >= 0 && total >= start && step > 0 && count in 1..8)
    val result = ArrayList<Long>(count)
    var next = start
    while (next < total && result.size < count) {
        result.add(next)
        next += minOf(step, total - next)
    }
    return result
}
