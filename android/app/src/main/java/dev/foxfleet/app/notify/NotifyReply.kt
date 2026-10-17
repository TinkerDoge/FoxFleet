package dev.foxfleet.app.notify

import android.content.SharedPreferences
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** What the notification's Reply did. */
sealed interface ReplyOutcome {
    data class Sent(val duplicate: Boolean) : ReplyOutcome
    /** [keepKey]: the key stays stored, so the user's next try with the same text is recognised by the hub if this one did arrive. */
    data class Failed(val message: String, val keepKey: Boolean) : ReplyOutcome
}

/** The two routes the actions use (NotifyApi in the app; a fake in tests). Errors are [NotifyHttpException] with the hub's `code`. */
interface ReplyHttp {
    suspend fun reply(agent: String, chat: String, text: String, key: String, token: String?, bearer: Boolean): JsonObject
    suspend fun read(agent: String, chat: String, token: String?, bearer: Boolean): JsonObject
    fun hasBearer(): Boolean
}

class NotifyApiReplyHttp(private val api: NotifyApi) : ReplyHttp {
    override suspend fun reply(agent: String, chat: String, text: String, key: String, token: String?, bearer: Boolean) = api.reply(agent, chat, text, key, token, bearer)
    override suspend fun read(agent: String, chat: String, token: String?, bearer: Boolean) = api.read(agent, chat, null, token, bearer)
    override fun hasBearer() = api.hasBearer()
}

/**
 * Idempotency keys for direct replies, kept until the hub confirmed the reply. One key per (hub, agent, chat, text): a retry
 * of the same text, by the app (a network drop) or by the user (Reply again after "Not sent"), reuses it, so the hub answers
 * `duplicate: true` instead of sending the message twice. After a confirmed send the key is dropped: the same text later is a new message.
 */
class ReplyKeys(private val prefs: SharedPreferences, private val newKey: () -> String = { java.util.UUID.randomUUID().toString() }) {
    private fun slot(scope: String, text: String) = "k_" + Integer.toHexString((scope + "\u0000" + text).hashCode()) + "_" + (scope + text).length
    fun keyFor(scope: String, text: String): String = prefs.getString(slot(scope, text), null) ?: newKey().also { prefs.edit().putString(slot(scope, text), it).apply() }
    fun done(scope: String, text: String) = prefs.edit().remove(slot(scope, text)).apply()
}

/**
 * Sends a notification reply (`POST /api/notify/reply`): retries a network failure, 5xx or 429 a few times with the SAME key;
 * a 403 `reply_token_invalid` is retried once with the device's sign-in alone, and is never treated as a sign-out (it is never 401).
 */
class ReplySender(private val http: ReplyHttp, private val keys: ReplyKeys, private val sleep: suspend (Long) -> Unit = { delay(it) }) {
    suspend fun send(hubId: String, agent: String, chat: String, text: String, token: String?): ReplyOutcome {
        val body = text.trim()
        if (body.isEmpty()) return ReplyOutcome.Failed("Nothing to send", keepKey = false)
        if (body.length > MAX_TEXT) return ReplyOutcome.Failed("Too long for a notification reply. Open the chat to send it.", keepKey = false)
        val scope = "$hubId\u001f$agent\u001f$chat"
        val key = keys.keyFor(scope, body)
        var useToken = token != null; var bearer = !useToken || http.hasBearer(); var attempt = 0
        while (true) {
            try {
                val res = http.reply(agent, chat, body, key, if (useToken) token else null, bearer)
                keys.done(scope, body)
                return ReplyOutcome.Sent((res["duplicate"] as? JsonPrimitive)?.booleanOrNull == true)
            } catch (e: CancellationException) { throw e } catch (e: NotifyHttpException) {
                when {
                    e.status == 403 && (e.code == "reply_token_invalid" || useToken) -> {
                        if (useToken && http.hasBearer()) { useToken = false; bearer = true; continue }
                        keys.done(scope, body); return ReplyOutcome.Failed("This notification expired. Open FoxFleet to reply.", keepKey = false)
                    }
                    e.status == 401 -> return ReplyOutcome.Failed("Open FoxFleet to sign in again, then reply.", keepKey = true)
                    e.status == 409 -> { keys.done(scope, body); return ReplyOutcome.Failed("Not sent: it clashed with an earlier reply. Open the chat.", keepKey = false) }
                    e.status == 413 -> { keys.done(scope, body); return ReplyOutcome.Failed("Too long for a notification reply. Open the chat to send it.", keepKey = false) }
                    e.status == 404 -> { keys.done(scope, body); return ReplyOutcome.Failed("Your hub can't take replies from notifications. Open the chat.", keepKey = false) }
                    e.network || e.status >= 500 || e.status == 429 || e.status == 408 -> {
                        if (attempt >= MAX_RETRIES) return ReplyOutcome.Failed(if (e.status == 429) "Too many replies. Try again in a minute." else "Can't reach your hub. Try again.", keepKey = true)
                        sleep(e.retryAfterSec?.let { (it * 1000L).coerceAtMost(MAX_WAIT_MS) } ?: (BASE_WAIT_MS shl attempt).coerceAtMost(MAX_WAIT_MS)); attempt++
                    }
                    else -> { keys.done(scope, body); return ReplyOutcome.Failed(e.message ?: "Not sent", keepKey = false) }
                }
            } catch (e: Exception) {
                if (attempt >= MAX_RETRIES) return ReplyOutcome.Failed("Can't reach your hub. Try again.", keepKey = true)
                sleep((BASE_WAIT_MS shl attempt).coerceAtMost(MAX_WAIT_MS)); attempt++
            }
        }
    }

    /** Mark read: token first, then the sign-in; true when the hub confirmed. */
    suspend fun read(agent: String, chat: String, token: String?): Boolean {
        for (useToken in listOfNotNull(token?.let { true }, if (http.hasBearer()) false else null)) {
            try { http.read(agent, chat, if (useToken) token else null, bearer = !useToken); return true }
            catch (e: CancellationException) { throw e } catch (e: NotifyHttpException) { if (e.status != 403) return false } catch (_: Exception) { return false }
        }
        return false
    }

    companion object {
        const val MAX_TEXT = 32_000
        /** The receiver runs under goAsync (about 10 s): three quick retries fit. */
        const val MAX_RETRIES = 3
        const val BASE_WAIT_MS = 600L
        const val MAX_WAIT_MS = 3_000L
    }
}
