package vip.fengzhu.bridge

import java.text.Collator
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal fun codexEventStatus(method: String, turnStatus: String = ""): String? = when {
    Regex("turn/(started|resumed)$", RegexOption.IGNORE_CASE).containsMatchIn(method) -> "mobile_running"
    Regex("turn/completed$", RegexOption.IGNORE_CASE).containsMatchIn(method) -> when {
        Regex("fail|error", RegexOption.IGNORE_CASE).containsMatchIn(turnStatus) -> "failed"
        Regex("cancel|abort|interrupt", RegexOption.IGNORE_CASE).containsMatchIn(turnStatus) -> "cancelled"
        else -> "completed"
    }
    Regex("turn/failed$", RegexOption.IGNORE_CASE).containsMatchIn(method) -> "failed"
    Regex("turn/(cancelled|aborted|interrupted)$", RegexOption.IGNORE_CASE).containsMatchIn(method) -> "cancelled"
    else -> null
}

private val localImageBlockRegex = Regex(
    """<image\b[^>]*>.*?</image\s*>""",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)
private val localImageTagRegex = Regex("""<image\b[^>]*/?>""", RegexOption.IGNORE_CASE)
private val localImageClosingTagRegex = Regex("""</image\s*>""", RegexOption.IGNORE_CASE)
private val requestMarkerRegex = Regex(
    """\n?\n?\[KH_LINK_REQUEST_ID:[0-9a-f-]{36}]\s*$""",
    RegexOption.IGNORE_CASE,
)
// Since connector 0.2.57 the request id is written in zero-width characters (invisible on the desktop).
private val invisibleRequestMarkerRegex = Regex("\u2063[\u200B\u200C\u200D\u2060]{64}\u2063")

/**
 * Removes protocol-only localImage markup before history is rendered.  Codex
 * may echo the Windows path used by the background adapter; that path is not
 * user content and must never be shown on the phone.  Keep the remaining
 * attachment context (filename/id) intact.
 */
fun sanitizeHistoryText(value: String): String = value
    .replace(localImageBlockRegex, "")
    .replace(localImageTagRegex, "")
    .replace(localImageClosingTagRegex, "")
    .replace(requestMarkerRegex, "")
    .replace(invisibleRequestMarkerRegex, "")
    .replace(Regex("\\n{3,}"), "\\n\\n")
    .trim()

fun containsLocalImageMarkup(value: String): Boolean = localImageBlockRegex.containsMatchIn(value) || localImageTagRegex.containsMatchIn(value) || localImageClosingTagRegex.containsMatchIn(value)

data class ThreadSummary(
    val id: String,
    val title: String,
    val cwd: String,
    val status: String,
    val updatedAt: Long,
    val archived: Boolean,
    val connectorId: String,
    val pinned: Boolean = false,
    val pinOrder: Int = -1,
    val unread: Boolean = false,
    val backend: String = "codex",
    /** What the computer is waiting for (Claude: the desktop's "needs action"). */
    val note: String = "",
    /** Claude: the session is open in the desktop app, which owns its settings. */
    val desktopLive: Boolean = false,
    /** Claude: what the desktop prompt is about, when it is waiting for you. */
    val waiting: DesktopWaiting? = null,
    /** Pi: "provider/model" of the session (PI WEB owns the choice). */
    val model: String = "",
    /** When this phone last opened the session (or marked everything read). */
    val phoneReadAt: Long = 0,
    /** Verified conversation time, excluding Desktop settings/index changes. */
    val activityAt: Long? = null,
    val codexQuestions: CodexQuestionState? = null,
    /** Claude: the desktop's own session id ("local_…") when it differs from [id]; links in replies point at it. */
    val desktopId: String = "",
)

fun mergeThreadActivityAt(fresh: ThreadSummary, known: ThreadSummary): Long =
    if (fresh.activityAt != null) maxOf(fresh.activityAt, known.activityAt ?: 0L)
    else maxOf(fresh.updatedAt, known.updatedAt)

/** How old (computer's time) a status event may be and still start or end a turn on the phone. */
const val STALE_STATUS_EVENT_MS = 5 * 60 * 1000L

/** A replayed status event from long ago: it must not start, time or announce a turn. */
fun isStaleStatusEvent(eventAt: Long, now: Long): Boolean = eventAt > 0 && now - eventAt > STALE_STATUS_EVENT_MS

/**
 * A connector can deliver an older running slice after the terminal event for
 * the same turn.  The turn id is the durable identity needed to discard that
 * replay instead of reopening the green running indicator.
 */
internal fun isSameTurnStatusReplay(lastTerminalTurnId: String?, incomingTurnId: String?): Boolean =
    !lastTerminalTurnId.isNullOrBlank() && !incomingTurnId.isNullOrBlank() && lastTerminalTurnId == incomingTurnId

/** A busy status for a turn that has already emitted its terminal event. */
internal fun shouldIgnoreBusyStatusReplay(status: String, lastTerminalTurnId: String?, incomingTurnId: String?): Boolean =
    isTurnBusyStatus(status) && isSameTurnStatusReplay(lastTerminalTurnId, incomingTurnId)

/** How long a finished session stays in "recent" if it is not opened on the phone. */
const val FINISHED_HIGHLIGHT_MS = 12 * 60 * 60 * 1000L

/**
 * Finished with activity the phone has not seen yet. The computer's own unread
 * mark is not enough: it never marks the session the user is looking at there.
 */
fun isFinishedUnseen(thread: ThreadSummary, status: String, now: Long = System.currentTimeMillis()): Boolean =
    isCompletedThreadStatus(status) && thread.updatedAt > thread.phoneReadAt &&
        now - thread.updatedAt in 0 until FINISHED_HIGHLIGHT_MS

/**
 * Finished and not looked at yet, within [FINISHED_HIGHLIGHT_MS]: the green dot
 * on a row, and exactly the finished rows that lead the list. Older unread
 * marks stay quiet so days-old tasks do not crowd the top.
 */
fun isFinishedHighlight(thread: ThreadSummary, status: String, now: Long = System.currentTimeMillis()): Boolean =
    now - thread.updatedAt in 0 until FINISHED_HIGHLIGHT_MS &&
        ((thread.unread && isCompletedThreadStatus(status)) || isFinishedUnseen(thread, status, now))

/** The home tab a thread belongs to: "codex", "dsh", "claude", "hermes", "pi" or "antigravity". */
fun backendTab(backend: String): String = when (backend) { "claude", "pi", "antigravity", "dsh", "hermes" -> backend; else -> "codex" }


/** One model PI WEB offers for a session. */
data class PiModel(val provider: String, val id: String, val name: String, val contextWindow: Long, val reasoning: Boolean) {
    val key: String get() = "$provider/$id"
}

/** One model of a Pi relay provider; prices are $ per 1M tokens, kept as typed text while editing. */
data class PiProviderModel(val id: String, val inputCost: String = "", val outputCost: String = "", val contextWindow: String = "")

/** A Pi relay provider as PI WEB lists it. The API key itself never reaches the phone. */
data class PiProvider(
    val id: String,
    val name: String,
    val baseUrl: String,
    val api: String,
    val hasKey: Boolean,
    val models: List<PiProviderModel>,
    val revision: String,
)

val PI_API_TYPES = listOf(
    "openai-completions" to "OpenAI Chat",
    "openai-responses" to "OpenAI Responses",
    "anthropic-messages" to "Anthropic",
    "google-generative-ai" to "Google Gemini",
)

/** A new provider's id: PI WEB requires `custom-` plus lowercase letters, digits and dashes. */
fun piProviderId(name: String): String {
    val slug = name.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(40)
    return "custom-" + slug.ifBlank { System.currentTimeMillis().toString(36) }
}

/** What the Pi settings dialog shows: the catalog plus the session's current choice. */
data class PiModelChoice(val models: List<PiModel>, val thinkingLevels: List<String>, val current: String, val thinkingLevel: String)

/** Pi's thinking levels, weakest first, in the order pi-ai ranks them. */
private val PI_THINKING_LEVEL_ORDER = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

/**
 * The thinking levels a Pi model can use. PI WEB reports only whether a model reasons, not
 * which levels it takes: a model that does not reason has just "off"; a reasoning model gets the
 * levels the session reports, or the common ones when the session's own model does not reason.
 */
fun piThinkingLevelsFor(model: PiModel?, sessionLevels: List<String>): List<String> {
    if (model != null && !model.reasoning) return listOf("off")
    val reported = sessionLevels.map { it.lowercase() }.filter { it != "off" }.distinct()
    val levels = (reported.ifEmpty { listOf("minimal", "low", "medium", "high") }) + "off"
    return levels.distinct().sortedBy { level -> PI_THINKING_LEVEL_ORDER.indexOf(level).takeIf { it >= 0 } ?: Int.MAX_VALUE }
}

/**
 * The level to keep when a Pi model is switched: the level itself if the model offers it, otherwise
 * the nearest one it offers, searched upward first and then downward, as pi clamps a level.
 */
fun piNearestThinkingLevel(level: String, offered: List<String>): String {
    if (level in offered) return level
    val start = PI_THINKING_LEVEL_ORDER.indexOf(level)
    if (start < 0) return offered.firstOrNull() ?: "off"
    for (index in start until PI_THINKING_LEVEL_ORDER.size) {
        val candidate = PI_THINKING_LEVEL_ORDER[index]
        if (candidate in offered) return candidate
    }
    for (index in start - 1 downTo 0) {
        val candidate = PI_THINKING_LEVEL_ORDER[index]
        if (candidate in offered) return candidate
    }
    return offered.firstOrNull() ?: "off"
}


/** A session to open, e.g. from a tapped notification. */
object OpenThreadRequests { val pending = kotlinx.coroutines.flow.MutableStateFlow<String?>(null) }

private val sessionLinkRegex = Regex("(?:^|[#/])(local_[0-9a-fA-F-]{36})/?$")

/** The desktop session a reply links to: "#local_…", "claude://…/local_…" or a bare "local_…". */
fun sessionLinkId(uri: String): String? = sessionLinkRegex.find(uri.trim())?.groupValues?.get(1)?.lowercase()

/** The phone's conversation for a desktop session id: its own id, or a phone-created one registered there. */
fun linkedThread(threads: List<ThreadSummary>, sessionId: String): ThreadSummary? =
    threads.firstOrNull { it.id.equals(sessionId, true) } ?: threads.firstOrNull { it.desktopId.equals(sessionId, true) }

data class WaitingOption(val label: String, val description: String = "")
/** [allowOther] false: the computer's card has no free-text answer (the desktop's safeguard choice). */
data class WaitingQuestion(val question: String, val header: String = "", val multiSelect: Boolean = false, val options: List<WaitingOption> = emptyList(), val allowOther: Boolean = true)

/**
 * A Claude desktop prompt: a tool waiting for permission ("permission": tool +
 * command/target in summary), a question ("question") or a plan ("plan").
 */
data class DesktopWaiting(
    val kind: String,
    val tool: String,
    val requestId: String,
    val summary: String = "",
    val description: String = "",
    val questions: List<WaitingQuestion> = emptyList(),
    /** False when the prompt lives where the phone cannot reach (Codex Desktop's own questions). */
    val phoneCanAnswer: Boolean = true,
    /** False when the desktop's dialog has no "Allow and switch to Auto" (an MCP tool's request). */
    val autoOption: Boolean = true,
) {
    /** Whether it can be answered from the phone (otherwise: open it on the computer). */
    val answerable: Boolean get() = phoneCanAnswer && requestId.isNotBlank() && when (kind) {
        "permission" -> summary.isNotBlank()
        "question" -> questions.isNotEmpty() && questions.none { it.options.isEmpty() }
        "plan" -> true
        else -> false
    }
}

/** The answer to one question: the options picked and/or free "other" text. */
data class QuestionAnswer(val labels: List<String>, val other: String = "")

/** A single-choice question takes exactly one answer; a multi-select one at least one. */
fun isCompleteAnswer(question: WaitingQuestion, answer: QuestionAnswer?): Boolean {
    val count = (answer?.labels?.size ?: 0) + if (answer?.other.isNullOrBlank()) 0 else 1
    return if (question.multiSelect) count >= 1 else count == 1
}

private val worktreeSuffix = Regex("""[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$""", RegexOption.IGNORE_CASE)

/**
 * Working folders used recently, newest first. A Claude worktree
 * (…\.claude\worktrees\name) counts as its project folder.
 */
fun recentWorkdirs(threads: List<ThreadSummary>): List<String> = threads
    .sortedByDescending { it.updatedAt }
    .map { it.cwd.trim().replace(worktreeSuffix, "") }
    .filter { it.isNotBlank() }
    .distinctBy { it.lowercase().trimEnd('\\', '/') }

/** The last folder name of a path, for a compact chip. */
fun folderName(path: String): String = path.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/').ifBlank { path }

/** One line for the thread list: what the computer is asking. */
fun waitingPreview(waiting: DesktopWaiting?): String? = when (waiting?.kind) {
    "question" -> waiting.questions.firstOrNull()?.question?.takeIf { it.isNotBlank() }?.let { "问你：$it" }
    "permission" -> "等你批准 ${waiting.tool}：${waiting.summary.lineSequence().firstOrNull().orEmpty()}"
    "plan" -> "等你确认计划"
    else -> null
}

// Claude plan usage: remaining share of the five-hour and weekly windows and
// when each resets (epoch ms; null = not known yet).
/**
 * [resetEstimated]: the computer worked the reset out from the desktop's
 * usage samples (to within ~15 min).
 *
 * [observedAt] is the timestamp of the source sample/event, not the time the
 * phone received the frame. [stale] means Claude kept working after the
 * source went quiet. Historical figures stay separate from current quota:
 * [lastKnownRemainingPercent] is never used to fill a current quota gauge.
 */
data class ClaudeUsageWindow(
    val remainingPercent: Int? = null,
    val resetsAt: Long? = null,
    val resetEstimated: Boolean = false,
    val observedAt: Long? = null,
    val stale: Boolean = false,
    val atMost: Boolean = false, // accepted from older connectors; never a current figure
    val lastKnownRemainingPercent: Int? = null,
)

/** Both screens apply expiry locally, including while the connector is offline. */
fun ClaudeUsageWindow.displayAt(now: Long): ClaudeUsageWindow {
    val at = observedAt ?: 0L
    val expired = stale || atMost || at <= 0L || now - at !in -5 * 60_000L..CLAUDE_USAGE_STALE_MS ||
        (resetsAt != null && at < resetsAt && now >= resetsAt)
    return if (expired) copy(
        remainingPercent = null,
        lastKnownRemainingPercent = lastKnownRemainingPercent ?: remainingPercent,
        resetsAt = resetsAt?.takeIf { it > now },
        stale = true,
    ) else this
}

fun ClaudeUsageWindow?.remainingLabel(now: Long = System.currentTimeMillis()): String {
    val window = this?.displayAt(now) ?: return "剩余 —"
    window.remainingPercent?.let { return "剩余 $it%" }
    window.lastKnownRemainingPercent?.let { return "历史剩余 $it%" }
    return "剩余 —"
}

fun fiveHourResetLabel(resetsAt: Long?, now: Long, remainingPercent: Int? = null, estimated: Boolean = false): String {
    // The five-hour window only starts counting with the first message.
    if (resetsAt == null) return if (remainingPercent == 100) "未开始计时" else "重置时间未知"
    if (resetsAt <= now) return "已重置"
    val minutes = ((resetsAt - now) / 60_000).coerceAtLeast(0)
    val about = if (estimated) "约" else ""
    return when {
        minutes < 1 -> "即将重置"
        minutes < 60 -> "$about${minutes}分钟后重置"
        else -> "$about${minutes / 60}小时${minutes % 60}分后重置"
    }
}

fun weeklyResetLabel(resetsAt: Long?, now: Long, estimated: Boolean = false): String {
    if (resetsAt == null) return "重置时间未知"
    if (resetsAt <= now) return "已重置"
    val hours = ((resetsAt - now) / 3_600_000).coerceAtLeast(0)
    return if (hours >= 24) "${if (estimated) "约" else ""}${hours / 24}天${hours % 24}小时后重置" else fiveHourResetLabel(resetsAt, now, estimated = estimated)
}
/**
 * New content on the computer cannot reach the relay ([reason]: certificate,
 * timeout, dns, server or network) since [since] (the computer's clock).
 */
data class UploadIssue(val reason: String, val since: Long)

fun uploadIssueText(issue: UploadIssue): String {
    val why = when (issue.reason) {
        "certificate" -> "服务器证书不对，可能是电脑所在的网络被劫持"
        "timeout" -> "连接服务器超时"
        "dns" -> "电脑找不到服务器地址"
        "server" -> "服务器出错"
        else -> "电脑连不上服务器"
    }
    return "电脑上的新内容暂时传不上来：$why。恢复后会自动补传。"
}

/** How busy the computer is (percent, null = unknown, e.g. no NVIDIA GPU), sampled at [at] (computer time). */
data class PcLoad(val cpu: Int?, val gpu: Int?, val mem: Int?, val at: Long, val receivedAt: Long)

fun parsePcLoad(value: org.json.JSONObject?, receivedAt: Long): PcLoad? {
    value ?: return null
    return pcLoadOf(value.opt("cpu"), value.opt("gpu"), value.opt("mem"), value.optLong("at"), receivedAt)
}

/** Non-numbers (JSON null, missing) are unknown; numbers are clamped to 0..100. */
fun pcLoadOf(cpu: Any?, gpu: Any?, mem: Any?, at: Long, receivedAt: Long): PcLoad {
    fun pct(value: Any?): Int? = if (value is Number) value.toInt().coerceIn(0, 100) else null
    return PcLoad(pct(cpu), pct(gpu), pct(mem), at, receivedAt)
}

/** A sample the phone got more than [maxAgeMs] ago no longer describes the computer. */
fun PcLoad.isFresh(now: Long, maxAgeMs: Long = 20_000): Boolean = now - receivedAt in 0..maxAgeMs

data class ClaudeUsage(
    val fiveHour: ClaudeUsageWindow = ClaudeUsageWindow(),
    val sevenDay: ClaudeUsageWindow = ClaudeUsageWindow(),
    val updatedAt: Long = 0,
    val refreshResultAt: Long = 0,
    val refreshUnavailableReason: String? = null,
    val accountFingerprint: String? = null,
    val snapshotAt: Long = 0,
    val accountState: String? = null,
    /** "终端 Claude Code 实时额度" on the computer; null when the connector has no such option. */
    val statusline: ClaudeStatuslineState? = null,
)

data class ClaudeStatuslineState(val enabled: Boolean, val chained: Boolean, val error: String? = null)

fun ClaudeUsage.displayAt(now: Long): ClaudeUsage = copy(fiveHour = fiveHour.displayAt(now), sevenDay = sevenDay.displayAt(now))

/** Order snapshots across account changes, then merge observations within one account. */
fun mergeClaudeUsage(current: ClaudeUsage?, incoming: ClaudeUsage): ClaudeUsage {
    // Envelope order is independent of source observation age or identity.
    // This also rejects A arriving late after B (and a late switching frame).
    if (current != null && current.snapshotAt > incoming.snapshotAt) return current
    if (incoming.accountState == "switching" || incoming.accountState == "unavailable") return incoming
    if (current == null || incoming.accountFingerprint == null || current.accountFingerprint != incoming.accountFingerprint) return incoming
    fun newest(old: ClaudeUsageWindow, next: ClaudeUsageWindow): ClaudeUsageWindow =
        if ((old.observedAt ?: 0L) > (next.observedAt ?: 0L)) old else next
    val five = newest(current.fiveHour, incoming.fiveHour)
    val week = newest(current.sevenDay, incoming.sevenDay)
    val refresh = if (current.refreshResultAt > incoming.refreshResultAt) current else incoming
    return incoming.copy(fiveHour = five, sevenDay = week,
        updatedAt = maxOf(five.observedAt ?: 0L, week.observedAt ?: 0L),
        refreshResultAt = refresh.refreshResultAt, refreshUnavailableReason = refresh.refreshUnavailableReason)
}

/** One-shot confirmation requested before Claude loads a new workspace. */
data class ClaudeWorkspaceTrustRequest(val threadId: String, val folder: String)

private const val CLAUDE_USAGE_STALE_MS = 30 * 60_000L

/**
 * Keep the age of a quota visible. The connector may retain the last known
 * figure while Claude is idle, but once it marks a window stale the UI must
 * say so instead of presenting that figure as current.
 */
fun ClaudeUsage.freshnessLabel(now: Long = System.currentTimeMillis()): String {
    if (accountState == "switching") return "正在切换账号"
    if (accountState == "unavailable") return "当前账号暂时无法确认"
    val windows = listOf(fiveHour.displayAt(now), sevenDay.displayAt(now))
    // The older window must not borrow the newer window's observation time.
    val observedAt = windows.mapNotNull { it.observedAt?.takeIf { at -> at > 0L } }.minOrNull()
        ?: return "暂时无法获取"
    val age = quotaAgeLabel(observedAt, now)
    return when {
        windows.any { it.stale && (it.observedAt ?: 0L) > 0L } -> if (age.endsWith("）")) age.dropLast(1) + "，已过期）" else "$age（已过期）"
        windows.any { it.remainingPercent == null } -> "$age · 部分额度暂时无法获取"
        else -> age
    }
}

/** How old a quota figure is, with its clock time: "12 分钟前更新（10:12）". */
fun quotaAgeLabel(observedAt: Long, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
    val minutes = ((now - observedAt) / 60_000).coerceAtLeast(0)
    val pattern = if (now - observedAt >= 24 * 60 * 60_000L) "MM-dd HH:mm" else "HH:mm"
    val time = SimpleDateFormat(pattern, Locale.getDefault()).apply { timeZone = zone }.format(Date(observedAt))
    return when {
        minutes < 1 -> "刚刚更新（$time）"
        minutes < 60 -> "$minutes 分钟前更新（$time）"
        minutes < 24 * 60 -> "${minutes / 60} 小时前更新（$time）"
        else -> "$time 更新"
    }
}

fun ClaudeUsage.refreshHelp(now: Long = System.currentTimeMillis()): String {
    val windows = listOf(fiveHour.displayAt(now), sevenDay.displayAt(now))
    if (windows.all { it.remainingPercent != null }) return "已重新读取电脑上的用量，暂无更晚的记录。${freshnessLabel(now)}。"
    return when (refreshUnavailableReason) {
    "missing_binary" -> "电脑端暂时无法读取新的 Claude 额度，请检查 Claude 桌面版是否已安装。"
    "account_unconfirmed" -> "无法确认刷新来源与桌面版使用的是同一账号。请在电脑打开 Claude 托盘的用量弹窗，随后会自动同步。"
    else -> "目前只有电脑上的历史用量数据。请在电脑点击系统托盘中的 Claude 图标，打开用量弹窗；新的数据会自动同步到手机。"
}

}

// A Claude Code model as reported by the desktop's own Claude Code
// (value goes to --model; efforts are the levels that model accepts).
data class ClaudeModel(val value: String, val label: String, val efforts: List<String>)

data class ThreadReadSnapshot(
    val allReadAt: Long = 0,
    val byThread: Map<String, Long> = emptyMap(),
) {
    fun readAt(threadId: String): Long = maxOf(allReadAt, byThread[threadId] ?: 0)
}

fun effectiveUnread(sourceUnread: Boolean, updatedAt: Long, readAt: Long): Boolean =
    sourceUnread && updatedAt > readAt

fun withAllThreadsRead(items: List<ThreadSummary>, readAt: Long = Long.MAX_VALUE): List<ThreadSummary> =
    items.map { it.copy(unread = false, phoneReadAt = maxOf(it.phoneReadAt, if (readAt == Long.MAX_VALUE) it.updatedAt else readAt)) }

fun sortThreadSummaries(items: List<ThreadSummary>): List<ThreadSummary> = items.sortedWith(
    compareBy<ThreadSummary> { if (it.pinned) 0 else 1 }
        .thenBy { if (it.pinned && it.pinOrder >= 0) it.pinOrder else Int.MAX_VALUE }
        .thenByDescending { it.updatedAt },
)

fun sortPinnedThreadSummaries(items: List<ThreadSummary>): List<ThreadSummary> = items
    .filter { it.pinned }
    .sortedWith(
        compareBy<ThreadSummary> { if (it.pinOrder >= 0) it.pinOrder else Int.MAX_VALUE }
            .thenByDescending { it.updatedAt }
            .thenBy { it.id },
    )

/** Tabs whose pinned section is a copy of the desktop app's sidebar pins. */
val DESKTOP_MIRRORED_PIN_TABS = setOf("codex", "claude", "dsh", "hermes")

// Codex's, Claude's and DSH's pinned sections mirror their desktop even while
// a pinned chat also appears in Recent. Other backends keep their compact grouping.
fun homePinnedThreads(items: List<ThreadSummary>, recentIds: Set<String>, backend: String): List<ThreadSummary> =
    sortPinnedThreadSummaries(items).filter { backend in DESKTOP_MIRRORED_PIN_TABS || it.id !in recentIds }

fun withDesktopCodexPins(items: List<ThreadSummary>, pinsByConnector: Map<String, List<String>>): List<ThreadSummary> =
    withDesktopPins(items, pinsByConnector, "codex")

/**
 * Applies a connector's authoritative desktop pin list (membership and order)
 * to one backend's threads, so pins removed while offline or on an old page
 * of the history index do not linger on the phone.
 */
fun withDesktopPins(items: List<ThreadSummary>, pinsByConnector: Map<String, List<String>>, backend: String): List<ThreadSummary> {
    val orders = pinsByConnector.mapValues { (_, ids) -> ids.distinct().withIndex().associate { it.value to it.index } }
    return items.map { thread ->
        val order = orders[thread.connectorId]
        if (backendTab(thread.backend) != backend || order == null) thread
        else {
            val rank = if (thread.archived) null else order[thread.id]
            thread.copy(pinned = rank != null, pinOrder = rank ?: -1)
        }
    }
}

fun isRunningThreadStatus(status: String): Boolean =
    status.contains("running", true) || status.contains("progress", true) ||
        status.contains("compact", true) || status.equals("active", true)

/**
 * The turn is over and ended on a question (Claude Desktop's "Blocked · Asked
 * a question"). Shown like waiting, but nothing is running: replies are sent
 * straight away, not queued, and there is nothing to stop.
 */
fun isNeedsReplyStatus(status: String): Boolean = status.equals("needs_reply", true)

/** A Desktop-owned tool is blocked on a confirmation in the computer UI. */
fun isDesktopApprovalStatus(status: String): Boolean = status.equals("desktop_waiting_approval", true)

/** Ignore stale/replayed approvals while allowing a new observed prompt to alert. */
fun shouldNotifyDesktopApproval(previous: String, status: String, kind: String, applied: Boolean, eventAt: Long, lastNoticeAt: Long, now: Long): Boolean =
    kind == "thread.status" && applied && isDesktopApprovalStatus(status) && !isDesktopApprovalStatus(previous) &&
        eventAt > lastNoticeAt && eventAt > now - 120_000L && eventAt <= now + 10_000L

/** The connector cannot yet determine whether this turn has finished. */
fun isUnknownThreadStatus(status: String): Boolean = status.contains("unknown", true)

fun isCompletedThreadStatus(status: String): Boolean =
    !isRunningThreadStatus(status) && !isNeedsReplyStatus(status) && !isUnknownThreadStatus(status) &&
        !status.contains("waiting", true) && !status.contains("input", true) && !status.contains("approval", true) &&
        !status.contains("queued", true) && !status.contains("fail", true) && !status.contains("error", true) &&
        !status.contains("cancel", true) && !status.contains("abort", true) && !status.contains("interrupt", true)

/** A status change that is new activity: running or waiting now, or ending a run. */
fun isStatusActivity(previous: String, status: String): Boolean {
    val active = { value: String -> isRunningThreadStatus(value) || isWaitingThreadStatus(value) }
    return active(status) || active(previous)
}

fun isWaitingThreadStatus(status: String): Boolean =
    isNeedsReplyStatus(status) || !isRunningThreadStatus(status) && !status.contains("queued", true) &&
        (status.contains("waiting", true) || status.contains("input", true) || status.contains("approval", true))

/**
 * The "recent" section: sessions waiting for the user first (they need
 * attention), then finished-but-unread ones, then those still running.
 */
fun recentThreadHighlights(
    items: List<ThreadSummary>,
    now: Long = System.currentTimeMillis(),
    statusOf: (ThreadSummary) -> String = { it.status },
): List<ThreadSummary> {
    val newestFirst = compareByDescending<ThreadSummary> { it.updatedAt }
    val titleCollator = Collator.getInstance(Locale.CHINA).apply { strength = Collator.PRIMARY }
    val waiting = items.filter { isWaitingThreadStatus(statusOf(it)) }.sortedWith(newestFirst)
    val unreadCompleted = items.filter { item -> isFinishedHighlight(item, statusOf(item), now) }.sortedWith(newestFirst)
    val running = items.filter { item ->
        isRunningThreadStatus(statusOf(item))
    }.sortedWith { left, right ->
        naturalTitleCompare(left.title, right.title, titleCollator).takeIf { it != 0 }
            ?: left.id.compareTo(right.id)
    }
    return (waiting + unreadCompleted + running).distinctBy { it.id }
}

private fun naturalTitleCompare(left: String, right: String, collator: Collator): Int {
    val token = Regex("\\d+|\\D+")
    val leftParts = token.findAll(left.trim()).map { it.value }.toList()
    val rightParts = token.findAll(right.trim()).map { it.value }.toList()
    for (index in 0 until minOf(leftParts.size, rightParts.size)) {
        val leftPart = leftParts[index]
        val rightPart = rightParts[index]
        val leftNumber = leftPart.toLongOrNull()
        val rightNumber = rightPart.toLongOrNull()
        val comparison = if (leftNumber != null && rightNumber != null) {
            leftNumber.compareTo(rightNumber)
        } else {
            collator.compare(leftPart, rightPart)
        }
        if (comparison != 0) return comparison
    }
    return leftParts.size.compareTo(rightParts.size)
}

data class HistoryImage(
    val data: String,
    val mimeType: String? = null,
)

data class HistoryItem(
    val id: String,
    val order: Long,
    val type: String,
    val text: String,
    val status: String?,
    val truncated: Boolean,
    val images: List<HistoryImage> = emptyList(),
    /** Server-side creation time. Cached rows can fall back to the timestamp encoded in order. */
    val createdAt: Long = 0L,
    /** Images produced by Codex image generation, deferred until the answer has finished. */
    val generatedImages: List<HistoryImage> = emptyList(),
    /** Images a Claude tool returned, only referenced: loaded from the computer on request. */
    val imageRefs: List<HistoryImageRef> = emptyList(),
    /** A question Codex asked without stopping (codexQuestion), with the options to answer it. */
    val questions: List<CodexQuestion> = emptyList(),
    /** How long it took (contextCompaction). */
    val durationMs: Long = 0L,
    /** Stable Pi transcript entry id; its display indices can change after branch switches. */
    val sourceMessageId: String? = null,
    /** Claude Desktop's end-of-turn next-step box; replies remain ordinary chat messages. */
    val nextStep: ClaudeNextStep? = null,
    /** Claude Desktop's task list for a turn (claudeTaskList), updated in place. */
    val taskList: ClaudeTaskList? = null,
    /** Files the agent sent to the user (sentFiles): computer paths, fetched only when shown or tapped. */
    val files: List<SentFile> = emptyList(),
    /** Light mode: a tool step uploaded as a placeholder; its details are fetched from the computer. */
    val light: Boolean = false,
    /** Pictures you sent that are still on their way: their content URIs on this phone. */
    val localImages: List<String> = emptyList(),
)

/** A file the agent sent with SendUserFile. [kind] is image, video or file. */
data class SentFile(val path: String, val name: String, val kind: String, val size: Long = 0L, val mimeType: String? = null)

fun parseSentFiles(array: org.json.JSONArray?): List<SentFile> = (0 until (array?.length() ?: 0)).mapNotNull { index ->
    val file = array?.optJSONObject(index) ?: return@mapNotNull null
    val path = file.optString("path").takeIf { it.isNotBlank() && it != "null" } ?: return@mapNotNull null
    val kind = file.optString("kind").takeIf { it in setOf("image", "video", "file") } ?: when (computerFileKind(path)) {
        ComputerFileKind.IMAGE -> "image"; ComputerFileKind.VIDEO -> "video"; else -> "file"
    }
    SentFile(path, file.optString("name").takeIf { it.isNotBlank() && it != "null" } ?: computerFileName(path), kind,
        file.optLong("size", 0L), file.optString("mimeType").takeIf { it.isNotBlank() && it != "null" })
}

/** One question of a codexQuestion item; [id] is the one Codex Desktop answers with. */
data class CodexQuestion(val id: String, val question: String, val options: List<String>)

/** Questions Codex has just asked in [threadId], offered at once on the phone. */
data class CodexQuestionPrompt(val threadId: String, val itemId: String, val questions: List<CodexQuestion>)

fun parseCodexQuestions(array: org.json.JSONArray?): List<CodexQuestion> = (0 until (array?.length() ?: 0)).mapNotNull { index ->
    val question = array?.optJSONObject(index) ?: return@mapNotNull null
    val options = question.optJSONArray("options")?.let { list -> (0 until list.length()).map(list::optString).filter(String::isNotBlank) }.orEmpty()
    CodexQuestion(question.optString("id"), question.optString("question"), options).takeIf { it.id.isNotBlank() && it.question.isNotBlank() }
}

/** An answer to a [CodexQuestion], as carried by the user message that answers it. */
data class QuestionReply(val id: String, val question: String, val answer: String)

private val questionReplyRegex = Regex("""<send_user_message_question_reply>\s*(\[.*])\s*</send_user_message_question_reply>""", RegexOption.DOT_MATCHES_ALL)

/**
 * Codex Desktop answers a non-blocking question with a user message in this
 * form; the phone sends the same, so Codex reads both alike. (Written and read
 * by hand: compact JSON with characters left as typed, like Codex Desktop's.)
 */
fun questionReplyText(question: CodexQuestion, answer: String): String =
    "<send_user_message_question_reply>\n[{\"questionItemId\":${jsonString(question.id)},\"question\":${jsonString(question.question)},\"answer\":${jsonString(answer)}}]\n</send_user_message_question_reply>"

private fun jsonString(value: String): String = buildString {
    append('"')
    for (char in value) when {
        char == '"' -> append("\\\"")
        char == '\\' -> append("\\\\")
        char == '\n' -> append("\\n")
        char == '\r' -> append("\\r")
        char == '\t' -> append("\\t")
        char < ' ' -> append("\\u%04x".format(char.code))
        else -> append(char)
    }
    append('"')
}

/** The JSON string value of [key] at or after [from] in [json], and where it ends. */
private fun jsonStringField(json: String, key: String, from: Int): Pair<String, Int>? {
    val keyAt = json.indexOf("\"$key\"", from).takeIf { it >= 0 } ?: return null
    var index = json.indexOf('"', json.indexOf(':', keyAt + key.length + 2) + 1).takeIf { it >= 0 } ?: return null
    val out = StringBuilder()
    index++
    while (index < json.length) {
        val char = json[index]
        if (char == '"') return out.toString() to index + 1
        if (char == '\\' && index + 1 < json.length) {
            index++
            when (val escaped = json[index]) {
                'n' -> out.append('\n'); 'r' -> out.append('\r'); 't' -> out.append('\t'); 'b' -> out.append('\b'); 'f' -> out.append('\u000c')
                'u' -> { out.append(json.substring(index + 1, (index + 5).coerceAtMost(json.length)).toIntOrNull(16)?.toChar() ?: '?'); index += 4 }
                else -> out.append(escaped)
            }
        } else out.append(char)
        index++
    }
    return null
}

/** The answers a user message carries, or none when it isn't an answer. */
fun parseQuestionReplies(text: String): List<QuestionReply> {
    val body = questionReplyRegex.find(text)?.groupValues?.get(1) ?: return emptyList()
    val replies = mutableListOf<QuestionReply>()
    var at = 0
    while (true) {
        val (id, afterId) = jsonStringField(body, "questionItemId", at) ?: break
        val next = body.indexOf("\"questionItemId\"", afterId).let { if (it < 0) body.length else it }
        val scope = body.substring(0, next)
        val question = jsonStringField(scope, "question", afterId)?.first.orEmpty()
        val answer = jsonStringField(scope, "answer", afterId)?.first.orEmpty()
        if (id.isNotBlank()) replies += QuestionReply(id, question, answer)
        at = next
        if (next >= body.length) break
    }
    return replies
}

/** How an answer shows in the conversation, instead of the raw reply block. */
fun questionReplyDisplay(text: String): String? = parseQuestionReplies(text).takeIf { it.isNotEmpty() }
    ?.joinToString("\n") { "回答：${it.answer}" }

/** An image kept on the computer; `bytes` is its size, shown before loading. */
data class HistoryImageRef(val ref: String, val mimeType: String, val bytes: Long)

fun historyItemTimestamp(item: HistoryItem): Long? =
    item.createdAt.takeIf { it > 0L }
        ?: (item.order / 1000L).takeIf { it > 1_000_000_000_000L }

data class HistoryLoadState(
    val threadId: String? = null,
    val loading: Boolean = false,
    val loadedCount: Int = 0,
    /** Number of history pages fetched during this load, when known. */
    val loadedPages: Int = 0,
    val hasMore: Boolean = false,
    val error: String? = null,
    val recovering: Boolean = false,
    /** The relay cleared this conversation's older history (prune-history). */
    val trimmed: Boolean = false,
)

data class TurnDuration(
    val startedAt: Long = 0L,
    val completedAt: Long = 0L,
    val durationMs: Long = 0L,
    val terminalStatus: String = "completed",
)

data class LatestHistoryMerge(
    val items: List<HistoryItem>,
    val resetToLatest: Boolean,
)

/**
 * Conversations worth fetching into the cache before they are opened: the most
 * recently active ones (archived ones skipped) whose activity is newer than
 * their last prefetch, newest first, never the one already on screen.
 */
fun prefetchCandidates(threads: List<ThreadSummary>, activeId: String?, prefetchedAt: (String) -> Long, limit: Int): List<String> =
    threads.asSequence()
        .filter { !it.archived && it.id != activeId }
        .sortedByDescending { it.updatedAt }
        .take(limit)
        .filter { it.updatedAt > prefetchedAt(it.id) }
        .map { it.id }
        .toList()

fun historyNeedsForwardRecovery(existing: List<HistoryItem>, latest: List<HistoryItem>): Boolean {
    if (existing.isEmpty() || latest.isEmpty()) return false
    return latest.minOf { it.order } > existing.maxOf { it.order }
}

/**
 * The items stored since the phone's last look (new ones and ones changed in
 * place) merged into what it shows. An item the relay replaced at the same
 * position (a live reply by the stored one) and one now held as not shown go.
 */
fun mergeChangedHistoryItems(existing: List<HistoryItem>, changed: List<HistoryItem>, removed: Set<String>): List<HistoryItem> {
    val changedIds = changed.mapTo(HashSet()) { it.id }
    val atOrder = changed.associate { it.order to it.id }
    val kept = existing.filter { item ->
        item.id !in removed && item.id !in changedIds && (atOrder[item.order] ?: item.id) == item.id
    }
    return (kept + changed.distinctBy { it.id }).sortedBy { it.order }
}

fun mergeLatestHistoryPage(existing: List<HistoryItem>, latest: List<HistoryItem>): LatestHistoryMerge {
    if (latest.isEmpty()) return LatestHistoryMerge(existing.sortedBy { it.order }, false)
    if (existing.isEmpty()) return LatestHistoryMerge(latest.distinctBy { it.id }.sortedBy { it.order }, false)

    return LatestHistoryMerge(
        // A missing middle page is recoverable. Never discard locally cached items
        // just because the newest server page does not overlap them.
        items = (latest + existing).distinctBy { it.id }.sortedBy { it.order },
        resetToLatest = false,
    )
}

/**
 * Keep generated images out of the live activity stream and attach them to the
 * last assistant message in the same answer.  Tool/screenshot images remain in
 * their original activity item and are therefore still opt-in details.
 */
fun hydrateLightDetailsAndPlaceImages(items: List<HistoryItem>, details: Map<String, HistoryItem>): List<HistoryItem> =
    deferGeneratedImagesToAnswerEnd(items.map { if (it.light) details[it.id] ?: it else it })

fun deferGeneratedImagesToAnswerEnd(items: List<HistoryItem>): List<HistoryItem> {
    if (items.none { it.type == "imageGeneration" && it.images.isNotEmpty() }) return items
    val output = mutableListOf<HistoryItem>()
    var segmentStart = 0
    var index = 0
    fun flushSegment(segment: List<HistoryItem>) {
        val generated = segment.filter { it.type == "imageGeneration" && it.images.isNotEmpty() }
        val targetIndex = segment.indexOfLast { it.type == "agentMessage" }
        if (generated.isEmpty() || targetIndex < 0) {
            output += segment
            return
        }
        // Codex can publish the same final bitmap once from
        // image_generation_end and once from the tool output. Keep distinct
        // generated results, but never show the exact same data URI twice.
        val generatedImages = generated.flatMap { it.images }.distinctBy { it.data }
        segment.forEachIndexed { position, item ->
            if (item.type == "imageGeneration" && item.images.isNotEmpty()) return@forEachIndexed
            if (position == targetIndex) output += item.copy(generatedImages = item.generatedImages + generatedImages)
            else output += item
        }
    }
    while (index < items.size) {
        if (items[index].type.contains("user", true)) {
            flushSegment(items.subList(segmentStart, index))
            output += items[index]
            segmentStart = index + 1
        }
        index++
    }
    flushSegment(items.subList(segmentStart, items.size))
    return output
}

sealed interface HistoryBlock {
    val key: String

    data class Single(val item: HistoryItem) : HistoryBlock {
        override val key = item.id
    }

    data class ActivityGroup(val items: List<HistoryItem>) : HistoryBlock {
        override val key = "activity:${items.first().id}"
    }
}

data class ActivityEntry(
    val primary: HistoryItem,
    val outputs: List<HistoryItem> = emptyList(),
) {
    val status: String? get() = outputs.lastOrNull()?.status ?: primary.status
}

private val activityItemTypes = setOf(
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "webSearch",
    "imageView",
    "imageGeneration",
    "collabAgentToolCall",
    "error",
    "turnError",
)

private val workItemTypes = activityItemTypes + setOf("reasoning", "plan")

/**
 * Codex can persist a reasoning/plan item whose only payload is an empty
 * summary ([], {}, or whitespace).  It is still useful for the desktop
 * rollout, but it has no mobile-visible content and should not create an
 * empty row in the activity list.
 */
fun hasVisibleWorkItemContent(item: HistoryItem): Boolean {
    if (item.type != "reasoning" && item.type != "plan") return true
    val text = item.text.trim()
    return text.isNotEmpty() && text !in setOf("[]", "{}")
}

/**
 * [inlineReasoning]: Claude Code shows its thinking inline in the
 * conversation, so for Claude threads a reasoning item stays its own block
 * instead of being folded into the surrounding tool-activity group.
 */
fun groupHistoryItems(items: List<HistoryItem>, inlineReasoning: Boolean = false): List<HistoryBlock> {
    val result = mutableListOf<HistoryBlock>()
    var index = 0
    val visibleItems = withCardsAtTurnEnd(withoutRedundantClaudeRecaps(items.filter(::hasVisibleWorkItemContent)))
    val grouped = if (inlineReasoning) workItemTypes - "reasoning" else workItemTypes
    while (index < visibleItems.size) {
        val item = visibleItems[index]
        if (item.type !in grouped) {
            result += HistoryBlock.Single(item)
            index++
            continue
        }

        val run = mutableListOf<HistoryItem>()
        while (index < visibleItems.size && visibleItems[index].type in grouped) {
            run += visibleItems[index]
            index++
        }
        result += HistoryBlock.ActivityGroup(run)
    }
    return result
}

/**
 * How long the last turn took, read from the conversation itself: from the
 * last user message to the last thing after it. Right even for turns the phone
 * did not watch (e.g. run on the desktop while the app was closed).
 */
fun lastTurnDurationFromHistory(items: List<HistoryItem>): Long? {
    val userIndex = items.indexOfLast { it.type.contains("user", true) }
    if (userIndex < 0 || userIndex == items.lastIndex) return null
    val started = items[userIndex].createdAt
    val ended = items.drop(userIndex + 1).maxOfOrNull { it.createdAt } ?: return null
    return (ended - started).takeIf { started > 0L && it > 0L }
}

/**
 * The tool group of the turn in progress. A group from an earlier turn (a user
 * message follows it) is finished even while a newer turn is running.
 */
fun latestActivityGroupKey(blocks: List<HistoryBlock>): String? {
    val index = blocks.indexOfLast { it is HistoryBlock.ActivityGroup }
    if (index < 0) return null
    val laterUser = blocks.drop(index + 1).any { it is HistoryBlock.Single && it.item.type.contains("user", true) }
    return if (laterUser) null else blocks[index].key
}

fun activityEntries(items: List<HistoryItem>): List<ActivityEntry> {
    val entries = mutableListOf<ActivityEntry>()
    for (item in items) {
        val previous = entries.lastOrNull()
        if (item.type == "commandExecution" && isCommandOutput(item) && previous?.primary?.type == "commandExecution") {
            entries[entries.lastIndex] = previous.copy(outputs = previous.outputs + item)
        } else {
            entries += ActivityEntry(item)
        }
    }
    return entries
}

private fun isCommandOutput(item: HistoryItem): Boolean {
    val firstLine = item.text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty().trim()
    return firstLine.startsWith("Script completed", true) ||
        firstLine.startsWith("Script running", true) ||
        firstLine.startsWith("Command completed", true) ||
        firstLine.startsWith("Command failed", true)
}

data class ApprovalRequest(
    val rpcId: String,
    val method: String,
    val threadId: String?,
    val title: String,
    val detail: String,
    val expiresAt: Long,
    val questions: List<ApprovalQuestion> = emptyList(),
    val kind: String = "approval",
    /** Codex offers "allow for the rest of this session" for commands and file edits. */
    val allowSession: Boolean = false,
    val blocking: Boolean = true,
    val submitting: Boolean = false,
)

/** Original RPC plus thread identity protects a newer dialog from late ACKs. */
internal fun matchesApproval(request: ApprovalRequest?, rpcId: String?, threadId: String?): Boolean =
    request != null && (!rpcId.isNullOrBlank() || !threadId.isNullOrBlank()) &&
        (rpcId.isNullOrBlank() || request.rpcId == rpcId) &&
        (threadId.isNullOrBlank() || request.threadId == threadId)

internal fun mergeApprovalReplay(current: ApprovalRequest?, incoming: ApprovalRequest): ApprovalRequest =
    if (matchesApproval(current, incoming.rpcId, incoming.threadId)) incoming.copy(submitting = current?.submitting == true) else incoming

data class ApprovalQuestion(
    val id: String,
    val text: String,
    val detail: String = "",
    val options: List<ApprovalChoice> = emptyList(),
    val required: Boolean = true,
    val multiple: Boolean = false,
    val allowCustomInput: Boolean = false,
    val secret: Boolean = false,
)

data class ApprovalChoice(
    val id: String,
    val label: String,
    val detail: String = "",
    val custom: Boolean = false,
)

data class UserInputAnswer(val selected: Set<String> = emptySet(), val customText: String = "")

data class FileEntry(val name: String, val path: String, val directory: Boolean, val size: Long, val modifiedAt: Long)
data class DeviceEntry(val id: String, val name: String, val type: String, val revoked: Boolean)

sealed interface PairingLoginState {
    data object Idle : PairingLoginState
    data class Claiming(val deviceName: String = "") : PairingLoginState
    data class WaitingForDesktop(val deviceName: String) : PairingLoginState
    data class DirectConnecting(val pcName: String) : PairingLoginState
    data class Complete(val displayName: String) : PairingLoginState
    data class Failed(val message: String) : PairingLoginState
}

data class MembershipEntry(
    val product: String,
    val state: String,
    val plan: String? = null,
    val expiresAt: Long? = null,
)

data class AccountUiState(
    val displayName: String = "khLink 用户",
    val avatarUrl: String? = null,
    val khQuantSubject: String = "",
    val memberships: List<MembershipEntry> = emptyList(),
    val effectiveSource: String = "none",
    val canWrite: Boolean = false,
    val devices: List<DeviceEntry> = emptyList(),
    /** This month's traffic through the official server; null where nothing is counted. */
    val traffic: TrafficUsage? = null,
)

/** An account's traffic through the official relay this month (Beijing time). */
data class TrafficUsage(val month: String, val usedBytes: Long, val limitBytes: Long, val resetsAt: Long) {
    val free: Boolean get() = limitBytes > 0
    val exhausted: Boolean get() = free && usedBytes >= limitBytes
    val fraction: Float get() = if (limitBytes > 0) (usedBytes.toDouble() / limitBytes).coerceIn(0.0, 1.0).toFloat() else 0f
}

/** 12.3 MB, 860 KB: how phones show monthly traffic. */
fun formatTraffic(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.2f GB", bytes / 1073741824.0)
    bytes >= 1024L * 1024 -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1048576.0)
    else -> "${(bytes + 1023) / 1024} KB"
}

/** Parses effectiveEntitlement.traffic from the relay. */
fun parseTrafficUsage(value: org.json.JSONObject?): TrafficUsage? {
    if (value == null || !value.has("usedBytes")) return null
    return TrafficUsage(value.optString("month"), value.optLong("usedBytes"), value.optLong("limitBytes"), value.optLong("resetsAt"))
}

data class UpdateInfo(val versionName: String, val versionCode: Int, val url: String, val sha256: String,
    /** What this version changes, one line per change, from the signed manifest. */
    val notes: List<String> = emptyList(),
    /** Where to download it, in order: GitHub Releases first, then the relay. */
    val urls: List<String> = listOf(url))

/** Where to look for the signed manifest: the mirrors in order (comma-separated), then the relay. */
fun updateManifestSources(mirrors: String, relay: String): List<String> =
    (mirrors.split(',') + relay).map { it.trim().trimEnd('/') }.filter { it.isNotEmpty() }.distinct()

/**
 * A manifest entry's download sources in order. Newer manifests list `urls`
 * (GitHub first, the relay second); older ones a single `url`, which always
 * stays as the fallback.
 */
fun updateDownloadUrls(entry: org.json.JSONObject, rehome: (String) -> String = { it }): List<String> {
    val listed = entry.optJSONArray("urls")?.let { array -> (0 until array.length()).map { array.optString(it) } }.orEmpty()
    return (listed + entry.optString("url")).map { it.trim() }.filter { it.startsWith("https://") }.map(rehome).distinct()
}

/** Of the manifests that verified, the one with the newest Android build (a lagging mirror loses). */
fun newestAndroidManifest(manifests: List<org.json.JSONObject>): org.json.JSONObject? =
    manifests.filter { it.optJSONObject("android") != null }.maxByOrNull { it.getJSONObject("android").optInt("versionCode") }

/** GitHub and jsDelivr can be slow or blocked: they get short timeouts so the next source takes over quickly. */
fun isUpdateMirrorUrl(url: String): Boolean =
    Regex("^https://([a-z0-9-]+\\.)*(github\\.com|githubusercontent\\.com|jsdelivr\\.net)/", RegexOption.IGNORE_CASE).containsMatchIn(url)

/** A readable source name without exposing URL paths, query parameters or credentials. */
fun updateDownloadChannel(url: String): String {
    val host = runCatching { java.net.URI(url).host?.lowercase(Locale.ROOT)?.trimEnd('.') }.getOrNull().orEmpty()
    return when {
        host.isBlank() -> "未知渠道"
        host == "github.com" || host.endsWith(".github.com") || host == "githubusercontent.com" || host.endsWith(".githubusercontent.com") -> "GitHub"
        host == "gcore.jsdelivr.net" -> "jsDelivr · Gcore"
        host == "fastly.jsdelivr.net" -> "jsDelivr · Fastly"
        host == "jsdelivr.net" || host.endsWith(".jsdelivr.net") -> "jsDelivr"
        host == "khsci.vip" -> "khLink 官方服务器"
        else -> "下载服务器 · $host"
    }
}

/** The manifest's notes text as lines; older manifests have none. */
fun updateNotes(text: String?): List<String> = text.orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }.take(12)

/** Deferral only silences automatic prompts; an explicit check always finds newer versions. */
fun shouldOfferUpdate(
    versionCode: Int,
    currentVersionCode: Int,
    skippedVersionCode: Int,
    postponed: Set<Int>,
    manual: Boolean = false,
): Boolean = versionCode > currentVersionCode &&
    (manual || (versionCode != skippedVersionCode && versionCode !in postponed))

data class QuotaSnapshot(val remainingPercent: Int, val resetAt: Long?)

/** A cached quota whose reset time has passed describes a window that has since started over. */
fun QuotaSnapshot.current(now: Long): QuotaSnapshot = if (resetAt != null && resetAt <= now) QuotaSnapshot(100, null) else this

sealed interface UpdateDownloadState {
    data object Idle : UpdateDownloadState
    data class Downloading(
        val downloadedBytes: Long,
        val totalBytes: Long,
        val channel: String,
        val connecting: Boolean = false,
    ) : UpdateDownloadState
    data class Ready(val versionName: String) : UpdateDownloadState
    data class Failed(val message: String) : UpdateDownloadState
}

/** A new task on its way to the computer; [error] once it was refused. */
data class PendingNewTask(val backend: String, val cwd: String, val prompt: String, val startedAt: Long, val error: String? = null)

data class QueuedAttachment(
    val name: String,
    val size: Long = 0L,
    val mimeType: String? = null,
    val attachmentId: String? = null,
    val localUri: String? = null,
)

data class QueuedInstruction(
    val id: String,
    val text: String,
    val createdAt: Long,
    val state: String = "pending",
    val reason: String? = null,
    val startedAt: Long? = null,
    val origin: String = "mobile",
    val attachments: List<QueuedAttachment> = emptyList(),
    val stateVersion: Long = 0L,
    /** Whether this item is genuinely waiting behind a busy Desktop turn right
     * now, as opposed to being technically routed through the queue/dispatch
     * machinery but about to be delivered immediately. Drives "待发送" vs
     * "发送中" in the UI, independent of the raw [state] string. */
    val blocking: Boolean = true,
    /** Last real user-message order known before this phone sent the request. */
    val historyAfterOrder: Long? = null,
    /** The user explicitly chose Queue; keep that intent through older ACKs. */
    val queueRequested: Boolean = false,
    /** When this phone sent it, by the phone's clock; 0 when unknown (another
     * device, or read back after a restart). */
    val sentAt: Long = 0L,
)

/** How long a message just sent may sit in the computer's queue before it counts as waiting. */
const val QUEUE_SETTLE_MS = 4_000L

/**
 * The panel above the input holds everything waiting behind the running turn:
 * what the user chose to queue, what the computer queued itself, a message
 * sent now that is really waiting behind a turn, and failures that need a
 * decision. The computer may pass a message sent now through its own queue
 * and start it a second later; that one stays in the conversation as
 * "发送中" instead of flashing through the panel. It counts as waiting once
 * the computer says why it could not go in (a deferred steer) or after
 * [QUEUE_SETTLE_MS] still queued (2026-10-31).
 */
fun showInstructionInQueue(item: QueuedInstruction, now: Long = System.currentTimeMillis()): Boolean =
    item.state in setOf("uncertain", "failed") ||
        (item.state !in setOf("started", "steered", "completed", "cancelled") &&
            (item.queueRequested || item.origin == "desktop" || (isFiledBehindTurn(item) && !isSettlingInQueue(item, now))))

private fun isFiledBehindTurn(item: QueuedInstruction) =
    item.blocking && item.state in setOf("pending", "dispatching", "desktop_queued")

/** A message this phone just sent that the computer has queued but may still start at once. */
fun isSettlingInQueue(item: QueuedInstruction, now: Long): Boolean =
    isFiledBehindTurn(item) && !item.queueRequested && item.origin != "desktop" && item.reason == null &&
        item.sentAt > 0L && now - item.sentAt in 0 until QUEUE_SETTLE_MS

/**
 * Follow-up events can arrive out of order after a reconnect.  A replayed
 * `followup.queued` snapshot must not move an item that was already observed
 * as started/steered back to a queued state.
 */
fun mergeQueuedInstruction(existing: QueuedInstruction, incoming: QueuedInstruction): QueuedInstruction {
    val confirmed = incoming.state in setOf("started", "steered")
    val received = if (confirmed) incoming.copy(blocking = false, reason = null) else incoming
    if (existing.id != incoming.id) return received
    val queueRequested = existing.queueRequested || incoming.queueRequested
    // A request is sent once. A late timeout/failure cannot undo its own
    // confirmed receipt, even if a retry produced a larger state version.
    if (existing.state in setOf("started", "steered") && incoming.state in setOf("pending", "sending", "dispatching", "desktop_queued", "uncertain", "failed")) return existing.copy(blocking = false, reason = null, queueRequested = queueRequested)
    val existingRank = queuedStateRank(existing.state)
    val incomingRank = queuedStateRank(incoming.state)
    if (!confirmed && incoming.stateVersion > 0L && existing.stateVersion > incoming.stateVersion) return existing.copy(queueRequested = queueRequested)
    if (!confirmed && existingRank > incomingRank && incoming.stateVersion <= existing.stateVersion) {
        return existing.copy(
            queueRequested = queueRequested,
            reason = existing.reason ?: incoming.reason,
            startedAt = existing.startedAt ?: incoming.startedAt,
            attachments = if (existing.attachments.isNotEmpty()) existing.attachments else incoming.attachments,
        )
    }
    // A direct ACK can arrive after the phone's watchdog, without a new
    // server stateVersion. It still proves acceptance and clears the queue.
    return received.copy(
        queueRequested = queueRequested,
        sentAt = existing.sentAt.takeIf { it > 0L } ?: incoming.sentAt,
        createdAt = minOf(existing.createdAt, incoming.createdAt),
        startedAt = incoming.startedAt ?: existing.startedAt,
        attachments = mergeAttachments(existing.attachments, incoming.attachments),
        stateVersion = maxOf(existing.stateVersion, incoming.stateVersion),
        historyAfterOrder = existing.historyAfterOrder ?: incoming.historyAfterOrder,
    )
}

/**
 * The computer's copy of the attachments wins, but it never knows where a
 * picture is on this phone: keep that, so the bubble can still show it.
 */
private fun mergeAttachments(existing: List<QueuedAttachment>, incoming: List<QueuedAttachment>): List<QueuedAttachment> {
    if (incoming.isEmpty()) return existing
    return incoming.map { attachment ->
        if (attachment.localUri != null) attachment
        else attachment.copy(localUri = existing.firstOrNull { old ->
            (attachment.attachmentId != null && old.attachmentId == attachment.attachmentId) || old.name == attachment.name
        }?.localUri)
    }
}

/** A request with pictures and no words: the phone sends it as "图片附件". */
fun isPictureOnlyText(text: String): Boolean = normalizeInstructionText(text).let { it.isBlank() || it == "图片附件" }

private fun queuedStateRank(state: String): Int = when (state.lowercase()) {
    "pending", "sending" -> 10
    "dispatching" -> 20
    "desktop_queued" -> 30
    "started", "steered" -> 50
    "completed", "cancelled", "failed", "uncertain" -> 100
    else -> 10
}

fun mergeTransientUserInstructions(history: List<HistoryItem>, instructions: List<QueuedInstruction>, now: Long = System.currentTimeMillis()): List<HistoryItem> {
    // A non-blocking item is not genuinely waiting behind a busy turn (it is
    // about to be, or already is being, delivered) and belongs inline as a
    // "发送中" bubble. `uncertain`/`failed` always stay in the bottom queue
    // panel regardless of `blocking`, since they need their retry/confirm
    // affordances there.
    val transient = instructions.filter { !showInstructionInQueue(it, now) && it.state !in setOf("completed", "cancelled") && !isQueuedInstructionDelivered(it, history) }
        .mapIndexed { index, item ->
            HistoryItem(
                id = "outbound:${item.id}",
                order = (item.startedAt ?: item.createdAt) * 1000 + index,
                type = "userMessage",
                text = if (isPictureOnlyText(item.text) && outboundLocalImages(item).isNotEmpty()) "" else outboundBubbleText(item),
                status = outboundBubbleStatus(item),
                localImages = outboundLocalImages(item),
                truncated = false,
                createdAt = item.startedAt ?: item.createdAt,
            )
    }
    return (history + transient).sortedBy { it.order }
}

/**
 * What a sent message's bubble says until the conversation history has it:
 * "sending" until the computer acknowledges it, "waiting" while it sits behind
 * the running turn (it goes in at the next step), then sent/steered.
 */
fun outboundBubbleStatus(item: QueuedInstruction): String = when (item.state) {
    "started" -> "sent"
    "steered" -> "steered"
    // Waiting behind a turn moves it to the queue panel; in the conversation it is on its way.
    "desktop_queued", "pending", "dispatching" -> "sending"
    "sending" -> "sending"
    else -> "running"
}

/** The pictures of a request still on this phone, shown in its bubble until the history has them. */
fun outboundLocalImages(item: QueuedInstruction): List<String> = item.attachments.filter { attachment ->
    attachment.mimeType?.startsWith("image/") == true ||
        attachment.name.substringAfterLast('.', "").lowercase() in setOf("jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp")
}.mapNotNull { it.localUri?.takeIf(String::isNotBlank) }

/** A message of pictures alone reads "[图片]", as WeChat shows it, not as an empty bubble. */
fun outboundBubbleText(item: QueuedInstruction): String = when {
    !isPictureOnlyText(item.text) || item.attachments.isEmpty() -> item.text
    item.attachments.size > 1 -> "[图片] ×${item.attachments.size}"
    item.attachments.isNotEmpty() -> "[图片]"
    else -> item.text
}

/** The bubble is still on its way: show progress next to it. */
fun isOutboundInFlight(status: String?): Boolean = status == "sending" || status == "waiting"

fun normalizeInstructionText(value: String): String =
    value.replace("\r\n", "\n").replace(Regex("\\s+"), " ").trim()

/** The last confirmed history position before sending, independent of device clocks. */
fun queuedInstructionHistoryBoundary(threadId: String, history: List<HistoryItem>, state: HistoryLoadState, syncing: Boolean): Long? {
    if (state.threadId != threadId) return null
    val latest = history.asSequence().filterNot { it.id.startsWith("outbound:") }.maxOfOrNull { it.order }
    if (latest != null) return latest
    // Only an actually loaded, complete empty page proves there are no older
    // messages that could otherwise be mistaken for this first send.
    return if (!syncing && !state.loading && !state.hasMore && state.loadedPages > 0 && state.error == null) -1L else null
}

fun isQueuedInstructionDelivered(item: QueuedInstruction, history: List<HistoryItem>): Boolean {
    if (item.state !in setOf("pending", "sending", "dispatching", "desktop_queued", "uncertain", "started", "steered")) return false
    val text = normalizeInstructionText(item.text)
    val attachmentNames = item.attachments.map { normalizeInstructionText(it.name) }
        .filter { it.isNotBlank() }
    val attachmentIds = item.attachments.mapNotNull { it.attachmentId?.trim()?.takeIf(String::isNotBlank) }
    val candidates = history.asSequence().filter { candidate ->
        candidate.type == "userMessage" && !candidate.id.startsWith("outbound:") &&
            (item.historyAfterOrder?.let { candidate.order > it }
                ?: (historyItemTimestamp(candidate)?.let { it >= item.createdAt } == true))
    }
    // Pictures sent alone: Claude's history keeps them as images with no text
    // (or the bare "图片附件" label), never the file name, so an image-only
    // request matches a later message of images alone. Matching nothing, its
    // empty bubble stayed in the conversation for good (2026-10-22).
    if (isPictureOnlyText(item.text) && item.attachments.isNotEmpty() &&
        candidates.any { normalizeInstructionText(it.text).let { actual -> actual.isBlank() || actual == "图片附件" } }) return true
    return candidates.map { normalizeInstructionText(it.text) }.any { actual ->
        (text.isNotBlank() && actual == text) ||
            (text.length >= 12 && actual.contains(text)) ||
            // Pure-image history is normalised by the connector to a safe
            // filename/id label.  The optimistic queue row also contains
            // byte size and status, so match the durable attachment identity
            // instead of requiring the visible text to be byte-for-byte equal.
            attachmentNames.any { name ->
                actual.contains(name, ignoreCase = true) &&
                    (attachmentIds.isEmpty() || attachmentIds.any { id -> actual.contains(id, ignoreCase = true) } || Regex("\\[kh\\s*link 图片附件\\]", RegexOption.IGNORE_CASE).containsMatchIn(actual))
            }
    }
}

/** One notice per request, shared by command results and follow-up events. */
class FollowupFailureNotices(seen: Collection<String> = emptyList()) {
    private val observed = seen.toMutableSet()
    @Synchronized
    fun claim(threadId: String, item: QueuedInstruction, activeThreadId: String?): Boolean {
        if (threadId.isBlank() || item.id.isBlank() || item.state !in setOf("uncertain", "failed")) return false
        val first = observed.add("$threadId:${item.id}")
        // Background failures stay in their conversation's receipt card.
        // Replayed events must not raise a modal on the home screen.
        return first && activeThreadId == threadId
    }
    @Synchronized
    fun snapshot(): Set<String> = observed.toSet()
}

// The project's AGENTS.md also reaches the conversation as a user message (again after each compaction).
fun isInternalContextMessage(text: String): Boolean = isWholeTagBlock(text) || text.trimStart().startsWith("# AGENTS.md instructions for ") || Regex(
    "^<(environment_context|recommended_plugins|in-app-browser-context|app-context|skills_instructions|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|multi_agent_mode|multi_agent_role)(?:\\s|>)",
    RegexOption.IGNORE_CASE,
).containsMatchIn(text.trimStart())

fun isLegacyMisclassifiedRolloutError(type: String, order: Long): Boolean =
    type == "error" && order > 1_000_000_000_000L

fun isTurnBusyStatus(status: String) =
    status.contains("running", true) ||
        status.contains("progress", true) ||
        status.contains("active", true) ||
        status.contains("waiting", true) ||
        status.contains("input", true) ||
        status.contains("approval", true)

/** A context compaction in progress: Codex's own, or one the phone asked for. */
fun isCompactingThreadStatus(status: String): Boolean = status.contains("compact", true)

/**
 * The live status a compaction event leaves the turn in. A finished or failed
 * compaction does not end the turn; the turn's own terminal event still does.
 */
fun compactionLiveStatus(status: String): String? = when (status) {
    "started" -> "compacting"
    "completed", "failed" -> "mobile_running"
    else -> null
}

/**
 * A completion the computer read from silence (no end event: a long command or a
 * quiet model step writes nothing) clears the running badge. It is not the end of
 * the turn: the turn may still be running, and its real end is announced when it comes.
 */
fun isSilentCompletion(status: String, quiet: Boolean): Boolean =
    quiet && status.equals("completed", ignoreCase = true)

/** A deliberately retired unknown status must not finish or time an old turn. */
fun shouldClearUnknownTurnTracking(status: String, quiet: Boolean): Boolean =
    quiet && status.equals("unknown", ignoreCase = true)

fun reconcileLiveStatusSnapshot(
    existing: Map<String, String>,
    active: Map<String, String>,
    knownThreads: Map<String, String> = emptyMap(),
): Map<String, String> {
    // An activeThreads heartbeat is a live hint, not a completion event. A
    // delayed, partial, or connector-restart snapshot can omit a task that is
    // still running; converting that omission to `completed` made the phone
    // announce success in the middle of a turn. Keep the last known status and
    // let an explicit thread.status terminal event close it.
    val next = existing.toMutableMap()
    // `knownThreads` is retained in the signature for callers that also carry
    // durable rows, but a persisted running status is not enough evidence to
    // invent a live/terminal transition during a heartbeat.
    next.putAll(active)
    return next
}

/** How long a busy task must be missing from every fresh heartbeat before it is retired. */
const val LIVE_ABSENCE_RETIRE_MS = 90_000L

/**
 * Busy tasks that fresh heartbeats have left out for [graceMs]. A single
 * missing heartbeat is not a completion (it caused false "done" before), but a
 * terminal event that never reached the phone left a task "running" forever.
 * [absentSince] is updated in place: the first fresh snapshot without the task
 * starts its clock; reappearing, or a snapshot older than its last event, does
 * not count. Returns the task ids to retire.
 */
fun retireLongAbsentBusyStatuses(
    current: Map<String, String>,
    active: Set<String>,
    absentSince: MutableMap<String, Long>,
    snapshotAt: Long,
    lastEventAt: Map<String, Long>,
    graceMs: Long = LIVE_ABSENCE_RETIRE_MS,
): Set<String> {
    absentSince.keys.retainAll { it in current && it !in active }
    if (snapshotAt <= 0L) return emptySet()
    val retire = mutableSetOf<String>()
    current.forEach { (threadId, status) ->
        // A question nobody answers here may be answered on the computer; its
        // status frame can be missed like an end event.
        if (threadId in active || !(isTurnBusyStatus(status) || isCompactingThreadStatus(status) || isNeedsReplyStatus(status))) return@forEach
        // A snapshot taken before the task's last event says nothing about it.
        if (snapshotAt < (lastEventAt[threadId] ?: 0L)) return@forEach
        val since = absentSince.getOrPut(threadId) { snapshotAt }
        if (snapshotAt - since >= graceMs) retire += threadId
    }
    retire.forEach { absentSince.remove(it) }
    return retire
}

/** A missing Codex heartbeat is not a turn-end event. Preserve uncertainty so
 * a partial connector snapshot cannot manufacture a green completion badge. */
fun applyAbsentStatusRetirement(
    current: Map<String, String>,
    retired: Set<String>,
    backends: Map<String, String>,
): Map<String, String> = current.toMutableMap().apply {
    retired.forEach { id ->
        if (id in this) put(id, if (backendTab(backends[id].orEmpty()) == "codex") "unknown" else "completed")
    }
}

fun shouldFollowLatestMessage(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int, isScrollInProgress: Boolean): Boolean =
    !isScrollInProgress && firstVisibleItemIndex <= 1 && firstVisibleItemScrollOffset < 120

fun isAtLatestContent(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int): Boolean =
    firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset < 24

enum class ConnectionState { Offline, Connecting, Online }

fun isFreshConnectorPresence(sentAt: Long, now: Long = System.currentTimeMillis()): Boolean =
    sentAt > 0 && sentAt <= now + 5_000 && now - sentAt <= 20_000

data class CapabilityState(
    val models: List<String> = emptyList(),
    val efforts: List<String> = emptyList(),
    val tiers: List<String> = emptyList(),
    val rateLimit: String = "",
    val effortsByModel: Map<String, List<String>> = emptyMap(),
    val weeklyRemainingPercent: Int? = null,
    val weeklyResetAt: Long? = null,
    val quotaState: String = "loading",
    val quotaError: String? = null,
    val quotaSnapshotAt: Long = 0,
    val quotaAccountFingerprint: String? = null,
    val quotaAccountState: String? = null,
    val collaborationModes: List<String> = emptyList(),
    // Codex's sandbox cannot start this computer's (Store) PowerShell: only full access runs commands.
    val codexSandboxBlocked: Boolean = false,
    /** The model Codex uses when a task leaves it at "默认". */
    val defaultModel: String? = null,
    /** Each model's own reasoning effort when none is chosen. */
    val defaultEffortByModel: Map<String, String> = emptyMap(),
    /** Speed tiers each model offers besides the standard one (e.g. "fast"). */
    val tiersByModel: Map<String, List<String>> = emptyMap(),
)

/** The model Codex runs when the task's model is left at "默认". */
fun CapabilityState.codexDefaultModel(): String? = defaultModel ?: models.firstOrNull()

/** The reasoning effort Codex actually uses for [model] (null: the default model). */
fun CapabilityState.codexEffectiveEffort(model: String?, effort: String?): String? =
    effort ?: defaultEffortByModel[model ?: codexDefaultModel()]

/** Speed tiers [model] offers beyond the standard speed. */
fun CapabilityState.codexSpeedTiers(model: String?): List<String> =
    tiersByModel[model ?: codexDefaultModel()] ?: if (tiersByModel.isEmpty()) tiers else emptyList()

/**
 * Switching model keeps the effort the task was really using, written out,
 * so Codex does not fall back to the new model's own default. It is dropped
 * only when the new model does not offer it.
 */
fun CapabilityState.effortAfterModelChange(oldModel: String?, newModel: String?, effort: String?): String? {
    val kept = codexEffectiveEffort(oldModel, effort) ?: return null
    val supported = effortsByModel[newModel ?: codexDefaultModel()] ?: return kept
    return kept.takeIf { it in supported }
}

data class CodexQuotaUpdate(
    val quota: QuotaSnapshot?, val snapshotAt: Long = 0, val accountFingerprint: String? = null,
    val accountState: String? = null, val error: String? = null, val plan: String = "",
)

fun CapabilityState.withCodexQuota(next: CodexQuotaUpdate): CapabilityState {
    if (quotaSnapshotAt > next.snapshotAt) return this
    return copy(weeklyRemainingPercent = next.quota?.remainingPercent, weeklyResetAt = next.quota?.resetAt,
        rateLimit = next.plan, quotaState = if (next.quota != null) "available" else "unavailable",
        quotaError = next.error, quotaSnapshotAt = next.snapshotAt,
        quotaAccountFingerprint = next.accountFingerprint, quotaAccountState = next.accountState)
}

fun reasoningEffortLabel(value: String): String = when (value.lowercase()) {
    "minimal", "none" -> "最低"
    "low" -> "低"
    "medium" -> "中"
    "high" -> "高"
    "xhigh", "extra-high", "very-high" -> "极高"
    "max" -> "最大"
    "ultra" -> "超高"
    else -> value
}

fun orderedReasoningEfforts(values: Iterable<String>): List<String> {
    val order = listOf("minimal", "low", "medium", "high", "xhigh", "max", "ultra")
    return values.filter { it.isNotBlank() && it != "null" }.distinct().sortedWith(
        compareBy<String> { value -> order.indexOf(value.lowercase()).takeIf { it >= 0 } ?: Int.MAX_VALUE }
            .thenBy(String::lowercase),
    )
}

data class ThreadSettings(
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val approvalPolicy: String? = null,
    val approvalsReviewer: String? = null,
    val sandboxPolicy: String? = null,
    val permissionMode: String = "manual",
    val collaborationMode: String = "default",
    val effectiveCollaborationMode: String = collaborationMode,
    val desiredCollaborationMode: String = collaborationMode,
    val modeSyncState: String = "applied",
    val modeSyncReason: String? = null,
    val nextTurn: Boolean = false,
    // A Claude desktop session holds a model or effort choice until its running turn ends.
    val pendingDesktop: Boolean = false,
)

data class AttachmentUpload(
    val id: String,
    val name: String,
    val localUri: String,
    val path: String? = null,
    val size: Long = 0,
    val mimeType: String? = null,
    val state: String = "uploading",
    val error: String? = null,
    val attachmentId: String? = null,
)

/** Hermes' immediate steer is text-only; leave image drafts intact for queuing. */
internal fun hermesImageCannotSteer(backend: String, busy: Boolean, steer: Boolean, attachments: List<AttachmentUpload>): Boolean =
    backend == "hermes" && busy && steer && attachments.any {
        it.mimeType?.startsWith("image/", ignoreCase = true) == true ||
            it.name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif")
    }

/** A message that is one whole <tag>...</tag> block is context Codex gives the model. */
private fun isWholeTagBlock(text: String): Boolean {
    val trimmed = text.trim()
    val tag = Regex("^<([a-zA-Z][a-zA-Z0-9_-]{2,60})(?:\\s[^>]*)?>").find(trimmed)?.groupValues?.get(1) ?: return false
    // An image and an answer to a Codex question are the user's own.
    return tag.lowercase() !in setOf("image", "send_user_message_question_reply") && trimmed.endsWith("</$tag>")
}

/**
 * The computer file a link in a reply points to, as a Windows path, or null
 * for a web link. Handles `I:\a\b.md`, `/I:/a/b.md`, `file:///I:/a/b.md`,
 * percent-encoding, a trailing `:12` / `:12:3` / `#L12` line marker, and
 * paths relative to the session's folder (`src/a.ts`, `../b.md`).
 */
fun computerPathFromLink(link: String, cwd: String): String? {
    var value = link.trim()
    if (value.isEmpty() || Regex("^(https?|mailto|tel|data|intent|market):", RegexOption.IGNORE_CASE).containsMatchIn(value)) return null
    value = value.replaceFirst(Regex("^file:/*", RegexOption.IGNORE_CASE), "")
    value = runCatching { java.net.URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }.getOrDefault(value)
    value = value.replace(Regex("#L\\d+(-L?\\d+)?$"), "").replace(Regex("(?<=\\.[A-Za-z0-9]{1,8}):\\d+(:\\d+)?$"), "")
    if (value.isBlank() || value.startsWith("#")) return null
    val absolute = Regex("^/?([A-Za-z]:[\\\\/].*)$").find(value)?.groupValues?.get(1)
    val joined = when {
        absolute != null -> absolute
        cwd.isBlank() -> return null
        else -> cwd.trimEnd('\\', '/') + "\\" + value
    }
    val parts = ArrayDeque<String>()
    joined.split('\\', '/').forEachIndexed { index, part ->
        when {
            index == 0 -> parts.addLast(part)
            part.isEmpty() || part == "." -> Unit
            part == ".." -> if (parts.size > 1) parts.removeLast()
            else -> parts.addLast(part)
        }
    }
    return if (parts.size < 2) null else parts.joinToString("\\")
}

/** A computer file the user asked to open: awaiting confirmation, loading, or failed. */
data class ComputerFileLoad(val path: String, val confirmed: Boolean, val received: Long = 0, val total: Long = 0, val error: String? = null, val bytesPerSecond: Long = 0)

/** A computer file already fetched to the phone, shown in the in-app viewer. */
data class ComputerFileView(val path: String, val file: java.io.File)

/** A file fetched from the computer and kept on the phone, listed on the 电脑取回的文件 page. */
data class FetchedFile(val file: java.io.File, val path: String, val fetchedAt: Long)

/** How the in-app viewer shows a fetched file. */
enum class ComputerFileKind { MARKDOWN, HTML, TEXT, IMAGE, VIDEO, OTHER }

private val VIEWER_TEXT_EXTENSIONS = setOf("txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "xml", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "kt", "kts", "java", "rs", "go", "c", "h", "cpp", "hpp",
    "cs", "sh", "ps1", "bat", "cmd", "sql", "gradle", "properties", "vue", "svelte", "rb", "php", "swift", "dart", "lua", "r", "tex")
private val VIDEO_EXTENSIONS = setOf("mp4", "m4v", "mov", "webm", "mkv", "avi", "3gp")
private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "svg")

fun computerFileKind(name: String): ComputerFileKind = when (name.substringAfterLast('.', "").lowercase()) {
    "md", "markdown" -> ComputerFileKind.MARKDOWN
    "html", "htm" -> ComputerFileKind.HTML
    in VIEWER_TEXT_EXTENSIONS -> ComputerFileKind.TEXT
    in IMAGE_EXTENSIONS -> ComputerFileKind.IMAGE
    in VIDEO_EXTENSIONS -> ComputerFileKind.VIDEO
    else -> ComputerFileKind.OTHER
}

/** A web link straight to a video file, which the phone offers to download. */
fun isWebVideoLink(link: String): Boolean {
    val value = link.trim()
    if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(value)) return false
    val path = value.substringBefore('#').substringBefore('?')
    return path.substringAfterLast('/').substringAfterLast('.', "").lowercase() in VIDEO_EXTENSIONS
}

private fun isMarkdownPunctuation(c: Char): Boolean = when (Character.getType(c).toByte()) {
    Character.CONNECTOR_PUNCTUATION, Character.DASH_PUNCTUATION, Character.START_PUNCTUATION, Character.END_PUNCTUATION,
    Character.INITIAL_QUOTE_PUNCTUATION, Character.FINAL_QUOTE_PUNCTUATION, Character.OTHER_PUNCTUATION -> true
    else -> c in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
}

private fun isWordChar(c: Char?): Boolean = c != null && !c.isWhitespace() && !isMarkdownPunctuation(c)

/**
 * Markdown only ends `**bold**` when the closing stars are not squeezed
 * between punctuation and a letter, a rule written for spaced languages:
 * `**说明。**然后` or `的**「重点」**` stayed as raw stars. A hair space
 * (U+200A, whitespace to the parser, barely visible) on the letter side lets
 * those pairs close. Code spans and fenced blocks are left alone.
 */
fun fixCjkEmphasis(markdown: String): String {
    if (!markdown.contains("**")) return markdown
    var fence: String? = null
    return markdown.split('\n').joinToString("\n") { line ->
        val marker = Regex("^\\s{0,3}(`{3,}|~{3,})").find(line)?.groupValues?.get(1)
        when {
            fence != null -> { if (marker != null && marker[0] == fence!![0] && marker.length >= fence!!.length) fence = null; line }
            marker != null -> { fence = marker; line }
            else -> fixEmphasisLine(line)
        }
    }
}

private fun fixEmphasisLine(line: String): String {
    // Star pairs outside inline code, in order.
    val stars = mutableListOf<Int>()
    var i = 0; var inCode = false
    while (i < line.length) {
        when {
            line[i] == '`' -> { inCode = !inCode; i++ }
            !inCode && line.startsWith("**", i) && !line.startsWith("***", i) && (i == 0 || line[i - 1] != '*') -> { stars += i; i += 2 }
            else -> i++
        }
    }
    if (stars.size < 2) return line
    val before = mutableSetOf<Int>(); val after = mutableSetOf<Int>()
    for (k in 0 until stars.size - 1 step 2) {
        val open = stars[k]; val close = stars[k + 1]
        if (close - open <= 2) continue
        val openNext = line[open + 2]; val openPrev = line.getOrNull(open - 1)
        if (isMarkdownPunctuation(openNext) && isWordChar(openPrev)) before += open
        val closePrev = line[close - 1]; val closeNext = line.getOrNull(close + 2)
        if (isMarkdownPunctuation(closePrev) && isWordChar(closeNext)) after += close
    }
    if (before.isEmpty() && after.isEmpty()) return line
    val out = StringBuilder(line.length + 4)
    line.forEachIndexed { index, c ->
        if (index in before) out.append(' ')
        out.append(c)
        if (index - 1 in after && line[index - 1] == '*' && c == '*') out.append(' ')
    }
    return out.toString()
}

private val CODE_SPAN_PATH =Regex("(?<![\\[`])`([A-Za-z]:[\\\\/][^`\\n]*\\.[A-Za-z0-9]{1,8}(?::\\d+){0,2})`(?![`\\]])")

/**
 * Agents usually write computer paths as inline code (`I:\a\b.mp4`), which
 * the renderer does not make tappable. Turns such spans into file links so
 * they open like any other file link; fenced code blocks are left alone.
 */
fun linkifyComputerPaths(markdown: String): String {
    if (!markdown.contains('`')) return markdown
    var fence: String? = null
    return markdown.split('\n').joinToString("\n") { line ->
        val marker = Regex("^\\s{0,3}(`{3,}|~{3,})").find(line)?.groupValues?.get(1)
        when {
            fence != null -> { if (marker != null && marker[0] == fence!![0] && marker.length >= fence!!.length) fence = null; line }
            marker != null -> { fence = marker; line }
            else -> CODE_SPAN_PATH.replace(line) { match ->
                val path = match.groupValues[1]
                val url = computerFileUrl(path.replace(Regex("(?::\\d+){1,2}$"), ""))
                // Every ASCII punctuation escaped, so the text shows the path as
                // written: inside link text the renderer read `~1\CREDEN~` as
                // strikethrough and `\.` as an escape (seen: "CLAUDE1", "KH.codex").
                "[${escapeLinkText(path)}]($url)"
            }
        }
    }
}

private fun escapeLinkText(text: String) = text.replace(Regex("[!-/:-@\\[-`{-~]")) { "\\" + it.value }

/** A file:/// URL for a Windows path that the markdown parser keeps whole (no spaces, no backslashes). */
fun computerFileUrl(path: String): String = "file:///" + path.replace('\\', '/').split('/').joinToString("/") { part ->
    if (Regex("^[A-Za-z]:$").matches(part)) part
    else java.net.URLEncoder.encode(part, "UTF-8").replace("+", "%20")
}

// [text](<I:\a\b.apk>), [text](I:\a\b.apk) or [text](file:///I:/a/b.apk); not an image.
private val LOCAL_LINK = Regex("(?<!!)\\[([^\\]\\n]+)\\]\\(\\s*(<[^>\\n]+>|[^)\\s]+)\\s*\\)")
private val ABSOLUTE_LOCAL = Regex("^(?:file:/*)?/?[A-Za-z]:[\\\\/]", RegexOption.IGNORE_CASE)
private val FENCE_MARKER = Regex("^\\s{0,3}(`{3,}|~{3,})")

/**
 * Links to computer files written the way desktop apps accept them, which
 * the phone's renderer does not: an angle-bracket destination, backslashes,
 * spaces or Chinese in the path (seen 2026-11-05 from DSH:
 * `[风筑本地中心-手机版-2.4.0.apk](<I:\…\风筑本地中心-手机版-2.4.0.apk>)` showed
 * as plain text). Each becomes a file:/// link the phone can fetch. A fenced
 * block holding nothing but one such path gets a link under it, since a
 * code block itself cannot be tapped.
 */
fun linkifyLocalFileLinks(markdown: String): String {
    if (!markdown.contains(":\\") && !markdown.contains(":/")) return markdown
    val out = StringBuilder(); var fence: String? = null; val block = mutableListOf<String>()
    for (line in markdown.split('\n')) {
        val marker = FENCE_MARKER.find(line)?.groupValues?.get(1)
        if (fence != null) {
            out.append(line).append('\n')
            if (marker != null && marker[0] == fence[0] && marker.length >= fence.length) {
                fence = null
                val only = block.filter { it.isNotBlank() }.singleOrNull()?.trim()
                val path = only?.takeIf { ABSOLUTE_LOCAL.containsMatchIn(it) }?.let { computerPathFromLink(it, "") }
                // A paragraph of its own: text right after the block must not join it.
                if (path != null && computerFileName(path).contains('.')) out.append("[在手机上取回 ${escapeLinkText(computerFileName(path))}](${computerFileUrl(path)})\n\n")
            } else block.add(line)
            continue
        }
        if (marker != null) { fence = marker; block.clear(); out.append(line).append('\n'); continue }
        out.append(LOCAL_LINK.replace(line) { match ->
            val target = match.groupValues[2].removePrefix("<").removeSuffix(">").trim()
            val path = if (ABSOLUTE_LOCAL.containsMatchIn(target)) computerPathFromLink(target, "") else null
            if (path == null) match.value else "[${match.groupValues[1]}](${computerFileUrl(path)})"
        }).append('\n')
    }
    return out.dropLast(1).toString()
}

/** The file name at the end of a Windows (or Unix) path. */
fun computerFileName(path: String): String = path.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/')

private val markdownImagePattern = Regex("""!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)""")

/**
 * A markdown image whose URL is a local path cannot be loaded by the phone's
 * image loader; the renderer otherwise reserves a huge empty block for it.
 * Turn it into a compact clickable file link instead, so the transcript keeps
 * its height and the path can still be fetched from the computer.
 */
fun compactLocalMarkdownImages(markdown: String): String {
    if (!markdown.contains("![")) return markdown
    return markdownImagePattern.replace(markdown) { match ->
        val url = match.groupValues[2]
        val remote = url.startsWith("http://", true) || url.startsWith("https://", true) ||
            url.startsWith("data:", true) || url.startsWith("content:", true)
        if (remote) match.value
        else {
            val alt = match.groupValues[1].ifBlank { "图片" }.replace("[", "\\[").replace("]", "\\]")
            "[🖼 $alt]($url)"
        }
    }
}

private val markdownVideoLinkPattern = Regex(
    """(?<!!)\[([^\]]*)]\(([^)\s]+\.(?:mp4|m4v|mov|webm|mkv|avi|3gp))(?:\s+"[^"]*")?\)""",
    RegexOption.IGNORE_CASE,
)

/** A normal link to a local video becomes an inline, tap-to-load video card. */
fun markLocalVideoLinks(markdown: String): String {
    if (!markdown.contains("](")) return markdown
    return markdownVideoLinkPattern.replace(markdown) { match ->
        val url = match.groupValues[2]
        if (url.startsWith("http://", true) || url.startsWith("https://", true)) match.value
        else {
            val alt = match.groupValues[1].ifBlank { "视频" }.replace("[", "\\[").replace("]", "\\]")
            "![🎬 $alt]($url)"
        }
    }
}

/** WeChat shows a time over the conversation only when this long has passed since the last one. */
const val CHAT_TIME_GAP_MS = 5 * 60 * 1000L

/**
 * Which messages get a centered time above them in the chat layout: the
 * first one, then each that comes at least [CHAT_TIME_GAP_MS] after the last
 * time shown. Only user and agent messages carry one.
 */
fun chatTimeMarks(items: List<HistoryItem>, timestampOf: (HistoryItem) -> Long?): Set<String> {
    val marks = HashSet<String>()
    var last = Long.MIN_VALUE
    for (item in items.sortedBy { it.order }) {
        if (item.type != "userMessage" && item.type != "agentMessage") continue
        val at = timestampOf(item) ?: continue
        if (last == Long.MIN_VALUE || at - last >= CHAT_TIME_GAP_MS) { marks += item.id; last = at }
    }
    return marks
}

/**
 * A time the way WeChat writes it: "14:05" today, "昨天 14:05", the weekday
 * within a week, then the date ("10月12日 14:05", with the year once it is not
 * this year).
 */
fun wechatTimeLabel(epoch: Long, now: Long = System.currentTimeMillis(), zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
    val at = java.util.Calendar.getInstance(zone).apply { timeInMillis = epoch }
    val today = java.util.Calendar.getInstance(zone).apply { timeInMillis = now; set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0); set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0) }
    val clock = "%02d:%02d".format(at.get(java.util.Calendar.HOUR_OF_DAY), at.get(java.util.Calendar.MINUTE))
    val days = Math.floorDiv(today.timeInMillis - epoch, 86_400_000L) + 1
    return when {
        epoch >= today.timeInMillis -> clock
        days <= 1 -> "昨天 $clock"
        days < 7 -> listOf("星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六")[at.get(java.util.Calendar.DAY_OF_WEEK) - 1] + " " + clock
        at.get(java.util.Calendar.YEAR) == today.get(java.util.Calendar.YEAR) -> "${at.get(java.util.Calendar.MONTH) + 1}月${at.get(java.util.Calendar.DAY_OF_MONTH)}日 $clock"
        else -> "${at.get(java.util.Calendar.YEAR)}年${at.get(java.util.Calendar.MONTH) + 1}月${at.get(java.util.Calendar.DAY_OF_MONTH)}日 $clock"
    }
}

/** The chat list's time column: "14:05" today, "昨天", the weekday, then "10/12" ("2025/10/12" in another year). */
fun wechatListTime(epoch: Long, now: Long = System.currentTimeMillis(), zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
    val label = wechatTimeLabel(epoch, now, zone)
    if (!label.contains(' ')) return label
    val at = java.util.Calendar.getInstance(zone).apply { timeInMillis = epoch }
    val head = label.substringBefore(' ')
    return when {
        head == "昨天" || head.startsWith("星期") -> head
        label.contains("年") -> "${at.get(java.util.Calendar.YEAR)}/${at.get(java.util.Calendar.MONTH) + 1}/${at.get(java.util.Calendar.DAY_OF_MONTH)}"
        else -> "${at.get(java.util.Calendar.MONTH) + 1}/${at.get(java.util.Calendar.DAY_OF_MONTH)}"
    }
}

/** A session's last activity, for ordering a chat list. */
fun threadActivityTime(thread: ThreadSummary): Long = maxOf(thread.activityAt ?: 0L, thread.updatedAt)

/**
 * The WeChat-style list. What is going on now (waiting for you, just
 * finished and unseen, running) comes first in [highlights] order, pinned or
 * not (2026-10-29, at the owner's request); then the pinned chats, gray, in the desktop sidebar's
 * order; then the rest newest first. Pins that lead the list are not gray, so
 * the top rows do not stripe.
 */
fun wechatListOrder(threads: List<ThreadSummary>, highlights: List<ThreadSummary>): List<ThreadSummary> {
    // What is going on (running, waiting, finished and unopened) leads the
    // whole list, pinned or not; then the pins in the desktop sidebar's order
    // (pinOrder), then the rest by latest activity.
    val ids = threads.mapTo(HashSet()) { it.id }
    val top = highlights.filter { it.id in ids }
    val rest = threads.filterNot { thread -> top.any { it.id == thread.id } }.sortedByDescending(::threadActivityTime)
    val pinned = rest.filter { it.pinned }.sortedBy { if (it.pinOrder >= 0) it.pinOrder else Int.MAX_VALUE }
    return (top + pinned + rest.filterNot { it.pinned }).distinctBy { it.id }
}

/** How long a finished, unopened session keeps its red dot. */
const val RED_DOT_MS = 3 * 60 * 60 * 1000L

/**
 * A red dot on a chat: finished or changed since you last opened it, within
 * the last [RED_DOT_MS]. Older ones (mostly scheduled checks that ran by
 * themselves) stay quiet, so the dots point at what is new; a session
 * waiting for you has its own badge.
 */
fun wantsRedDot(thread: ThreadSummary, status: String, now: Long = System.currentTimeMillis()): Boolean =
    !isWaitingThreadStatus(status) && !isRunningThreadStatus(status) &&
        (thread.unread || isFinishedUnseen(thread, status, now)) &&
        now - threadActivityTime(thread) in 0 until RED_DOT_MS
