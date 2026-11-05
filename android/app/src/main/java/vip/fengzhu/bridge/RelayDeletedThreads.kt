package vip.fengzhu.bridge

import org.json.JSONArray

/** Conversations the relay deleted (history clean-up): id to deletion time, from the first threads page. */
internal fun parseDeletedThreads(rows: JSONArray?): Map<String, Long> = buildMap {
    for (index in 0 until (rows?.length() ?: 0)) {
        val row = rows?.optJSONObject(index) ?: continue
        val id = row.optString("id").takeIf { it.isNotBlank() } ?: continue
        put(id, row.optLong("deletedAt"))
    }
}

/** Which of the phone's conversations to drop: deleted on the relay, and not active since. */
internal fun threadsDeletedOnRelay(deleted: Map<String, Long>, threads: List<ThreadSummary>): Set<String> =
    threads.filter { thread -> deleted[thread.id]?.let { thread.updatedAt <= it } == true }.map { it.id }.toSet()
