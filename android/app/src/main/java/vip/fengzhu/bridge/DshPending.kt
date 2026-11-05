package vip.fengzhu.bridge

import org.json.JSONObject

/** A live question or approval card waiting in the DSH desktop window. */
data class DshPending(
    val threadId: String = "",
    val kind: String = "question",
    val prompt: String = "",
    val options: List<String> = emptyList(),
)

internal fun parseDshPending(value: JSONObject?): DshPending? {
    value ?: return null
    val options = mutableListOf<String>()
    val array = value.optJSONArray("options")
    if (array != null) for (index in 0 until array.length()) {
        array.optString(index).takeIf { it.isNotBlank() }?.let(options::add)
    }
    if (options.isEmpty()) return null
    return DshPending(
        threadId = value.optString("threadId"),
        kind = value.optString("kind").takeIf { it.isNotBlank() } ?: "question",
        prompt = value.optString("prompt"),
        options = options,
    )
}
