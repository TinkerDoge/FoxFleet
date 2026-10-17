package dev.foxfleet.app.notify

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The bearer token of one hub. A rotated token (`X-Session-Token`) is written back, and the next request uses it. */
interface TokenSource {
    fun get(): String?
    fun set(token: String)
}

/** Stream heartbeat is 15 s; the contract says treat 45 s of silence as a dead link. */
const val HEARTBEAT_TIMEOUT_SEC = 45L

class NotifyHttpException(val status: Int, message: String, val retryAfterSec: Int? = null, val network: Boolean = false, val code: String? = null) : Exception(message)

/** OkHttp transport for the stream: bearer token, `Last-Event-ID`, a 45 s read timeout (the heartbeat rule) and the rotated token header. */
class OkHttpNotifyTransport(private val baseUrl: String, private val tokens: TokenSource, private val client: OkHttpClient = defaultClient()) : NotifyTransport {
    override fun open(lastId: Long?): NotifyOpen {
        // reply=1 (phase 1, `notifyReply`): reply_finished / approval events carry a reply token for this device. Older hubs ignore the parameter.
        val url = baseUrl.trimEnd('/').toHttpUrl().newBuilder().encodedPath("/api/notify/stream").addQueryParameter("reply", "1").build()
        val b = Request.Builder().url(url).header("Accept", "text/event-stream").header("Cache-Control", "no-cache")
        tokens.get()?.let { b.header("Authorization", "Bearer $it") }
        if (lastId != null) b.header("Last-Event-ID", lastId.toString())
        val call = client.newCall(b.build())
        val res = call.execute()
        return NotifyOpen(res.code, res.header("Content-Type"), res.header("X-Session-Token"), NotifyRetryAfter.parse(res.header("Retry-After")), res.body?.charStream(), onClose = { res.close(); call.cancel() })
    }
    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(HEARTBEAT_TIMEOUT_SEC, TimeUnit.SECONDS).retryOnConnectionFailure(true).build()
    }
}

/** The JSON routes under `/api/notify` (prefs, mute, test, events). One small client so the service and Settings share the token handling. */
class NotifyApi(private val baseUrl: String, private val tokens: TokenSource, private val client: OkHttpClient = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build()) {
    private val json = Json { ignoreUnknownKeys = true }
    private val media = "application/json; charset=utf-8".toMediaType()

    private suspend fun call(method: String, path: String, body: JsonObject? = null, query: Map<String, String> = emptyMap(), replyToken: String? = null, bearer: Boolean = true): JsonObject = withContext(Dispatchers.IO) {
        val url = baseUrl.trimEnd('/').toHttpUrl().newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val b = Request.Builder().url(url).method(method, body?.toString()?.toRequestBody(media) ?: if (method == "GET") null else "{}".toRequestBody(media))
        if (bearer) tokens.get()?.let { b.header("Authorization", "Bearer $it") }
        if (replyToken != null) b.header("X-Foxfleet-Reply-Token", replyToken)
        val res = await(client.newCall(b.build()))
        res.use {
            it.header("X-Session-Token")?.takeIf { t -> t.isNotBlank() && tokens.get() != null }?.let(tokens::set)
            val text = it.body?.string().orEmpty()
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            if (!it.isSuccessful) throw NotifyHttpException(it.code, (obj?.get("error") as? JsonPrimitive)?.contentOrNull?.take(200) ?: "HTTP ${it.code}", NotifyRetryAfter.parse(it.header("Retry-After")), code = (obj?.get("code") as? JsonPrimitive)?.contentOrNull?.take(40))
            obj ?: throw NotifyHttpException(it.code, "Invalid response")
        }
    }

    private suspend fun await(call: Call): Response = suspendCancellableCoroutine { cont ->
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(NotifyHttpException(0, "The hub could not be reached", network = true)) }
            override fun onResponse(call: Call, response: Response) { if (cont.isActive) cont.resume(response) else response.close() }
        })
        cont.invokeOnCancellation { call.cancel() }
    }

    suspend fun prefs(): HubNotifyPrefs = HubNotifyPrefs.parse(call("GET", "/api/notify/prefs"))
    suspend fun setEnabled(enabled: Boolean): HubNotifyPrefs = HubNotifyPrefs.parse(call("PUT", "/api/notify/prefs", buildJsonObject { put("enabled", enabled) }))
    /** [forMs] null = until unmuted. [chat] null = the whole agent. */
    suspend fun mute(agent: String, chat: String?, muted: Boolean, forMs: Long? = null): HubNotifyPrefs =
        HubNotifyPrefs.parse(call("PUT", "/api/notify/mute", buildJsonObject { put("agent", agent); if (chat != null) put("chat", chat); put("muted", muted); if (muted && forMs != null) put("for_ms", forMs) }))
    /** `POST /api/notify/test`; the event's `muted` flag says whether the hub's master switch swallowed it. */
    suspend fun test(): NotifyEvent {
        val o = call("POST", "/api/notify/test", buildJsonObject { })
        return NotifyFrames.parseEvent(o["event"]?.jsonObject ?: throw NotifyHttpException(200, "Invalid response")) ?: throw NotifyHttpException(200, "Invalid response")
    }
    /** Phase 1 direct reply. Auth: the bearer and/or [replyToken]; [key] makes a retry safe (same key + same body = the first result). */
    suspend fun reply(agent: String, chat: String, text: String, key: String, replyToken: String?, bearer: Boolean): JsonObject =
        call("POST", "/api/notify/reply", buildJsonObject { put("agent", agent); put("chat", chat); put("text", text); put("idempotency_key", key); put("mark_read", true) }, replyToken = replyToken, bearer = bearer)
    /** The Mark-read action (newest message when [upTo] is null). */
    suspend fun read(agent: String, chat: String, upTo: Int?, replyToken: String?, bearer: Boolean): JsonObject =
        call("POST", "/api/notify/read", buildJsonObject { put("agent", agent); put("chat", chat); if (upTo != null) put("up_to", upTo) }, replyToken = replyToken, bearer = bearer)
    fun hasBearer() = tokens.get() != null
    suspend fun events(since: Long, limit: Int = 100): JsonObject = call("GET", "/api/notify/events", query = mapOf("since" to since.toString(), "limit" to limit.toString()))
}
