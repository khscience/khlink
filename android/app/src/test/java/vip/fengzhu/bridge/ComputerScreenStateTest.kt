package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ComputerScreenStateTest {
    @Test fun lockAlertsArePerLockAndUnknownIsNeverAnUnlock() {
        val first = parseComputerScreen(JSONObject().put("supported", true).put("locked", true).put("keepAwake", false)
            .put("wakeActive", false).put("lockId", "lock-one"))!!
        assertTrue(shouldNotifyComputerLock(first, null))
        assertFalse(shouldNotifyComputerLock(first, "lock-one"))
        assertTrue(shouldNotifyComputerLock(first.copy(lockId = "lock-two"), "lock-one"))
        assertFalse(shouldNotifyComputerLock(first.copy(locked = null), null))
        assertFalse(shouldNotifyComputerLock(first.copy(supported = false), null))
    }

    @Test fun distinguishesComputersAndShowsPendingOrFailedWakeState() {
        val state = ComputerScreenState(true, false, true, null, false, null)
        val screens = mapOf("one" to state, "two" to state.copy(locked = true, lockId = "other"))
        assertEquals(false, selectedComputerScreen("one", screens)?.locked)
        assertEquals(true, selectedComputerScreen("two", screens)?.locked)
        assertNull(selectedComputerScreen("unknown", screens))
        assertTrue(computerScreenSettingText(state, true).contains("等待电脑确认"))
        assertTrue(computerScreenSettingText(state.copy(wakeError = true), true).contains("未能应用"))
        assertTrue(computerScreenSettingText(state.copy(wakeActive = true), true).contains("已开启"))
        assertTrue(computerScreenSettingText(state, false).contains("未连接"))
    }
}
