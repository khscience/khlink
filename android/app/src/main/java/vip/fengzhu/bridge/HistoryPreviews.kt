package vip.fengzhu.bridge

internal const val HISTORY_PREVIEW_THREADS = 4
internal const val HISTORY_PREVIEW_ROWS = 24

internal data class HistoryPreviewKey(val threadId: String, val connectorId: String, val updatedAt: Long)

internal fun ThreadSummary.historyPreviewKey(selectedConnectorId: String?) =
    HistoryPreviewKey(id, connectorId.ifBlank { selectedConnectorId.orEmpty() }, updatedAt)

internal fun visibleHistoryPreviews(rowKeys: List<Any>, threads: Map<String, HistoryPreviewKey>): List<HistoryPreviewKey> =
    rowKeys.asSequence().filterIsInstance<String>().mapNotNull { key ->
        threads[key] ?: when {
            key.startsWith("recent-") -> threads[key.removePrefix("recent-")]
            key.startsWith("archived-") -> threads[key.removePrefix("archived-")]
            else -> null
        }
    }.distinct().take(HISTORY_PREVIEW_THREADS).toList()

/** Only the currently visible list observers populate this in-memory snapshot. */
internal class HistoryPreviews {
    private val rows = LinkedHashMap<HistoryPreviewKey, List<HistoryItem>>()

    @Synchronized fun get(key: HistoryPreviewKey): List<HistoryItem>? = rows[key]

    @Synchronized fun put(key: HistoryPreviewKey, items: List<HistoryItem>) {
        if (items.isEmpty()) {
            rows.remove(key)
            return
        }
        if (key !in rows && rows.size == HISTORY_PREVIEW_THREADS) rows.remove(rows.keys.first())
        rows[key] = items.takeLast(HISTORY_PREVIEW_ROWS)
    }

    @Synchronized fun remove(key: HistoryPreviewKey) { rows.remove(key) }

    private val missingRequests = LinkedHashMap<String, Long>()

    /** At most four extra cold conversations per minute across all list tabs. */
    @Synchronized fun reserveMissing(threadId: String, now: Long): Boolean {
        missingRequests.entries.removeAll { now - it.value >= 60_000L }
        if (threadId in missingRequests || missingRequests.size >= HISTORY_PREVIEW_THREADS) return false
        missingRequests[threadId] = now
        return true
    }

    @Synchronized fun clear() {
        rows.clear()
        missingRequests.clear()
    }
}
