package dev.foxfleet.app.data.live

import dev.foxfleet.app.data.local.ChatCache

/** What the screens must do after an event was written to the cache. */
sealed interface LiveEffect {
    /** A message of [chat] was added or replaced (the open chat shows it; others only change their list row). */
    data class Upserted(val agent: String, val chat: String, val message: HubMessage, val edited: Boolean) : LiveEffect
    data class Deleted(val agent: String, val chat: String, val hubIds: List<String>) : LiveEffect
    data class Status(val agent: String, val chat: String, val hubIds: List<String>, val status: String) : LiveEffect
    /** The cache cannot place this message (newer than its newest + 1, or the chat is cached without numbers): fetch `after_n`. */
    data class FetchAfter(val agent: String, val chat: String, val afterN: Int?) : LiveEffect
    /** Chat-list rows or totals changed: redraw the list and the badge. */
    data object ListChanged : LiveEffect
    data class Read(val agent: String, val chat: String?, val state: ReadState) : LiveEffect
    /** v1 notices that v2 carries too (runs, approvals): handled by the existing run-follow code. */
    data class Notice(val type: String, val agent: String, val chat: String?, val runId: String?, val state: String?) : LiveEffect
    /** The agent's own message ended its typing state in that chat. */
    data class StopTyping(val agent: String, val chat: String?) : LiveEffect
    /** `message.reaction` (or a message that carries its reactions): the full set on one message, already written to the cache. */
    data class Reactions(val agent: String, val chat: String, val hubId: String, val upstreamId: String?, val groups: List<dev.foxfleet.app.data.ReactionGroup>) : LiveEffect
    /** A room (created/updated) was written to the cache: redraw its list row and, when open, its header. */
    data class ConversationChanged(val conversation: dev.foxfleet.app.data.Conversation) : LiveEffect
    /** One room message (new or edited) was written to the cache: append/replace it in the open transcript. */
    data class ConversationMessageUpserted(val conversationId: String, val message: dev.foxfleet.app.data.ConversationMessage, val edited: Boolean) : LiveEffect
    data class ConversationMessageDeleted(val conversationId: String, val messageId: String) : LiveEffect
    data class ConversationReadChanged(val conversationId: String, val readUpTo: Int) : LiveEffect
}

/**
 * Applies v2 events to the Room cache, idempotently: the same event twice (a crash between apply and the cursor save, a
 * replay) leaves the same rows. The hub is the source of truth, so a row event replaces the row and a message event upserts
 * by `hub_id`; nothing is merged field by field except message status, which only moves forward.
 */
class LiveReducer(private val cache: ChatCache) {
    suspend fun apply(e: V2Event): List<LiveEffect> = when (e) {
        is V2Event.MessageNew -> message(e.agent, e.chat, e.message, edited = false)
        is V2Event.MessageEdited -> message(e.agent, e.chat, e.message, edited = true)
        is V2Event.MessageDeleted -> { cache.deleteLive(e.hubIds); listOf(LiveEffect.Deleted(e.agent, e.chat, e.hubIds)) }
        is V2Event.MessageStatusChanged -> { cache.statusLive(e.hubIds, e.status); listOf(LiveEffect.Status(e.agent, e.chat, e.hubIds, e.status)) }
        is V2Event.Read -> {
            cache.chatRow(e.agent)?.let { r -> cache.saveChatRow(r.copy(unread = e.state.agentUnread, readUpTo = maxOf(r.readUpTo, e.state.readUpTo), manualUnread = false)) }
            cache.saveTotals(e.state.totalUnread)
            listOf(LiveEffect.Read(e.agent, e.chat, e.state), LiveEffect.ListChanged)
        }
        is V2Event.ChatUpdated -> { cache.saveChatRow(e.row); listOf(LiveEffect.ListChanged) }
        is V2Event.ChatRemoved -> { cache.removeAgent(e.agent); listOf(LiveEffect.ListChanged) }
        is V2Event.RunStarted -> listOf(LiveEffect.Notice("run_started", e.agent, e.chat, e.runId, null))
        is V2Event.RunFinished -> listOf(LiveEffect.Notice("run_finished", e.agent, e.chat, e.runId, e.state), LiveEffect.StopTyping(e.agent, e.chat))
        is V2Event.Approval -> listOf(LiveEffect.Notice("approval", e.agent, e.chat, null, null))
        is V2Event.MessageReaction -> { cache.replaceReactions(e.agent, e.chat, e.hubId, e.upstreamId, e.reactions); listOf(LiveEffect.Reactions(e.agent, e.chat, e.hubId, e.upstreamId, e.reactions)) }
        is V2Event.ConversationCreated -> { cache.saveConversation(e.conversation); listOf(LiveEffect.ConversationChanged(e.conversation)) }
        is V2Event.ConversationUpdated -> { cache.saveConversation(e.conversation); listOf(LiveEffect.ConversationChanged(e.conversation)) }
        is V2Event.ConversationMessageNew -> { cache.upsertRoomMessage(e.message); listOf(LiveEffect.ConversationMessageUpserted(e.conversationId, e.message, false)) }
        is V2Event.ConversationMessageEdited -> { cache.upsertRoomMessage(e.message); listOf(LiveEffect.ConversationMessageUpserted(e.conversationId, e.message, true)) }
        is V2Event.ConversationMessageDeleted -> { cache.deleteRoomMessage(e.conversationId, e.messageId); listOf(LiveEffect.ConversationMessageDeleted(e.conversationId, e.messageId)) }
        is V2Event.ConversationRead -> listOf(LiveEffect.ConversationReadChanged(e.conversationId, e.readUpTo))
        is V2Event.ConversationMemberChanged -> emptyList() // conversation.updated carries the authoritative member list
        is V2Event.ConversationHandoff -> emptyList() // durable messages carry the visible markers
        is V2Event.Unknown -> emptyList()
    }

    private suspend fun message(agent: String, chat: String, m: HubMessage, edited: Boolean): List<LiveEffect> {
        val placed = cache.upsertLive(agent, chat, m.toUi())
        val out = ArrayList<LiveEffect>(3)
        out += LiveEffect.Upserted(agent, chat, m, edited)
        if (!placed && cache.numbered(agent, chat)) out += LiveEffect.FetchAfter(agent, chat, cache.maxN(agent, chat))
        if (m.role == "assistant" && !edited) out += LiveEffect.StopTyping(agent, chat)
        m.reactions?.let { g -> cache.replaceReactions(agent, chat, m.hubId, m.upstreamId, g); out += LiveEffect.Reactions(agent, chat, m.hubId, m.upstreamId, g) }
        return out
    }
}

/** Typing state per (agent, chat), JVM-testable. Clears after `ttl_ms` without a repeat, on `idle`, on run end, on the agent's message. */
class TypingTracker(private val clock: () -> Long = { System.currentTimeMillis() }) {
    private data class Entry(val t: Typing, val until: Long)
    private val map = HashMap<String, Entry>()
    private fun key(agent: String, chat: String) = "$agent\u0000$chat"

    /** True when what a header shows may have changed. */
    fun on(t: Typing): Boolean {
        val k = key(t.agent, t.chat)
        if (t.state == "idle") return map.remove(k) != null
        val old = map[k]; map[k] = Entry(t, clock() + t.ttlMs)
        return old?.t?.state != t.state || old.t.tool != t.tool
    }
    fun clear(agent: String, chat: String?): Boolean =
        if (chat != null) map.remove(key(agent, chat)) != null else map.keys.removeAll { it.startsWith("$agent\u0000") }
    fun clearAll() = map.clear()
    fun get(agent: String, chat: String?): Typing? {
        val now = clock(); map.entries.removeAll { it.value.until <= now }
        return if (chat != null) map[key(agent, chat)]?.t else map.values.firstOrNull { it.t.agent == agent }?.t
    }
    /** Ms until the next entry expires (to schedule a redraw), or null. */
    fun nextExpiryIn(): Long? = map.values.minOfOrNull { it.until }?.let { (it - clock()).coerceAtLeast(0) }

    companion object {
        /** The header line: "thinking…", "typing…", "running bash…". */
        fun label(t: Typing?): String? = when (t?.state) {
            null, "idle" -> null
            "thinking" -> "thinking…"
            "tool" -> t.tool?.takeIf { it.isNotBlank() }?.let { "running $it…" } ?: "using a tool…"
            else -> "typing…"
        }
    }
}

/**
 * Runs keyed on `run_id`, not on the message order: `run.started` can arrive before the `message.new` of the user message that
 * started it (a new chat learns its session id at launch), and a replay after a reconnect repeats both. A run is followed once;
 * a `run.started` replayed after its `run.finished` is ignored.
 */
class RunTracker(private val cap: Int = 128) {
    data class Run(val agent: String, val chat: String?)
    private val live = LinkedHashMap<String, Run>()
    private val done = LinkedHashSet<String>()
    /** True the first time this run is seen (start following it). */
    fun started(runId: String, agent: String, chat: String?): Boolean {
        if (runId in done) return false
        val old = live[runId]
        if (old != null) { if (old.chat == null && chat != null) live[runId] = old.copy(chat = chat); return false }
        live[runId] = Run(agent, chat); trim(); return true
    }
    /** The finished run (with the chat it started in when [chat] is null), or null if it was never started here. */
    fun finished(runId: String?, agent: String, chat: String?): Run? {
        if (runId == null) return null
        done += runId; trim()
        return live.remove(runId)?.let { if (it.chat == null) it.copy(chat = chat) else it }
    }
    fun running(agent: String): Boolean = live.values.any { it.agent == agent }
    /** Started and not finished yet (as far as this stream knows). */
    fun isLive(runId: String): Boolean = runId in live
    fun clear() { live.clear(); done.clear() }
    private fun trim() {
        while (live.size > cap) live.remove(live.keys.first())
        while (done.size > cap) done.remove(done.first())
    }
}
