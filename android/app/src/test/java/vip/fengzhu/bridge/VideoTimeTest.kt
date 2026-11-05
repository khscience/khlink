package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class VideoTimeTest {
    @Test fun timesReadLikeAPlayer() {
        assertEquals("0:00", formatVideoTime(0))
        assertEquals("1:21", formatVideoTime(80_700))
        assertEquals("10:05", formatVideoTime(605_000))
        assertEquals("1:02:05", formatVideoTime(3_725_000))
        assertEquals("0:00", formatVideoTime(-5))
    }

    @Test fun aVideoIsPickedUpWhereItWasLeft() {
        val file = java.io.File("J:/mov/ep1/video.mp4")
        assertEquals(0L, VideoPositions.of(java.io.File("J:/other.mp4")))
        VideoPositions.set(file, 12_345)
        assertEquals(12_345L, VideoPositions.of(file))
    }
}
