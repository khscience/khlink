package vip.fengzhu.bridge

/** Only the settings the person changed should be sent to Codex Desktop. */
internal data class CodexSettingsChanges(
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val clearTier: Boolean = false,
    val permissionMode: String? = null,
    val collaborationMode: String? = null,
) {
    fun isEmpty() = model == null && effort == null && serviceTier == null && !clearTier &&
        permissionMode == null && collaborationMode == null
}

private fun normalizedCodexTier(value: String?): String? = value?.lowercase()?.takeUnless {
    it in setOf("", "default", "standard", "auto")
}?.let { if (it == "priority") "fast" else it }

internal fun codexSettingsChanges(
    current: ThreadSettings,
    model: String?,
    effort: String?,
    tier: String?,
    permissionMode: String,
    collaborationMode: String,
): CodexSettingsChanges {
    val oldTier = normalizedCodexTier(current.serviceTier)
    val newTier = normalizedCodexTier(tier)
    return CodexSettingsChanges(
        model = model?.takeIf { it.isNotBlank() && it != current.model },
        effort = effort?.takeIf { it.isNotBlank() && it != current.effort },
        serviceTier = newTier?.takeIf { it != oldTier },
        clearTier = newTier == null && oldTier != null,
        permissionMode = permissionMode.takeIf { it != current.permissionMode },
        collaborationMode = collaborationMode.takeIf {
            it != current.desiredCollaborationMode || current.modeSyncState == "failed"
        },
    )
}
