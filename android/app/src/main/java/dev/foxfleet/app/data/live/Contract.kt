package dev.foxfleet.app.data.live

import dev.foxfleet.app.data.UiMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/*
 * Phase 1 hub contract (feat/tg-phase1, docs/LIVE-EVENTS.md v2 + contract/openapi.json): the models the app reads.
 * Every parser is lenient: unknown fields are ignored, an unknown event type is [V2Event.Unknown] (it still advances the
 * cursor), a malformed object is null. Nothing here branches on the hub's version string; features gate it ([HubFeatures]).
 */

/** What `hub.features` turned on. Feature names, never version numbers. */
data class HubFeatures(val live: Boolean, val live2: Boolean, val chats: Boolean, val readReceipts: Boolean, val notifyReply: Boolean) {
    companion object {
        fun of(list: List<String>) = HubFeatures("live" in list, "live2" in list, "chats" in list, "readReceipts" in list, "notifyReply" in list)
        val NONE = HubFeatures(false, false, false, false, false)
    }
}

object MessageStatus {
    const val SENT = "sent"; const val DELIVERED = "delivered"; const val READ = "read"; const val FAILED = "failed"
    val ALL = setOf(SENT, DELIVERED, READ, FAILED)
    private fun rank(s: String?) = when (s) { SENT -> 1; DELIVERED -> 2; READ -> 3; else -> 0 }
    /** Status only moves forward (sent → delivered → read); `failed` replaces only `sent` or nothing. */
    fun advance(old: String?, new: String?): String? = when {
        new == null || new !in ALL -> old
        new == FAILED -> if (old == null || old == SENT) FAILED else old
        old == FAILED -> if (rank(new) >= 2) new else old
        rank(new) > rank(old) -> new
        else -> old
    }
}

/** `Message` of the contract (stream events, the reply result). */
data class HubMessage(
    val hubId: String, val upstreamId: String?, val n: Int, val role: String, val text: String, val truncated: Boolean, val at: Long,
    val source: String, val status: String?, val replyTo: String?, val editedAt: Long?, val runId: String?, val images: List<String>,
    /** 0.4.1 hubs, agent messages: the reply's thinking and the tools it used (same shape as history). Empty on older hubs. */
    val reasoning: String = "", val tools: List<dev.foxfleet.app.data.ToolStep> = emptyList(),
) {
    fun toUi() = UiMessage(role = role, content = text, id = upstreamId, ts = at, imageUrls = images, hubId = hubId, n = n, status = status.takeIf { role == "user" },
        reasoning = if (role == "assistant") reasoning else "", steps = if (role == "assistant") tools else emptyList(), runId = runId)
}

data class LastMessage(val hubId: String?, val role: String?, val sender: String?, val preview: String, val at: Long?, val status: String?)

/** `ChatRow` of `GET /api/chats`: one row per agent. [mutedUntil] null with [muted] true = muted until unmuted. */
data class HubChat(
    val agent: String, val label: String, val kind: String, val chat: String?, val last: LastMessage?, val unread: Int, val readUpTo: Int,
    val archived: Boolean, val muted: Boolean, val mutedUntil: Long?, val pinned: Boolean, val pinOrder: Int?, val working: Boolean,
    val needsInput: Boolean, val manualUnread: Boolean, val updatedAt: Long,
) {
    fun mutedAt(now: Long) = muted && (mutedUntil == null || mutedUntil > now)
    /** The badge: unread replies, or 1 for a chat marked unread by hand. */
    val badge: Int get() = if (unread > 0) unread else if (manualUnread) 1 else 0
}

data class ChatsSnapshot(val chats: List<HubChat>, val cursor: String?, val totalUnread: Int, val totalUnreadAll: Int)
data class ReadState(val chat: String?, val readUpTo: Int, val unread: Int, val agentUnread: Int, val totalUnread: Int)

/** Persisted v2 events. [seq] orders them per account; [id] is the SSE id `<store>:<seq>` (the resume cursor). */
sealed interface V2Event {
    val seq: Long; val agent: String?; val chat: String?
    data class MessageNew(override val seq: Long, override val agent: String, override val chat: String, val message: HubMessage) : V2Event
    data class MessageEdited(override val seq: Long, override val agent: String, override val chat: String, val message: HubMessage) : V2Event
    data class MessageDeleted(override val seq: Long, override val agent: String, override val chat: String, val hubIds: List<String>) : V2Event
    data class MessageStatusChanged(override val seq: Long, override val agent: String, override val chat: String, val hubIds: List<String>, val status: String) : V2Event
    data class Read(override val seq: Long, override val agent: String, override val chat: String?, val state: ReadState) : V2Event
    data class ChatUpdated(override val seq: Long, val row: HubChat) : V2Event { override val agent get() = row.agent; override val chat get() = row.chat }
    data class ChatRemoved(override val seq: Long, override val agent: String) : V2Event { override val chat: String? get() = null }
    data class RunStarted(override val seq: Long, override val agent: String, override val chat: String?, val runId: String) : V2Event
    data class RunFinished(override val seq: Long, override val agent: String, override val chat: String?, val runId: String?, val state: String?) : V2Event
    data class Approval(override val seq: Long, override val agent: String, override val chat: String?, val requestId: String?, val kind: String?) : V2Event
    /** A type this app does not know (or a known one it cannot read): ignored, but its id still moves the cursor. */
    data class Unknown(override val seq: Long, val type: String, override val agent: String?, override val chat: String?) : V2Event
}

/** Ephemeral `event: typing` (no id, never replayed). [label] / [toolId]: 0.4.1 hubs (what the step is about). */
data class Typing(val agent: String, val chat: String, val state: String, val tool: String?, val ttlMs: Long, val label: String? = null, val toolId: String? = null)

/** Ephemeral `event: run.step` (0.4.1 hubs): one step of a reply that is running in [chat]; never stored or replayed. */
data class RunStep(
    val agent: String, val chat: String, val runId: String?, val kind: String, val toolId: String?, val name: String?,
    val preview: String?, val ok: Boolean?, val durationMs: Long?, val text: String?, val at: Long,
)

object Contract {
    val json = Json { ignoreUnknownKeys = true }

    private fun JsonObject.p(k: String) = this[k] as? JsonPrimitive
    private fun JsonObject.s(k: String) = p(k)?.takeIf { it.isString }?.contentOrNull
    private fun JsonObject.l(k: String) = p(k)?.takeIf { it !is JsonNull && !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.takeIf { d -> d.isFinite() }?.toLong() }
    private fun JsonObject.b(k: String) = p(k)?.takeIf { !it.isString }?.booleanOrNull
    private fun JsonObject.o(k: String) = this[k] as? JsonObject
    private fun JsonObject.strings(k: String) = (this[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

    fun message(o: JsonObject?): HubMessage? {
        o ?: return null
        val role = o.s("role")?.takeIf { it == "user" || it == "assistant" } ?: return null
        return HubMessage(
            hubId = o.s("hub_id")?.takeIf { it.isNotEmpty() } ?: return null, upstreamId = o.s("upstream_id"), n = o.l("n")?.toInt() ?: return null,
            role = role, text = o.s("text").orEmpty(), truncated = o.b("truncated") == true, at = o.l("at") ?: 0L, source = o.s("source") ?: "agent",
            status = o.s("status")?.takeIf { it in MessageStatus.ALL }, replyTo = o.s("reply_to"), editedAt = o.l("edited_at"), runId = o.s("run_id"),
            images = (o["images"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.s("url") }.orEmpty(),
            reasoning = if (role == "assistant") o.s("reasoning").orEmpty() else "",
            tools = if (role == "assistant") tools(o["tools"]) else emptyList(),
        )
    }

    /** `tools: [{name, args?, result?, ok?}]` of a reply (lenient: bad entries are skipped). */
    fun tools(e: JsonElement?): List<dev.foxfleet.app.data.ToolStep> = (e as? JsonArray)?.mapNotNull { t ->
        val o = t as? JsonObject ?: return@mapNotNull null; val name = o.s("name")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        dev.foxfleet.app.data.ToolStep(name.take(80), o.s("args").orEmpty().take(500), o.s("result").orEmpty().take(500), o.b("ok"))
    }?.take(50).orEmpty()

    fun runStep(o: JsonObject): RunStep? {
        val agent = o.s("agent") ?: return null; val chat = o.s("chat") ?: return null; val kind = o.s("kind") ?: return null
        return RunStep(agent, chat, o.s("run_id"), kind, o.s("tool_id"), o.s("name"), o.s("preview"), o.b("ok"), o.l("duration_ms")?.takeIf { it >= 0 }, o.s("text"), o.l("at") ?: 0L)
    }

    fun chat(o: JsonObject?): HubChat? {
        o ?: return null
        val agent = o.s("agent") ?: return null
        val last = o.o("last_message")?.let { m -> LastMessage(m.s("hub_id"), m.s("role"), m.s("sender"), m.s("preview").orEmpty(), m.l("at"), m.s("status")) }
        val mute = o.o("muted")
        return HubChat(
            agent = agent, label = o.s("label") ?: agent, kind = o.s("kind") ?: "hermes", chat = o.s("chat"), last = last,
            unread = (o.l("unread_count") ?: 0L).toInt().coerceAtLeast(0), readUpTo = (o.l("read_up_to") ?: 0L).toInt(),
            archived = o.b("archived") == true, muted = mute != null, mutedUntil = mute?.l("until"), pinned = o.b("pinned") == true,
            pinOrder = o.l("pin_order")?.toInt(), working = o.b("working") == true, needsInput = o.b("needs_input") == true,
            manualUnread = o.b("manual_unread") == true, updatedAt = o.l("updated_at") ?: 0L,
        )
    }

    fun snapshot(o: JsonObject) = ChatsSnapshot(
        (o["chats"] as? JsonArray)?.mapNotNull { chat(it as? JsonObject) }.orEmpty(), o.s("cursor"),
        (o.l("total_unread") ?: 0L).toInt(), (o.l("total_unread_all") ?: 0L).toInt(),
    )

    fun read(o: JsonObject) = ReadState(o.s("chat"), (o.l("read_up_to") ?: 0L).toInt(), (o.l("unread_count") ?: 0L).toInt(), (o.l("agent_unread") ?: 0L).toInt(), (o.l("total_unread") ?: 0L).toInt())

    /** One persisted event (stream `data:` or an element of `GET /api/live/events`). Null only when it has no `seq` at all. */
    fun event(o: JsonObject, sseType: String? = null): V2Event? {
        val seq = o.l("seq") ?: return null
        val type = o.s("type") ?: sseType ?: return null
        val agent = o.s("agent"); val chat = o.s("chat")
        fun unknown() = V2Event.Unknown(seq, type, agent, chat)
        if (agent == null && type != "chat.updated") return unknown()
        return when (type) {
            "message.new" -> message(o.o("message"))?.let { m -> chat?.let { V2Event.MessageNew(seq, agent!!, it, m) } }
            "message.edited" -> message(o.o("message"))?.let { m -> chat?.let { V2Event.MessageEdited(seq, agent!!, it, m) } }
            "message.deleted" -> chat?.let { V2Event.MessageDeleted(seq, agent!!, it, o.strings("hub_ids")) }
            "message.status" -> o.s("status")?.takeIf { it in MessageStatus.ALL }?.let { st -> chat?.let { V2Event.MessageStatusChanged(seq, agent!!, it, o.strings("hub_ids"), st) } }
            "read" -> V2Event.Read(seq, agent!!, chat, read(o))
            "chat.updated" -> chat(o.o("row"))?.let { V2Event.ChatUpdated(seq, it) }
            "chat.removed" -> V2Event.ChatRemoved(seq, agent!!)
            "run.started" -> o.s("run_id")?.let { V2Event.RunStarted(seq, agent!!, chat, it) }
            "run.finished" -> V2Event.RunFinished(seq, agent!!, chat, o.s("run_id"), o.s("state"))
            "approval" -> V2Event.Approval(seq, agent!!, chat, o.s("request_id"), o.s("kind"))
            else -> null
        } ?: unknown()
    }

    fun typing(o: JsonObject): Typing? {
        val agent = o.s("agent") ?: return null; val chat = o.s("chat") ?: return null
        return Typing(agent, chat, o.s("state") ?: "idle", o.s("tool")?.take(80), (o.l("ttl_ms") ?: 6000L).coerceIn(500L, 60_000L), o.s("label")?.take(200)?.takeIf { it.isNotBlank() }, o.s("tool_id"))
    }

    fun obj(text: String): JsonObject? = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
    fun obj(e: JsonElement?): JsonObject? = e as? JsonObject
}
