package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class LiveStatusSnapshotTest {
    @Test
    fun heartbeatOmissionKeepsBusyStatusesUntilExplicitTerminalEvent() {
        val existing = mapOf(
            "finished" to "desktop_running",
            "waiting" to "desktop_waiting_input",
            "failed" to "failed",
            "mobile-queued" to "queued",
        )

        assertEquals(
            mapOf("finished" to "desktop_running", "waiting" to "desktop_waiting_input", "failed" to "failed", "mobile-queued" to "queued"),
            reconcileLiveStatusSnapshot(existing, mapOf("waiting" to "desktop_waiting_input")),
        )
    }

    @Test
    fun emptyHeartbeatDoesNotCompleteMobileBusyStatusOrQueuedRows() {
        assertEquals(
            mapOf("mobile" to "mobile_running", "queued" to "queued"),
            reconcileLiveStatusSnapshot(
                mapOf("mobile" to "mobile_running", "queued" to "queued"),
                emptyMap(),
            ),
        )
    }

    @Test
    fun durableRunningStatusIsNotTerminalizedByAnEmptyHeartbeat() {
        assertEquals(
            emptyMap<String, String>(),
            reconcileLiveStatusSnapshot(
                emptyMap(),
                emptyMap(),
                mapOf("finished" to "running"),
            ),
        )
    }

    @Test
    fun snapshotCanRefreshAnExistingBusyStatus() {
        assertEquals(
            mapOf("task" to "desktop_waiting_input"),
            reconcileLiveStatusSnapshot(mapOf("task" to "desktop_running"), mapOf("task" to "desktop_waiting_input")),
        )
    }

    @Test
    fun aBusyTaskMissingFromHeartbeatsFor90SecondsIsRetired() {
        val absent = mutableMapOf<String, Long>()
        val current = mapOf("stuck" to "desktop_running", "live" to "desktop_running", "done" to "completed")
        val lastEvent = mapOf("stuck" to 1_000L, "live" to 1_000L)
        // A brief omission is not a completion.
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, setOf("live"), absent, 10_000L, lastEvent))
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, setOf("live"), absent, 60_000L, lastEvent))
        // Reappearing restarts the clock.
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, setOf("live", "stuck"), absent, 70_000L, lastEvent))
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, setOf("live"), absent, 80_000L, lastEvent))
        // Missing from every fresh heartbeat for 90 s: its end event was missed.
        assertEquals(setOf("stuck"), retireLongAbsentBusyStatuses(current, setOf("live"), absent, 170_000L, lastEvent))
        assertEquals(emptyMap<String, Long>(), absent)
    }

    @Test
    fun aHeartbeatOlderThanTheTasksLastEventDoesNotCount() {
        val absent = mutableMapOf<String, Long>()
        val current = mapOf("new" to "mobile_running")
        val lastEvent = mapOf("new" to 500_000L)
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, emptySet(), absent, 100_000L, lastEvent))
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(current, emptySet(), absent, 400_000L, lastEvent))
        assertEquals(emptyMap<String, Long>(), absent)
    }

    @Test
    fun missingCodexHeartbeatsBecomeUnknownAndCanResumeWithoutFakeCompletion() {
        val absent = mutableMapOf<String, Long>()
        val running = mapOf("codex" to "desktop_running", "claude" to "desktop_running")
        val backends = mapOf("codex" to "codex", "claude" to "claude")
        assertEquals(emptySet<String>(), retireLongAbsentBusyStatuses(running, emptySet(), absent, 1_000L, emptyMap()))
        val retired = retireLongAbsentBusyStatuses(running, emptySet(), absent, 91_000L, emptyMap())
        val uncertain = applyAbsentStatusRetirement(running, retired, backends)
        assertEquals("unknown", uncertain["codex"])
        assertFalse(isCompletedThreadStatus(uncertain.getValue("codex")))
        assertEquals("completed", uncertain["claude"])
        assertEquals("desktop_running", reconcileLiveStatusSnapshot(uncertain, mapOf("codex" to "desktop_running"))["codex"])
    }
}
