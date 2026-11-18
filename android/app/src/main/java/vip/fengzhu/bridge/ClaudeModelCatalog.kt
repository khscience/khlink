package vip.fengzhu.bridge

import org.json.JSONArray

internal fun parseClaudeModelRows(rows: JSONArray?): List<ClaudeModel> {
    if (rows == null) return emptyList()
    return (0 until rows.length()).mapNotNull { index ->
        val row = rows.optJSONObject(index) ?: return@mapNotNull null
        val value = row.optString("value").takeIf { it.isNotBlank() && it != "null" } ?: return@mapNotNull null
        val efforts = row.optJSONArray("efforts")?.let { array ->
            (0 until array.length()).map { array.optString(it) }.filter { it.isNotBlank() && it != "null" }
        }.orEmpty()
        ClaudeModel(value, row.optString("label").takeUnless { it.isBlank() || it == "null" } ?: value, efforts,
            row.optString("source").takeUnless { it == "null" }.orEmpty())
    }.distinctBy { it.value.lowercase() }
}

// A delayed response from a previously selected computer must not replace the
// current computer's list; old connectors may omit source or revision.
internal fun acceptsClaudeModelSnapshot(selected: String?, target: String?, source: String?, incomingAt: Long, currentAt: Long): Boolean {
    val active = selected?.takeIf { it.isNotBlank() }
    val requested = target?.takeIf { it.isNotBlank() }
    val sender = source?.takeIf { it.isNotBlank() && it != "null" }
    if (active != null && (requested != null && requested != active || sender != null && sender != active)) return false
    if (requested != null && sender != null && requested != sender) return false
    return if (incomingAt <= 0) currentAt <= 0 else incomingAt >= currentAt
}
