package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAvatarTest {
    @Test fun sessionsGetDifferentPhotosUntilAllAreInUse() {
        assertEquals(AVATAR_PHOTO_COUNT, AVATAR_PHOTOS.size)
        val taken = mutableListOf<Int>()
        repeat(AVATAR_PHOTO_COUNT) { taken += nextFreeAvatarPhoto("local_$it", taken) }
        assertEquals(AVATAR_PHOTO_COUNT, taken.toSet().size)
        // All in use: a repeat is unavoidable, and it is the session's own start.
        assertEquals(autoAvatarPhoto("local_more"), nextFreeAvatarPhoto("local_more", taken))
    }

    @Test fun aFreeStartIsKeptAndATakenOneMovesOn() {
        val start = autoAvatarPhoto("local_x")
        assertEquals(start, nextFreeAvatarPhoto("local_x", emptyList()))
        val next = nextFreeAvatarPhoto("local_x", listOf(start))
        assertNotEquals(start, next)
        assertTrue(next in 0 until AVATAR_PHOTO_COUNT)
    }
}
