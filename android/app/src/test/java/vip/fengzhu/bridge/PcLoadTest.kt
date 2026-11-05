package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PcLoadTest {
    @Test
    fun presenceLoadIsReadAndClamped() {
        val load = pcLoadOf(37, null, 104, 1_790_772_654_000L, 5_000L)
        assertEquals(37, load.cpu)
        assertNull("no NVIDIA GPU", load.gpu)
        assertEquals(100, load.mem)
        assertNull("JSON null is unknown", pcLoadOf(1, "null", 2, 0L, 0L).gpu)
    }

    @Test
    fun anOldSampleIsNotShown() {
        val load = PcLoad(10, 20, 30, 0L, receivedAt = 1_000L)
        assertTrue(load.isFresh(15_000L))
        assertFalse(load.isFresh(25_000L))
    }
}
