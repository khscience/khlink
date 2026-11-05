package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    @Test
    fun offersOnlyNewerVersionsUnlessSkippedOrPostponed() {
        assertFalse(shouldOfferUpdate(240, 240, 0, emptySet()))
        assertTrue(shouldOfferUpdate(241, 240, 0, emptySet()))
        assertFalse(shouldOfferUpdate(241, 240, 241, emptySet()))
        assertFalse(shouldOfferUpdate(241, 240, 240, setOf(241)))
        assertTrue(shouldOfferUpdate(242, 240, 241, setOf(242).minus(242)))
    }

    @Test
    fun manualCheckFindsTheVersionPostponedEarlierInThisRun() {
        val postponed = setOf(247)
        assertFalse(shouldOfferUpdate(247, 246, 0, postponed))
        assertTrue(shouldOfferUpdate(247, 246, 0, postponed, manual = true))
        // Checking manually must not discard the user's automatic-reminder preference.
        assertFalse(shouldOfferUpdate(247, 246, 0, postponed))
    }

    @Test
    fun manualCheckFindsAPersistentlySkippedVersion() {
        assertFalse(shouldOfferUpdate(247, 246, 247, emptySet()))
        assertTrue(shouldOfferUpdate(247, 246, 247, emptySet(), manual = true))
        assertFalse(shouldOfferUpdate(247, 246, 247, emptySet()))
    }

    @Test
    fun manualCheckDoesNotOfferInstalledOrOlderVersions() {
        assertFalse(shouldOfferUpdate(247, 247, 247, setOf(247), manual = true))
        assertFalse(shouldOfferUpdate(246, 247, 246, setOf(246), manual = true))
        assertTrue(shouldOfferUpdate(248, 247, 248, setOf(248), manual = true))
    }

    @Test
    fun aNewReleasePromptsAutomaticallyAfterDeferringThePreviousOne() {
        assertTrue(shouldOfferUpdate(248, 246, 247, setOf(247)))
    }
}
