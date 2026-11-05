package vip.fengzhu.bridge

import org.json.JSONObject

/** thread.newWithTurn acknowledges both creation and the first instruction. */
fun confirmsNewTaskStart(result: JSONObject): Boolean =
    result.optString("threadId").let { it.isNotBlank() && it != "null" } &&
        result.optJSONObject("requiresConfirmation") == null &&
        listOf("queued", "uncertain", "failed", "pending").none { result.optBoolean(it) }

/** Only this phone's submitted requests can produce a start cue. Queue ACKs,
 * optimistic running states and history snapshots are not start receipts. */
class MessageStartFeedback(saved: Map<String, Long> = emptyMap()) {
    private val pending = saved.toMutableMap()

    @Synchronized
    fun register(key: String, now: Long) {
        pending.entries.removeAll { now - it.value > RETENTION_MS }
        pending[key] = now
        while (pending.size > 256) pending.remove(pending.minBy { it.value }.key)
    }

    @Synchronized
    fun confirm(key: String, state: String, startedAt: Long?, now: Long): Boolean {
        if (state !in setOf("started", "steered") || startedAt == null || startedAt <= 0) return false
        val sentAt = pending.remove(key) ?: return false
        // Consume old receipts too, but do not buzz for an old turn on reconnect.
        // A little clock skew is allowed between the computer and phone.
        return now - sentAt in 0..RETENTION_MS && startedAt >= sentAt - CLOCK_SKEW_MS &&
            now - startedAt in -CLOCK_SKEW_MS..FRESH_RECEIPT_MS
    }

    @Synchronized
    fun snapshot(): Map<String, Long> = pending.toMap()

    companion object {
        private const val CLOCK_SKEW_MS = 15_000L
        private const val FRESH_RECEIPT_MS = 60_000L
        private const val RETENTION_MS = 7 * 24 * 60 * 60 * 1000L
    }
}

/** Explicit low amplitudes; never fall back to Android's default/full strength. */
enum class GentleCue(val durationMs: Long, val amplitude: Int) {
    Tick(10, 28), Started(18, 40), Confirm(14, 32), Reject(18, 40), Attention(20, 40),
}
