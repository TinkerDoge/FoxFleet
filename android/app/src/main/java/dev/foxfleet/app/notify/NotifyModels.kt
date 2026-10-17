package dev.foxfleet.app.notify

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** The four event types of contract `foxfleet.notify/1`. Unknown future types are kept as [Other] and ignored (but still advance the cursor). */
enum class NotifyType { ReplyFinished, Approval, Error, Test, Other }

/** One hub event. Ids only: no message, command or question text ever comes with it (the hub's privacy rule). */
data class NotifyEvent(
    val id: Long,
    val type: NotifyType,
    val agent: String?,
    val chat: String?,
    val high: Boolean,
    val at: Long,
    val muted: Boolean,
    val runId: String? = null,
    val requestId: String? = null,
    val kind: String? = null,
    val message: String? = null,
    /** Phase 1 (`notifyReply`, stream opened with `?reply=1`): a 24 h token for direct reply / mark read on this event's chat. Never logged. */
    val reply: ReplyGrant? = null,
) {
    /** The (agent, chat) pair that one notification belongs to; null for test events. */
    val chatKey: String? get() = if (agent != null && chat != null) chatKeyOf(agent, chat) else null
}

fun chatKeyOf(agent: String, chat: String) = "$agent\u0000$chat"

/** A reply token from a `notify` event. [toString] hides the token so it can never reach a log line. */
class ReplyGrant(val token: String, val expiresAt: Long) {
    fun validAt(now: Long) = token.isNotBlank() && expiresAt > now
    override fun toString() = "ReplyGrant(expiresAt=$expiresAt)"
    override fun equals(other: Any?) = other is ReplyGrant && other.token == token && other.expiresAt == expiresAt
    override fun hashCode() = token.hashCode() * 31 + expiresAt.hashCode()
}

/** What the stream says, after the SSE framing is decoded. */
sealed interface NotifyFrame {
    data class Event(val event: NotifyEvent, val sseId: Long?) : NotifyFrame
    /** `foxfleet.gap`: ids were lost ([first] = oldest retained id, [cursor] = newest id). */
    data class Gap(val first: Long, val cursor: Long) : NotifyFrame
    /** `foxfleet.ready`: the replay is over; [cursor] is the newest id the hub has. */
    data class Ready(val cursor: Long) : NotifyFrame
    /** `foxfleet.auth`: the hub ended this login. Do not reconnect. */
    data class Auth(val reason: String) : NotifyFrame
}

object NotifyFrames {
    private val json = Json { ignoreUnknownKeys = true }

    /** Plain decimal ids only (the hub's own rule for a cursor). */
    fun parseId(s: String?): Long? = s?.takeIf { it.isNotEmpty() && it.length <= 18 && it.all { c -> c in '0'..'9' } }?.toLongOrNull()

    fun parseEvent(o: JsonObject): NotifyEvent? {
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val id = (o["id"] as? JsonPrimitive)?.longOrNull?.takeIf { it >= 0 } ?: return null
        val type = when (str("type")) {
            "reply_finished" -> NotifyType.ReplyFinished; "approval" -> NotifyType.Approval; "error" -> NotifyType.Error; "test" -> NotifyType.Test
            else -> NotifyType.Other
        }
        return NotifyEvent(
            id = id, type = type, agent = str("agent"), chat = str("chat"), high = str("priority") == "high",
            at = (o["at"] as? JsonPrimitive)?.longOrNull ?: 0L, muted = (o["muted"] as? JsonPrimitive)?.booleanOrNull ?: false,
            runId = str("run_id"), requestId = str("request_id"), kind = str("kind"), message = str("message"),
            reply = (o["reply"] as? JsonObject)?.let { r ->
                val t = (r["token"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull; val exp = (r["expires_at"] as? JsonPrimitive)?.longOrNull
                if (t != null && exp != null) ReplyGrant(t, exp) else null
            },
        )
    }

    /** Decodes one SSE event of the stream; null for anything this client does not know (forward compatible). */
    fun decode(event: String, data: String, sseId: String?): NotifyFrame? {
        val o = runCatching { json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
        return when (event) {
            "notify" -> parseEvent(o)?.let { NotifyFrame.Event(it, parseId(sseId) ?: it.id) }
            "foxfleet.gap" -> {
                val first = (o["first"] as? JsonPrimitive)?.longOrNull; val cursor = (o["cursor"] as? JsonPrimitive)?.longOrNull
                if (first != null && cursor != null) NotifyFrame.Gap(first, cursor) else null
            }
            "foxfleet.ready" -> (o["cursor"] as? JsonPrimitive)?.longOrNull?.let { NotifyFrame.Ready(it) }
            "foxfleet.auth" -> NotifyFrame.Auth((o["reason"] as? JsonPrimitive)?.contentOrNull ?: "signed_out")
            else -> null
        }
    }
}

/** One mute rule of the hub's prefs view. [chat] is null for an agent mute; [until] is ms since the epoch, null = until unmuted. */
data class MuteRule(val agent: String, val chat: String?, val until: Long?) {
    fun activeAt(now: Long) = until == null || until > now
}

/** `GET/PUT /api/notify/prefs` and `PUT /api/notify/mute`. */
data class HubNotifyPrefs(val enabled: Boolean = true, val storageOk: Boolean = true, val storageError: String? = null, val mutes: List<MuteRule> = emptyList()) {
    fun agentMute(agent: String, now: Long) = mutes.firstOrNull { it.chat == null && it.agent == agent && it.activeAt(now) }
    fun chatMute(agent: String, chat: String, now: Long) = mutes.firstOrNull { it.chat == chat && it.agent == agent && it.activeAt(now) }

    companion object {
        fun parse(o: JsonObject): HubNotifyPrefs {
            fun rules(arr: JsonArray?, withChat: Boolean) = arr?.mapNotNull { el ->
                val r = el as? JsonObject ?: return@mapNotNull null
                val agent = (r["agent"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                val chat = if (withChat) ((r["chat"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null) else null
                MuteRule(agent, chat, (r["until"] as? JsonPrimitive)?.longOrNull)
            }.orEmpty()
            val storage = o["storage"] as? JsonObject
            return HubNotifyPrefs(
                enabled = (o["enabled"] as? JsonPrimitive)?.booleanOrNull ?: true,
                storageOk = (storage?.get("ok") as? JsonPrimitive)?.booleanOrNull ?: true,
                storageError = (storage?.get("error") as? JsonPrimitive)?.contentOrNull,
                mutes = rules(runCatching { o["agents"]?.jsonArray }.getOrNull(), false) + rules(runCatching { o["chats"]?.jsonArray }.getOrNull(), true),
            )
        }
    }
}

/** Result of the Settings "Send test notification" button. */
sealed interface TestOutcome {
    data object Idle : TestOutcome
    data object Sending : TestOutcome
    data object Sent : TestOutcome
    /** The hub accepted it, but the connection is off on this phone, so nothing will show here. */
    data object SentWhileOff : TestOutcome
    /** The hub's master switch is off, so the event was created muted and nothing is pushed. */
    data object HubMuted : TestOutcome
    data class RateLimited(val retryAfterSec: Int) : TestOutcome
    data class Failed(val message: String) : TestOutcome
}

/** Three user-facing categories. Quiet hours and hub-side category toggles are not in phase 1, so these are local. */
enum class NotifyCategory(val label: String, val description: String) {
    Replies("Replies", "When an agent finishes a reply"),
    Approvals("Approvals and questions", "When an agent needs your OK or an answer"),
    Errors("Errors", "When a reply fails");
    companion object { fun of(t: NotifyType): NotifyCategory? = when (t) { NotifyType.ReplyFinished -> Replies; NotifyType.Approval -> Approvals; NotifyType.Error -> Errors; else -> null } }
}

/** What the Settings status line and the service notification say. */
sealed interface NotifyLink {
    data object Off : NotifyLink
    data object Connecting : NotifyLink
    data object Connected : NotifyLink
    data class Reconnecting(val attempt: Int) : NotifyLink
    data object Offline : NotifyLink
    /** The hub signed this device out; the user has to log in again. */
    data object SignedOut : NotifyLink
    /** The hub is too old to have /api/notify. */
    data object Unsupported : NotifyLink
    /** Android refused to start the service from the background (or its time limit ran out). */
    data object Blocked : NotifyLink
}
