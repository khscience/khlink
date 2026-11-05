package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TrafficUsageTest {
    @Test fun formatsMonthlyTraffic() {
        assertEquals("860 KB", formatTraffic(860L * 1024))
        assertEquals("100.0 MB", formatTraffic(100L * 1024 * 1024))
        assertEquals("1.50 GB", formatTraffic(1536L * 1024 * 1024))
    }

    @Test fun parsesTheRelaysTrafficAndKnowsWhenTheFreeMonthIsUsedUp() {
        val usage = parseTrafficUsage(JSONObject().put("month", "2026-11").put("usedBytes", 90L * 1048576).put("limitBytes", 100L * 1048576).put("resetsAt", 1L))!!
        assertTrue(usage.free); assertFalse(usage.exhausted); assertEquals(0.9f, usage.fraction, 0.001f)
        assertTrue(usage.copy(usedBytes = 100L * 1048576).exhausted)
        // A relay without a free allowance (members only, or self-hosted) never runs out.
        assertFalse(usage.copy(limitBytes = 0).exhausted)
        assertNull(parseTrafficUsage(null)); assertNull(parseTrafficUsage(JSONObject()))
    }
}
