package vip.fengzhu.bridge

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "cached_threads")
data class CachedThread(
    @PrimaryKey val id: String,
    val updatedAt: Long,
    val nonce: String,
    val ciphertext: String,
)

@Entity(tableName = "cached_items", primaryKeys = ["threadId", "id"])
data class CachedItem(
    val threadId: String,
    val id: String,
    val itemOrder: Long,
    val nonce: String,
    val ciphertext: String,
    val touchedAt: Long,
    /** The relay's creation time: Codex and DSH items carry no time of their own. */
    @ColumnInfo(defaultValue = "0") val createdAt: Long = 0L,
)

/**
 * Light mode: the full encrypted row of a tool step the connector uploaded
 * only as a placeholder, fetched from the computer on request and kept here so
 * it stays readable while the computer is off.
 */
@Entity(tableName = "light_details", primaryKeys = ["threadId", "id"])
data class LightDetail(
    val threadId: String,
    val id: String,
    val itemOrder: Long,
    val nonce: String,
    val ciphertext: String,
    val fetchedAt: Long,
)

@Entity(tableName = "drafts")
data class DraftEntry(
    @PrimaryKey val threadId: String,
    val nonce: String,
    val ciphertext: String,
    val touchedAt: Long,
)

/**
 * A command that has been accepted by the phone UI but may not yet have
 * reached the connector.  The args are encrypted with the account key so an
 * attachment path or task prompt is never stored as plaintext in the cache.
 */
@Entity(tableName = "pending_commands")
data class PendingCommandEntry(
    @PrimaryKey val id: String,
    val action: String,
    val threadId: String?,
    val nonce: String,
    val ciphertext: String,
    val createdAt: Long,
)

@Dao
interface CacheDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putThreads(items: List<CachedThread>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putItems(items: List<CachedItem>)
    @Query("SELECT * FROM cached_threads ORDER BY updatedAt DESC") suspend fun threads(): List<CachedThread>
    // A single encrypted history item can be much larger than Android's
    // CursorWindow. Keep oversized rows out of the offline cache read; the
    // repository will still load them from the server when the connection is
    // available instead of showing a fatal "Row too big" dialog.
    @Query("SELECT * FROM cached_items WHERE threadId=:threadId AND length(ciphertext) <= :maxCiphertextChars ORDER BY itemOrder DESC LIMIT :limit")
    suspend fun items(threadId: String, limit: Int, maxCiphertextChars: Int): List<CachedItem>
    @Query("DELETE FROM cached_items WHERE threadId=:threadId") suspend fun deleteItems(threadId: String)
    @Query("SELECT MAX(itemOrder) FROM cached_items WHERE threadId=:threadId") suspend fun maxItemOrder(threadId: String): Long?
    @Query("DELETE FROM cached_threads WHERE id=:threadId") suspend fun deleteThread(threadId: String)
    @Query("DELETE FROM cached_items WHERE threadId=:threadId AND itemOrder<:before") suspend fun deleteItemsBefore(threadId: String, before: Long)
    @Query("DELETE FROM cached_items WHERE threadId=:threadId AND id IN (:ids)") suspend fun deleteItemIds(threadId: String, ids: List<String>)
    @Query("DELETE FROM cached_items WHERE threadId=:threadId AND itemOrder=:order AND id<>:keepId") suspend fun deleteItemsAtOrder(threadId: String, order: Long, keepId: String)
    @Query("DELETE FROM cached_items WHERE rowid IN (SELECT rowid FROM cached_items ORDER BY touchedAt ASC LIMIT :count)") suspend fun trimItems(count: Int)
    @Query("SELECT * FROM drafts WHERE threadId=:threadId LIMIT 1") suspend fun draft(threadId: String): DraftEntry?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putDraft(item: DraftEntry)
    @Query("DELETE FROM drafts WHERE threadId=:threadId") suspend fun deleteDraft(threadId: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putPendingCommand(item: PendingCommandEntry)
    @Query("SELECT * FROM pending_commands ORDER BY createdAt ASC") suspend fun pendingCommands(): List<PendingCommandEntry>
    @Query("DELETE FROM pending_commands WHERE id=:id") suspend fun deletePendingCommand(id: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putLightDetails(items: List<LightDetail>)
    @Query("SELECT * FROM light_details WHERE threadId=:threadId") suspend fun lightDetails(threadId: String): List<LightDetail>
}

@Database(entities = [CachedThread::class, CachedItem::class, DraftEntry::class, PendingCommandEntry::class, LightDetail::class], version = 5, exportSchema = false)
abstract class BridgeDatabase : RoomDatabase() {
    abstract fun cache(): CacheDao
    companion object {
        @Volatile private var instance: BridgeDatabase? = null
        private val migration1To2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS drafts (threadId TEXT NOT NULL PRIMARY KEY, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, touchedAt INTEGER NOT NULL)")
            }
        }
        private val migration2To3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS pending_commands (id TEXT NOT NULL PRIMARY KEY, action TEXT NOT NULL, threadId TEXT, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, createdAt INTEGER NOT NULL)")
            }
        }
        private val migration3To4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS light_details (threadId TEXT NOT NULL, id TEXT NOT NULL, itemOrder INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, fetchedAt INTEGER NOT NULL, PRIMARY KEY(threadId, id))")
            }
        }
        private val migration4To5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE cached_items ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0")
            }
        }
        fun get(context: Context): BridgeDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context, BridgeDatabase::class.java, "fengzhu-cache.db")
                .addMigrations(migration1To2)
                .addMigrations(migration2To3)
                .addMigrations(migration3To4)
                .addMigrations(migration4To5)
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING).build().also { instance = it }
        }
    }
}
