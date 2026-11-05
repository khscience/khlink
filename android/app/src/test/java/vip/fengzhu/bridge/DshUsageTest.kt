package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class DshUsageTest {
    @Test fun parsesBalanceAndTodaysTokens() {
        val usage = parseDshUsage(JSONObject("""
            {
              "backend":"dsh",
              "day":"2026-10-18",
              "today":{"input":2940000,"output":800000,"cacheRead":324160000,"cacheWrite":0,"total":327900000},
              "account":{"status":"credential-stored","contact":"150******22","balance":[{"currency":"CNY","balance":"60.00"}],"bonusWallets":[{"currency":"CNY","balance":"0"}]},
              "spent":1.72,"spentCurrency":"CNY","spentSince":0,
              "updatedAt":1792288097461
            }
        """))
        assertNotNull(usage)
        assertEquals(2_940_000L, usage!!.input)
        assertEquals(800_000L, usage.output)
        assertEquals(324_160_000L, usage.cacheRead)
        assertEquals("¥60.00", dshBalanceText(usage))
        assertEquals("¥1.72", dshSpentText(usage))
        assertEquals("今日累计", dshSpentLabel(usage))
        assertEquals("3.74M", compactDshTokens(usage.input + usage.output))
        assertEquals("324.16M", compactDshTokens(usage.cacheRead))
    }

    @Test fun missingAccountStillShowsUsage() {
        val usage = parseDshUsage(JSONObject("""{"today":{"input":12,"output":3},"account":{"status":"signed-out"}}"""))
        assertEquals("—", dshBalanceText(usage))
        assertEquals("—", dshSpentText(usage))
        assertEquals("15", compactDshTokens((usage?.input ?: 0) + (usage?.output ?: 0)))
    }

    @Test fun pinnedDshThreadsStayInThePinnedSectionWhileAlsoRecent() {
        assertEquals(true, "dsh" in DESKTOP_MIRRORED_PIN_TABS)
    }
}
