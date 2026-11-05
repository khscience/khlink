package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OrderedReplayBufferTest {
    @Test fun liveFramesWaitForEveryReplayPageAndPresenceRemainsImmediate() {
        val gate = OrderedReplayBuffer<Long>()
        val applied = mutableListOf<Long>()
        var cursor = 0L
        val apply: (Long) -> Unit = { value ->
            if (value == 0L || value > cursor) {
                applied += value
                if (value > cursor) cursor = value
            }
        }
        // There can be gaps between account-visible sequence numbers.
        gate.offer(1_201, 1_201, 10, apply)
        gate.offer(0, 0, 10, apply)
        assertEquals(listOf(0L), applied)
        for (value in 1L..500L) gate.replay(value, apply)
        assertFalse(replayPageFinished(500, 500, 500, 1_200))
        for (value in 501L..1_000L) gate.replay(value, apply)
        assertFalse(replayPageFinished(500, 500, 1_000, 1_200))
        for (value in 1_001L..1_200L) gate.replay(value, apply)
        assertTrue(replayPageFinished(200, 500, 1_200, 1_200))
        gate.finish(apply)
        assertEquals((0L..1_201L).toList(), applied)
        assertEquals(1_201L, cursor)
    }

    @Test fun bufferedOverlapIsOrderedAndAppliedOnce() {
        val gate = OrderedReplayBuffer<Long>()
        val applied = mutableListOf<Long>()
        var cursor = 40L
        val apply: (Long) -> Unit = { if (it > cursor) { cursor = it; applied += it } }
        gate.offer(45, 45, 1, apply)
        gate.offer(43, 43, 1, apply)
        gate.offer(43, 43, 1, apply)
        gate.replay(41, apply)
        gate.replay(43, apply)
        gate.finish(apply)
        gate.offer(46, 46, 1, apply)
        assertEquals(listOf(41L, 43L, 45L, 46L), applied)
    }

    @Test fun overflowAndAbortDoNotAdvanceTheLiveCursor() {
        val gate = OrderedReplayBuffer<Long>(maxFrames = 1, maxBytes = 5)
        val applied = mutableListOf<Long>()
        assertTrue(gate.offer(10, 10, 5) { applied += it })
        assertFalse(gate.offer(11, 11, 1) { applied += it })
        gate.abort()
        assertFalse(gate.finish { applied += it })
        assertTrue(applied.isEmpty())
        assertFalse(replayPageFinished(500, 500, 1000, null))
        assertTrue(replayPageFinished(12, 500, 1030, 1100))
    }

    @Test
    fun aFreshDeviceReplaysOnlyRecentEvents() {
        org.junit.Assert.assertEquals(9_500L, freshReplayStart(0L, 10_000L, 500L))
        // A device that has caught up before resumes exactly where it stopped.
        org.junit.Assert.assertEquals(42L, freshReplayStart(42L, 10_000L, 500L))
        // Few events, or no snapshot yet: replay from the start as before.
        org.junit.Assert.assertEquals(0L, freshReplayStart(0L, 300L, 500L))
        org.junit.Assert.assertEquals(0L, freshReplayStart(0L, null, 500L))
    }
}
