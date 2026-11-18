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

/** Pi's request boundaries come from its own message and persisted-entry clocks. */
data class OutputSpeedSample(
    val outputTokens: Long, val durationMs: Long, val completedAt: Long,
    val turnId: String?, val messageId: String,
) {
    fun toFields(): Map<String, Any?> = mapOf("method" to "pi_request_elapsed_v1", "outputTokens" to outputTokens,
        "durationMs" to durationMs, "completedAt" to completedAt, "turnId" to turnId, "messageId" to messageId)
}

/** A native terminal event binds this amount to one final answer, never to a live status guess. */
data class CompletedTurnTokenUsage(
    val turnId: String, val startedAt: Long, val completedAt: Long,
    val finalMessageAt: Long, val finalMessageId: String?,
    val usage: ConversationTokenCounts, val partial: Boolean = false, val finalOutputSpeed: OutputSpeedSample? = null,
    val durationMs: Long? = null, val firstTokenMs: Long? = null,
) {
    val elapsedMs get() = durationMs ?: (completedAt - startedAt)
    fun toFields(): Map<String, Any?> = mapOf(
        "durationMs" to durationMs, "firstTokenMs" to firstTokenMs,
        "turnId" to turnId, "startedAt" to startedAt, "completedAt" to completedAt,
        "finalMessageAt" to finalMessageAt, "finalMessageId" to finalMessageId, "partial" to partial,
        "finalOutputSpeed" to finalOutputSpeed?.toFields(),
        "usage" to mapOf("input" to usage.input, "output" to usage.output, "total" to usage.total,
            "cacheRead" to usage.cacheRead, "cacheWrite" to usage.cacheWrite, "reasoning" to usage.reasoning),
    )
}

data class ConversationTokenUsage(
    val backend: String, val status: String,
    val totals: ConversationTokenCounts? = null, val turn: ConversationTokenCounts? = null,
    val latest: ConversationTokenCounts? = null, val turnActive: Boolean = false, val turnId: String? = null,
    val latestOutputSpeed: OutputSpeedSample? = null,
    val model: String? = null, val updatedAt: Long = 0, val usageUpdatedAt: Long = 0,
    val partial: Boolean = false, val reason: String? = null, val fromCache: Boolean = false,
    val completedTurns: List<CompletedTurnTokenUsage> = emptyList(),
    val measuredReplyMs: Map<String, Long> = emptyMap(),
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
            val backend = text("backend") ?: ""
            val latest = if (supported) tokenCounts(fields["latest"] as? Map<*, *>) else null
            val sourceAt = tokenNumber(fields["usageUpdatedAt"]) ?: 0
            val latestSpeed = if (supported && backend == "pi") outputSpeedSample(fields["latestOutputSpeed"] as? Map<*, *>)?.takeIf {
                it.completedAt == sourceAt && it.outputTokens == latest?.output
            } else null
            return ConversationTokenUsage(
                backend = backend, status = state, totals = total,
                turn = if (supported) tokenCounts(fields["turn"] as? Map<*, *>) else null,
                latest = latest,
                turnActive = fields["turnActive"] == true, turnId = text("turnId"),
                latestOutputSpeed = latestSpeed,
                measuredReplyMs = if (supported && backend == "hermes") (fields["measuredReplyMs"] as? Map<*, *>)?.entries
                    ?.mapNotNull { (id, ms) -> if (id is String && id.isNotBlank()) tokenNumber(ms)?.takeIf { it > 0 }?.let { id to it } else null }
                    ?.takeLast(200)?.toMap().orEmpty() else emptyMap(),
                model = text("model"),
                updatedAt = tokenNumber(fields["updatedAt"]) ?: 0,
                usageUpdatedAt = sourceAt,
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
                    val finalId = (row["finalMessageId"] as? String)?.takeIf { it.isNotBlank() && it != "null" }
                    val speed = if (backend == "pi") outputSpeedSample(row["finalOutputSpeed"] as? Map<*, *>)?.takeIf {
                        it.turnId == id && it.messageId == finalId && it.completedAt in finalAt..end &&
                            it.completedAt - it.durationMs == finalAt && it.outputTokens <= counts.output
                    } else null
                    val duration = tokenNumber(row["durationMs"])?.takeIf { backend == "codex" && it > 0 }
                    val first = tokenNumber(row["firstTokenMs"])?.takeIf { duration != null && it <= duration }
                    CompletedTurnTokenUsage(id, start, end, finalAt, finalId, counts, row["partial"] == true, speed, duration, first)
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

internal fun outputSpeedSample(fields: Map<*, *>?): OutputSpeedSample? {
    fields ?: return null
    if (fields["method"] != "pi_request_elapsed_v1") return null
    val count = tokenNumber(fields["outputTokens"])?.takeIf { it > 0 } ?: return null
    val duration = tokenNumber(fields["durationMs"])?.takeIf { it > 0 } ?: return null
    val completed = tokenNumber(fields["completedAt"])?.takeIf { it >= duration && it - duration >= 1_000_000_000_000L } ?: return null
    val id = (fields["messageId"] as? String)?.takeIf { it.isNotBlank() } ?: return null
    val turn = (fields["turnId"] as? String)?.takeIf { it.isNotBlank() }
    return OutputSpeedSample(count, duration, completed, turn, id)
}

private fun formatOutputRate(outputTokens: Long, durationMs: Long): String {
    val rate = outputTokens.toDouble() * 1_000.0 / durationMs.toDouble()
    return if (rate < 0.01) "<0.01" else NumberFormat.getNumberInstance(Locale.US).apply {
        minimumFractionDigits = 0; maximumFractionDigits = if (rate < 1) 2 else 1
    }.format(rate)
}

internal fun outputSpeedLabel(sample: OutputSpeedSample): String =
    "输出速度约 ${formatOutputRate(sample.outputTokens, sample.durationMs)} Token/秒"

internal fun wholeTurnSpeedLabel(turn: CompletedTurnTokenUsage): String? {
    val durationMs = turn.elapsedMs
    if (turn.partial || turn.startedAt <= 0 || durationMs <= 0 || turn.usage.output <= 0) return null
    return "整轮均速 ${formatOutputRate(turn.usage.output, durationMs)} Token/秒"
}

internal fun liveOutputSpeed(usage: ConversationTokenUsage?, online: Boolean, busy: Boolean, latestUserAt: Long?): OutputSpeedSample? {
    if (usage == null || usage.status != "ready" || !online || !busy || usage.fromCache || !usage.turnActive || usage.turnId.isNullOrBlank()) return null
    return usage.latestOutputSpeed?.takeIf {
        it.turnId == usage.turnId && (latestUserAt == null || latestUserAt <= it.completedAt)
    }
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

internal data class MessageUsageFooter(
    val turn: CompletedTurnTokenUsage?,
    val latestReply: Boolean = false,
    val conversation: ConversationTokenUsage? = null,
    val replySpeed: OutputSpeedSample? = turn?.finalOutputSpeed,
    val textSpeed: String? = null,
) {
    fun summary(unit: TokenDisplayUnit, exact: Boolean = false): String {
        fun count(value: Long) = if (exact) "${formatTokenCount(value)} Token" else formatTokenDisplay(value, unit)
        val round = turn?.let { "本轮${if (it.partial) "已记录" else ""} ${count(it.usage.total)}" }
        val cumulative = conversation?.takeIf { latestReply }?.let { usage ->
            usage.totals?.let { "累计${conversationQualifier(usage)} ${count(it.total)}" }
        }
        val speed = replySpeed?.let { "输出约 ${formatOutputRate(it.outputTokens, it.durationMs)} Token/秒" }
            ?: turn?.let(::wholeTurnSpeedLabel) ?: textSpeed
        return listOfNotNull(round, cumulative, speed).joinToString(if (exact) "，" else " · ")
    }

    private fun conversationQualifier(conversation: ConversationTokenUsage): String =
        when {
            conversation.partial && conversation.fromCache -> "（已记录，缓存）"
            conversation.partial -> "（已记录）"
            conversation.fromCache -> "（缓存）"
            else -> ""
        }
}

/** Visible reply text per wall-clock turn, including tools and waiting. Source timestamps
 * keep this reproducible when the phone opens a conversation after it finished. */
internal fun visibleTurnSpeeds(items: List<HistoryItem>, busy: Boolean, backend: String? = null,
    measuredMs: Map<String, Long> = emptyMap()): Map<String, String> = buildMap {
    var start = 0L
    var answer: HistoryItem? = null
    var count = 0L
    var completeText = true
    fun finish() {
        val final = answer ?: return
        // Hermes can insert the entire exchange in a single SQLite transaction.
        // A Pi assistant timestamp marks request start. Neither clocks the reply.
        val elapsed = measuredMs[final.id] ?: when (backend) {
            "hermes", "pi" -> return
            else -> final.createdAt - start
        }
        if (completeText && start > 0 && elapsed > 0 && count > 0)
            put(final.id, "正文均速 ${formatOutputRate(count, elapsed)} 字符/秒")
    }
    for (item in items) {
        if (item.type == "userMessage") {
            finish()
            start = item.createdAt
            count = 0
            answer = null
            completeText = true
        } else if (item.type == "agentMessage" && start > 0 && item.text.isNotBlank()) {
            if (item.status == "inProgress" || item.id.endsWith("-noreply") || item.id.endsWith("-live")) continue
            completeText = completeText && !item.truncated && item.createdAt >= start
            count += item.text.codePointCount(0, item.text.length)
            answer = item
        }
    }
    if (!busy) finish()
}

/** Clock only incremental growth of the same reply. Opening history or receiving
 * the entire answer in one update supplies no streaming interval. */
internal class LiveTextSpeed {
    private var last = ""
    private var started = 0L
    private var added = 0L
    fun observe(text: String, now: Long): String? {
        if (last.isEmpty() || !text.startsWith(last) || now < started) {
            last = text
            started = now
            added = 0
            return null
        }
        added += text.codePointCount(last.length, text.length)
        last = text
        return if (added > 0 && now > started) "正文输出 ${formatOutputRate(added, now - started)} 字符/秒" else null
    }
}

internal fun messageUsageFooters(
    items: List<HistoryItem>, usage: ConversationTokenUsage?, busy: Boolean, backend: String? = usage?.backend,
): Map<String, MessageUsageFooter> {
    val turns = completedTurnFooters(items, usage)
    val latestReply = if (busy) null else items.lastOrNull { it.type == "agentMessage" || it.type == "userMessage" }
        ?.takeIf { it.type == "agentMessage" }
    val textSpeeds = visibleTurnSpeeds(items, busy, backend, usage?.measuredReplyMs.orEmpty())
    return buildMap {
        textSpeeds.forEach { (id, speed) -> put(id, MessageUsageFooter(turns[id], textSpeed = speed)) }
        turns.forEach { (id, turn) -> put(id, MessageUsageFooter(turn, textSpeed = textSpeeds[id])) }
        latestReply?.let { reply ->
            val turn = turns[reply.id]
            val speed = turn?.finalOutputSpeed ?: usage?.latestOutputSpeed?.takeIf {
                it.messageId == reply.id || it.messageId == reply.sourceMessageId
            }
            put(reply.id, MessageUsageFooter(turn, latestReply = true, conversation = usage, replySpeed = speed, textSpeed = textSpeeds[reply.id]))
        }
    }
}

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
