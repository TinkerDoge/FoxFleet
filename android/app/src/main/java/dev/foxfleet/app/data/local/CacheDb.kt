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
        Index(value = ["owner", "live_id"]),
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
    /** v2: the contract's `hub_id` (events address messages by it), the gap-free number `n` (then [ord] = n) and your message's status. */
    @ColumnInfo(name = "live_id") val liveId: String? = null,
    val n: Int? = null,
    val status: String? = null,
)

/**
 * v2: one chat-list row as `GET /api/chats` / `chat.updated` describe it (one row per agent): unread badge, preview with
 * sender, archived, muted, pinned. Replaced whole on every update, never merged.
 */
@Entity(tableName = "chat_rows", primaryKeys = ["owner", "agent"], indices = [Index(value = ["owner", "archived"])])
data class ChatListRow(
    val owner: String,
    val agent: String,
    val label: String,
    val kind: String,
    val chat: String?,
    @ColumnInfo(name = "last_hub_id") val lastHubId: String?,
    @ColumnInfo(name = "last_role") val lastRole: String?,
    @ColumnInfo(name = "last_sender") val lastSender: String?,
    @ColumnInfo(name = "last_preview") val lastPreview: String,
    @ColumnInfo(name = "last_at") val lastAt: Long?,
    @ColumnInfo(name = "last_status") val lastStatus: String?,
    val unread: Int,
    @ColumnInfo(name = "read_up_to") val readUpTo: Int,
    val archived: Boolean,
    val muted: Boolean,
    @ColumnInfo(name = "muted_until") val mutedUntil: Long?,
    val pinned: Boolean,
    @ColumnInfo(name = "pin_order") val pinOrder: Int?,
    val working: Boolean,
    @ColumnInfo(name = "needs_input") val needsInput: Boolean,
    @ColumnInfo(name = "manual_unread") val manualUnread: Boolean,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * v2: the owner's resume cursor (`<store>:<seq>`) and the account's unread totals (the launcher badge).
 * v3: [owedResync] = a resync the live stream still owes (gap / 410 / first connect / stuck escape), written in the same row
 * as the cursor that skipped ahead and cleared only after the resync finished, so a failed, cancelled or killed resync is redone.
 */
@Entity(tableName = "sync_state")
data class SyncRow(
    @PrimaryKey val owner: String,
    val cursor: String?,
    @ColumnInfo(name = "total_unread") val totalUnread: Int,
    @ColumnInfo(name = "total_unread_all") val totalUnreadAll: Int,
    @ColumnInfo(name = "synced_at") val syncedAt: Long,
    @ColumnInfo(name = "owed_resync") val owedResync: String? = null,
)

/**
 * v4 (0.4.1): the hub's reaction snapshot of one conversation, in the hub's own JSON (`actor`, `messages`, `by_hub_id`, `hidden`),
 * so chips and "delete for me" show at once on a cache-first open and offline. Replaced by every snapshot; `message.reaction`
 * edits one message in it.
 */
@Entity(tableName = "reactions", primaryKeys = ["owner", "agent", "chat_id"])
data class ReactionRow(
    val owner: String,
    val agent: String,
    @ColumnInfo(name = "chat_id") val chatId: String,
    val snapshot: String,
    @ColumnInfo(name = "synced_at") val syncedAt: Long,
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

    @Query("SELECT * FROM messages WHERE owner = :owner AND agent = :agent ORDER BY ts, ord")
    suspend fun all(owner: String, agent: String): List<MessageRow>
    @Query("SELECT * FROM chat_meta WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun meta(owner: String, agent: String, chatId: String): ChatMetaRow?
    @Upsert
    suspend fun upsertMeta(row: ChatMetaRow)
    @Query("DELETE FROM chat_meta WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun deleteMeta(owner: String, agent: String, chatId: String)
}

/** The v2 live layer: chat-list rows, the sync row, and messages addressed by the contract's `hub_id`. */
@Dao
interface LiveDao {
    @Query("SELECT * FROM chat_rows WHERE owner = :owner AND archived = :archived ORDER BY pinned DESC, CASE WHEN pin_order IS NULL THEN 1 ELSE 0 END, pin_order, last_at DESC, agent")
    suspend fun chatRows(owner: String, archived: Boolean): List<ChatListRow>
    @Query("SELECT * FROM chat_rows WHERE owner = :owner ORDER BY pinned DESC, CASE WHEN pin_order IS NULL THEN 1 ELSE 0 END, pin_order, last_at DESC, agent")
    fun observeChatRows(owner: String): Flow<List<ChatListRow>>
    @Query("SELECT * FROM chat_rows WHERE owner = :owner AND agent = :agent")
    suspend fun chatRow(owner: String, agent: String): ChatListRow?
    @Upsert suspend fun upsertChatRows(rows: List<ChatListRow>)
    @Query("DELETE FROM chat_rows WHERE owner = :owner AND agent = :agent")
    suspend fun deleteChatRow(owner: String, agent: String)
    @Query("DELETE FROM chat_rows WHERE owner = :owner AND archived = :archived")
    suspend fun clearChatRows(owner: String, archived: Boolean)
    /** A snapshot of one list (main or archived) replaces that list; a row that moved lists is replaced by its new copy. */
    @Transaction
    suspend fun replaceChatRows(owner: String, archived: Boolean, rows: List<ChatListRow>) { clearChatRows(owner, archived); upsertChatRows(rows) }

    @Query("SELECT * FROM sync_state WHERE owner = :owner") suspend fun sync(owner: String): SyncRow?
    @Query("SELECT * FROM sync_state WHERE owner = :owner") fun observeSync(owner: String): Flow<SyncRow?>
    @Upsert suspend fun upsertSync(row: SyncRow)

    @Query("SELECT * FROM messages WHERE owner = :owner AND live_id = :liveId LIMIT 1")
    suspend fun byLiveId(owner: String, liveId: String): MessageRow?
    @Query("SELECT * FROM messages WHERE owner = :owner AND live_id IN (:ids)")
    suspend fun byLiveIds(owner: String, ids: List<String>): List<MessageRow>
    @Query("DELETE FROM messages WHERE owner = :owner AND live_id IN (:ids)")
    suspend fun deleteByLiveIds(owner: String, ids: List<String>)
    @Query("UPDATE messages SET status = :status WHERE rowId = :rowId")
    suspend fun setStatus(rowId: Long, status: String?)
    @Query("SELECT MAX(n) FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun maxN(owner: String, agent: String, chatId: String): Int?
    @Query("SELECT COUNT(*) FROM messages WHERE owner = :owner AND agent = :agent AND chat_id = :chatId AND n IS NULL")
    suspend fun unnumbered(owner: String, agent: String, chatId: String): Int
    @Upsert suspend fun upsertMessage(row: MessageRow)
    /** Cached conversations and their newest number: what `after_n` resync walks after a gap. */
    @Query("SELECT agent, chat_id AS chatId, MAX(n) AS maxN FROM messages WHERE owner = :owner GROUP BY agent, chat_id")
    suspend fun cachedChats(owner: String): List<CachedChatRef>

    @Query("SELECT * FROM reactions WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun reactions(owner: String, agent: String, chatId: String): ReactionRow?
    @Upsert suspend fun upsertReactions(row: ReactionRow)
    @Query("DELETE FROM reactions WHERE owner = :owner AND agent = :agent AND chat_id = :chatId")
    suspend fun deleteReactions(owner: String, agent: String, chatId: String)
}

data class CachedChatRef(val agent: String, val chatId: String, val maxN: Int?)

@Dao
interface CacheAdminDao {
    @Query("DELETE FROM agents") suspend fun wipeAgents()
    @Query("DELETE FROM chats") suspend fun wipeChats()
    @Query("DELETE FROM messages") suspend fun wipeMessages()
    @Query("DELETE FROM chat_meta") suspend fun wipeMeta()
    @Query("DELETE FROM chat_rows") suspend fun wipeChatRows()
    @Query("DELETE FROM sync_state") suspend fun wipeSync()
    @Query("DELETE FROM reactions") suspend fun wipeReactions()
    @Transaction
    suspend fun wipeAll() { wipeAgents(); wipeChats(); wipeMessages(); wipeMeta(); wipeChatRows(); wipeSync(); wipeReactions() }
}

/**
 * Version history (every version's schema is exported to app/schemas and committed):
 * - 1: agents, chats, messages, chat_meta.
 * - 2 (phase 1, 0.4.0): messages gain live_id / n / status (+ index owner,live_id); new chat_rows and sync_state. [MIGRATION_1_2]
 *   keeps every cached message (the new columns start empty and fill from the next page or event).
 * - 3 (0.4.0 QA A1): sync_state gains owed_resync. [MIGRATION_2_3]
 * - 4 (0.4.1): new table reactions (one reaction snapshot per conversation). [MIGRATION_3_4]
 *
 * Migration strategy: each schema change bumps [VERSION] and ships either an `@AutoMigration` (added columns/tables) or a
 * hand-written [androidx.room.migration.Migration] in [MIGRATIONS], each covered by CacheMigrationTest against the exported
 * JSON. Because this is a cache of hub data, a missing path is not data loss: [build] falls back to a destructive rebuild
 * (the next sync refills it) instead of crashing; a downgrade does the same.
 */
@Database(entities = [AgentRow::class, ChatRow::class, MessageRow::class, ChatMetaRow::class, ChatListRow::class, SyncRow::class, ReactionRow::class], version = CacheDb.VERSION, exportSchema = true)
abstract class CacheDb : RoomDatabase() {
    abstract fun chatList(): ChatListDao
    abstract fun messages(): MessageDao
    abstract fun admin(): CacheAdminDao
    abstract fun live(): LiveDao

    companion object {
        const val VERSION = 4
        const val NAME = "foxfleet-cache.db"
        val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                MIGRATION_1_2_SQL.forEach { db.execSQL(it) }
            }
        }
        /** Copied from schemas/…/2.json (createSql); CacheMigrationTest proves the result equals a fresh v2 database. */
        internal val MIGRATION_1_2_SQL = listOf(
            "ALTER TABLE `messages` ADD COLUMN `live_id` TEXT",
            "ALTER TABLE `messages` ADD COLUMN `n` INTEGER",
            "ALTER TABLE `messages` ADD COLUMN `status` TEXT",
            "CREATE INDEX IF NOT EXISTS `index_messages_owner_live_id` ON `messages` (`owner`, `live_id`)",
            "CREATE TABLE IF NOT EXISTS `chat_rows` (`owner` TEXT NOT NULL, `agent` TEXT NOT NULL, `label` TEXT NOT NULL, `kind` TEXT NOT NULL, `chat` TEXT, `last_hub_id` TEXT, `last_role` TEXT, `last_sender` TEXT, `last_preview` TEXT NOT NULL, `last_at` INTEGER, `last_status` TEXT, `unread` INTEGER NOT NULL, `read_up_to` INTEGER NOT NULL, `archived` INTEGER NOT NULL, `muted` INTEGER NOT NULL, `muted_until` INTEGER, `pinned` INTEGER NOT NULL, `pin_order` INTEGER, `working` INTEGER NOT NULL, `needs_input` INTEGER NOT NULL, `manual_unread` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL, PRIMARY KEY(`owner`, `agent`))",
            "CREATE INDEX IF NOT EXISTS `index_chat_rows_owner_archived` ON `chat_rows` (`owner`, `archived`)",
            "CREATE TABLE IF NOT EXISTS `sync_state` (`owner` TEXT NOT NULL, `cursor` TEXT, `total_unread` INTEGER NOT NULL, `total_unread_all` INTEGER NOT NULL, `synced_at` INTEGER NOT NULL, PRIMARY KEY(`owner`))",
        )
        val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) { db.execSQL("ALTER TABLE `sync_state` ADD COLUMN `owed_resync` TEXT") }
        }
        /** Copied from schemas/…/4.json (createSql); CacheMigrationTest proves the result equals a fresh v4 database. */
        internal const val MIGRATION_3_4_SQL = "CREATE TABLE IF NOT EXISTS `reactions` (`owner` TEXT NOT NULL, `agent` TEXT NOT NULL, `chat_id` TEXT NOT NULL, `snapshot` TEXT NOT NULL, `synced_at` INTEGER NOT NULL, PRIMARY KEY(`owner`, `agent`, `chat_id`))"
        val MIGRATION_3_4 = object : androidx.room.migration.Migration(3, 4) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) { db.execSQL(MIGRATION_3_4_SQL) }
        }
        val MIGRATIONS: Array<androidx.room.migration.Migration> = arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)

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
