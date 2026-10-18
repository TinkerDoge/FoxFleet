package dev.foxfleet.app.data.local

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import dev.foxfleet.app.data.live.ChatsSnapshot
import dev.foxfleet.app.data.live.HubChat
import dev.foxfleet.app.data.live.LastMessage
import dev.foxfleet.app.data.live.MessageStatus
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
/** One cached message with the conversation it belongs to (dossier media, 0.4.3 C3). */
data class AgentMessage(val chatId: String, val message: UiMessage)
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
    private val list = db.chatList(); private val msgs = db.messages(); private val live = db.live()

    // ---- chat list ----
    suspend fun agents(): List<AgentStatus> = list.agents(owner).map { it.toAgent() }
    suspend fun saveAgents(sorted: List<AgentStatus>) = list.replaceAgents(owner, sorted.mapIndexed { i, a -> a.toRow(owner, i) })

    suspend fun chats(agent: String, limit: Int = 30): List<SessionInfo> = list.chats(owner, agent, limit).map { SessionInfo(it.chatId, it.title, it.updated, it.preview, it.messages) }
    suspend fun saveChats(agent: String, first: List<SessionInfo>) = list.replaceChats(owner, agent, first.map { ChatRow(owner, agent, it.id, it.title, it.updated, it.preview, it.messages) })
    suspend fun forgetChat(agent: String, chatId: String) = db.withTransaction { list.deleteChat(owner, agent, chatId); msgs.deleteChat(owner, agent, chatId); msgs.deleteMeta(owner, agent, chatId); live.deleteReactions(owner, agent, chatId) }

    // ---- messages ----
    /** The newest [limit] cached messages of a conversation, or null when nothing is cached. */
    suspend fun open(agent: String, chatId: String, limit: Int = CACHE_PAGE): CachedChat? {
        val rows = msgs.newest(owner, agent, chatId, limit); if (rows.isEmpty()) return null
        val meta = msgs.meta(owner, agent, chatId)
        val moreOnDevice = msgs.count(owner, agent, chatId) > rows.size
        return CachedChat(rows.asReversed().map { it.toUi() }, moreOnDevice || meta?.hasOlder == true, meta?.olderOffset ?: CACHE_PAGE)
    }

    /**
     * Every cached message of [agent] across all its conversations (dossier media, 0.4.3 C3), each tagged with
     * its chat id so the viewer can rebuild the same cache instance key the chat used (a warm disk hit, no re-download).
     */
    suspend fun messages(agent: String): List<AgentMessage> = msgs.all(owner, agent).map { AgentMessage(it.chatId, it.toUi()) }

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
        // A hub with `readReceipts` numbers every message (n, gap-free per chat): then ord = n, and pages and live events join exactly.
        val numbered = page.all { it.n != null }
        db.withTransaction {
            val page = keepExtras(page) // a history page without thinking/tools must not wipe what the live reply stored (0.4.1)
            val mixed = numbered && live.unnumbered(owner, agent, chatId) > 0 // cached before the hub numbered messages: start over
            val anchor = if (mixed) null else msgs.ordOf(owner, agent, chatId, keys[0]); val meta = msgs.meta(owner, agent, chatId)
            if (anchor != null && meta != null) {
                val from = if (numbered) minOf(anchor, page[0].n!!.toLong()) else anchor
                val removed = msgs.countFrom(owner, agent, chatId, from)
                msgs.deleteFrom(owner, agent, chatId, from)
                msgs.insert(page.mapIndexed { i, m -> m.toRow(owner, agent, chatId, keys[i], if (numbered) m.n!!.toLong() else anchor + i) })
                val grown = (page.size - removed).coerceAtLeast(0) // newer messages push the hub's next older page further back
                msgs.upsertMeta(meta.copy(olderOffset = meta.olderOffset + grown, syncedAt = now()))
            } else {
                msgs.deleteChat(owner, agent, chatId)
                msgs.insert(page.mapIndexed { i, m -> m.toRow(owner, agent, chatId, keys[i], if (numbered) m.n!!.toLong() else i.toLong()) })
                msgs.upsertMeta(ChatMetaRow(owner, agent, chatId, pageSize, hasMore, now()))
            }
        }
    }

    /** Agent messages of [page] that carry no reasoning or tools get the ones this device already stored for the same hub id. */
    private suspend fun keepExtras(page: List<UiMessage>): List<UiMessage> = page.map { m ->
        val id = m.hubId
        if (m.role != "assistant" || id == null || (m.reasoning.isNotEmpty() && m.steps.isNotEmpty())) m
        else live.byLiveId(owner, id)?.toUi()?.let { old -> m.copy(reasoning = m.reasoning.ifEmpty { old.reasoning }, steps = m.steps.ifEmpty { old.steps }) } ?: m
    }

    /** An older page fetched from the hub at [offset]: goes before the oldest cached message (keys already stored are skipped). */
    suspend fun saveOlder(agent: String, chatId: String, page: List<UiMessage>, hasMore: Boolean, offset: Int, pageSize: Int = CACHE_PAGE) {
        db.withTransaction {
            val have = msgs.keys(owner, agent, chatId).toHashSet()
            if (have.isEmpty()) return@withTransaction // nothing to join it to: the next newest page starts the cache
            val keys = MessageKeys.keys(page)
            val fresh = page.indices.filter { keys[it] !in have }
            val min = msgs.minOrd(owner, agent, chatId) ?: 0L
            val numbered = page.all { it.n != null } && live.unnumbered(owner, agent, chatId) == 0
            msgs.insert(fresh.mapIndexed { j, i -> page[i].toRow(owner, agent, chatId, keys[i], if (numbered) page[i].n!!.toLong() else min - fresh.size + j) })
            msgs.upsertMeta(ChatMetaRow(owner, agent, chatId, offset + pageSize, hasMore, now()))
        }
    }

    // ---- v2 live layer (phase 1) ----

    suspend fun chatRows(archived: Boolean): List<HubChat> = live.chatRows(owner, archived).map { it.toHub() }
    fun observeChatRows(): Flow<List<HubChat>> = live.observeChatRows(owner).map { rows -> rows.map { it.toHub() } }
    suspend fun chatRow(agent: String): HubChat? = live.chatRow(owner, agent)?.toHub()
    /** A `GET /api/chats?archived=` snapshot replaces that list; the totals and (when given) the cursor go to the sync row. */
    suspend fun saveSnapshot(archived: Boolean, snap: ChatsSnapshot, takeCursor: Boolean) = db.withTransaction {
        live.replaceChatRows(owner, archived, snap.chats.map { it.toRow(owner) })
        val old = live.sync(owner)
        live.upsertSync(SyncRow(owner, if (takeCursor && snap.cursor != null) snap.cursor else old?.cursor, snap.totalUnread, snap.totalUnreadAll, now(), old?.owedResync))
    }
    suspend fun saveChatRow(row: HubChat) = live.upsertChatRows(listOf(row.toRow(owner)))
    /** `chat.removed`: the row goes now; the agent row and its cached chats go with the next fleet refresh. */
    suspend fun removeAgent(agent: String) = live.deleteChatRow(owner, agent)
    suspend fun sync(): SyncRow? = live.sync(owner)
    fun observeSync(): Flow<SyncRow?> = live.observeSync(owner)
    suspend fun saveCursor(cursor: String) { val old = live.sync(owner); live.upsertSync((old ?: SyncRow(owner, null, 0, 0, now())).copy(cursor = cursor, syncedAt = now())) }
    /** Cursor and owed resync in one write ([cursor] null = start at now next time). */
    suspend fun saveOwed(cursor: String?, reason: String) { val old = live.sync(owner); live.upsertSync((old ?: SyncRow(owner, null, 0, 0, now())).copy(cursor = cursor, owedResync = reason, syncedAt = now())) }
    /** The resync finished: nothing owed any more. */
    suspend fun clearOwed() { val old = live.sync(owner) ?: return; if (old.owedResync != null) live.upsertSync(old.copy(owedResync = null)) }
    suspend fun saveTotals(total: Int) { val old = live.sync(owner); live.upsertSync((old ?: SyncRow(owner, null, 0, 0, now())).copy(totalUnread = total)) }
    suspend fun cachedChats(): List<CachedChatRef> = live.cachedChats(owner)
    suspend fun maxN(agent: String, chatId: String): Int? = live.maxN(owner, agent, chatId)
    suspend fun numbered(agent: String, chatId: String): Boolean = msgs.count(owner, agent, chatId) > 0 && live.unnumbered(owner, agent, chatId) == 0
    suspend fun dropChatMessages(agent: String, chatId: String) = db.withTransaction { msgs.deleteChat(owner, agent, chatId); msgs.deleteMeta(owner, agent, chatId) }

    // ---- reactions (v4) ----
    /** The conversation's last reaction snapshot from the hub, or null. */
    suspend fun reactions(agent: String, chatId: String): dev.foxfleet.app.data.ReactionSnapshot? = live.reactions(owner, agent, chatId)?.let { r ->
        runCatching { dev.foxfleet.app.data.HubApi.parseReactions(kotlinx.serialization.json.Json.parseToJsonElement(r.snapshot).jsonObject) }.getOrNull()
    }
    suspend fun saveReactions(agent: String, chatId: String, snap: dev.foxfleet.app.data.ReactionSnapshot) =
        live.upsertReactions(ReactionRow(owner, agent, chatId, dev.foxfleet.app.data.HubApi.reactionsJson(snap), now()))
    /** `message.reaction`: one message's full set replaces its entry in the stored snapshot (nothing stored yet: nothing to edit). */
    suspend fun replaceReactions(agent: String, chatId: String, hubId: String, upstreamId: String?, groups: List<dev.foxfleet.app.data.ReactionGroup>) = db.withTransaction {
        val snap = reactions(agent, chatId) ?: return@withTransaction
        saveReactions(agent, chatId, snap.replace(hubId, upstreamId, groups))
    }

    /**
     * One message from the stream (new or edited), by `hub_id`. Returns false when it could not be placed: the chat is not
     * cached in numbered form, or it is newer than the cache's newest + 1 (a gap the caller fills with `after_n`).
     */
    suspend fun upsertLive(agent: String, chatId: String, m: UiMessage): Boolean = db.withTransaction {
        val hubId = m.hubId ?: return@withTransaction false; val n = m.n ?: return@withTransaction false
        val existing = live.byLiveId(owner, hubId)
        if (existing != null) {
            val row = m.toRow(owner, agent, chatId, existing.msgKey, existing.ord)
            // reasoning and tools only ever arrive or stay: a text-only copy (older hub, an edit) keeps what the live reply stored
            val keep = existing.copy(content = m.content, ts = if (m.ts > 0) m.ts else existing.ts, hubId = m.id ?: existing.hubId,
                status = if (m.role == "user") MessageStatus.advance(existing.status, m.status) else null, images = row.images,
                reasoning = m.reasoning.ifEmpty { existing.reasoning }, steps = if (m.steps.isNotEmpty()) row.steps else existing.steps,
                kind = MessageKinds.of(m.copy(reasoning = m.reasoning.ifEmpty { existing.reasoning })))
            live.upsertMessage(keep); return@withTransaction true
        }
        if (!numbered(agent, chatId)) return@withTransaction false
        val max = live.maxN(owner, agent, chatId) ?: return@withTransaction false
        if (n > max + 1) return@withTransaction false
        msgs.insert(listOf(m.toRow(owner, agent, chatId, MessageKeys.base(m), n.toLong())))
        msgs.meta(owner, agent, chatId)?.let { if (n > max) msgs.upsertMeta(it.copy(olderOffset = it.olderOffset + 1, syncedAt = now())) }
        true
    }
    suspend fun deleteLive(ids: List<String>) { if (ids.isNotEmpty()) live.deleteByLiveIds(owner, ids) }
    suspend fun statusLive(ids: List<String>, status: String) = db.withTransaction {
        if (ids.isNotEmpty()) live.byLiveIds(owner, ids).forEach { r -> val s = MessageStatus.advance(r.status, status); if (s != r.status) live.setStatus(r.rowId, s) }
    }

    companion object {
        fun forOwner(context: Context, owner: String) = ChatCache(CacheDb.get(context), owner)
    }
}

// ---- mapping ----

internal fun UiMessage.toRow(owner: String, agent: String, chatId: String, key: String, ord: Long) = MessageRow(
    owner = owner, agent = agent, chatId = chatId, msgKey = key, hubId = id, ord = ord, ts = ts, role = role, content = content, reasoning = reasoning,
    steps = if (steps.isEmpty()) "" else JsonArray(steps.map { s -> JsonObject(mapOf("name" to JsonPrimitive(s.name), "args" to JsonPrimitive(s.args), "result" to JsonPrimitive(s.result), "ok" to (s.ok?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull))) }).toString(),
    images = if (imageUrls.isEmpty()) "" else JsonArray(imageUrls.map { JsonPrimitive(it) }).toString(),
    kind = MessageKinds.of(this),
    liveId = hubId, n = n, status = status?.takeIf { role == "user" },
)

internal fun MessageRow.toUi(): UiMessage {
    val st = if (steps.isEmpty()) emptyList() else runCatching {
        Json.parseToJsonElement(steps).jsonArray.map { e ->
            val o = e.jsonObject
            ToolStep(o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(), o["args"]?.jsonPrimitive?.contentOrNull.orEmpty(), o["result"]?.jsonPrimitive?.contentOrNull.orEmpty(), o["ok"]?.let { v -> runCatching { v.jsonPrimitive.booleanOrNull }.getOrNull() })
        }
    }.getOrDefault(emptyList())
    val urls = if (images.isEmpty()) emptyList() else runCatching { Json.parseToJsonElement(images).jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull } }.getOrDefault(emptyList())
    return UiMessage(role = role, content = content, id = hubId, reasoning = reasoning, steps = st, ts = ts, imageUrls = urls, hubId = liveId, n = n, status = status?.takeIf { role == "user" })
}

/** Capabilities as "flag,flag;busy=queue|interrupt": small and readable in a database dump. */
object CapsCodec {
    private val names = listOf("chat", "images", "files", "screen", "voice", "skills", "sessions", "nativeUi", "reactions", "agentReactions", "bot")
    fun encode(c: Capabilities): String {
        val flags = listOf(c.chat, c.images, c.files, c.screen, c.voice, c.skills, c.sessions, c.nativeUi, c.reactions, c.agentReactions, c.bot)
        return names.filterIndexed { i, _ -> flags[i] }.joinToString(",") + ";busy=" + c.busy.joinToString("|") + (c.models?.let { ";models=$it" } ?: "")
    }
    fun decode(s: String): Capabilities {
        val models = s.substringAfter(";models=", "").substringBefore(';').takeIf { it in Capabilities.MODEL_MODES }
        val parts = s.substringBefore(";models=").split(";busy=", limit = 2); val on = parts[0].split(',').toSet()
        val busy = parts.getOrElse(1) { "queue" }.split('|').filter { it.isNotBlank() }.ifEmpty { listOf("queue") }
        return Capabilities(chat = "chat" in on, images = "images" in on, files = "files" in on, screen = "screen" in on, voice = "voice" in on, skills = "skills" in on,
            sessions = "sessions" in on, busy = busy, nativeUi = "nativeUi" in on, reactions = "reactions" in on, agentReactions = "agentReactions" in on, bot = "bot" in on, models = models)
    }
}

internal fun AgentStatus.toRow(owner: String, position: Int) = AgentRow(owner, name, position, online, chatReady, managementReady, activeSessions, kind, label, description,
    CapsCodec.encode(capabilities), order, lastActivityAt, lastSessionTitle, lastMessagePreview, lastRole, pinOrder, working, needsInput)

internal fun AgentRow.toAgent() = AgentStatus(name = name, online = online, chatReady = chatReady, managementReady = managementReady, activeSessions = activeSessions, kind = kind,
    label = label, description = description, capabilities = CapsCodec.decode(caps), order = registryOrder, lastActivityAt = lastActivityAt, lastSessionTitle = lastSessionTitle,
    lastMessagePreview = lastMessagePreview, lastRole = lastRole, pinOrder = pinOrder, working = working, needsInput = needsInput)

internal fun HubChat.toRow(owner: String) = ChatListRow(owner, agent, label, kind, chat, last?.hubId, last?.role, last?.sender, last?.preview.orEmpty(), last?.at, last?.status,
    unread, readUpTo, archived, muted, mutedUntil, pinned, pinOrder, working, needsInput, manualUnread, updatedAt)

internal fun ChatListRow.toHub() = HubChat(agent, label, kind, chat,
    if (lastHubId == null && lastPreview.isEmpty() && lastAt == null) null else LastMessage(lastHubId, lastRole, lastSender, lastPreview, lastAt, lastStatus),
    unread, readUpTo, archived, muted, mutedUntil, pinned, pinOrder, working, needsInput, manualUnread, updatedAt)
