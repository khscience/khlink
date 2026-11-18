package vip.fengzhu.bridge

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LightDetailDatabaseTest {
    @Test fun largeAndLegacyDetailsSurviveReopenWithoutOversizedCursorRows() = runBlocking {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), BridgeDatabase::class.java).build()
        try {
            val dao = db.cache()
            val original = "A".repeat(10_800_000)
            val detail = LightDetail("test-thread", "new-image", 1L, "nonce", original, 1L)
            dao.saveLightDetails(listOf(detail))
            assertEquals("", dao.lightDetails("test-thread", LIGHT_DETAIL_CACHE_PART_CHARS).single().ciphertext)
            assertTrue(dao.lightDetailParts("test-thread", "new-image").size > 1)
            assertTrue(dao.completeLightDetails("test-thread").single().ciphertext == original)

            // Simulate an oversized row written by the old app before migration.
            dao.putLightDetails(listOf(detail.copy(id = "old-image")))
            assertTrue(dao.completeLightDetails("test-thread").first { it.id == "old-image" }.ciphertext == original)

            dao.saveLightDetails(listOf(detail.copy(ciphertext = "small")))
            assertEquals("small", dao.completeLightDetails("test-thread").first { it.id == "new-image" }.ciphertext)
            assertTrue(dao.lightDetailParts("test-thread", "new-image").isEmpty())
        } finally { db.close() }
    }
}
