package vip.fengzhu.bridge

import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/** Exercises synthetic status events only, in the separately installed QA app. */
class PjaCodexPrebootStatusTest {
    @Suppress("UNCHECKED_CAST")
    @Test fun quietUnknownDiscardsOldTimerAndKeepsNewTurnsWorking() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("vip.fengzhu.bridge.safeqa20261102", context.packageName)
        val repository = (context.applicationContext as FengzhuApplication).repository
        assertFalse("Only the logged-out QA app is allowed", repository.configured())
        val klass = BridgeRepository::class.java
        val setStatus = klass.getDeclaredMethod("setLiveStatus", String::class.java, String::class.java,
            java.lang.Long::class.java, String::class.java, java.lang.Boolean.TYPE).apply { isAccessible = true }
        fun field(name: String): Any = klass.getDeclaredField(name).apply { isAccessible = true }.get(repository)
        val starts = field("turnStartedAt") as MutableMap<String, Long>
        val turnIds = field("turnStartedTurnId") as MutableMap<String, String>
        val pending = field("pendingTurnEnds") as MutableMap<String, Pair<Long, Job>>
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val testScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            setStatus.invoke(repository, id, "desktop_running", now, "old-turn", false)
            assertNotNull(starts[id])
            val notice = testScope.launch { delay(60_000) }
            pending[id] = now to notice
            setStatus.invoke(repository, id, "unknown", now + 1, "old-turn", true)
            assertEquals("unknown", repository.liveStatuses.value[id])
            assertTrue(isUnknownThreadStatus(repository.liveStatuses.value[id].orEmpty()))
            assertFalse(isRunningThreadStatus(repository.liveStatuses.value[id].orEmpty()))
            assertFalse(isCompletedThreadStatus(repository.liveStatuses.value[id].orEmpty()))
            assertNull(starts[id])
            assertNull(turnIds[id])
            assertNull(pending[id])
            assertTrue(notice.isCancelled)
            assertNull(repository.turnDurations.value[id])

            setStatus.invoke(repository, id, "desktop_running", now + 2, "new-turn", false)
            assertEquals("new-turn", turnIds[id])
            SystemClock.sleep(30)
            setStatus.invoke(repository, id, "completed", now + 3, "new-turn", false)
            assertEquals("completed", repository.turnDurations.value[id]?.terminalStatus)
        } finally {
            testScope.cancel()
        }
    }
}
