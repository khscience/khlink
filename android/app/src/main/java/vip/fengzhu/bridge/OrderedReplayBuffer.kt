package vip.fengzhu.bridge

import java.util.TreeMap

/** Keeps live, durable frames behind the reconnect replay without delaying
 * ephemeral presence frames. Overflow abandons the socket so the saved cursor
 * can be replayed again; no buffered frame is silently discarded. */
internal class OrderedReplayBuffer<T>(
    private val maxFrames: Int = 1024,
    private val maxBytes: Long = 8L * 1024 * 1024,
) {
    private val pending = TreeMap<Long, Pair<T, Int>>()
    private var pendingBytes = 0L
    private var buffering = true
    private var closed = false

    @Synchronized fun offer(sequence: Long, value: T, bytes: Int, apply: (T) -> Unit): Boolean {
        if (closed) return false
        if (sequence <= 0L || !buffering) { apply(value); return true }
        if (pending.containsKey(sequence)) return true
        if (pending.size >= maxFrames || bytes < 0 || pendingBytes + bytes > maxBytes) return false
        pending[sequence] = value to bytes
        pendingBytes += bytes
        return true
    }

    @Synchronized fun replay(value: T, apply: (T) -> Unit): Boolean {
        if (closed) return false
        apply(value)
        return true
    }

    @Synchronized fun finish(apply: (T) -> Unit): Boolean {
        if (closed) return false
        pending.values.forEach { (value, _) -> apply(value) }
        pending.clear(); pendingBytes = 0L; buffering = false
        return true
    }

    @Synchronized fun abort() {
        closed = true
        pending.clear(); pendingBytes = 0L
    }
}

/** Relay sequence numbers can have gaps for other devices/accounts. */
internal fun replayPageFinished(pageSize: Int, pageLimit: Int, lastPageSequence: Long, snapshotSequence: Long?): Boolean =
    pageSize < pageLimit || (snapshotSequence != null && lastPageSequence >= snapshotSequence)

/**
 * Where event replay starts. A device that has seen nothing yet starts a
 * bounded window before the relay's current sequence instead of at zero.
 */
internal fun freshReplayStart(lastSequence: Long, snapshotSequence: Long?, window: Long): Long =
    if (lastSequence > 0L || snapshotSequence == null || snapshotSequence <= window) lastSequence
    else snapshotSequence - window
