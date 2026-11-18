package vip.fengzhu.bridge

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class HistoryPreviewDatabaseTest {
    @Test fun visibleEmptyThreadReceivesPrefetchedRowsAndRemovals() = runBlocking {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), BridgeDatabase::class.java).build()
        val changes = Channel<List<String>>(Channel.UNLIMITED)
        val dao = db.cache()
        val watch = launch {
            dao.observeLatestItems("shown", HISTORY_PREVIEW_ROWS, 64 * 1024).collect { rows -> changes.send(rows.map { it.id }) }
        }
        try {
            withTimeout(10_000L) {
                assertEquals(emptyList<String>(), changes.receive())
                dao.putItems(listOf(CachedItem("shown", "m1", 1, "nonce", "encrypted", 1)))
                assertEquals(listOf("m1"), changes.receive())
                dao.deleteItems("shown")
                assertEquals(emptyList<String>(), changes.receive())
            }
        } finally {
            watch.cancel()
            db.close()
        }
    }

    @Test fun versionSixCacheSurvivesMigrationAndUsesAnOrderedIndex() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "preview-migration-${UUID.randomUUID()}.db"
        val seed = Room.databaseBuilder(context, BridgeDatabase::class.java, name).build()
        try {
            val items = (1..100).map { CachedItem("a", "m$it", it.toLong(), "nonce", "encrypted", 1) }
            seed.cache().putItems(items + CachedItem("other", "private", 101L, "nonce", "other", 1))
            seed.openHelper.writableDatabase.apply {
                execSQL("DROP INDEX index_cached_items_threadId_itemOrder")
                execSQL("DROP TABLE room_master_table")
                version = 6
            }
        } finally { seed.close() }
        val upgraded = Room.databaseBuilder(context, BridgeDatabase::class.java, name)
            .addMigrations(BridgeDatabase.migration6To7).build()
        try {
            val dao = upgraded.cache()
            val preview = dao.observeLatestItems("a", HISTORY_PREVIEW_ROWS, 64 * 1024).first()
            assertEquals((100L downTo 77L).toList(), preview.map { it.itemOrder })
            assertEquals(100, dao.items("a", 6000, 64 * 1024).size)
            val first = dao.items("a", 60, 64 * 1024)
            val rest = dao.itemsBefore("a", first.last().itemOrder, 60, 64 * 1024)
            assertEquals((100L downTo 1L).toList(), (first + rest).map { it.itemOrder })
            assertTrue(dao.itemsBefore("a", rest.last().itemOrder, 60, 64 * 1024).isEmpty())
            val detail = upgraded.openHelper.readableDatabase.query(
                "EXPLAIN QUERY PLAN SELECT * FROM cached_items WHERE threadId='a' AND length(ciphertext)<=65536 ORDER BY itemOrder DESC LIMIT 24"
            ).use { cursor -> buildString { while (cursor.moveToNext()) append(cursor.getString(3)) } }
            assertTrue(detail, detail.contains("index_cached_items_threadId_itemOrder"))
            assertFalse(detail, detail.contains("TEMP B-TREE"))
            dao.putItems(listOf(CachedItem("a", "m101", 101, "nonce", "new", 1)))
            assertEquals("m101", dao.observeLatestItems("a", HISTORY_PREVIEW_ROWS, 64 * 1024).first().first().id)
            assertEquals("private", dao.items("other", 1, 64 * 1024).single().id)
        } finally {
            upgraded.close()
            context.deleteDatabase(name)
        }
    }
}
