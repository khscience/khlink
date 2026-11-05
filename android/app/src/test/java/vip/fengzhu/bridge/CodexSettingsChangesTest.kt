package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexSettingsChangesTest {
    private val current = ThreadSettings(model = "gpt-6-astra", effort = "medium", serviceTier = "priority", permissionMode = "manual")

    @Test fun changingOnlyPlanModeDoesNotResendOtherSettings() {
        assertEquals(CodexSettingsChanges(collaborationMode = "plan"), codexSettingsChanges(current, "gpt-6-astra", "medium", "fast", "manual", "plan"))
    }

    @Test fun unchangedSettingsDoNotCreateACommand() {
        assertTrue(codexSettingsChanges(current, "gpt-6-astra", "medium", "fast", "manual", "default").isEmpty())
    }

    @Test fun speedResetAndIndependentModelChangeArePreserved() {
        val delta = codexSettingsChanges(current, "gpt-6.1-sol", "high", null, "yolo", "default")
        assertEquals(CodexSettingsChanges(model = "gpt-6.1-sol", effort = "high", clearTier = true, permissionMode = "yolo"), delta)
        assertFalse(delta.isEmpty())
    }

    @Test fun failedModeCanBeRetriedWithoutChangingTheSelection() {
        val failed = current.copy(desiredCollaborationMode = "plan", modeSyncState = "failed")
        assertEquals("plan", codexSettingsChanges(failed, failed.model, failed.effort, "fast", "manual", "plan").collaborationMode)
    }
}
