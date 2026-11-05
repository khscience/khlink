package vip.fengzhu.bridge

import org.json.JSONObject
import org.json.JSONArray
import java.text.NumberFormat
import java.util.Locale
import java.math.BigDecimal
import java.math.RoundingMode

enum class TokenDisplayUnit(val id: String, val label: String, val divisor: Long) {
    Millions("m", "M", 1_000_000), TenThousands("wan", "万", 10_000);
    companion object { fun fromStored(value: String?): TokenDisplayUnit = entries.firstOrNull { it.id == value } ?: TenThousands }
}

/** Counts are inclusive: cache is part of input; reasoning is part of output. */
data class ConversationTokenCounts(
    val input: Long, val output: Long, val total: Long,
    val cacheRead: Long? = null, val cacheWrite: Long? = null, val reasoning: Long? = null,
)

/** A native terminal event binds this amount to one final answer, never to a live status guess. */
data class CompletedTurnTokenUsage(
    val turnId: String, val startedAt: Long, val completedAt: Long,
    val finalMessageAt: Long, val finalMessageId: String?,
    val usage: ConversationTokenCounts, val partial: Boolean = false,
) {
    fun toFields(): Map<String, Any?> = mapOf(
        "turnId" to turnId, "startedAt" to startedAt, "completedAt" to completedAt,
        "finalMessageAt" to finalMessageAt, "finalMessageId" to finalMessageId, "partial" to partial,
        "usage" to mapOf("input" to usage.input, "output" to usage.output, "total" to usage.total,
            "cacheRead" to usage.cacheRead, "cacheWrite" to usage.cacheWrite, "reasoning" to usage.reasoning),
    )
}

data class ConversationTokenUsage(
    val backend: String, val status: String,
    val totals: ConversationTokenCounts? = null, val turn: ConversationTokenCounts? = null,
    val latest: ConversationTokenCounts? = null, val turnActive: Boolean = false,
    val model: String? = null, val updatedAt: Long = 0, val usageUpdatedAt: Long = 0,
    val partial: Boolean = false, val reason: String? = null, val fromCache: Boolean = false,
    val completedTurns: List<CompletedTurnTokenUsage> = emptyList(),
) {
    companion object {
        fun fromFields(fields: Map<String, Any?>): ConversationTokenUsage {
            fun text(key: String) = (fields[key] as? String)?.takeIf { it.isNotBlank() && it != "null" }
            val supported = (fields["schemaVersion"] as? Number)?.toInt() == 1
            val total = if (supported) tokenCounts(fields["totals"] as? Map<*, *>) else null
            val requested = text("status")
            val state = when {
                !supported -> "unavailable"
                requested == "ready" && total != null -> "ready"
                requested == "scanning" -> "scanning"
                else -> "unavailable"
            }
            return ConversationTokenUsage(
                backend = text("backend") ?: "", status = state, totals = total,
                turn = if (supported) tokenCounts(fields["turn"] as? Map<*, *>) else null,
                latest = if (supported) tokenCounts(fields["latest"] as? Map<*, *>) else null,
                turnActive = fields["turnActive"] == true, model = text("model"),
                updatedAt = tokenNumber(fields["updatedAt"]) ?: 0,
                usageUpdatedAt = tokenNumber(fields["usageUpdatedAt"]) ?: 0,
                partial = fields["partial"] == true,
                reason = if (!supported) "电脑连接器需要更新后才能读取用量" else text("reason"),
                completedTurns = if (supported) (fields["completedTurns"] as? List<*>)?.mapNotNull {
                    val row = it as? Map<*, *> ?: return@mapNotNull null
                    val id = (row["turnId"] as? String)?.takeIf(String::isNotBlank) ?: return@mapNotNull null
                    val start = tokenNumber(row["startedAt"]) ?: return@mapNotNull null
                    val end = tokenNumber(row["completedAt"]) ?: return@mapNotNull null
                    val finalAt = tokenNumber(row["finalMessageAt"]) ?: return@mapNotNull null
                    if (start <= 0 || finalAt < start || end < finalAt) return@mapNotNull null
                    val counts = tokenCounts(row["usage"] as? Map<*, *>) ?: return@mapNotNull null
                    CompletedTurnTokenUsage(id, start, end, finalAt,
                        (row["finalMessageId"] as? String)?.takeIf { it.isNotBlank() && it != "null" }, counts, row["partial"] == true)
                }?.takeLast(200).orEmpty() else emptyList(),
            )
        }

        fun fromJson(json: JSONObject): ConversationTokenUsage {
            fun valueFields(value: Any?): Any? = when (value) {
                is JSONObject -> value.keys().asSequence().associateWith { valueFields(value.opt(it)) }
                is JSONArray -> (0 until value.length()).map { valueFields(value.opt(it)) }
                else -> value
            }
            @Suppress("UNCHECKED_CAST")
            return fromFields(valueFields(json) as Map<String, Any?>)
        }
    }
}

private fun tokenNumber(value: Any?): Long? = (value as? Number)?.let {
    // Do not truncate fractions, overflow Long or turn unknown data into zero.
    val number = it.toDouble()
    if (number.isFinite() && number >= 0 && number <= 9_007_199_254_740_991.0 && number == it.toLong().toDouble()) it.toLong() else null
}

internal fun tokenCounts(fields: Map<*, *>?): ConversationTokenCounts? {
    fields ?: return null
    val input = tokenNumber(fields["input"]) ?: return null
    val output = tokenNumber(fields["output"]) ?: return null
    val total = tokenNumber(fields["total"]) ?: return null
    if (total != input + output) return null
    val read = tokenNumber(fields["cacheRead"])
    val write = tokenNumber(fields["cacheWrite"])
    val reasoning = tokenNumber(fields["reasoning"])
    if ((read ?: 0) + (write ?: 0) > input || (reasoning ?: 0) > output) return null
    return ConversationTokenCounts(input, output, total, read, write, reasoning)
}

internal fun mergeConversationUsage(previous: ConversationTokenUsage?, next: ConversationTokenUsage): ConversationTokenUsage {
    if (previous == null || previous.backend != next.backend) return next
    if (previous.status == "ready" && next.status != "ready")
        return previous.copy(fromCache = true, reason = next.reason ?: "暂时无法更新用量")
    // Replayed events or scans finishing out of order cannot replace newer
    // source data. Compare log timestamps, never phone receipt time.
    if (next.updatedAt < previous.updatedAt || next.usageUpdatedAt < previous.usageUpdatedAt) return previous
    val completed = (previous.completedTurns + next.completedTurns).groupBy { it.turnId }
        .values.map { entries -> entries.reduce { old, current -> if (current.completedAt >= old.completedAt) current else old } }
        .sortedBy { it.completedAt }.takeLast(200)
    return next.copy(completedTurns = completed)
}

/** Match source identity first; time is only for older connectors without source ids. */
internal fun completedTurnFooters(items: List<HistoryItem>, usage: ConversationTokenUsage?): Map<String, CompletedTurnTokenUsage> {
    usage ?: return emptyMap()
    val answers = items.filter { it.type == "agentMessage" }
    return buildMap {
        usage.completedTurns.forEach { turn ->
            val answer = if (turn.finalMessageId != null)
                answers.filter { it.id == turn.finalMessageId || it.sourceMessageId == turn.finalMessageId }.maxByOrNull { it.order }
            else answers.filter { historyItemTimestamp(it) == turn.finalMessageAt }.maxByOrNull { it.order }
            if (answer != null) put(answer.id, turn)
        }
    }
}

internal fun completedTurnTokenLabel(turn: CompletedTurnTokenUsage, unit: TokenDisplayUnit): String =
    "${if (turn.partial) "已记录" else "消耗"} ${formatTokenDisplay(turn.usage.total, unit)}"

internal fun formatTokenCount(value: Long?): String = value?.let { NumberFormat.getIntegerInstance(Locale.US).format(it) } ?: "—"

internal fun formatTokenDisplay(value: Long?, unit: TokenDisplayUnit): String {
    if (value == null) return "—"
    // Tiny positive values retain enough digits to never look like zero.
    val places = when {
        value >= unit.divisor -> 2
        value >= unit.divisor / 100 -> 4
        unit == TokenDisplayUnit.Millions -> 6
        else -> 4
    }
    val scaled = BigDecimal.valueOf(value).divide(BigDecimal.valueOf(unit.divisor), places, RoundingMode.HALF_UP)
    val format = NumberFormat.getNumberInstance(Locale.US).apply { maximumFractionDigits = places; minimumFractionDigits = 0 }
    return "${format.format(scaled)} ${unit.label}"
}
