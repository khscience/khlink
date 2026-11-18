package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LightDetailCacheTest {
    private fun part(index: Int, value: String) = LightDetailCachePart("thread", "item", index, value)

    @Test fun joinsOnlyCompleteOrderedBoundedParts() {
        assertEquals("abcdef", joinLightDetailCacheParts(listOf(part(0, "abc"), part(1, "def"))))
        assertNull(joinLightDetailCacheParts(emptyList()))
        assertNull(joinLightDetailCacheParts(listOf(part(0, "abc"), part(2, "def"))))
        assertNull(joinLightDetailCacheParts(listOf(part(0, ""))))
        assertNull(joinLightDetailCacheParts(listOf(part(0, "x".repeat(LIGHT_DETAIL_CACHE_PART_CHARS + 1)))))
    }
}
