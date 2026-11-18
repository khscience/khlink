package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FetchedFileFreshnessTest {
    @Test
    fun anUnchangedFileKeepsItsCopy() {
        assertTrue(fetchedCopyIsCurrent(100, 100, 5_000, 6_000, remoteTotal = 100, remoteModifiedAt = 5_000))
    }

    @Test
    fun aFileEditedSinceIsFetchedAgain() {
        // An agent rewrote it with the same length: only the time tells.
        assertFalse(fetchedCopyIsCurrent(100, 100, 5_000, 6_000, remoteTotal = 100, remoteModifiedAt = 9_000))
        // A different length.
        assertFalse(fetchedCopyIsCurrent(100, 100, 5_000, 6_000, remoteTotal = 120, remoteModifiedAt = 5_000))
    }

    @Test
    fun anOlderRecordComparesWithWhenItWasFetched() {
        // Records written before 0.1.352 have no size or time of their own.
        assertTrue(fetchedCopyIsCurrent(100, null, null, 6_000, remoteTotal = 100, remoteModifiedAt = 5_000))
        assertFalse(fetchedCopyIsCurrent(100, null, null, 6_000, remoteTotal = 100, remoteModifiedAt = 7_000))
        assertFalse(fetchedCopyIsCurrent(100, null, null, 6_000, remoteTotal = 101, remoteModifiedAt = 5_000))
    }

    @Test
    fun anOlderConnectorOnlyReportsTheSize() {
        assertTrue(fetchedCopyIsCurrent(100, 100, 5_000, 6_000, remoteTotal = 100, remoteModifiedAt = null))
        assertFalse(fetchedCopyIsCurrent(100, 100, 5_000, 6_000, remoteTotal = 90, remoteModifiedAt = null))
    }
}
