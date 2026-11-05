package vip.fengzhu.bridge

val HOME_AGENT_IDS = listOf("codex", "dsh", "claude", "hermes", "pi", "antigravity")

/** Up to four tabs, in the user's order. Codex/Claude/DSH/Hermes by default. */
val DEFAULT_HOME_AGENT_ORDER = listOf("codex", "claude", "dsh", "hermes")
const val MAX_HOME_AGENTS = 4

enum class HomeAgentState { Open, Closed, Unknown, Offline }

/** Presence snapshots are not proof of a current computer state when the phone is offline. */
enum class ComputerPresence { Online, Offline, Unknown }
fun computerPresence(phoneHasNetwork: Boolean, lastSeen: Long?, now: Long): ComputerPresence = when {
    !phoneHasNetwork -> ComputerPresence.Unknown
    // The UI's periodic `now` can be a few seconds older than a just-received
    // heartbeat. Treat that heartbeat as fresh instead of flashing offline.
    lastSeen != null && lastSeen > 0L && now - lastSeen < 45_000L -> ComputerPresence.Online
    else -> ComputerPresence.Offline
}
fun computerPresenceLabel(presence: ComputerPresence): String = when (presence) {
    ComputerPresence.Online -> "在线"
    ComputerPresence.Offline -> "离线"
    ComputerPresence.Unknown -> "状态待确认"
}

/** Adds the Hermes tab: replaces Antigravity, else takes a free slot; a full set of others is left as chosen. */
fun withHermesTab(order: List<String>): List<String> = when {
    "hermes" in order -> order
    "antigravity" in order -> order.map { if (it == "antigravity") "hermes" else it }
    order.size < MAX_HOME_AGENTS -> order + "hermes"
    else -> order
}

fun normalizeHomeAgentOrder(order: List<String>): List<String> =
    order.filter { it in HOME_AGENT_IDS }.distinct().take(MAX_HOME_AGENTS).ifEmpty { listOf("codex") }

fun visibleHomeAgents(values: Set<String>): List<String> =
    HOME_AGENT_IDS.filter { it in values }.ifEmpty { listOf("codex") }

fun visibleHomeAgents(values: Set<String>, order: List<String>): List<String> =
    normalizeHomeAgentOrder(order).filter { it in values }.ifEmpty { listOf("codex") }

fun homeAgentState(id: String, openStates: Map<String, Boolean>, connection: ConnectionState): HomeAgentState = when {
    connection == ConnectionState.Offline -> HomeAgentState.Offline
    connection != ConnectionState.Online -> HomeAgentState.Unknown
    openStates[id] == true -> HomeAgentState.Open
    openStates[id] == false -> HomeAgentState.Closed
    else -> HomeAgentState.Unknown
}

/** The saved computer is per agent; an absent or removed choice keeps the current one. */
fun homeAgentConnector(
    agent: String,
    selected: String?,
    remembered: Map<String, String>,
    available: Set<String>,
): String? = remembered[agent]?.takeIf { it.isNotBlank() && (available.isEmpty() || it in available) }
    ?: selected?.takeIf { it.isNotBlank() }

/** Badge input: each tab gets its own computer's sessions, even while another tab is visible. */
fun threadsForHomeAgentTabs(
    threads: List<ThreadSummary>,
    selected: String?,
    remembered: Map<String, String>,
    available: Set<String>,
): List<ThreadSummary> {
    if (available.size <= 1) return threads
    return threads.filter { thread ->
        thread.connectorId.isBlank() || thread.connectorId == homeAgentConnector(backendTab(thread.backend), selected, remembered, available)
    }
}

/** Match the completed-but-unseen indication already shown in the chat layout. */
fun homeTabHasUnread(thread: ThreadSummary, status: String, now: Long = System.currentTimeMillis()): Boolean =
    !isWaitingThreadStatus(status) && (thread.unread || isFinishedUnseen(thread, status, now))

/** Resolve agent availability against the computer remembered by that agent. */
fun homeAgentStatesByConnector(
    selected: String?,
    remembered: Map<String, String>,
    available: Set<String>,
    selectedStates: Map<String, Boolean>,
    snapshots: Map<String, Map<String, Boolean>>,
    seenAt: Map<String, Long>,
    connection: ConnectionState,
    now: Long = System.currentTimeMillis(),
): Map<String, HomeAgentState> = HOME_AGENT_IDS.associateWith { agent ->
    if (available.size <= 1) return@associateWith homeAgentState(agent, selectedStates, connection)
    val connector = homeAgentConnector(agent, selected, remembered, available)
    val lastSeen = connector?.let(seenAt::get)
    if (connection == ConnectionState.Online && lastSeen != null && now - lastSeen >= 45_000L) {
        HomeAgentState.Offline
    } else {
        val states = connector?.let(snapshots::get) ?: if (connector == selected) selectedStates else emptyMap()
        homeAgentState(agent, states, connection)
    }
}

/** Keep the navigation order, including when the manually selected tab is closed. */
fun nextHomeAgent(selected: String, step: Int, tabs: List<String>, states: Map<String, HomeAgentState>): String? {
    val index = tabs.indexOf(selected)
    if (index < 0 || step == 0) return null
    val indices = if (step > 0) (index + 1 until tabs.size) else (index - 1 downTo 0)
    return indices.firstOrNull { states[tabs[it]] !in setOf(HomeAgentState.Closed, HomeAgentState.Offline) }?.let(tabs::get)
}
