package dev.foxfleet.app.data.local

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/*
 * The on-device cache of chats and messages. It mirrors what the hub returned (the hub stays the source of truth) so the
 * chat list and a chat open instantly, also offline. Every row carries [owner] (account + hub, see CacheOwner): rows of
 * one account are never shown to another, and a different owner signing in clears the lot.
 */

/** One agent row of the chat list, as the hub last described it. [position] is its place in the sorted list. */
@Entity(tableName = "agents", primaryKeys = ["owner", "name"], indices = [Index(value = ["owner", "position"])])
data class AgentRow(
    val owner: String,
    val name: String,
    val position: Int,
    val online: Boolean,
    @ColumnInfo(name = "chat_ready") val chatReady: Boolean,
    @ColumnInfo(name = "management_ready") val managementReady: Boolean,
    @ColumnInfo(name = "active_sessions") val activeSessions: Int?,
    val kind: String,
    val label: String?,
    val description: String,
    /** [CapsCodec] text: the agent's capabilities. */
    val caps: String,
    @ColumnInfo(name = "registry_order") val registryOrder: Int,
    @ColumnInfo(name = "last_activity_at") val lastActivityAt: Long?,
    @ColumnInfo(name = "last_session_title") val lastSessionTitle: String?,
    @ColumnInfo(name = "last_message_preview") val lastMessagePreview: String?,
    @ColumnInfo(name = "last_role") val lastRole: String?,
    @ColumnInfo(name = "pin_order") val pinOrder: Int?,
    val working: Boolean,
    @ColumnInfo(name = "needs_input") val needsInput: Boolean,
)

/** One conversation in an agent's history list (first page only). */
@Entity(tableName = "chats", primaryKeys = ["owner", "agent", "chat_id"], indices = [Index(value = ["owner", "agent", "updated"])])
data class ChatRow(
    val owner: String,
    val agent: String,
    @ColumnInfo(name = "chat_id") val chatId: String,
    val title: String?,
    val updated: Long,
    val preview: String,
    val messages: Int,
)

/**
 * One message. [ord] orders a conversation (larger = newer) and is the keyset for paging; [ts] is the hub's time
 * (0 when unknown). [msgKey] is the hub's message id, or a content key for the rare message without one ([MessageKeys]).
 */
@Entity(
    tableName = "messages",
    indices = [
        Index(value = ["owner", "agent", "chat_id", "msg_key"], unique = true),
        Index(value = ["owner", "agent", "chat_id", "ord"]),
        Index(value = ["chat_id", "ts"]),
    ],
)
data class MessageRow(
    @PrimaryKey(autoGenerate = true) val rowId: Long = 0,
    val owner: String,
    val agent: String,
    @ColumnInfo(name = "chat_id") val chatId: String,
    @ColumnInfo(name = "msg_key") val msgKey: String,
    @ColumnInfo(name = "hub_id") val hubId: String?,
    val ord: Long,
    val ts: Long,
    val role: String,
    val content: String,
    val reasoning: String,
    /** JSON array of tool steps; "" when none. */
    val steps: String,
    /** JSON array of image URLs; "" when none. */
    val images: String,
    /** The bubble kind ([MessageKinds]): kept so a list can be grouped or counted without parsing. */
    val kind: String,
)

/** Paging state of one cached conversation: where the hub's next older page starts and whether it has one. */
@Entity(tableName = "chat_meta", primaryKeys = ["owner", "agent", "chat_id"])
data class ChatMetaRow(
    val owner: String,
    val agent: String,
    @ColumnInfo(name = "chat_id") val chatId: String,
    /** Hub offset (counted back from the newest message) of the next older page. */
    @ColumnInfo(name = "older_offset") val olderOffset: Int,
    @ColumnInfo(name = "has_older") val hasOlder: Boolean,
    @ColumnInfo(name = "synced_at") val syncedAt: Long,
)

@Dao
interface ChatListDao {
    @Query("SELECT * FROM agents WHERE owner = :owner ORDER BY position")
    suspend fun agents(owner: String): List<AgentRow>
    @Query("SELECT * FROM agents WHERE owner = :owner ORDER BY position")
    fun observeAgents(owner: String): Flow<List<AgentRow>>
    @Query("DELETE FROM agents WHERE owner = :owner")
    suspend fun clearAgents(owner: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAgents(rows: List<AgentRow>)
    /** The hub's list is the whole truth: agents it no longer shows go. */
    @Transaction
    suspend fun replaceAgents(owner: String, rows: List<AgentRow>) { clearAgents(owner); insertAgents(rows) }

    @Query("SELECT * FROM chats WHERE owner = :owner AND agent = :agent ORDER BY updated DESC LIMIT :limit")
    suspend fun chats(owner: String, agent: String, limit: Int): List<ChatRow>
    @Query("DELETE FROM chats WHERE owner = :owner AND agent = :agent")
    suspend fun clearChats(owner: String, agent: String)
    @Upsert
    suspend fun upsertChats(rows: List<ChatRow>)
    @Transaction
    suspend fun replaceChats(owner: String, agent: String, rows: List<ChatRow>) { clearChats(owner, agent); upsertChats(rows) }
    @Query("DELETE FROM chats WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun deleteChat(owner: String, agent: String, chatId: String)
}

@Dao
interface MessageDao {
    /** The newest [limit] messages, newest first (callers reverse for display). */
    @Query("SELECT * FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId ORDER BY ord DESC LIMIT :limit")
    suspend fun newest(owner: String, agent: String, chatId: String, limit: Int): List<MessageRow>
    /** Keyset page: the [limit] messages just before [beforeOrd], newest first. */
    @Query("SELECT * FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId AND ord < :beforeOrd ORDER BY ord DESC LIMIT :limit")
    suspend fun before(owner: String, agent: String, chatId: String, beforeOrd: Long, limit: Int): List<MessageRow>
    @Query("SELECT ord FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId AND msg_key = :key")
    suspend fun ordOf(owner: String, agent: String, chatId: String, key: String): Long?
    @Query("SELECT msg_key FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun keys(owner: String, agent: String, chatId: String): List<String>
    @Query("SELECT MIN(ord) FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun minOrd(owner: String, agent: String, chatId: String): Long?
    @Query("SELECT COUNT(*) FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId AND ord >= :fromOrd")
    suspend fun countFrom(owner: String, agent: String, chatId: String, fromOrd: Long): Int
    @Query("SELECT COUNT(*) FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun count(owner: String, agent: String, chatId: String): Int
    @Query("DELETE FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId AND ord >= :fromOrd")
    suspend fun deleteFrom(owner: String, agent: String, chatId: String, fromOrd: Long)
    @Query("DELETE FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun deleteChat(owner: String, agent: String, chatId: String)
    /** IGNORE: a key that is already stored keeps its place (a page that overlaps the cache never moves rows). */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(rows: List<MessageRow>)

    @Query("SELECT * FROM chat_meta WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun meta(owner: String, agent: String, chatId: String): ChatMetaRow?
    @Upsert
    suspend fun upsertMeta(row: ChatMetaRow)
    @Query("DELETE FROM chat_meta WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun deleteMeta(owner: String, agent: String, chatId: String)
}

@Dao
interface CacheAdminDao {
    @Query("DELETE FROM agents") suspend fun wipeAgents()
    @Query("DELETE FROM chats") suspend fun wipeChats()
    @Query("DELETE FROM messages") suspend fun wipeMessages()
    @Query("DELETE FROM chat_meta") suspend fun wipeMeta()
    @Transaction
    suspend fun wipeAll() { wipeAgents(); wipeChats(); wipeMessages(); wipeMeta() }
}

/**
 * Version history (every version's schema is exported to app/schemas and committed):
 * - 1: agents, chats, messages, chat_meta.
 *
 * Migration strategy: each schema change bumps [VERSION] and ships either an `@AutoMigration` (added columns/tables) or a
 * hand-written [androidx.room.migration.Migration] in [MIGRATIONS], each covered by CacheMigrationTest against the exported
 * JSON. Because this is a cache of hub data, a missing path is not data loss: [build] falls back to a destructive rebuild
 * (the next sync refills it) instead of crashing; a downgrade does the same.
 */
@Database(entities = [AgentRow::class, ChatRow::class, MessageRow::class, ChatMetaRow::class], version = CacheDb.VERSION, exportSchema = true)
abstract class CacheDb : RoomDatabase() {
    abstract fun chatList(): ChatListDao
    abstract fun messages(): MessageDao
    abstract fun admin(): CacheAdminDao

    companion object {
        const val VERSION = 1
        const val NAME = "foxfleet-cache.db"
        val MIGRATIONS: Array<androidx.room.migration.Migration> = emptyArray()

        @Volatile private var instance: CacheDb? = null
        fun get(context: Context): CacheDb = instance ?: synchronized(this) { instance ?: build(context.applicationContext).also { instance = it } }

        /** [destructive] = false only in tests: a missing or broken migration must fail there, not rebuild quietly. */
        fun build(context: Context, name: String? = NAME, destructive: Boolean = true): CacheDb {
            val b = if (name == null) Room.inMemoryDatabaseBuilder(context, CacheDb::class.java) else Room.databaseBuilder(context, CacheDb::class.java, name)
            b.addMigrations(*MIGRATIONS)
            if (destructive) b.fallbackToDestructiveMigration(dropAllTables = true)
            return b.build()
        }
    }
}
