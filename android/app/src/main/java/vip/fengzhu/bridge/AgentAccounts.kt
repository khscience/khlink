package vip.fengzhu.bridge

import org.json.JSONObject

internal const val CLAUDE_REMOTE_NOTICE = "khLink 通过遥控你电脑上已登录的官方 Claude 工作，使用的是你自己的 Claude 账号和额度。Anthropic 对第三方工具配合订阅账号使用有条款限制，存在账号被限制的可能，请自行判断是否使用。khLink 不读取、不传输你的登录信息。"
// Claude Desktop account switching stays disabled. The homepage quota card
// independently reads existing official observations after remote-use consent.
internal const val CLAUDE_ACCOUNT_SWITCH_ENABLED = false
enum class ClaudeConsent(val stored: String) {
    New("new"), Enabled("enabled"), Disabled("disabled");
    val enabled get() = this == Enabled
    val promptOnFirstUse get() = this == New
    companion object { fun fromStored(value: String?) = entries.firstOrNull { it.stored == value } ?: New }
}
data class AgentQuotaWindow(val remaining: Double, val resetsAt: Long?, val observedAt: Long, val historical: Boolean, val estimated: Boolean)
data class AgentAccountProfile(val id: String, val name: String, val active: Boolean, val running: Boolean, val fiveHour: AgentQuotaWindow?, val week: AgentQuotaWindow?)
data class AgentAccountOperation(val requestId: String, val phase: String, val message: String, val busy: Boolean, val at: Long, val from: String?, val to: String?, val origin: String, val recovery: List<String>, val blockers: List<String>)
data class AgentAccountsState(val backend: String, val snapshotAt: Long, val configured: Boolean, val readonly: Boolean, val switching: Boolean, val profiles: List<AgentAccountProfile>, val operation: AgentAccountOperation?, val usageFingerprint: String? = null) {
    val active get() = profiles.firstOrNull { it.active }
}
private fun JSONObject.safeAccountId(key: String): String? = optString(key).takeIf { it.matches(Regex("[a-f0-9]{32}")) }
private fun parseAccountWindow(value: JSONObject?): AgentQuotaWindow? {
    value ?: return null
    val remaining = value.optDouble("remaining", Double.NaN)
    if (!remaining.isFinite() || remaining !in 0.0..100.0) return null
    return AgentQuotaWindow(remaining, value.optLong("resetsAt").takeIf { it > 0 }, value.optLong("observedAt"), value.optBoolean("historical"), value.optBoolean("estimated"))
}
internal fun parseAgentAccounts(value: JSONObject): AgentAccountsState? {
    val backend = value.optString("backend").takeIf { it == "claude" || it == "codex" } ?: return null
    val at = value.optLong("snapshotAt").takeIf { it > 0 } ?: return null
    val rows = value.optJSONArray("profiles")
    val profiles = (0 until (rows?.length() ?: 0)).mapNotNull { i ->
        val p = rows?.optJSONObject(i) ?: return@mapNotNull null
        val id = p.safeAccountId("id") ?: return@mapNotNull null
        val name = p.optString("name").take(32).takeIf { it.isNotBlank() && !it.contains(Regex("[@\\\\/]|[A-Za-z]:")) } ?: "账号 ${i + 1}"
        val quota = p.optJSONObject("quota")
        AgentAccountProfile(id, name, p.optBoolean("active"), p.optBoolean("running"), parseAccountWindow(quota?.optJSONObject("fiveHour")), parseAccountWindow(quota?.optJSONObject("week")))
    }
    val operation = value.optJSONObject("lastSwitch")?.let { op ->
        val reasons = op.optJSONArray("blockers")
        val recovery = op.optJSONArray("recovery")
        AgentAccountOperation(op.optString("requestId"), op.optString("phase"), op.optString("message"), op.optBoolean("busy"), op.optLong("at"), op.safeAccountId("from"), op.safeAccountId("to"), op.optString("origin"),
            (0 until (recovery?.length() ?: 0)).mapNotNull { recovery?.optString(it)?.takeIf { r -> r in setOf("reopen", "switch_back", "repair") } },
            (0 until (reasons?.length() ?: 0)).mapNotNull { reasons?.optJSONObject(it)?.optString("message") })
    }
    return AgentAccountsState(backend, at, value.optBoolean("configured"), backend == "codex", value.optBoolean("switching"), profiles, operation, value.safeAccountId("usageFingerprint"))
}

internal fun mergeAgentAccounts(previous: AgentAccountsState?, incoming: AgentAccountsState): AgentAccountsState {
    if (previous == null || previous.backend != incoming.backend) return incoming
    if (previous.snapshotAt > incoming.snapshotAt) return previous
    // Only Claude uses the shared passive observations. Keep Codex unchanged.
    if (incoming.backend != "claude") return incoming
    return incoming.copy(profiles = incoming.profiles.map { next ->
        val old = previous.profiles.firstOrNull { it.id == next.id } ?: return@map next
        if (next.active && old.active && previous.usageFingerprint != null && incoming.usageFingerprint != null && previous.usageFingerprint != incoming.usageFingerprint) return@map next
        fun newer(a: AgentQuotaWindow?, b: AgentQuotaWindow?) = if (next.active && a?.estimated == true) b else if ((a?.observedAt ?: 0L) > (b?.observedAt ?: 0L)) a else b
        next.copy(fiveHour = newer(old.fiveHour, next.fiveHour), week = newer(old.week, next.week))
    })
}

/** A phone can reuse its newer homepage sample only for the explicitly bound account. */
internal fun AgentAccountsState.withClaudeUsage(usage: ClaudeUsage?): AgentAccountsState {
    if (backend != "claude" || switching || usage?.accountState != "ready" || usageFingerprint == null || usageFingerprint != usage.accountFingerprint) return this
    fun merge(old: AgentQuotaWindow?, sample: ClaudeUsageWindow): AgentQuotaWindow? {
        val remaining = sample.remainingPercent ?: sample.lastKnownRemainingPercent ?: return old
        val at = sample.observedAt ?: return old
        if (remaining !in 0..100 || at <= 0 || at < (old?.observedAt ?: 0L)) return old
        val reset = sample.resetsAt ?: old?.resetsAt?.takeIf { it > at && remaining <= old.remaining }
        return AgentQuotaWindow(remaining.toDouble(), reset, at, sample.stale || sample.atMost || sample.remainingPercent == null, false)
    }
    return copy(profiles = profiles.map { if (it.active) it.copy(fiveHour = merge(it.fiveHour, usage.fiveHour), week = merge(it.week, usage.sevenDay)) else it })
}

internal fun AgentQuotaWindow.displayAt(now: Long, active: Boolean): AgentQuotaWindow {
    val expired = resetsAt != null && resetsAt > observedAt && now >= resetsAt
    val old = historical || observedAt <= 0 || now - observedAt !in -60_000L..30 * 60_000L || expired
    return copy(remaining = if (!active && expired) 100.0 else remaining, historical = old, estimated = !active && expired)
}

internal fun AgentAccountsState.displayAt(now: Long): AgentAccountsState = if (backend != "claude") this else copy(profiles = profiles.map { p ->
    p.copy(fiveHour = p.fiveHour?.displayAt(now, p.active), week = p.week?.displayAt(now, p.active))
})
