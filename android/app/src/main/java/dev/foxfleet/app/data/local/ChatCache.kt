package dev.foxfleet.app.data.local

import android.content.Context
import androidx.room.withTransaction
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.MessageKeys
import dev.foxfleet.app.data.MessageKinds
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.UiMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Page size of the hub's message route as the app uses it (same as ChatState's PAGE). */
const val CACHE_PAGE = 80

/** One step of "cache first, then the hub". */
sealed interface Load<out T> {
    /** What the device had (shown at once). */
    data class Cached<T>(val value: T) : Load<T>
    /** What the hub answered (already written to the cache). */
    data class Fresh<T>(val value: T) : Load<T>
    /** The hub could not be asked; [hadCache] says whether a Cached value was shown before. A lost login is thrown instead. */
    data class Failed(val error: Exception, val hadCache: Boolean) : Load<Nothing>
}

/** Emits the cached value (when there is one), then fetches from the hub, writes it to the cache, and emits it. */
fun <T> cacheThenNetwork(read: suspend () -> T?, fetch: suspend () -> T, write: suspend (T) -> Unit): Flow<Load<T>> = flow {
    val cached = try { read() } catch (e: CancellationException) { throw e } catch (_: Exception) { null } // a broken cache never blocks the hub
    if (cached != null) emit(Load.Cached(cached))
    val fresh = try { fetch() } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (e: Exception) { emit(Load.Failed(e, cached != null)); return@flow }
    try { write(fresh) } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    emit(Load.Fresh(fresh))
}

/** A cached conversation window: the newest messages (chronological) and whether older ones exist on the device or the hub. */
data class CachedChat(val messages: List<UiMessage>, val hasOlder: Boolean, val olderOffset: Int)
/** An older page from the device: [messages] chronological; [moreOnDevice] false when the device holds nothing older. */
data class CachedPage(val messages: List<UiMessage>, val moreOnDevice: Boolean, val hubHasOlder: Boolean, val hubOffset: Int)

/**
 * The repository over [CacheDb] for one owner (account + hub). The hub is the source of truth; this class mirrors the pages
 * the app fetched, merges them in order ([MessageRow.ord]) and serves them back by keyset, so opening never waits on the network.
 *
 * Paging choice (0.4.0): simple keyset paging, not Paging 3 + RemoteMediator. The chat screen already holds one
 * chronological list in ChatState (live turns, queue, optimistic sends, reactions all edit it) and shows it in a
 * reversed LazyColumn keyed by message identity; Paging 3 would split that into a PagingData stream plus a separate live
 * overlay and lose index access the follow/pill logic needs. Keyset over [MessageRow.ord] gives the same "load older
 * from disk first, then the network" behaviour: the device is read with `ord < oldest` (indexed), and when it runs out
 * the hub's own offset paging continues from [ChatMetaRow.olderOffset]. With the phase 1 contract, `n` (gap-free per
 * chat) replaces both: `ord` becomes `n` and `after_n` fills gaps.
 */
class ChatCache(private val db: CacheDb, val owner: String, private val now: () -> Long = { System.currentTimeMillis() }) {
    private val list = db.chatList(); private val msgs = db.messages()

    // ---- chat list ----
    suspend fun agents(): List<AgentStatus> = list.agents(owner).map { it.toAgent() }
    suspend fun saveAgents(sorted: List<AgentStatus>) = list.replaceAgents(owner, sorted.mapIndexed { i, a -> a.toRow(owner, i) })

    suspend fun chats(agent: String, limit: Int = 30): List<SessionInfo> = list.chats(owner, agent, limit).map { SessionInfo(it.chatId, it.title, it.updated, it.preview, it.messages) }
    suspend fun saveChats(agent: String, first: List<SessionInfo>) = list.replaceChats(owner, agent, first.map { ChatRow(owner, agent, it.id, it.title, it.updated, it.preview, it.messages) })
    suspend fun forgetChat(agent: String, chatId: String) = db.withTransaction { list.deleteChat(owner, agent, chatId); msgs.deleteChat(owner, agent, chatId); msgs.deleteMeta(owner, agent, chatId) }

    // ---- messages ----
    /** The newest [limit] cached messages of a conversation, or null when nothing is cached. */
    suspend fun open(agent: String, chatId: String, limit: Int = CACHE_PAGE): CachedChat? {
        val rows = msgs.newest(owner, agent, chatId, limit); if (rows.isEmpty()) return null
        val meta = msgs.meta(owner, agent, chatId)
        val moreOnDevice = msgs.count(owner, agent, chatId) > rows.size
        return CachedChat(rows.asReversed().map { it.toUi() }, moreOnDevice || meta?.hasOlder == true, meta?.olderOffset ?: CACHE_PAGE)
    }

    /** Keyset page: up to [limit] cached messages older than the message keyed [keyOfOldest]; null when that one is not cached or nothing older is. */
    suspend fun olderThan(agent: String, chatId: String, keyOfOldest: String, limit: Int = CACHE_PAGE): CachedPage? {
        val ord = msgs.ordOf(owner, agent, chatId, keyOfOldest) ?: return null
        val rows = msgs.before(owner, agent, chatId, ord, limit + 1); if (rows.isEmpty()) return null
        val meta = msgs.meta(owner, agent, chatId)
        return CachedPage(rows.take(limit).asReversed().map { it.toUi() }, rows.size > limit, meta?.hasOlder == true, meta?.olderOffset ?: CACHE_PAGE)
    }

    /** Where the hub's next older page starts once the device has nothing older, and whether there is one. */
    suspend fun hubCursor(agent: String, chatId: String): Pair<Int, Boolean>? = msgs.meta(owner, agent, chatId)?.let { it.olderOffset to it.hasOlder }

    /**
     * The hub's newest page (chronological). When its first message is already cached, everything from there on is replaced by
     * the page (edits and removals in that window win) and the older cached part stays. Otherwise the cache cannot prove that the
     * page joins up with what it holds, so the conversation is replaced by the page.
     */
    suspend fun saveNewest(agent: String, chatId: String, page: List<UiMessage>, hasMore: Boolean, pageSize: Int = CACHE_PAGE) {
        if (page.isEmpty()) return
        val keys = MessageKeys.keys(page)
        db.withTransaction {
            val anchor = msgs.ordOf(owner, agent, chatId, keys[0]); val meta = msgs.meta(owner, agent, chatId)
            if (anchor != null && meta != null) {
                val removed = msgs.countFrom(owner, agent, chatId, anchor)
                msgs.deleteFrom(owner, agent, chatId, anchor)
                msgs.insert(page.mapIndexed { i, m -> m.toRow(owner, agent, chatId, keys[i], anchor + i) })
                val grown = (page.size - removed).coerceAtLeast(0) // newer messages push the hub's next older page further back
                msgs.upsertMeta(meta.copy(olderOffset = meta.olderOffset + grown, syncedAt = now()))
            } else {
                msgs.deleteChat(owner, agent, chatId)
                msgs.insert(page.mapIndexed { i, m -> m.toRow(owner, agent, chatId, keys[i], i.toLong()) })
                msgs.upsertMeta(ChatMetaRow(owner, agent, chatId, pageSize, hasMore, now()))
            }
        }
    }

    /** An older page fetched from the hub at [offset]: goes before the oldest cached message (keys already stored are skipped). */
    suspend fun saveOlder(agent: String, chatId: String, page: List<UiMessage>, hasMore: Boolean, offset: Int, pageSize: Int = CACHE_PAGE) {
        db.withTransaction {
            val have = msgs.keys(owner, agent, chatId).toHashSet()
            if (have.isEmpty()) return@withTransaction // nothing to join it to: the next newest page starts the cache
            val keys = MessageKeys.keys(page)
            val fresh = page.indices.filter { keys[it] !in have }
            val min = msgs.minOrd(owner, agent, chatId) ?: 0L
            msgs.insert(fresh.mapIndexed { j, i -> page[i].toRow(owner, agent, chatId, keys[i], min - fresh.size + j) })
            msgs.upsertMeta(ChatMetaRow(owner, agent, chatId, offset + pageSize, hasMore, now()))
        }
    }

    companion object {
        fun forOwner(context: Context, owner: String) = ChatCache(CacheDb.get(context), owner)
    }
}

// ---- mapping ----

internal fun UiMessage.toRow(owner: String, agent: String, chatId: String, key: String, ord: Long) = MessageRow(
    owner = owner, agent = agent, chatId = chatId, msgKey = key, hubId = id, ord = ord, ts = ts, role = role, content = content, reasoning = reasoning,
    steps = if (steps.isEmpty()) "" else JsonArray(steps.map { s -> JsonObject(mapOf("name" to JsonPrimitive(s.name), "args" to JsonPrimitive(s.args), "result" to JsonPrimitive(s.result), "ok" to JsonPrimitive(s.ok))) }).toString(),
    images = if (imageUrls.isEmpty()) "" else JsonArray(imageUrls.map { JsonPrimitive(it) }).toString(),
    kind = MessageKinds.of(this),
)

internal fun MessageRow.toUi(): UiMessage {
    val st = if (steps.isEmpty()) emptyList() else runCatching {
        Json.parseToJsonElement(steps).jsonArray.map { e ->
            val o = e.jsonObject
            ToolStep(o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(), o["args"]?.jsonPrimitive?.contentOrNull.orEmpty(), o["result"]?.jsonPrimitive?.contentOrNull.orEmpty(), o["ok"]?.jsonPrimitive?.booleanOrNull != false)
        }
    }.getOrDefault(emptyList())
    val urls = if (images.isEmpty()) emptyList() else runCatching { Json.parseToJsonElement(images).jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull } }.getOrDefault(emptyList())
    return UiMessage(role = role, content = content, id = hubId, reasoning = reasoning, steps = st, ts = ts, imageUrls = urls)
}

/** Capabilities as "flag,flag;busy=queue|interrupt": small and readable in a database dump. */
object CapsCodec {
    private val names = listOf("chat", "images", "files", "screen", "voice", "skills", "sessions", "nativeUi", "reactions", "agentReactions", "bot")
    fun encode(c: Capabilities): String {
        val flags = listOf(c.chat, c.images, c.files, c.screen, c.voice, c.skills, c.sessions, c.nativeUi, c.reactions, c.agentReactions, c.bot)
        return names.filterIndexed { i, _ -> flags[i] }.joinToString(",") + ";busy=" + c.busy.joinToString("|")
    }
    fun decode(s: String): Capabilities {
        val parts = s.split(";busy=", limit = 2); val on = parts[0].split(',').toSet()
        val busy = parts.getOrElse(1) { "queue" }.split('|').filter { it.isNotBlank() }.ifEmpty { listOf("queue") }
        return Capabilities(chat = "chat" in on, images = "images" in on, files = "files" in on, screen = "screen" in on, voice = "voice" in on, skills = "skills" in on,
            sessions = "sessions" in on, busy = busy, nativeUi = "nativeUi" in on, reactions = "reactions" in on, agentReactions = "agentReactions" in on, bot = "bot" in on)
    }
}

internal fun AgentStatus.toRow(owner: String, position: Int) = AgentRow(owner, name, position, online, chatReady, managementReady, activeSessions, kind, label, description,
    CapsCodec.encode(capabilities), order, lastActivityAt, lastSessionTitle, lastMessagePreview, lastRole, pinOrder, working, needsInput)

internal fun AgentRow.toAgent() = AgentStatus(name = name, online = online, chatReady = chatReady, managementReady = managementReady, activeSessions = activeSessions, kind = kind,
    label = label, description = description, capabilities = CapsCodec.decode(caps), order = registryOrder, lastActivityAt = lastActivityAt, lastSessionTitle = lastSessionTitle,
    lastMessagePreview = lastMessagePreview, lastRole = lastRole, pinOrder = pinOrder, working = working, needsInput = needsInput)
