package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Calendar
import java.util.TimeZone

class AgentUsageAndFileCacheTest {
    @Test fun boundariesUseLocalCalendarMidnightAndMonth() {
        val old = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Singapore"))
            val c = Calendar.getInstance().apply { clear(); set(2026, Calendar.NOVEMBER, 8, 19, 30) }
            val (today, month) = agentUsageBoundaries(c.timeInMillis)
            c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0)
            assertEquals(c.timeInMillis, today)
            c.set(Calendar.DAY_OF_MONTH, 1)
            assertEquals(c.timeInMillis, month)
        } finally { TimeZone.setDefault(old) }
    }
    @Test fun parsingRejectsMismatchedPeriodsAndUnknownTotals() {
        val json = JSONObject("""{"status":"ready","periods":{"todayFrom":100,"monthFrom":50,"today":{"total":150,"partial":true},"month":{"total":200},"all":null}}""")
        val parsed = parseAgentUsageEntry(json, 100, 50)
        assertEquals(AgentUsageAmount(150, true), parsed.today)
        assertNull(parsed.all)
        assertEquals("unavailable", parseAgentUsageEntry(json, 101, 50).status)
        assertEquals("unavailable", parseAgentUsageEntry(JSONObject("""{"status":"ready"}"""), 100, 50).status)
    }
    @Test fun sharesUseOnlyKnownAmountsAndKeepPartialMarks() {
        fun thread(id: String) = ThreadSummary(id, id, "", "", 0, false, "pc")
        val threads = listOf(thread("a"), thread("b"), thread("unknown"))
        val entries = mapOf("a" to AgentUsageEntry("ready", today = AgentUsageAmount(75, false)),
            "b" to AgentUsageEntry("ready", today = AgentUsageAmount(25, true)))
        val slices = agentUsageSlices(threads, entries, AgentUsagePeriod.TODAY)
        assertEquals(listOf("a", "b"), slices.map { it.thread.id })
        assertEquals(0.75, slices[0].fraction, 0.0001)
        assertEquals(0.25, slices[1].fraction, 0.0001)
        assertTrue(slices[1].amount.partial)
        assertEquals("<0.1%", formatAgentUsagePercent(0.00001))
        assertEquals("暂无法统计", formatAgentUsageAmount(AgentUsageAmount(0, true), TokenDisplayUnit.TenThousands))
    }
    @Test fun archivedThreadsAreExcludedForEveryAgentAndPeriod() {
        val agents = listOf("codex", "claude", "pi", "dsh", "hermes", "antigravity")
        for (agent in agents) {
            fun thread(id: String, archived: Boolean = false, pc: String = "pc", backend: String = agent) =
                ThreadSummary(id, id, "", "", 0, archived, pc, backend = backend)
            val source = listOf(thread("active"), thread("desktop-archived", true), thread("phone-archived"),
                thread("pending-archive"), thread("restoring", true), thread("other-pc", pc = "other"),
                thread("legacy-unscoped", pc = ""), thread("other-agent", backend = if (agent == "claude") "codex" else "claude"))
            val selected = agentUsageThreads(source, agent, "pc", 2,
                setOf("phone-archived", "restoring"), mapOf("pending-archive" to true, "restoring" to false))
            assertEquals("$agent selection", listOf("active", "restoring"), selected.map { it.id })
            fun amount(n: Long) = AgentUsageEntry("ready", AgentUsageAmount(n, false), AgentUsageAmount(n, false), AgentUsageAmount(n, false))
            val entries = source.associate { it.id to amount(if (it.id == "active") 75 else if (it.id == "restoring") 25 else 10_000) }
            for (period in AgentUsagePeriod.entries) {
                val slices = agentUsageSlices(selected, entries, period)
                assertEquals("$agent/$period", listOf("active", "restoring"), slices.map { it.thread.id })
                assertEquals(100L, slices.sumOf { it.amount.total })
                assertEquals(0.75, slices[0].fraction, 0.0001)
                assertEquals(0.25, slices[1].fraction, 0.0001)
            }
            val singlePc = agentUsageThreads(source, agent, "pc", 1, emptySet(), emptyMap())
            assertTrue(singlePc.any { it.id == "legacy-unscoped" })
            assertFalse(singlePc.any { it.id == "desktop-archived" })
        }
    }
    @Test fun openChartRechecksLiveAndLocalArchiveState() {
        fun thread(id: String, pc: String = "pc", archived: Boolean = false) =
            ThreadSummary(id, id, "", "", 0, archived, pc)
        val initiallyLoaded = listOf(thread("a"), thread("b"), thread("c"), thread("removed"))
        val live = listOf(thread("a", archived = true), thread("a", pc = "other"), thread("b"), thread("c"))
        assertEquals(listOf("c"), agentUsageLiveThreads(initiallyLoaded, live, setOf("b"), emptyMap()).map { it.id })
        assertEquals(listOf("a", "c"), agentUsageLiveThreads(initiallyLoaded, live, setOf("b"), mapOf("a" to false)).map { it.id })
        assertTrue(agentUsageLiveThreads(initiallyLoaded, live, setOf("b"), mapOf("c" to true)).isEmpty())
    }
    @Test fun cachedFileRequiresExactAccountComputerAndPath() {
        val root = Files.createTempDirectory("khlink-file-cache").toFile()
        try {
            val account = fetchedAccountScope("server", "account")
            val scope = fetchedFileScope(account, "computer-one")!!
            val otherComputer = fetchedFileScope(account, "computer-two")!!
            val otherAccount = fetchedFileScope(fetchedAccountScope("server", "other-account"), "computer-one")!!
            val path = "/home/user/音乐.mp3"
            val folder = File(root, fetchedFileKey(scope, path)).apply { mkdirs() }
            val payload = File(folder, "音乐.mp3").apply { writeText("audio") }
            File(folder, ".meta").writeText(JSONObject().put("path", path).put("scope", scope).put("name", payload.name).toString())
            assertEquals(payload, findFetchedCopy(root, path, scope, ".meta"))
            assertNull(findFetchedCopy(root, path, otherComputer, ".meta"))
            assertNull(findFetchedCopy(root, path, otherAccount, ".meta"))
            assertNull(findFetchedCopy(root, path.uppercase(), scope, ".meta"))
            File(folder, ".meta").writeText(JSONObject().put("path", path).put("name", payload.name).toString())
            assertNull(findFetchedCopy(root, path, scope, ".meta")) // legacy has no origin
            File(folder, ".meta").writeText(JSONObject().put("path", path).put("scope", scope).put("name", "../other").toString())
            assertNull(findFetchedCopy(root, path, scope, ".meta"))
        } finally { root.deleteRecursively() }
    }
    @Test fun trafficDescriptionsDoNotRevealMembershipAndStillExplainRealLimits() {
        val traffic = TrafficUsage("2026-11", 100, 300, 0)
        val privileged = trafficExplanation(traffic, true, "12 月 1 日")
        assertFalse(privileged.contains("khQuant", ignoreCase = true))
        assertFalse(privileged.contains("VIP", ignoreCase = true))
        assertFalse(privileged.contains("不限"))
        assertTrue(trafficExplanation(traffic, false, "12 月 1 日").contains("12 月 1 日"))
    }
    @Test fun legalCopyUsesGenericAuthorizationWithoutChangingExistingConsent() {
        assertEquals("kh-link-legal-v8", LegalCopy.VERSION)
        assertTrue("kh-link-legal-v7" in LegalCopy.STILL_ACCEPTED)
        assertTrue("kh-link-legal-v6" in LegalCopy.STILL_ACCEPTED)
        assertFalse(LegalCopy.agreement.contains("khQuant", ignoreCase = true))
        assertFalse(LegalCopy.privacy.contains("khQuant", ignoreCase = true))
        assertTrue(LegalCopy.agreement.contains("具体额度以账号实际授权为准"))
        assertTrue(LegalCopy.privacy.contains("会员权益状态"))
    }
    @Test fun audioAndPdfAreRecognizedWithoutTreatingOtherFilesAsMedia() {
        assertEquals(ComputerFileKind.AUDIO, computerFileKind("track.MP3"))
        assertEquals(ComputerFileKind.AUDIO, computerFileKind("声音.flac"))
        assertEquals(ComputerFileKind.PDF, computerFileKind("说明.PDF"))
        assertEquals(ComputerFileKind.OTHER, computerFileKind("archive.zip"))
    }
}
