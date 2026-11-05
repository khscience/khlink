package vip.fengzhu.bridge

// Requests the app sends by itself (opening a thread, reconnecting, the home
// screen's periodic reads). Their failure has no one waiting for it, so it must
// never raise the blocking message dialog: a backend that is down would
// otherwise pop the same dialog up again every few seconds.
private val BACKGROUND_ACTIONS = setOf(
    "capabilities", "backends.capabilities", "claude.usage", "claude.usage.refresh", "dsh.usage",
    "followup.list", "thread.list", "thread.read", "thread.settings.read", "thread.ownership.read",
    "history.sync", "accounts.read",
)

/**
 * Whether a failed command result should be shown to the user. `action` is
 * null for a result this app does not know it asked for (another device's, or
 * one replayed after the request was forgotten): nobody here is waiting for it.
 */
internal fun shouldShowCommandFailure(action: String?): Boolean =
    action != null && action !in BACKGROUND_ACTIONS && !action.startsWith("file.upload.") && action !in SHOWN_BY_CALLER

// Requests whose screen shows the failure itself (the computer-file dialog
// says why a file could not be opened); a second, global dialog repeated it.
private val SHOWN_BY_CALLER = setOf("file.read", "file.historyDetailPart", "history.details")

/** Pi and Antigravity have no per-thread settings to read; DSH has its own dialog. */
internal fun backendHasThreadSettings(backend: String?): Boolean = backend != "pi" && backend != "antigravity"

// These commands may have reached the computer before their ACK was lost.
// A timeout provides no proof of rejection for any agent; showing "failed,
// retry" encouraged a second message with a new request ID.
internal fun instructionAckTimeoutState(action: String?): String =
    if (action in setOf("turn.start", "turn.steer", "followup.enqueue")) "uncertain" else "failed"

internal fun canSteerQueuedInstruction(backend: String, state: String, origin: String?, turnBusy: Boolean): Boolean =
    backend != "antigravity" && origin != "desktop" &&
        (state == "desktop_queued" || (backend == "codex" && state == "pending" && turnBusy))

/** Show actionable queue explanations even when the message is safely queued. */
internal fun visibleQueuedInstructionReason(state: String, reason: String?): String? {
    val text = reason?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return text.takeIf { state in setOf("uncertain", "failed") || it.startsWith("电脑端队列因中断而暂停") }
}

/** What to say once the computer has archived (or unarchived) a task; `note` is the computer's remark, if any. */
internal fun archiveDoneMessage(archived: Boolean, title: String, note: String?): String {
    val name = title.trim().take(20).let { if (it.isEmpty()) "" else "「$it」" }
    val text = if (archived) "已归档$name，要恢复请在电脑端的归档里取消归档" else "已取消归档$name"
    val remark = note?.trim().orEmpty().takeUnless { it == "null" }.orEmpty()
    return if (remark.isEmpty()) text else "$text（$remark）"
}
