package vip.fengzhu.bridge

import java.util.concurrent.CountDownLatch
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionSnapshotGuardTest {
    @Test fun aDelayedOldAccountRefreshCannotRepopulateTheNewAccountList() {
        val guard = SessionSnapshotGuard()
        val oldTicket = guard.capture()
        val allowOldRefresh = CountDownLatch(1)
        val published = mutableListOf<String>()
        val oldRefresh = Thread {
            allowOldRefresh.await()
            guard.publish(oldTicket) { published += "old-account" }
        }
        oldRefresh.start()
        guard.invalidate { published.clear() }
        val currentTicket = guard.capture()
        guard.publish(currentTicket) { published += "new-account" }
        allowOldRefresh.countDown()
        oldRefresh.join(2_000)
        assertEquals(listOf("new-account"), published)
    }
}
