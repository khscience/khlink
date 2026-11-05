package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeAgentNavigationTest {
    @Test fun computerPresenceDoesNotClaimOnlineFromAStaleSnapshotWhenPhoneHasNoNetwork() {
        assertEquals(ComputerPresence.Unknown, computerPresence(false, 99_000L, 100_000L))
        assertEquals("状态待确认", computerPresenceLabel(computerPresence(false, 99_000L, 100_000L)))
        assertEquals(ComputerPresence.Online, computerPresence(true, 99_000L, 100_000L))
        assertEquals(ComputerPresence.Offline, computerPresence(true, 50_000L, 100_000L))
        // A heartbeat can arrive after the UI's most recent periodic clock tick.
        assertEquals(ComputerPresence.Online, computerPresence(true, 101_000L, 100_000L))
    }

    @Test fun badgesUseTheComputerRememberedByEachAgentRegardlessOfTheOpenTab() {
        val now = 100_000L
        fun thread(id: String, backend: String, connector: String) =
            ThreadSummary(id, id, "", "completed", now - 1_000L, false, connector, unread = true, backend = backend)
        val rows = listOf(
            thread("codex-pc", "codex", "pc"),
            thread("codex-server", "codex", "server"),
            thread("hermes-pc", "hermes", "pc"),
            thread("hermes-server", "hermes", "server"),
            thread("old-owner-unknown", "codex", ""),
        )
        val selections = mapOf("codex" to "pc", "hermes" to "server")
        for (current in listOf("pc", "server")) {
            val tabRows = threadsForHomeAgentTabs(rows, current, selections, setOf("pc", "server"))
            assertEquals(setOf("codex-pc", "hermes-server", "old-owner-unknown"), tabRows.map { it.id }.toSet())
            assertTrue(tabRows.any { it.id == "codex-pc" && wantsRedDot(it, it.status, now) })
            assertTrue(tabRows.any { it.id == "hermes-server" && wantsRedDot(it, it.status, now) })
        }
    }

    @Test fun tabSelectionFallsBackSafelyForOldAndRemovedDeviceChoices() {
        val rows = listOf(
            ThreadSummary("pc", "", "", "idle", 1L, false, "pc", backend = "codex"),
            ThreadSummary("server", "", "", "idle", 1L, false, "server", backend = "codex"),
        )
        assertEquals("pc", homeAgentConnector("codex", "pc", mapOf("codex" to "removed"), setOf("pc", "server")))
        assertEquals(listOf("pc"), threadsForHomeAgentTabs(rows, "pc", emptyMap(), setOf("pc", "server")).map { it.id })
        assertEquals(rows, threadsForHomeAgentTabs(rows, "pc", emptyMap(), setOf("pc")))
    }

    @Test fun standardTabsShowFinishedUnseenAndKeepWaitingSeparate() {
        val now = 100_000L
        val unseen = ThreadSummary("h", "", "", "completed", now - 1_000L, false, "server", backend = "hermes", phoneReadAt = now - 2_000L)
        assertTrue(homeTabHasUnread(unseen, "completed", now))
        assertFalse(homeTabHasUnread(unseen.copy(phoneReadAt = now), "completed", now))
        assertFalse(homeTabHasUnread(unseen.copy(unread = true), "waiting_input", now))
    }

    @Test fun agentAvailabilityUsesItsOwnComputerAndExpiresStalePresence() {
        val selected = mapOf("codex" to "pc", "hermes" to "server")
        val snapshots = mapOf("pc" to mapOf("codex" to true, "hermes" to false), "server" to mapOf("codex" to false, "hermes" to true))
        val available = setOf("pc", "server")
        val fresh = mapOf("pc" to 99_000L, "server" to 99_000L)
        for (current in available) {
            val states = homeAgentStatesByConnector(current, selected, available, snapshots.getValue(current), snapshots, fresh, ConnectionState.Online, 100_000L)
            assertEquals(HomeAgentState.Open, states["codex"])
            assertEquals(HomeAgentState.Open, states["hermes"])
            assertFalse(states["hermes"] == HomeAgentState.Closed)
        }
        val stale = homeAgentStatesByConnector("pc", selected, available, snapshots.getValue("pc"), snapshots, fresh + ("server" to 40_000L), ConnectionState.Online, 100_000L)
        assertEquals(HomeAgentState.Open, stale["codex"])
        assertEquals(HomeAgentState.Offline, stale["hermes"])
        val disconnected = homeAgentStatesByConnector("pc", selected, available, snapshots.getValue("pc"), snapshots, fresh, ConnectionState.Offline, 100_000L)
        assertEquals(HomeAgentState.Offline, disconnected["codex"])
        assertEquals(HomeAgentState.Offline, disconnected["hermes"])
    }

    @Test fun swipeSkipsClosedAgentsInBothDirections() {
        val states = mapOf("codex" to HomeAgentState.Open, "dsh" to HomeAgentState.Closed, "claude" to HomeAgentState.Closed, "hermes" to HomeAgentState.Closed, "pi" to HomeAgentState.Open, "antigravity" to HomeAgentState.Closed)
        assertEquals("pi", nextHomeAgent("codex", 1, HOME_AGENT_IDS, states))
        assertEquals("codex", nextHomeAgent("pi", -1, HOME_AGENT_IDS, states))
        assertNull(nextHomeAgent("pi", 1, HOME_AGENT_IDS, states))
    }

    @Test fun manuallySelectedClosedTabCanStillSwipeToItsNeighbours() {
        val states = mapOf("codex" to HomeAgentState.Open, "dsh" to HomeAgentState.Closed, "claude" to HomeAgentState.Closed, "hermes" to HomeAgentState.Offline, "pi" to HomeAgentState.Open)
        assertEquals("pi", nextHomeAgent("claude", 1, HOME_AGENT_IDS, states))
        assertEquals("codex", nextHomeAgent("claude", -1, HOME_AGENT_IDS, states))
    }

    @Test fun hiddenAndOfflineAgentsAreNeverSwipeDestinations() {
        val tabs = visibleHomeAgents(setOf("antigravity", "codex", "invalid"))
        assertEquals(listOf("codex", "antigravity"), tabs)
        assertNull(nextHomeAgent("codex", 1, tabs, tabs.associateWith { HomeAgentState.Offline }))
        assertEquals(listOf("codex"), visibleHomeAgents(emptySet()))
    }

    @Test fun connectionLossOverridesTheLastOpenSnapshot() {
        assertEquals(HomeAgentState.Open, homeAgentState("codex", mapOf("codex" to true), ConnectionState.Online))
        assertEquals(HomeAgentState.Offline, homeAgentState("codex", mapOf("codex" to true), ConnectionState.Offline))
        assertEquals(HomeAgentState.Unknown, homeAgentState("codex", mapOf("codex" to true), ConnectionState.Connecting))
        assertEquals(HomeAgentState.Closed, homeAgentState("pi", mapOf("pi" to false), ConnectionState.Online))
    }

    @Test fun desktopPresenceBooleansMapToOpenOrClosedForEveryAgent() {
        val states = mapOf(
            "codex" to homeAgentState("codex", mapOf("codex" to false), ConnectionState.Online),
            "claude" to homeAgentState("claude", mapOf("claude" to true), ConnectionState.Online),
            "pi" to homeAgentState("pi", mapOf("pi" to false), ConnectionState.Online),
            "antigravity" to homeAgentState("antigravity", mapOf("antigravity" to true), ConnectionState.Online),
            "dsh" to homeAgentState("dsh", mapOf("dsh" to true), ConnectionState.Online),
        )
        assertEquals(HomeAgentState.Closed, states["codex"])
        assertEquals(HomeAgentState.Open, states["claude"])
        assertEquals(HomeAgentState.Closed, states["pi"])
        assertEquals(HomeAgentState.Open, states["antigravity"])
        assertEquals(HomeAgentState.Open, states["dsh"])
    }

    @Test fun olderConnectorsWithoutAgentStatesKeepNavigationUsable() {
        assertEquals(HomeAgentState.Unknown, homeAgentState("claude", emptyMap(), ConnectionState.Online))
        assertEquals("dsh", nextHomeAgent("codex", 1, HOME_AGENT_IDS, emptyMap()))
    }

    @Test fun hermesTakesAntigravitysPlaceOrAFreeSlotOnce() {
        assertEquals(listOf("codex", "claude", "dsh", "hermes"), withHermesTab(listOf("codex", "claude", "dsh", "antigravity")))
        assertEquals(listOf("codex", "claude", "hermes"), withHermesTab(listOf("codex", "claude")))
        assertEquals(listOf("codex", "claude", "dsh", "pi"), withHermesTab(listOf("codex", "claude", "dsh", "pi")))
        assertEquals(listOf("hermes", "codex"), withHermesTab(listOf("hermes", "codex")))
        assertEquals("hermes", backendTab("hermes"))
        assertEquals(listOf("codex", "claude", "dsh", "hermes"), DEFAULT_HOME_AGENT_ORDER)
    }

    @Test fun hermesModelsReadAsMoaPresetsOrShortNames() {
        assertEquals("专家会诊 · panel", hermesModelLabel("moa/panel"))
        assertEquals("专家会诊 · quick", hermesModelLabel("quick"))
        assertEquals("默认模型", hermesModelLabel(""))
        assertEquals(shortModelName("claude-sonnet-4-6"), hermesModelLabel("custom/custom:claude-sonnet-4-6"))
    }
}
