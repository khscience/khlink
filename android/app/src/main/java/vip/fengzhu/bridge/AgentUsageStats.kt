package vip.fengzhu.bridge

import org.json.JSONObject
import java.util.Calendar

enum class AgentUsagePeriod(val label: String) { TODAY("今天"), MONTH("本月"), ALL("全部") }

data class AgentUsageAmount(val total: Long, val partial: Boolean)
data class AgentUsageEntry(val status: String, val today: AgentUsageAmount? = null,
    val month: AgentUsageAmount? = null, val all: AgentUsageAmount? = null, val reason: String? = null) {
    fun amount(period: AgentUsagePeriod): AgentUsageAmount? = when (period) {
        AgentUsagePeriod.TODAY -> today; AgentUsagePeriod.MONTH -> month; AgentUsagePeriod.ALL -> all
    }
}
data class AgentUsageSnapshot(val backend: String, val connectorId: String?, val todayFrom: Long, val monthFrom: Long, val requestKey: String,
    val threads: List<ThreadSummary> = emptyList(), val entries: Map<String, AgentUsageEntry> = emptyMap(),
    val loading: Boolean = true, val reason: String? = null)
data class AgentUsageSlice(val thread: ThreadSummary, val amount: AgentUsageAmount, val fraction: Double)

/** Match the home list: a pending archive/restore overrides the stored state. */
internal fun agentUsageIsArchived(thread: ThreadSummary, phoneArchived: Set<String>, archiving: Map<String, Boolean>): Boolean =
    archiving[thread.id] ?: (thread.archived || thread.id in phoneArchived)

/** Choose which sessions may be read for a particular agent and computer. */
internal fun agentUsageThreads(threads: List<ThreadSummary>, backend: String, connectorId: String?, computerCount: Int,
    phoneArchived: Set<String>, archiving: Map<String, Boolean>): List<ThreadSummary> =
    threads.filter { thread ->
        backendTab(thread.backend) == backend &&
            (thread.connectorId == connectorId || (thread.connectorId.isBlank() && computerCount <= 1)) &&
            !agentUsageIsArchived(thread, phoneArchived, archiving)
    }.distinctBy { it.id }

/** Recheck loaded sessions as the live list or local archive state changes. */
internal fun agentUsageLiveThreads(loaded: List<ThreadSummary>, live: List<ThreadSummary>,
    phoneArchived: Set<String>, archiving: Map<String, Boolean>): List<ThreadSummary> {
    val byOrigin = live.associateBy { it.id to it.connectorId }
    return loaded.mapNotNull { byOrigin[it.id to it.connectorId] }
        .filterNot { agentUsageIsArchived(it, phoneArchived, archiving) }
}

/** Local midnight, including daylight-saving changes, rather than a 24-hour subtraction. */
internal fun agentUsageBoundaries(now: Long = System.currentTimeMillis()): Pair<Long, Long> {
    val calendar = Calendar.getInstance().apply {
        timeInMillis = now
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }
    val today = calendar.timeInMillis
    calendar.set(Calendar.DAY_OF_MONTH, 1)
    return today to calendar.timeInMillis
}

internal fun parseAgentUsageEntry(value: JSONObject, todayFrom: Long, monthFrom: Long): AgentUsageEntry {
    val state = value.optString("status")
    val reason = value.optString("reason").takeIf { it.isNotBlank() && it != "null" }
    if (state == "scanning") return AgentUsageEntry("scanning", reason = reason)
    if (state != "ready") return AgentUsageEntry("unavailable", reason = reason ?: "暂无用量数据")
    val periods = value.optJSONObject("periods") ?: return AgentUsageEntry("unavailable", reason = "请更新这台电脑的连接器")
    if (periods.optLong("todayFrom") != todayFrom || periods.optLong("monthFrom") != monthFrom)
        return AgentUsageEntry("unavailable", reason = "用量时间范围不匹配，请刷新")
    fun amount(name: String): AgentUsageAmount? {
        val row = periods.optJSONObject(name) ?: return null
        val raw = row.opt("total") as? Number ?: return null
        val n = raw.toDouble()
        if (!n.isFinite() || n < 0 || n > 9_007_199_254_740_991.0 || n != raw.toLong().toDouble()) return null
        return AgentUsageAmount(raw.toLong(), row.optBoolean("partial"))
    }
    return AgentUsageEntry("ready", amount("today"), amount("month"), amount("all"), reason)
}

/** Percentages are based only on known amounts; callers must surface partial coverage. */
internal fun agentUsageSlices(threads: List<ThreadSummary>, entries: Map<String, AgentUsageEntry>, period: AgentUsagePeriod): List<AgentUsageSlice> {
    val known = threads.mapNotNull { thread -> entries[thread.id]?.amount(period)?.let { thread to it } }
        .sortedWith(compareByDescending<Pair<ThreadSummary, AgentUsageAmount>> { it.second.total }.thenBy { it.first.title })
    val total = known.sumOf { it.second.total.toDouble() }
    return known.map { (thread, amount) -> AgentUsageSlice(thread, amount, if (total > 0) amount.total / total else 0.0) }
}
