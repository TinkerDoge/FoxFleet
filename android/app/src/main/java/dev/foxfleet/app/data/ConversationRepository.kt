package dev.foxfleet.app.data

import dev.foxfleet.app.data.local.CachedRoom
import dev.foxfleet.app.data.local.ChatCache
import dev.foxfleet.app.data.live.LiveReducer
import dev.foxfleet.app.data.live.V2Event

/**
 * Rooms over the hub and the device cache. A room is addressed by its own `fc_…` id and the account key,
 * never by a member agent: the DM cache and a room's transcript never share rows.
 *
 * Every read is cache-first when the device has something (the screen opens instantly, also offline), then the
 * hub's answer replaces/merges it. Writes go to the hub first and only the hub's accepted shape is cached.
 */
class ConversationRepository(private val api: HubApi, private val cache: ChatCache?) {

    // ---- list ----

    suspend fun cachedConversations(): List<Conversation> = cache?.conversations().orEmpty()
    fun observeCachedConversations() = cache?.observeConversations()

    /** The hub's room list; the account's cached rooms are replaced by the snapshot. */
    suspend fun list(limit: Int = 50, offset: Int = 0): List<Conversation> {
        val page = api.conversations(limit, offset)
        if (offset == 0) cache?.saveConversations(page.conversations) else page.conversations.forEach { cache?.saveConversation(it) }
        return page.conversations
    }

    /** The room itself (title, members, paused): cached first, then the hub. */
    suspend fun conversation(id: String): Conversation {
        val fresh = api.conversation(id)
        cache?.saveConversation(fresh)
        return fresh
    }

    suspend fun cachedConversation(id: String): Conversation? = cache?.conversation(id)

    suspend fun create(title: String, memberIds: List<String>, clientId: String? = null): Conversation {
        val room = api.createConversation(title, memberIds, clientId)
        cache?.saveConversation(room)
        return room
    }

    suspend fun rename(id: String, title: String): Conversation = cacheSaved { api.renameConversation(id, title) }
    suspend fun addMember(id: String, agent: String): Conversation = cacheSaved { api.addConversationMember(id, agent) }
    suspend fun removeMember(id: String, agent: String): Conversation = cacheSaved { api.removeConversationMember(id, agent) }

    // ---- transcript ----

    suspend fun cachedRoom(id: String, limit: Int = 80): CachedRoom? = cache?.roomNewest(id, limit)

    /** The newest page (chronological). [cursor] pages older; each page is written through to the cache. */
    suspend fun page(id: String, cursor: Int? = null, limit: Int = 50): ConversationPage {
        val page = api.conversationMessages(id, limit = limit, cursor = cursor)
        cache?.upsertRoomMessages(page.messages)
        return page
    }

    suspend fun message(id: String, messageId: String): ConversationMessage {
        val m = api.conversationMessage(id, messageId)
        cache?.upsertRoomMessage(m)
        return m
    }

    suspend fun cachedMessage(id: String, messageId: String): ConversationMessage? = cache?.roomMessage(id, messageId)

    suspend fun send(
        id: String, text: String, mentions: List<ConversationMention> = emptyList(),
        replyTo: String? = null, media: List<String> = emptyList(), clientId: String? = null,
    ): Pair<ConversationMessage, List<String>> {
        val sent = api.sendConversationMessage(id, text, mentions, replyTo, media, clientId)
        cache?.upsertRoomMessage(sent.first)
        return sent
    }

    suspend fun markRead(id: String, upTo: Int? = null): Conversation = cacheSaved { api.markConversationRead(id, upTo) }

    suspend fun preferences(id: String, prefs: ConversationPreferences): ConversationPreferences {
        val saved = api.conversationPreferences(id, prefs)
        cachedConversation(id)?.let { cache?.saveConversation(it.copy(archived = saved.archived)) }
        return saved
    }

    /** Owner Stop. The hub's `paused` flag is authoritative; the cached room follows it. */
    suspend fun stop(id: String): ConversationStopResult {
        val result = api.stopConversation(id)
        cachedConversation(id)?.let { cache?.saveConversation(it.copy(paused = result.paused ?: true)) }
        return result
    }

    suspend fun resume(id: String): Conversation = cacheSaved { api.resumeConversation(id) }

    fun mediaUrl(id: String, media: String): String = api.conversationMediaUrl(id, media)

    /** Live v2 `conversation.*`: write through the same reducer the DM stream uses. */
    suspend fun applyLive(event: V2Event): List<dev.foxfleet.app.data.live.LiveEffect> {
        val c = cache ?: return emptyList()
        val e = event
        if (e.conversationId == null) return emptyList()
        return LiveReducer(c).apply(e)
    }

    private suspend fun cacheSaved(block: suspend () -> Conversation): Conversation {
        val room = block()
        cache?.saveConversation(room)
        return room
    }
}

/** Explicit typed mentions, at word boundaries, exactly as the web client computes them. */
object ConversationMentions {
    fun mentionsIn(text: String, members: List<ConversationMember>): List<ConversationMention> {
        val out = ArrayList<ConversationMention>()
        val agents = members.filter { it.isAgent }.sortedByDescending { it.name.length }
        for (m in agents) {
            val needle = "@${m.name}"
            var from = 0
            while (true) {
                val at = text.indexOf(needle, from)
                if (at < 0) break
                val end = at + needle.length
                val after = text.getOrNull(end)?.toString().orEmpty()
                val before = if (at == 0) "" else text[at - 1].toString()
                if (!WORD.matches(after) && !WORD.matches(before)) {
                    out += ConversationMention("agent", "agent:${m.name}", at, needle.length)
                }
                from = end
            }
        }
        return out.sortedBy { it.offset }
    }

    data class Token(val at: Int, val query: String)

    /** The `@…` token being typed at [caret], or null (only after whitespace/start; no spaces; ≤64 chars). */
    fun tokenAt(text: String, caret: Int): Token? {
        val before = text.take(caret.coerceIn(0, text.length))
        val at = before.lastIndexOf('@')
        if (at < 0) return null
        if (at > 0 && !before[at - 1].isWhitespace()) return null
        val query = before.substring(at + 1)
        if (query.any { it.isWhitespace() } || query.length > 64) return null
        return Token(at, query)
    }

    private val WORD = Regex("[A-Za-z0-9_]")
}

/** Deterministic room list ordering shared by the screens and tests. */
object ConversationOrder {
    fun sorted(list: List<Conversation>): List<Conversation> = list.sortedWith(compareByDescending<Conversation> { it.activityAt }.thenBy { it.title })
}
