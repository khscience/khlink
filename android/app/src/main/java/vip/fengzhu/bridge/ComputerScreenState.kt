package vip.fengzhu.bridge

import org.json.JSONObject

data class ComputerScreenState(
    val supported: Boolean,
    val locked: Boolean?,
    val keepAwake: Boolean,
    val wakeActive: Boolean?,
    val wakeError: Boolean,
    val lockId: String?,
)

internal fun parseComputerScreen(value: JSONObject?): ComputerScreenState? {
    value ?: return null
    if (value.opt("supported") !is Boolean) return null
    fun optionalBoolean(key: String): Boolean? = value.opt(key) as? Boolean
    val locked = optionalBoolean("locked")
    return ComputerScreenState(value.optBoolean("supported"), locked, value.optBoolean("keepAwake"),
        optionalBoolean("wakeActive"), value.optBoolean("wakeError"), value.optString("lockId").takeIf { locked == true && it.isNotBlank() && it != "null" })
}

// Unknown is not unlocked: it must neither post a fresh alert nor clear one.
internal fun shouldNotifyComputerLock(state: ComputerScreenState, notifiedLockId: String?): Boolean =
    state.supported && state.locked == true && !state.lockId.isNullOrBlank() && state.lockId != notifiedLockId

internal fun selectedComputerScreen(id: String?, screens: Map<String, ComputerScreenState>): ComputerScreenState? =
    if (id.isNullOrBlank()) screens.values.singleOrNull() else screens[id]
