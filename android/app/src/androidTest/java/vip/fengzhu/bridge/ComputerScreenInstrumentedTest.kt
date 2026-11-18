package vip.fengzhu.bridge

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Runs only in the separate demo package; no real account or computer is touched. */
@RunWith(AndroidJUnit4::class)
class ComputerScreenInstrumentedTest {
    @Test fun simulatedLockShowsAndDeduplicatesTheRealPhoneNotification() = runBlocking {
        assumeTrue(BuildConfig.DEMO)
        val app = ApplicationProvider.getApplicationContext<FengzhuApplication>()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        val repo = app.repository
        repo.recoverSessionOnStartup()
        val pc = repo.selectedConnectorId.value ?: error("demo computer missing")
        val launch = Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(launch)
        ContextCompat.startForegroundService(app, Intent(app, BridgeService::class.java))
        for (attempt in 0 until 50) {
            if (repo.computerLockNotificationSink != null) break
            SystemClock.sleep(100)
        }
        assertNotNull(repo.computerLockNotificationSink)

        val method = BridgeRepository::class.java.getDeclaredMethod("applyFrame", JSONObject::class.java, String::class.java, String::class.java, JSONObject::class.java)
        method.isAccessible = true
        fun send(locked: Boolean?, id: String?) {
            val screen = JSONObject().put("supported", true).put("locked", locked ?: JSONObject.NULL)
                .put("keepAwake", false).put("wakeActive", false).put("lockId", id ?: JSONObject.NULL)
            val frame = JSONObject().put("sourceDeviceId", pc).put("createdAt", System.currentTimeMillis())
            val payload = JSONObject().put("connectorId", pc).put("deviceName", "测试电脑").put("sentAt", System.currentTimeMillis()).put("screen", screen)
            method.invoke(repo, frame, "connector.presence", null, payload)
        }
        val manager = app.getSystemService(NotificationManager::class.java)
        val tag = "computer-lock:$pc"
        fun notices() = manager.activeNotifications.filter { it.tag == tag }
        fun waitUntil(predicate: () -> Boolean): Boolean {
            repeat(150) { if (predicate()) return true else SystemClock.sleep(100) }
            return predicate()
        }
        val firstId = UUID.randomUUID().toString()
        try {
            send(false, null); send(true, firstId)
            assertTrue("lock notification should arrive", waitUntil { notices().size == 1 })
            assertEquals(true, repo.computerScreens.value[pc]?.locked)
            assertEquals(1, notices().size)
            val whenFirst = notices().single().notification.`when`
            send(null, null); send(true, firstId); SystemClock.sleep(300)
            assertEquals(whenFirst, notices().single().notification.`when`)
            send(false, null)
            assertTrue("unlock should remove the notification", waitUntil { notices().isEmpty() })
            send(true, UUID.randomUUID().toString())
            assertTrue("a new lock should generate a new notification", waitUntil { notices().size == 1 })
        } finally {
            send(false, null); app.stopService(Intent(app, BridgeService::class.java))
        }
    }
}
