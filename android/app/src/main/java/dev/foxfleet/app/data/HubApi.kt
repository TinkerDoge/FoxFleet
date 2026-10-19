package dev.foxfleet.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class AuthRequiredException(message: String = "Login required") : Exception(message)
class HubApiException(val status: Int, message: String, val network: Boolean = false, val refused: Boolean = false, val code: String? = null) : Exception(scrubAddresses(message)) {
    /** A gateway or tunnel hiccup (502/503/504/52x, timeout, reset): never a verdict about the login or the request. */
    val transient: Boolean get() = network || (!refused && isTransientStatus(status))
}
fun isTransientStatus(s: Int) = s == 408 || s == 502 || s == 503 || s == 504 || s in 520..530
/** Exponential backoff with jitter: 0.5x..1x of base*2^n, capped. */
fun backoffMs(n: Int, base: Long = 400, cap: Long = 8000): Long = (minOf(cap, base shl minOf(n, 12)) * (0.5 + Math.random() / 2)).toLong()

/** Adds the active hub's bearer token and keeps a rotated token the hub hands back (X-Session-Token). */
private class BearerInterceptor(private val store: SettingsStore) : okhttp3.Interceptor {
    override fun intercept(chain: okhttp3.Interceptor.Chain): Response {
        val token = store.sessionToken
        val req = if (token != null) chain.request().newBuilder().header("Authorization", "Bearer $token").build() else chain.request()
        val res = chain.proceed(req)
        res.header("X-Session-Token")?.takeIf { it.isNotBlank() && token != null }?.let { store.sessionToken = it }
        return res
    }
}

class HubApi(private val store: SettingsStore) {

    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .addInterceptor(BearerInterceptor(store))
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // SSE: no read timeout; per-call timeouts below
        .build()

    private fun base(): HttpUrl {
        val url = store.baseUrl.toHttpUrlOrNull()
            ?: throw HubApiException(0, "Set the server address first")
        return url
    }

    private fun enc(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    private fun agentPath(name: String) = "/api/agents/" + enc(name)

    // ---- helpers ----

    private suspend fun await(call: Call): Response = suspendCancellableCoroutine { cont ->
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) {
                if (cont.isActive) cont.resumeWithException(HubApiException(0, "The hub could not be reached (${e.message})", network = true))
            }
            override fun onResponse(call: Call, response: Response) {
                if (cont.isActive) cont.resume(response)
            }
        })
        cont.invokeOnCancellation { call.cancel() }
    }

    private fun errorBody(response: Response): String = errorParts(response).first

    /** The hub's error text and, when it classified the failure itself, its stable code ("machine_offline", "display_unsupported", ...). */
    private fun errorParts(response: Response): Pair<String, String?> {
        val raw = runCatching { response.body?.string() }.getOrNull() ?: return "" to null
        return runCatching {
            val obj = json.parseToJsonElement(raw).jsonObject
            (obj["error"]?.jsonPrimitive?.content?.take(250) ?: raw.take(250)) to obj["code"]?.jsonPrimitive?.contentOrNull?.take(40)
        }.getOrNull() ?: (raw.take(250) to null)
    }

    private enum class Session { VALID, GONE, UNKNOWN }
    /** Asks the hub itself whether the login is still good. UNKNOWN (hub unreachable, 5xx) must never sign anyone out. */
    private suspend fun sessionState(): Session = try {
        val c = client.newCall(Request.Builder().url(base().newBuilder().encodedPath("/api/auth").build()).build()); c.timeout().timeout(10, TimeUnit.SECONDS)
        await(c).use { r ->
            if (r.code == 401) Session.GONE
            else if (!r.isSuccessful) Session.UNKNOWN
            else when (runCatching { json.parseToJsonElement(r.body?.string().orEmpty()).jsonObject.bool("authenticated") }.getOrNull()) { true -> Session.VALID; false -> Session.GONE; null -> Session.UNKNOWN }
        }
    } catch (e: CancellationException) { throw e } catch (_: Exception) { Session.UNKNOWN }

    /** What a 401 means. Only the hub saying "not authenticated" ends the session; a refusing agent or an unreachable hub never does. */
    private suspend fun unauthorized(message: String): Exception = when (sessionState()) {
        Session.GONE -> AuthRequiredException()
        Session.VALID -> HubApiException(502, message.ifEmpty { "The agent did not accept the hub's credentials" }, refused = true)
        Session.UNKNOWN -> HubApiException(0, "The hub could not be reached", network = true)
    }

    /** First retry delay for transient failures (tests shrink it). */
    internal var retryBaseMs = 400L

    /** Idempotent reads ride out a tunnel blip quietly (3 retries, backoff + jitter); writes are never replayed here. */
    private suspend fun request(path: String, method: String = "GET", body: String? = null, timeoutSec: Long = 30, query: Map<String, String> = emptyMap(), plain401: Boolean = false): JsonObject {
        var n = 0
        while (true) {
            try { return requestOnce(path, method, body, timeoutSec, query, plain401) }
            catch (e: HubApiException) {
                if (method != "GET" || !e.transient || n >= 3) throw e
                kotlinx.coroutines.delay(backoffMs(n++, retryBaseMs, 4000))
            }
        }
    }

    private suspend fun requestOnce(path: String, method: String, body: String?, timeoutSec: Long, query: Map<String, String>, plain401: Boolean): JsonObject {
        val url = base().newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val builder = Request.Builder().url(url).method(method, body?.toRequestBody(jsonMedia))
        val call = client.newCall(builder.build())
        call.timeout().timeout(timeoutSec, TimeUnit.SECONDS)
        val response = await(call)
        response.use {
            if (it.code == 401 && !plain401) throw unauthorized(errorBody(it))
            if (!it.isSuccessful) { val (msg, code) = errorParts(it); throw HubApiException(it.code, msg.ifEmpty { "Request failed (${it.code})" }, refused = code != null, code = code) } // a classified error is the hub's verdict: never retried, never "reconnecting"
            val contentType = it.header("Content-Type") ?: ""
            if (!contentType.contains("application/json")) throw HubApiException(0, "Invalid response from the relay")
            val text = it.body?.string() ?: ""
            return json.parseToJsonElement(text).jsonObject
        }
    }

    // ---- auth ----

    suspend fun authInfo(): AuthInfo = withContext(Dispatchers.IO) { parseAuthInfo(request("/api/auth", timeoutSec = 10)) }

    /** True when the address answers like an Foxfleet (used by the first-launch address screen). */
    suspend fun probeHub(): AuthInfo = authInfo()

    private suspend fun signIn(path: String, body: Map<String, String>): AuthInfo {
        store.sessionToken = null
        val payload = buildJsonObject { body.forEach { (k, v) -> put(k, v) }; put("client", "app"); put("deviceName", android.os.Build.MODEL ?: "Android") }.toString()
        val obj = request(path, "POST", payload, timeoutSec = 20, plain401 = true)
        store.sessionToken = obj["token"]?.jsonPrimitive?.contentOrNull ?: throw HubApiException(0, "The hub did not return a session")
        return AuthInfo(authenticated = true, username = obj["user"]?.jsonObject?.str("username"))
    }
    suspend fun login(username: String, password: String) = withContext(Dispatchers.IO) { signIn("/api/auth/login", mapOf("username" to username, "password" to password)) }
    suspend fun setup(username: String, password: String, code: String, acceptedTerms: String? = null) = withContext(Dispatchers.IO) { signIn("/api/auth/setup", buildMap { put("username", username); put("password", password); if (code.isNotBlank()) put("setupCode", code); if (acceptedTerms != null) put("acceptedTerms", acceptedTerms) }) }
    suspend fun register(username: String, password: String, invite: String, acceptedTerms: String? = null) = withContext(Dispatchers.IO) { signIn("/api/auth/register", buildMap { put("username", username); put("password", password); if (invite.isNotBlank()) put("invite", invite); if (acceptedTerms != null) put("acceptedTerms", acceptedTerms) }) }

    // ---- machines: one connector per computer, paired with a short-lived code ----
    suspend fun machines(): List<Machine> = withContext(Dispatchers.IO) { parseMachines(request("/api/machines")) }
    suspend fun createPairing(machineId: String? = null): Pairing = withContext(Dispatchers.IO) { parsePairing(request("/api/machines/pairing", "POST", if (machineId == null) "{}" else buildJsonObject { put("machineId", machineId) }.toString())) }
    suspend fun pairingStatus(code: String): PairingState = withContext(Dispatchers.IO) { parsePairingState(request("/api/machines/pairing?code=" + enc(code))) }
    suspend fun renameMachine(id: String, name: String) = withContext(Dispatchers.IO) { request("/api/machines/" + enc(id), "PATCH", buildJsonObject { put("name", name) }.toString()); Unit }
    suspend fun revokeMachine(id: String) = withContext(Dispatchers.IO) { request("/api/machines/" + enc(id), "DELETE"); Unit }
    suspend fun rotateMachine(id: String): Pairing = withContext(Dispatchers.IO) { parsePairing(request("/api/machines/" + enc(id) + "/token", "POST", "{}")) }

    // ---- admin (owner only) ----
    suspend fun registrationMode(): String = withContext(Dispatchers.IO) { request("/api/admin/settings")["registration"]?.jsonPrimitive?.contentOrNull ?: "closed" }
    suspend fun setRegistration(mode: String) = withContext(Dispatchers.IO) { request("/api/admin/settings", "PUT", buildJsonObject { put("registration", mode) }.toString()); Unit }
    suspend fun pairing(): Shareable = withContext(Dispatchers.IO) { parseShareable(request("/api/admin/pairing")) }
    suspend fun invites(): List<Invite> = withContext(Dispatchers.IO) { parseInvites(request("/api/admin/invites")) }
    suspend fun createInvite(): Shareable = withContext(Dispatchers.IO) { parseShareable(request("/api/admin/invites", "POST", "{}")) }
    suspend fun revokeInvite(id: String) = withContext(Dispatchers.IO) { request("/api/admin/invites/" + enc(id), "DELETE"); Unit }
    suspend fun adminUsers(): List<AdminUser> = withContext(Dispatchers.IO) { parseAdminUsers(request("/api/admin/users")) }
    suspend fun setUserDisabled(id: String, disabled: Boolean) = withContext(Dispatchers.IO) { request("/api/admin/users/" + enc(id), "PATCH", buildJsonObject { put("disabled", disabled) }.toString()); Unit }

    suspend fun logout() = withContext(Dispatchers.IO) {
        runCatching { request("/api/auth/logout", "POST", "{}") }
        store.sessionToken = null
        Unit
    }
    suspend fun logoutEverywhere() = withContext(Dispatchers.IO) { runCatching { request("/api/auth/logout-all", "POST", "{}") }; store.sessionToken = null; Unit }
    suspend fun devices(): List<Device> = withContext(Dispatchers.IO) { parseDevices(request("/api/auth/devices")) }
    suspend fun revokeDevice(id: String): Boolean = withContext(Dispatchers.IO) { request("/api/auth/devices/" + enc(id), "DELETE")["signedOut"]?.jsonPrimitive?.booleanOrNull ?: false }
    suspend fun changePassword(current: String, next: String) = withContext(Dispatchers.IO) {
        request("/api/auth/password", "POST", buildJsonObject { put("current", current); put("next", next) }.toString(), plain401 = true); Unit
    }

    // ---- fleet ----

    suspend fun agents(): List<AgentStatus> = withContext(Dispatchers.IO) {
        val obj = request("/api/agents", timeoutSec = 60)
        val arr = obj["agents"]?.jsonArray ?: throw HubApiException(0, "Invalid response from the relay")
        arr.map { parseAgent(it.jsonObject) }
    }

    /** Pin or unpin an agent for the signed-in user; pinned agents stay on top in the order they were pinned. */
    suspend fun pinAgent(agent: String, pinned: Boolean): Unit = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/pin", "PUT", buildJsonObject { put("pinned", pinned) }.toString()); Unit
    }

    // ---- agent registry (owner) ----

    suspend fun agentKinds(): List<AgentKind> = withContext(Dispatchers.IO) {
        parseKinds(request("/api/agent-kinds"))
    }

    suspend fun savedAgents(): List<SavedAgent> = withContext(Dispatchers.IO) {
        request("/api/connections")["connections"]?.jsonArray?.map { parseSaved(it.jsonObject) } ?: emptyList()
    }

    suspend fun addAgent(fields: Map<String, Any>): SaveResult = withContext(Dispatchers.IO) {
        val obj = request("/api/connections", "POST", jsonOf(fields))
        SaveResult(parseSaved(obj["connection"]!!.jsonObject))
    }

    suspend fun editAgent(name: String, fields: Map<String, Any>): SaveResult = withContext(Dispatchers.IO) {
        SaveResult(parseSaved(request("/api/connections/" + enc(name), "PUT", jsonOf(fields))["connection"]!!.jsonObject))
    }

    suspend fun deleteAgent(name: String) = withContext(Dispatchers.IO) { request("/api/connections/" + enc(name), "DELETE"); Unit }

    suspend fun reorderAgents(names: List<String>) = withContext(Dispatchers.IO) {
        request("/api/connections/order", "POST", buildJsonObject { putJsonArray("names") { names.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } }.toString()); Unit
    }

    /** Probes a draft without saving; when editing, the hub reuses the saved endpoint and secrets. */
    suspend fun testAgent(fields: Map<String, Any>): TestResult = withContext(Dispatchers.IO) {
        parseTest(request("/api/connections/test", "POST", jsonOf(fields), timeoutSec = 45))
    }

    // ---- group conversations (rooms): a separate account-scoped list, never folded into agents ----

    private fun convPath(id: String) = "/api/conversations/" + enc(id)

    suspend fun conversations(limit: Int = 50, offset: Int = 0): ConversationList = withContext(Dispatchers.IO) {
        val obj = request("/api/conversations", query = mapOf("limit" to "$limit", "offset" to "$offset"), timeoutSec = 30)
        val list = obj["conversations"]?.jsonArray?.mapNotNull { runCatching { it.jsonObject }.getOrNull()?.let(::parseConversation) }.orEmpty()
        ConversationList(list, obj["total"]?.jsonPrimitive?.intOrNull ?: list.size)
    }

    suspend fun conversation(id: String): Conversation = withContext(Dispatchers.IO) {
        parseConversation(request(convPath(id), timeoutSec = 30)) ?: throw HubApiException(0, "Invalid room response")
    }

    suspend fun createConversation(title: String, memberIds: List<String> = emptyList(), clientId: String? = null): Conversation = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("title", title)
            if (memberIds.isNotEmpty()) putJsonArray("member_ids") { memberIds.forEach { add(JsonPrimitive(it)) } }
            if (!clientId.isNullOrBlank()) put("client_id", clientId)
        }
        parseConversation(request("/api/conversations", "POST", body.toString(), timeoutSec = 30)) ?: throw HubApiException(0, "Invalid room response")
    }

    suspend fun renameConversation(id: String, title: String): Conversation = withContext(Dispatchers.IO) {
        parseConversation(request(convPath(id), "PATCH", buildJsonObject { put("title", title) }.toString(), timeoutSec = 30))
            ?: throw HubApiException(0, "Invalid room response")
    }

    suspend fun addConversationMember(id: String, agent: String): Conversation = withContext(Dispatchers.IO) {
        parseConversation(request(convPath(id) + "/members/" + enc(agent), "PUT", "{}", timeoutSec = 30))
            ?: throw HubApiException(0, "Invalid room response")
    }

    suspend fun removeConversationMember(id: String, agent: String): Conversation = withContext(Dispatchers.IO) {
        parseConversation(request(convPath(id) + "/members/" + enc(agent), "DELETE", timeoutSec = 30))
            ?: throw HubApiException(0, "Invalid room response")
    }

    /** Newest page first ([cursor] counts back from the newest); messages inside the page are chronological. */
    suspend fun conversationMessages(id: String, limit: Int = 50, offset: Int? = null, cursor: Int? = null): ConversationPage = withContext(Dispatchers.IO) {
        val query = buildMap {
            put("limit", "$limit")
            if (offset != null) put("offset", "$offset")
            if (cursor != null) put("cursor", "$cursor")
        }
        val obj = request(convPath(id) + "/messages", query = query, timeoutSec = 60)
        val messages = obj["messages"]?.jsonArray?.mapNotNull { runCatching { it.jsonObject }.getOrNull()?.let(::parseConversationMessage) }.orEmpty()
        ConversationPage(messages, obj["has_more"]?.jsonPrimitive?.booleanOrNull == true, obj["next_cursor"]?.jsonPrimitive?.intOrNull ?: messages.firstOrNull()?.seq,
            obj["total"]?.jsonPrimitive?.intOrNull ?: messages.size)
    }

    suspend fun conversationMessage(id: String, messageId: String): ConversationMessage = withContext(Dispatchers.IO) {
        parseConversationMessage(request(convPath(id) + "/messages/" + enc(messageId), timeoutSec = 30))
            ?: throw HubApiException(0, "Invalid room message")
    }

    /**
     * Send to a room. The hub binds the author to this sign-in: the body never carries an actor or an admit.
     * Mentions are the explicit spans the server validates; [replyTo] jumps to an earlier message.
     */
    suspend fun sendConversationMessage(
        id: String, text: String, mentions: List<ConversationMention> = emptyList(),
        replyTo: String? = null, media: List<String> = emptyList(), clientId: String? = null,
    ): Pair<ConversationMessage, List<String>> = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("text", text)
            if (mentions.isNotEmpty()) putJsonArray("mentions") {
                mentions.forEach { m -> add(buildJsonObject { put("kind", m.kind); put("id", m.id); put("offset", m.offset); put("length", m.length) }) }
            }
            if (!replyTo.isNullOrBlank()) put("reply_to", replyTo)
            if (media.isNotEmpty()) putJsonArray("media") { media.forEach { add(JsonPrimitive(it)) } }
            if (!clientId.isNullOrBlank()) put("client_id", clientId)
        }
        val obj = request(convPath(id) + "/messages", "POST", body.toString(), timeoutSec = 30)
        val message = parseConversationMessage(obj["message"]?.jsonObject ?: throw HubApiException(0, "Invalid room response"))
            ?: throw HubApiException(0, "Invalid room response")
        val dispatched = obj["dispatched_to"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
        message to dispatched
    }

    suspend fun markConversationRead(id: String, upTo: Int? = null): Conversation = withContext(Dispatchers.IO) {
        val body = if (upTo == null) "{}" else buildJsonObject { put("up_to", upTo) }.toString()
        parseConversation(request(convPath(id) + "/read", "POST", body, timeoutSec = 30)) ?: throw HubApiException(0, "Invalid room response")
    }

    suspend fun conversationPreferences(id: String, prefs: ConversationPreferences): ConversationPreferences = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("muted", prefs.muted); put("notify", prefs.notify); put("archived", prefs.archived)
            prefs.pinned?.let { put("pinned", it) }
        }
        parseConversationPreferences(request(convPath(id) + "/preferences", "PUT", body.toString(), timeoutSec = 30))
    }

    /** Owner Stop: cancels queued turns and asks the dispatch engine to stop live ones. */
    suspend fun stopConversation(id: String): ConversationStopResult = withContext(Dispatchers.IO) {
        val o = request(convPath(id) + "/stop", "POST", "{}", timeoutSec = 30)
        ConversationStopResult(
            stopped = o.bool("stopped") ?: false, confirmed = o.bool("confirmed") ?: false,
            state = o.str("state"), epoch = o["epoch"]?.jsonPrimitive?.longOrNull, paused = o.bool("paused"),
        )
    }

    suspend fun resumeConversation(id: String): Conversation = withContext(Dispatchers.IO) {
        parseConversation(request(convPath(id) + "/resume", "POST", "{}", timeoutSec = 30)) ?: throw HubApiException(0, "Invalid room response")
    }

    /** Upload one attachment over the same owner cookie/bearer; the id is referenced from a room message. */
    suspend fun uploadConversationMedia(id: String, name: String, mime: String?, size: Long, open: () -> java.io.InputStream, onProgress: (Float) -> Unit = {}): ConversationMedia = withContext(Dispatchers.IO) {
        if (size <= 0) throw HubApiException(0, "That file is empty")
        val body = object : okhttp3.RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = size
            override fun writeTo(sink: okio.BufferedSink) {
                open().use { input ->
                    val buf = ByteArray(64 * 1024); var sent = 0L
                    while (true) {
                        val n = input.read(buf); if (n < 0) break
                        sink.write(buf, 0, n); sent += n; onProgress((sent.toFloat() / size).coerceAtMost(1f))
                    }
                }
            }
        }
        val url = base().newBuilder().encodedPath(convPath(id) + "/media").build()
        val call = client.newCall(Request.Builder().url(url).post(body).header("X-Foxfleet-Name", name).build())
        call.timeout().timeout(10, TimeUnit.MINUTES)
        await(call).use {
            if (it.code == 401) throw unauthorized(errorBody(it))
            if (!it.isSuccessful) throw HubApiException(it.code, errorBody(it).ifEmpty { "Upload failed (${it.code})" })
            val obj = json.parseToJsonElement(it.body?.string() ?: "{}").jsonObject
            parseConversationMedia(obj, name) ?: throw HubApiException(0, "Invalid upload response")
        }
    }

    /** The authenticated media URL of a room attachment (the shared HTTP client adds the sign-in). */
    fun conversationMediaUrl(id: String, media: String): String = store.baseUrl.trimEnd('/') + convPath(id) + "/media/" + enc(media)

    // ---- sessions ----

    suspend fun sessions(agent: String, offset: Int = 0, limit: Int = 30, q: String = ""): SessionPage = withContext(Dispatchers.IO) {
        val obj = request(agentPath(agent) + "/sessions", query = buildMap { put("limit", "$limit"); put("offset", "$offset"); if (q.isNotBlank()) put("q", q) }, timeoutSec = 30)
        val arr = obj["sessions"]?.jsonArray ?: throw HubApiException(0, "Invalid response from the relay")
        val list = arr.mapNotNull { el ->
            val s = el.jsonObject; val id = s.str("id")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            SessionInfo(id, s.str("title"), s["updated"]?.jsonPrimitive?.longOrNull ?: 0L, s.str("preview").orEmpty(), s["messages"]?.jsonPrimitive?.intOrNull ?: 0)
        }
        SessionPage(list, obj["total"]?.jsonPrimitive?.intOrNull ?: list.size)
    }

    /** One page of a conversation; [offset] counts back from the newest message, the page itself is chronological. */
    suspend fun messages(agent: String, sessionId: String, offset: Int = 0, limit: Int = 80): HistoryPage = withContext(Dispatchers.IO) {
        val obj = request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/messages", query = mapOf("limit" to "$limit", "offset" to "$offset"), timeoutSec = 60)
        val arr = obj["messages"]?.jsonArray ?: throw HubApiException(0, "Invalid response from the relay")
        HistoryPage(arr.mapNotNull { historyMessage(it) }, obj["has_more"]?.jsonPrimitive?.booleanOrNull == true)
    }

    /** Reactions in one conversation. The hub binds the actor to this sign-in; we never send one. */
    suspend fun reactions(agent: String, sessionId: String): ReactionSnapshot = withContext(Dispatchers.IO) {
        parseReactions(request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/reactions"))
    }
    /** Idempotent: PUT adds this emoji once, DELETE removes it; repeating either changes nothing. */
    suspend fun react(agent: String, sessionId: String, messageId: String, emoji: String, present: Boolean): ReactionSnapshot = withContext(Dispatchers.IO) {
        parseReactions(request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/reactions", if (present) "PUT" else "DELETE",
            buildJsonObject { put("message_id", messageId); put("emoji", emoji) }.toString()))
    }
    /** Delete for me: hide (or show again) one message for this sign-in. Idempotent; the agent keeps it. */
    suspend fun hide(agent: String, sessionId: String, messageId: String, present: Boolean): ReactionSnapshot = withContext(Dispatchers.IO) {
        parseReactions(request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/hidden", if (present) "PUT" else "DELETE",
            buildJsonObject { put("message_id", messageId) }.toString()))
    }

    suspend fun renameSession(agent: String, id: String, title: String) = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/sessions/" + enc(id), "PATCH", buildJsonObject { put("title", title) }.toString()); Unit
    }
    suspend fun deleteSession(agent: String, id: String) = withContext(Dispatchers.IO) { request(agentPath(agent) + "/sessions/" + enc(id), "DELETE"); Unit }

    /** The hub sends normalised history (tool JSON, control tags and hidden rows already gone); anything odd is skipped. */
    internal fun historyMessage(el: kotlinx.serialization.json.JsonElement): UiMessage? {
        val m = runCatching { el.jsonObject }.getOrNull() ?: return null
        val role = m.str("role")?.takeIf { it == "user" || it == "assistant" } ?: return null
        val content = m.str("content").orEmpty(); val reasoning = m.str("reasoning").orEmpty()
        val steps = runCatching { m["tools"]?.jsonArray }.getOrNull()?.mapNotNull { t ->
            val o = runCatching { t.jsonObject }.getOrNull() ?: return@mapNotNull null
            ToolStep(o.str("name") ?: return@mapNotNull null, o.str("args").orEmpty(), o.str("result").orEmpty(), o.bool("ok"))
        }.orEmpty()
        val urls = runCatching { m["images"]?.jsonArray }.getOrNull()?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
        if (content.isEmpty() && reasoning.isEmpty() && urls.isEmpty()) return null // a tool-only step is diagnostics, not a message
        val id = runCatching { m["id"]?.jsonPrimitive?.takeIf { it !is JsonNull }?.content }.getOrNull()?.takeIf { it.isNotEmpty() }
        // phase 1 (readReceipts): additive fields, absent on older hubs
        val hubId = m.str("hub_id")?.takeIf { it.isNotEmpty() }; val n = m["n"]?.jsonPrimitive?.longOrNull?.toInt()
        val status = m.str("status")?.takeIf { role == "user" && it in dev.foxfleet.app.data.live.MessageStatus.ALL }
        return UiMessage(role = role, content = content, id = id, reasoning = reasoning, steps = steps, ts = m["ts"]?.jsonPrimitive?.longOrNull ?: 0L, imageUrls = urls, hubId = hubId, n = n, status = status,
            reactionOnly = role == "assistant" && m.bool("reaction_only") == true)
    }

    private fun contentToString(value: kotlinx.serialization.json.JsonElement?): String {
        if (value == null || value is JsonNull) return ""
        return runCatching { value.jsonPrimitive.content }.getOrElse {
            runCatching { value.jsonArray.joinToString("") { part -> part.jsonObject["text"]?.jsonPrimitive?.content ?: "" } }.getOrDefault("")
        }
    }

    /** Skill names for the # / slash autocomplete. Best effort: empty on any failure. */
    suspend fun skills(agent: String): List<String> = withContext(Dispatchers.IO) {
        runCatching {
            val obj = request(agentPath(agent) + "/skills", timeoutSec = 20)
            val arr = obj["skills"]?.jsonArray ?: obj["data"]?.jsonArray ?: return@runCatching emptyList()
            arr.mapNotNull { el ->
                runCatching { el.jsonObject["name"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                    ?: runCatching { el.jsonPrimitive.contentOrNull }.getOrNull()
            }.filter { it.isNotBlank() }.distinct().take(200)
        }.getOrElse { if (it is AuthRequiredException) throw it; emptyList() }
    }

    // ---- files (streamed to the agent's disk) ----

    /**
     * Streams [size] bytes from [open] to POST /api/agents/{name}/files (application/octet-stream).
     * The hub forwards them as a chunked multipart upload into the agent's managed files.
     */
    suspend fun uploadFile(agent: String, name: String, mime: String?, size: Long, open: () -> java.io.InputStream, onProgress: (Float) -> Unit = {}): FileRef = withContext(Dispatchers.IO) {
        if (size <= 0) throw HubApiException(0, "That file is empty")
        if (size > FileMarker.MAX_BYTES) throw HubApiException(413, "Files can be up to ${FileMarker.MAX_BYTES / 1048576} MB")
        val body = object : okhttp3.RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = size
            override fun writeTo(sink: okio.BufferedSink) {
                open().use { input ->
                    val buf = ByteArray(64 * 1024); var sent = 0L
                    while (true) { val n = input.read(buf); if (n < 0) break; sink.write(buf, 0, n); sent += n; onProgress((sent.toFloat() / size).coerceAtMost(1f)) }
                }
            }
        }
        val url = base().newBuilder().encodedPath(agentPath(agent) + "/files")
            .addQueryParameter("name", name).apply { if (!mime.isNullOrBlank()) addQueryParameter("type", mime) }.build()
        val call = client.newCall(Request.Builder().url(url).post(body).build())
        call.timeout().timeout(10, TimeUnit.MINUTES)
        await(call).use {
            if (it.code == 401) throw unauthorized(errorBody(it))
            if (!it.isSuccessful) throw HubApiException(it.code, errorBody(it).ifEmpty { "Upload failed (${it.code})" })
            val obj = json.parseToJsonElement(it.body?.string() ?: "{}").jsonObject
            FileRef(obj["name"]?.jsonPrimitive?.contentOrNull ?: name, obj["path"]?.jsonPrimitive?.contentOrNull ?: throw HubApiException(0, "Invalid upload response"), size)
        }
    }

    // ---- Bot Screen ----

    suspend fun screen(agent: String, action: String): JsonObject = withContext(Dispatchers.IO) {
        if (action == "status") request(agentPath(agent) + "/screen/status", timeoutSec = 30)
        else request(agentPath(agent) + "/screen/" + action, "POST", "{}", timeoutSec = if (action == "start" || action == "restart") 95 else 45)
    }

    fun parseScreen(obj: JsonObject) = ScreenStatus(
        running = obj["running"]?.jsonPrimitive?.booleanOrNull ?: false,
        supported = obj["supported"]?.jsonPrimitive?.booleanOrNull ?: true,
        state = obj["state"]?.jsonPrimitive?.contentOrNull,
        missing = obj["missing"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
        holder = runCatching { obj["lease"]?.jsonObject?.get("holder")?.jsonPrimitive?.contentOrNull }.getOrNull(),
        blocker = obj["blocker"]?.jsonPrimitive?.contentOrNull,
    )

    /** wss://hub/api/agents/{name}/screen/ws?ticket=… for the noVNC page (ticket: single use, 30 s). */
    fun screenSocketUrl(agent: String, ticket: String): String {
        val url = base().newBuilder().encodedPath(agentPath(agent) + "/screen/ws").addQueryParameter("ticket", ticket).build().toString()
        return url.replaceFirst(Regex("^http"), "ws")
    }

    val baseUrl: String get() = store.baseUrl

    /** Shared client so Coil/Media3 can load hub-authenticated media with the owner cookie. */
    val httpClient: OkHttpClient get() = client

    // ---- chat (SSE) ----

    /** Callbacks for one streamed reply. [onRun] gets the hub's run id (the reply keeps running on the hub if we disconnect). */
    class StreamCallbacks(
        val onContent: (String) -> Unit, val onReasoning: (String) -> Unit, val onTool: (String) -> Unit,
        val onSession: (String) -> Unit, val onRun: (String) -> Unit = {}, val onGap: () -> Unit = {}, val onRunState: (String) -> Unit = {},
        val onRequest: (OpenRequest) -> Unit = {}, val onRequestClosed: (String, String) -> Unit = { _, _ -> }, val onAck: (String, String) -> Unit = { _, _ -> },
        val onReconnecting: () -> Unit = {},
        /** Per-call tool lifecycle (start/progress/end with turn and call ids) from hubs that send it; [onTool] stays for older ones. */
        val onToolEvent: (ToolEvent) -> Unit = {},
        val onReplace: (String) -> Unit = {},
        /** 0.4.1 hubs: `foxfleet.step` commentary / status / sub-agent lines (kind, text, level). */
        val onStep: (String, String, String?) -> Unit = { _, _, _ -> },
        /** 0.4.2 hubs: `foxfleet.reasoning` carries the whole thinking so far — replace, never append. */
        val onReasoningSnapshot: (String) -> Unit = {},
    )

    /**
     * Streams a chat turn. Returns the full assistant text. If the connection drops mid-reply the stream is resumed from
     * the last event id (the hub keeps the agent run alive and buffers events), a few tries with backoff.
     */
    suspend fun chat(
        agent: String,
        history: List<UiMessage>,
        sessionId: String?,
        onContent: (String) -> Unit,
        onReasoning: (String) -> Unit,
        onTool: (String) -> Unit,
        onSession: (String) -> Unit,
        onRun: (String) -> Unit = {},
        onGap: () -> Unit = {},
        onRequest: (OpenRequest) -> Unit = {},
        onRequestClosed: (String, String) -> Unit = { _, _ -> },
        onAck: (String, String) -> Unit = { _, _ -> },
        onReconnecting: () -> Unit = {},
        onToolEvent: (ToolEvent) -> Unit = {},
        onReplace: (String) -> Unit = {},
        onStep: (String, String, String?) -> Unit = { _, _, _ -> },
        onRunState: (String) -> Unit = {},
        onReasoningSnapshot: (String) -> Unit = {},
    ): String = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("model", "hermes-agent")
            put("stream", true)
            if (!sessionId.isNullOrBlank()) put("session_id", sessionId)
            put("messages", ChatPayload.messages(history))
        }.toString()
        val url = base().newBuilder().encodedPath(agentPath(agent) + "/chat").build()
        val response = await(client.newCall(Request.Builder().url(url).post(payload.toRequestBody(jsonMedia)).build()))
        pump(agent, response, StreamCallbacks(onContent, onReasoning, onTool, onSession, onRun, onGap, onRequest = onRequest, onRequestClosed = onRequestClosed, onAck = onAck, onReconnecting = onReconnecting, onToolEvent = onToolEvent, onReplace = onReplace, onStep = onStep, onRunState = onRunState, onReasoningSnapshot = onReasoningSnapshot), null, 0)
    }

    /** Reattach to a run after a restart or a lost connection; replays from [after] (0 = the whole reply so far). */
    suspend fun follow(agent: String, run: String, after: Int, cb: StreamCallbacks): String = withContext(Dispatchers.IO) {
        val first = try { openEvents(agent, run, after) } catch (e: HubApiException) { if (!e.transient) throw e; null }
        val res = if (first != null && !isTransientStatus(first.code)) first else { first?.close(); reopen(agent, run, after, cb, 0) ?: return@withContext "" }
        pump(agent, res, cb, run, after)
    }

    /**
     * Opens the run's event stream again from the cursor, retrying through tunnel faults with backoff and jitter (about three minutes).
     * Null when the hub says the run is gone; throws on cancellation, sign-out or giving up.
     */
    private suspend fun reopen(agent: String, run: String, cursor: Int, cb: StreamCallbacks, start: Int): Response? {
        var n = start
        while (true) {
            if (n >= 14) throw HubApiException(0, "Lost the connection to the hub", network = true)
            cb.onReconnecting(); kotlinx.coroutines.delay(backoffMs(n, (retryBaseMs * 5) / 4, 15000)); n++
            val r = try { openEvents(agent, run, cursor) } catch (e: CancellationException) { throw e } catch (e: HubApiException) { if (!e.transient) throw e; continue }
            when {
                r.code == 404 -> { r.close(); return null }
                r.code == 401 -> { val ex = r.use { unauthorized(errorBody(it)) }; if (ex is AuthRequiredException) throw ex; if ((ex as? HubApiException)?.network == true) continue; return null }
                isTransientStatus(r.code) -> { r.close(); continue }
                else -> return r
            }
        }
    }

    /** Live chat events (hub feature `live`): its own client, read timeout = 3 missed heartbeats so a dead link reconnects. */
    private val liveClient by lazy { client.newBuilder().readTimeout(LiveStreamRunner.READ_TIMEOUT_SEC, TimeUnit.SECONDS).build() }
    val liveTransport = LiveTransport { cursor, cancel ->
        val url = base().newBuilder().encodedPath("/api/live/stream").build()
        val req = Request.Builder().url(url).get().header("Accept", "text/event-stream").apply { if (!cursor.isNullOrBlank()) header("Last-Event-ID", cursor) }.build()
        val call = liveClient.newCall(req)
        cancel.onCancel { call.cancel() } // backgrounded while connecting: abort now, not at the next heartbeat
        val r = call.execute()
        if (r.code == 401) { r.close(); return@LiveTransport LiveOpen(401, null, null) }
        LiveOpen(r.code, r.header("Content-Type"), r.body?.byteStream()?.let { java.io.InputStreamReader(it, Charsets.UTF_8) }) { call.cancel(); r.close() }
    }

    /** v2 stream (`live2`): `?v=2&since=<cursor>` plus `Last-Event-ID` (the query wins on the hub; both say the same). */
    val liveV2Transport: (String?, LiveCancel) -> LiveOpen = { cursor, cancel ->
        val url = base().newBuilder().encodedPath("/api/live/stream").addQueryParameter("v", "2").apply { if (!cursor.isNullOrBlank()) addQueryParameter("since", cursor) }.build()
        val req = Request.Builder().url(url).get().header("Accept", "text/event-stream").apply { if (!cursor.isNullOrBlank()) header("Last-Event-ID", cursor) }.build()
        val call = liveClient.newCall(req)
        cancel.onCancel { call.cancel() }
        val r = call.execute()
        if (r.code == 401) { r.close(); LiveOpen(401, null, null) }
        else LiveOpen(r.code, r.header("Content-Type"), r.body?.byteStream()?.let { java.io.InputStreamReader(it, Charsets.UTF_8) }) { call.cancel(); r.close() }
    }

    // ---- phase 1 (0.4.0): chat list, read receipts (routes answer 404 until hub.features lists them) ----

    private fun chatPath(agent: String) = "/api/chats/" + enc(agent)
    /** `GET /api/chats?archived=0|1`: rows + the v2 cursor this snapshot matches. */
    suspend fun chats(archived: Boolean = false): dev.foxfleet.app.data.live.ChatsSnapshot = withContext(Dispatchers.IO) {
        dev.foxfleet.app.data.live.Contract.snapshot(request("/api/chats", query = mapOf("archived" to if (archived) "1" else "0"), timeoutSec = 20))
    }
    suspend fun archiveChat(agent: String, archived: Boolean): dev.foxfleet.app.data.live.HubChat = withContext(Dispatchers.IO) {
        dev.foxfleet.app.data.live.Contract.chat(request(chatPath(agent) + "/archive", "PUT", buildJsonObject { put("archived", archived) }.toString(), timeoutSec = 15))
            ?: throw HubApiException(0, "Invalid response from the relay")
    }
    suspend fun markChatUnread(agent: String, unread: Boolean): dev.foxfleet.app.data.live.HubChat = withContext(Dispatchers.IO) {
        dev.foxfleet.app.data.live.Contract.chat(request(chatPath(agent) + "/unread", "PUT", buildJsonObject { put("unread", unread) }.toString(), timeoutSec = 15))
            ?: throw HubApiException(0, "Invalid response from the relay")
    }
    /** Read receipts: `{chat, up_to}` or every session (`all`). Idempotent and monotonic on the hub. */
    suspend fun markChatRead(agent: String, chat: String?, upTo: Int?): dev.foxfleet.app.data.live.ReadState = withContext(Dispatchers.IO) {
        val body = buildJsonObject { if (chat == null) put("all", true) else { put("chat", chat); if (upTo != null) put("up_to", upTo) } }
        dev.foxfleet.app.data.live.Contract.read(request(chatPath(agent) + "/read", "POST", body.toString(), timeoutSec = 15))
    }
    /** Cache catch-up: messages after number [afterN], oldest first. */
    suspend fun messagesAfter(agent: String, sessionId: String, afterN: Int, limit: Int = 80): HistoryPage = withContext(Dispatchers.IO) {
        val obj = request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/messages", query = mapOf("after_n" to "$afterN", "limit" to "$limit"), timeoutSec = 60)
        val arr = obj["messages"]?.jsonArray ?: throw HubApiException(0, "Invalid response from the relay")
        HistoryPage(arr.mapNotNull { historyMessage(it) }, obj["has_more"]?.jsonPrimitive?.booleanOrNull == true)
    }
    /** `PUT /api/notify/mute` for a whole agent (the chat list's mute). [forMs] null = until unmuted. */
    suspend fun muteAgent(agent: String, muted: Boolean, forMs: Long? = null): Unit = withContext(Dispatchers.IO) {
        request("/api/notify/mute", "PUT", buildJsonObject { put("agent", agent); put("muted", muted); if (muted && forMs != null) put("for_ms", forMs) }.toString(), timeoutSec = 15); Unit
    }

    private suspend fun openEvents(agent: String, run: String, after: Int): Response {
        val url = base().newBuilder().encodedPath(agentPath(agent) + "/runs/" + enc(run) + "/events").addQueryParameter("after", after.toString()).build()
        return await(client.newCall(Request.Builder().url(url).get().build()))
    }

    suspend fun runs(agent: String, session: String?): List<RunInfo> = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/runs", query = if (session.isNullOrBlank()) emptyMap() else mapOf("session_id" to session), timeoutSec = 15)["runs"]?.jsonArray?.mapNotNull { e ->
            val o = e.jsonObject; val id = o.str("id") ?: return@mapNotNull null
            RunInfo(id, o.str("session_id"), o.str("state") ?: "done", o["started"]?.jsonPrimitive?.longOrNull ?: 0L)
        } ?: emptyList()
    }

    /** The explicit Stop button: cancels the agent run itself. Just closing the app never does. */
    /** A file or picture the agent mentioned with MEDIA: -> a short-lived link for this user (the hub fetches it from the agent's machine). */
    suspend fun media(agent: String, ref: String): MediaLink = withContext(Dispatchers.IO) {
        val r = request(agentPath(agent) + "/media", "POST", buildJsonObject { put("ref", ref) }.toString())
        val path = r["url"]?.jsonPrimitive?.contentOrNull ?: throw HubApiException(502, "Invalid media reply")
        if (!path.startsWith("/api/media/")) throw HubApiException(502, "Invalid media reply")
        val kind = when (r["kind"]?.jsonPrimitive?.contentOrNull) { "image" -> "image"; "video" -> "video"; "audio" -> "audio"; else -> "file" }
        MediaLink(store.baseUrl.trimEnd('/') + path, kind, r["name"]?.jsonPrimitive?.contentOrNull ?: "file")
    }

    /** Delete this media for everyone (0.4.3): the hub forgets the offer. Throws on failure, including 404 (already gone). */
    suspend fun deleteMedia(agent: String, ref: String): Unit = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/media", "DELETE", buildJsonObject { put("ref", ref) }.toString())
    }

    /** First byte of a media link, to learn WHY a card cannot load. Null when it works; otherwise what the hub said. */
    suspend fun mediaDiagnose(url: String): dev.foxfleet.app.ui.components.HubFailure? = withContext(Dispatchers.IO) {
        try {
            val call = client.newCall(Request.Builder().url(url).header("Range", "bytes=0-0").build()); call.timeout().timeout(40, TimeUnit.SECONDS)
            await(call).use { r ->
                if (r.isSuccessful) return@withContext null
                val (msg, code) = errorParts(r)
                dev.foxfleet.app.ui.components.HubFailure(r.code, code, msg)
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { dev.foxfleet.app.ui.components.HubFailure(network = true) }
    }

    suspend fun stopRun(agent: String, run: String) = withContext(Dispatchers.IO) { request(agentPath(agent) + "/runs/" + enc(run) + "/stop", "POST", "{}"); Unit }

    /** A message the hub holds for a conversation: queued, waiting for a stop, or guidance accepted by the run. */
    /** [ack] is what Hermes itself answered (queued / steered / redirected / rejected / streaming); null until it did. Shown as received, never predicted. */
    data class QueuedMessage(val id: String, val state: String, val mode: String, val text: String, val error: String? = null, val note: String? = null, val runId: String? = null, val ack: String? = null)
    data class RequestQuestion(val id: String, val question: String, val choices: List<String>, val multi: Boolean)
    /** A question or an approval the agent waits on (native sessions). Answered once, by [id]. */
    data class OpenRequest(val id: String, val kind: String, val questions: List<RequestQuestion> = emptyList(), val command: String? = null, val description: String? = null)
    data class QueueState(val items: List<QueuedMessage>, val halted: Boolean, val activeRun: String?, val modes: List<String>, val openRequests: List<OpenRequest> = emptyList(), val canCancel: Boolean = true)
    data class ModelProvider(val slug: String, val name: String, val models: List<String>, val current: Boolean)
    data class SendResult(val message: QueuedMessage, val runId: String?, val sessionId: String?)

    private fun queued(o: JsonObject) = QueuedMessage(o.str("id").orEmpty(), o.str("state") ?: "queued", o.str("mode") ?: "queue", o.str("text").orEmpty(), o.str("error"), o.str("note"), o.str("run_id"), o.str("ack")?.takeIf { it in ACKS })
    private fun queueState(o: JsonObject) = QueueState(
        o["items"]?.let { runCatching { it.jsonArray.map { e -> queued(e.jsonObject) } }.getOrNull() } ?: emptyList(), o.bool("halted") ?: false, o.str("active_run"),
        o["modes"]?.let { runCatching { it.jsonArray.map { e -> e.jsonPrimitive.content } }.getOrNull() } ?: emptyList(),
        o["open_requests"]?.let { runCatching { it.jsonArray.mapNotNull { e -> parseRequest(e.jsonObject) } }.getOrNull() } ?: emptyList(), o.bool("can_cancel") ?: true,
    )

    /** Send while the agent may be replying. The hub stores and acknowledges it first; [mode] says what to do if it is busy (queue / steer / interrupt). */
    suspend fun sendMessage(agent: String, userMessage: UiMessage, sessionId: String?, mode: String, clientId: String): SendResult = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("model", "hermes-agent"); put("mode", mode); put("client_id", clientId)
            if (!sessionId.isNullOrBlank()) put("session_id", sessionId)
            put("messages", ChatPayload.messages(listOf(userMessage)))
        }.toString()
        val o = request(agentPath(agent) + "/messages", "POST", body)
        SendResult(queued(o["message"]!!.jsonObject), o.str("run_id"), o.str("session_id"))
    }
    suspend fun queue(agent: String, session: String?): QueueState = withContext(Dispatchers.IO) {
        queueState(request(agentPath(agent) + "/queue", query = if (session.isNullOrBlank()) emptyMap() else mapOf("session_id" to session), timeoutSec = 15))
    }
    /** Answer an open question or approval, once. A 404 means it was already closed (answered elsewhere or cancelled): the caller just drops the card. */
    suspend fun answerRequest(agent: String, session: String, id: String, result: JsonObject) = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/native/sessions/" + enc(session) + "/requests/" + enc(id), "POST", buildJsonObject { put("result", result) }.toString(), timeoutSec = 20); Unit
    }
    suspend fun models(agent: String): List<ModelProvider> = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/native/models", timeoutSec = 30)["providers"]?.jsonArray?.mapNotNull { e ->
            val o = e.jsonObject; val slug = o.str("slug") ?: return@mapNotNull null
            ModelProvider(slug, o.str("name") ?: slug, o["models"]?.jsonArray?.mapNotNull { m -> m.jsonPrimitive.contentOrNull } ?: emptyList(), o.bool("current") ?: false)
        } ?: emptyList()
    }
    /** 0.4.1 hubs, any Hermes agent: `GET /api/agents/{name}/models` ({mode, providers, override?}). */
    suspend fun agentModels(agent: String, session: String?): List<ModelProvider> = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/models", query = if (session != null) mapOf("session_id" to session) else emptyMap(), timeoutSec = 30)["providers"]?.let { runCatching { it.jsonArray }.getOrNull() }?.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null; val slug = o.str("slug") ?: return@mapNotNull null
            ModelProvider(slug, o.str("name") ?: slug, (o["models"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { m -> (m as? JsonPrimitive)?.contentOrNull } ?: emptyList(), o.bool("current") ?: false)
        } ?: emptyList()
    }
    /** `models: request`: the hub keeps this chat's model and sends it with each new run. */
    suspend fun setChatModel(agent: String, session: String, model: String, provider: String?): String = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/sessions/" + enc(session) + "/model", "POST", buildJsonObject { put("model", model); if (!provider.isNullOrBlank()) put("provider", provider) }.toString(), timeoutSec = 20)
        "Model for this chat: $model"
    }
    /** Session-scoped: this conversation only. The profile default is never touched from here. */
    /** Hermes did NOT switch: the model is guarded (e.g. very expensive) and needs the user's confirmation, sent by calling [setModel] again with confirm = true. */
    class ModelConfirmRequired(val reason: String) : Exception(reason)
    suspend fun setModel(agent: String, session: String, model: String, provider: String?, confirm: Boolean = false): String = withContext(Dispatchers.IO) {
        val value = if (provider.isNullOrBlank()) model else "$model --provider $provider"
        val r = request(agentPath(agent) + "/native/sessions/" + enc(session) + "/model", "POST", buildJsonObject { put("model", value); if (confirm) put("confirm", true) }.toString(), timeoutSec = 30)
        if (r.bool("confirm_required") == true) throw ModelConfirmRequired(r.str("confirm_message") ?: "Hermes asks you to confirm this model before it switches.")
        "Model for this chat: $model"
    }
    suspend fun profileBusy(agent: String): String = withContext(Dispatchers.IO) { request(agentPath(agent) + "/native/busy", timeoutSec = 15).str("mode").orEmpty() }
    suspend fun setProfileBusy(agent: String, mode: String) = withContext(Dispatchers.IO) { request(agentPath(agent) + "/native/busy", "POST", buildJsonObject { put("mode", mode); put("confirm", true) }.toString(), timeoutSec = 15); Unit }
    suspend fun resumeQueue(agent: String, session: String?): QueueState = withContext(Dispatchers.IO) {
        queueState(request(agentPath(agent) + "/queue/resume", "POST", "{}", query = if (session.isNullOrBlank()) emptyMap() else mapOf("session_id" to session), timeoutSec = 15))
    }
    suspend fun cancelQueued(agent: String, id: String, session: String?) = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/queue/" + enc(id), "DELETE", query = if (session.isNullOrBlank()) emptyMap() else mapOf("session_id" to session), timeoutSec = 15); Unit
    }
    /** The hub's per-agent command catalog (JSON text), parsed by [dev.foxfleet.app.ui.chat.HermesCatalog.parseDefs]. */
    suspend fun commandsJson(agent: String): String = withContext(Dispatchers.IO) { request(agentPath(agent) + "/commands", timeoutSec = 15).toString() }

    private suspend fun pump(agent: String, first: Response, cb: StreamCallbacks, knownRun: String?, from: Int): String {
        var res = first; var run = knownRun; var last = from; var attempts = 0
        val builder = StringBuilder()
        while (true) {
            var finished = false; var progressed = false
            res.use {
                if (it.code == 401) throw unauthorized(errorBody(it))
                if (!it.isSuccessful) throw HubApiException(it.code, errorBody(it).ifEmpty { "Chat failed (${it.code})" })
                if (!(it.header("Content-Type") ?: "").contains("text/event-stream")) throw HubApiException(0, "Invalid reply stream")
                it.header("X-Hermes-Session-Id")?.let { id -> if (id.matches(Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}"))) cb.onSession(id) }
                it.header("X-Foxfleet-Run")?.let { r -> if (r != run) { run = r; cb.onRun(r) } }
                val parser = SseParser(onEvent = { e ->
                    e.id?.toIntOrNull()?.let { n -> if (n > last) { last = n; progressed = true } }
                    when {
                        e.data == "[DONE]" -> { finished = true; false }
                        e.event == "foxfleet.replace" -> {
                            val text = runCatching { json.parseToJsonElement(e.data).jsonObject["text"] as? JsonPrimitive }.getOrNull()?.takeIf { it.isString }?.content
                            if (text != null) { builder.setLength(0); builder.append(text); cb.onReplace(text) }
                            true
                        }
                        // The turn's thinking (0.4.2 hub + plugin): the whole text so far. The screen
                        // replaces its live ReasoningBlock, so replays and revisions converge.
                        e.event == "foxfleet.reasoning" -> {
                            runCatching { json.parseToJsonElement(e.data).jsonObject["text"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                                ?.let(cb.onReasoningSnapshot)
                            true
                        }
                        e.event == "foxfleet.gap" -> { builder.setLength(0); cb.onGap(); true }
                        e.event == "foxfleet.run" -> { runCatching { json.parseToJsonElement(e.data).jsonObject["state"]?.jsonPrimitive?.contentOrNull }.getOrNull()?.let(cb.onRunState); finished = true; false } // stopped or failed on the hub
                        e.event == "foxfleet.request" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let(::parseRequest)?.let(cb.onRequest); true }
                        e.event == "foxfleet.request_closed" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let { v -> v.str("request_id")?.let { id -> cb.onRequestClosed(id, v.str("reason") ?: "closed") } }; true }
                        e.event == "foxfleet.tool" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let(::toolEvent)?.let(cb.onToolEvent); true }
                        e.event == "foxfleet.step" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let { v -> val k = v.str("kind"); val t = v.str("text"); if (k != null && t != null) cb.onStep(k, t, v.str("level")) }; true }
                        e.event == "foxfleet.ack" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let { v -> val a = v.str("ack"); if (a != null && a in ACKS) cb.onAck(v.str("message_id").orEmpty(), a) }; true }
                        e.event == "error" -> throw HubApiException(0, "The agent reply failed. Check the agent and try again.")
                        else -> {
                            val value = runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()
                            if (value == null) true
                            else if (value.containsKey("error")) throw HubApiException(0, "The agent reply failed. Check the agent and try again.")
                            else if (e.event == "hermes.tool.progress") {
                                cb.onTool(value["tool"]?.jsonPrimitive?.contentOrNull ?: value["name"]?.jsonPrimitive?.contentOrNull ?: "tool"); true
                            } else {
                                val choices = runCatching { value["choices"]?.jsonArray }.getOrNull()
                                if (choices != null) for (choice in choices) {
                                    val delta = runCatching { choice.jsonObject["delta"]?.jsonObject }.getOrNull() ?: continue
                                    delta["content"]?.jsonPrimitive?.contentOrNull?.let { text -> if (text.isNotEmpty()) { builder.append(text); cb.onContent(text) } }
                                    delta["reasoning_content"]?.jsonPrimitive?.contentOrNull?.let { text -> if (text.isNotEmpty()) cb.onReasoning(text) }
                                }
                                true
                            }
                        }
                    }
                })
                val reader = InputStreamReader(it.body?.byteStream() ?: throw HubApiException(0, "Invalid reply stream"), Charsets.UTF_8)
                val chars = CharArray(8192)
                try {
                    while (!parser.isStopped) {
                        val n = reader.read(chars)
                        if (n < 0) break
                        if (n > 0) { parser.feed(String(chars, 0, n)); kotlin.coroutines.coroutineContext.ensureActive() }
                    }
                    parser.end()
                } catch (e: CancellationException) { throw e } catch (e: HubApiException) { throw e } catch (e: java.io.IOException) {
                    // connection dropped: fall through and resume below
                } finally { runCatching { reader.close() } }
            }
            val r = run
            if (finished || r == null) return builder.toString()
            attempts = if (progressed) 0 else attempts + 1 // a stream that delivered something restarts the patience budget
            res = reopen(agent, r, last, cb, attempts) ?: return builder.toString() // the run is gone for good: keep what we have
        }
    }

    companion object {
        private val parser = Json { ignoreUnknownKeys = true }

        internal val ACKS = setOf("streaming", "queued", "steered", "redirected", "rejected")
        internal val TOOL_EVENTS = setOf("tool.start", "tool.progress", "tool.end")
        /** `foxfleet.tool` (lenient: unknown fields ignored, wrong types dropped). */
        internal fun toolEvent(v: JsonObject): ToolEvent? {
            fun s(k: String) = (v[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val type = s("type")?.takeIf { it in TOOL_EVENTS } ?: return null; val name = s("name") ?: return null
            val ok = (v["ok"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            val ms = (v["duration_ms"] as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }?.takeIf { it >= 0 }
            // an end's preview is its result (as on run.step): it never replaces the start's arguments
            return if (type == "tool.end") ToolEvent(type, s("turn_id"), s("tool_id"), name, null, ok, ms, s("result_preview") ?: s("preview"))
            else ToolEvent(type, s("turn_id"), s("tool_id"), name, s("preview"), ok, ms, s("result_preview"))
        }

        /** The hub's reaction snapshot; anything malformed is skipped rather than failing the chat. */
        fun parseReactions(o: JsonObject): ReactionSnapshot {
            fun actor(v: JsonObject?): ReactionActor? { val id = v?.str("id") ?: return null; return ReactionActor(id, v.str("name") ?: id, if (v.str("kind") == "agent") "agent" else "human") }
            val me = actor(runCatching { o["actor"]?.jsonObject }.getOrNull()) ?: ReactionActor("", "You", "human")
            val msgs = runCatching { o["messages"]?.jsonObject }.getOrNull().orEmpty().mapValues { (_, groups) -> parseGroups(groups) }.filterValues { it.isNotEmpty() }
            // null = a hub older than 0.3.9 (no "hidden" field): Delete for me is not offered
            val hidden = runCatching { o["hidden"]?.jsonArray }.getOrNull()?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }?.toSet()
            // 0.4.1 (`reactionEvents`): the same reactions keyed by hub id; null on older hubs
            val byHub = runCatching { o["by_hub_id"]?.jsonObject }.getOrNull()?.mapValues { (_, groups) -> parseGroups(groups) }?.filterValues { it.isNotEmpty() }
            return ReactionSnapshot(me, msgs, hidden, byHub)
        }
        private fun reactionActor(v: JsonObject?): ReactionActor? { val id = v?.str("id") ?: return null; return ReactionActor(id, v.str("name") ?: id, if (v.str("kind") == "agent") "agent" else "human") }
        /** `ReactionGroup[]` (snapshot, `message.reaction`, a message's `reactions`); malformed groups and actor-less groups are dropped. */
        fun parseGroups(groups: kotlinx.serialization.json.JsonElement?): List<ReactionGroup> =
            runCatching { groups!!.jsonArray }.getOrNull().orEmpty().mapNotNull { g ->
                val go = runCatching { g.jsonObject }.getOrNull() ?: return@mapNotNull null
                val emoji = go.str("emoji") ?: return@mapNotNull null
                ReactionGroup(emoji, runCatching { go["actors"]!!.jsonArray }.getOrNull().orEmpty().mapNotNull { reactionActor(runCatching { it.jsonObject }.getOrNull()) }).takeIf { it.actors.isNotEmpty() }
            }
        /** The snapshot in the hub's own JSON shape (the device cache stores it so; [parseReactions] reads it back). */
        fun reactionsJson(s: ReactionSnapshot): String {
            fun actor(a: ReactionActor) = buildJsonObject { put("id", a.id); put("name", a.name); put("kind", a.kind) }
            fun groups(gs: List<ReactionGroup>) = kotlinx.serialization.json.buildJsonArray { gs.forEach { g -> add(buildJsonObject { put("emoji", g.emoji); put("actors", kotlinx.serialization.json.buildJsonArray { g.actors.forEach { add(actor(it)) } }) }) } }
            return buildJsonObject {
                put("actor", actor(s.actor))
                put("messages", buildJsonObject { s.messages.forEach { (k, v) -> put(k, groups(v)) } })
                s.hidden?.let { h -> put("hidden", kotlinx.serialization.json.buildJsonArray { h.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }) }
                s.byHub?.let { b -> put("by_hub_id", buildJsonObject { b.forEach { (k, v) -> put(k, groups(v)) } }) }
            }.toString()
        }
        /** A short line for a reaction the hub refused (SHAPES.md error codes); null for anything else (generic text). */
        fun reactionErrorText(e: Throwable): String = when ((e as? HubApiException)?.code) {
            "invalid_emoji" -> "That emoji can't be used as a reaction."
            "invalid_message_id", "message_not_found" -> "That message can't take reactions yet."
            "reaction_limit" -> "This message has too many reactions."
            else -> "Couldn't update the reaction. Try again."
        }
        /** Only clarify and approval become cards; any other kind is ignored (the hub already declined it upstream, so nothing waits). */
        internal fun parseRequest(o: JsonObject): OpenRequest? {
            val kind = o.str("kind"); val id = o.str("request_id")
            if ((kind != "clarify" && kind != "approval") || id == null || !id.matches(Regex("[\\w.:-]{1,100}"))) return null
            val qs = runCatching { o["questions"]?.jsonArray }.getOrNull()?.take(6)?.mapIndexed { i, q ->
                val qo = q.jsonObject
                RequestQuestion(qo.str("id") ?: "q$i", (qo.str("question") ?: "").take(2000), runCatching { qo["choices"]!!.jsonArray.map { it.jsonPrimitive.content }.take(50) }.getOrNull() ?: emptyList(), qo.bool("multi_select") ?: false)
            } ?: emptyList()
            return OpenRequest(id, kind, qs, o.str("command"), o.str("description"))
        }
        internal fun JsonObject.str(k: String) = this[k]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
        internal fun JsonObject.bool(k: String) = this[k]?.let { runCatching { it.jsonPrimitive.booleanOrNull }.getOrNull() }

        fun parseMember(o: JsonObject?): ConversationMember? {
            o ?: return null
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: return null
            return ConversationMember(
                id = id, name = o.str("name")?.takeIf { it.isNotBlank() } ?: id,
                kind = if (o.str("kind") == "agent") "agent" else "human",
                isBot = o.bool("is_bot") == true, joinedAt = o["joined_at"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
        }

        fun parseMention(o: JsonObject?): ConversationMention? {
            o ?: return null
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: return null
            val offset = o["offset"]?.jsonPrimitive?.intOrNull ?: return null
            val length = o["length"]?.jsonPrimitive?.intOrNull ?: return null
            if (offset < 0 || length < 1) return null
            return ConversationMention(if (o.str("kind") == "agent") "agent" else o.str("kind") ?: "agent", id, offset, length)
        }

        fun parseConversationMedia(o: JsonObject?, fallbackName: String = ""): ConversationMedia? {
            o ?: return null
            val id = o.str("id") ?: return null
            val kind = o.str("kind")?.takeIf { it in setOf("image", "video", "audio", "file") } ?: "file"
            return ConversationMedia(id, kind, o.str("mime") ?: "application/octet-stream", o.str("name") ?: fallbackName, o["size"]?.jsonPrimitive?.longOrNull ?: 0L, o.str("sha256"))
        }

        fun parseConversationMessage(o: JsonObject?): ConversationMessage? {
            o ?: return null
            val id = o.str("id") ?: return null
            val conversationId = o.str("conversation_id") ?: return null
            val sender = parseMember(o["sender"]?.let { runCatching { it.jsonObject }.getOrNull() }) ?: ConversationMember("", "", "human")
            return ConversationMessage(
                id = id, conversationId = conversationId, sender = sender, text = o.str("text").orEmpty(),
                createdAt = o["created_at"]?.jsonPrimitive?.longOrNull ?: 0L,
                replyTo = o.str("reply_to"), mentions = o["mentions"]?.let { arr -> runCatching { arr.jsonArray.mapNotNull { parseMention(runCatching { it.jsonObject }.getOrNull()) } }.getOrNull() }.orEmpty(),
                edited = o.bool("edited") == true,
                media = o["media"]?.let { arr -> runCatching { arr.jsonArray.mapNotNull { parseConversationMedia(runCatching { it.jsonObject }.getOrNull()) } }.getOrNull() }.orEmpty(),
                system = o.bool("system") == true, code = o.str("code"), deliveryState = o.str("delivery_state"),
                dispatchId = o.str("dispatch_id"), rootId = o.str("root_id"),
                seq = o["seq"]?.jsonPrimitive?.intOrNull, deleted = o.bool("deleted") == true,
                reasoning = o.str("reasoning").orEmpty(),
            )
        }

        fun parseConversation(o: JsonObject?): Conversation? {
            o ?: return null
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: return null
            val owner = parseMember(o["owner"]?.let { runCatching { it.jsonObject }.getOrNull() }) ?: ConversationMember("", "You", "human")
            val members = o["members"]?.let { arr -> runCatching { arr.jsonArray.mapNotNull { parseMember(runCatching { it.jsonObject }.getOrNull()) } }.getOrNull() }.orEmpty()
            return Conversation(
                id = id, threadId = o.str("thread_id") ?: ("fcr_" + id.removePrefix("fc_")), chatType = o.str("chat_type") ?: "group",
                title = o.str("title") ?: "Room", owner = owner, members = members,
                createdAt = o["created_at"]?.jsonPrimitive?.longOrNull ?: 0L, updatedAt = o["updated_at"]?.jsonPrimitive?.longOrNull ?: 0L,
                archived = o.bool("archived") == true, unreadCount = (o["unread_count"]?.jsonPrimitive?.intOrNull ?: 0).coerceAtLeast(0),
                lastMessageAt = o["last_message_at"]?.jsonPrimitive?.longOrNull, paused = o.bool("paused") == true,
                epoch = o["epoch"]?.jsonPrimitive?.longOrNull ?: 1L,
            )
        }

        fun parseConversationPreferences(o: JsonObject): ConversationPreferences = ConversationPreferences(
            muted = o.bool("muted") == true, notify = o.str("notify") ?: "all", archived = o.bool("archived") == true,
            pinned = o["pinned"]?.let { runCatching { it.jsonPrimitive.booleanOrNull }.getOrNull() },
        )

        fun parseAgent(a: JsonObject): AgentStatus {
            val kind = a.str("kind") ?: "hermes"
            val caps = a["capabilities"]?.let { runCatching { it.jsonObject }.getOrNull() }
            return AgentStatus(
                name = a.str("id") ?: a.str("name") ?: "?",
                online = a.bool("online") ?: false,
                chatReady = a.bool("chatReady") ?: false,
                managementReady = a.bool("managementReady") ?: false,
                activeSessions = (a["activeSessions"] ?: a["active_sessions"])?.let { runCatching { it.jsonPrimitive.intOrNull }.getOrNull() },
                kind = kind,
                label = (a.str("displayName") ?: a.str("label"))?.takeIf { it.isNotBlank() && it != (a.str("id") ?: a.str("name")) },
                description = a.str("description").orEmpty(),
                order = a["order"]?.let { runCatching { it.jsonPrimitive.intOrNull }.getOrNull() } ?: 0,
                lastActivityAt = a["last_activity_at"]?.let { runCatching { it.jsonPrimitive.longOrNull }.getOrNull() },
                lastSessionTitle = a.str("last_session_title"), lastMessagePreview = a.str("last_message_preview"), lastRole = a.str("last_role"),
                pinOrder = a["pin_order"]?.let { runCatching { it.jsonPrimitive.intOrNull }.getOrNull() },
                working = a.bool("working") ?: false, needsInput = a.bool("needs_input") ?: false,
                capabilities = if (caps != null && caps.containsKey("chat")) Capabilities(
                    chat = caps.bool("chat") ?: true, images = caps.bool("images") ?: false, files = caps.bool("files") ?: false,
                    screen = caps.bool("screen") ?: false, voice = caps.bool("voice") ?: false, skills = caps.bool("skills") ?: false,
                    sessions = caps.bool("sessions") ?: false,
                    nativeUi = caps.bool("nativeUi") ?: false,
                    bot = caps.bool("bot") ?: false,
                    models = caps.str("models")?.takeIf { it in Capabilities.MODEL_MODES },
                    reactions = caps.bool("reactions") ?: false, agentReactions = caps.bool("agentReactions") ?: false,
                    busy = runCatching { caps["busy"]!!.jsonArray.map { it.jsonPrimitive.content }.filter { it in listOf("queue", "steer", "interrupt") } }.getOrNull()?.ifEmpty { null } ?: listOf("queue"),
                ) else Capabilities.forKind(kind).copy(bot = caps?.bool("bot") ?: false),
            )
        }

        fun parseAgents(text: String) = parser.parseToJsonElement(text).jsonObject["agents"]!!.jsonArray.map { parseAgent(it.jsonObject) }

        fun parseAuthInfo(o: JsonObject) = AuthInfo(
            required = o.bool("required") ?: true, authenticated = o.bool("authenticated") ?: false, setupRequired = o.bool("setupRequired") ?: false,
            setupCodeRequired = o.bool("setupCodeRequired") ?: false, registration = o.str("registration") ?: "closed", termsVersion = o.str("termsVersion"), hubVersion = o["hub"]?.jsonObject?.str("version"), hubFeatures = o["hub"]?.jsonObject?.get("features")?.jsonArray?.mapNotNull { f -> f.jsonPrimitive.contentOrNull } ?: emptyList(), username = o["user"]?.jsonObject?.str("username"), role = o["user"]?.jsonObject?.str("role"), userId = o["user"]?.jsonObject?.str("id"),
        )
        fun parseMachine(o: JsonObject) = Machine(
            id = o.str("id") ?: "", name = o.str("name") ?: "Machine", online = o.bool("online") ?: false, lastSeen = o["lastSeen"]?.jsonPrimitive?.longOrNull,
            profiles = o["profiles"]?.jsonArray?.mapNotNull { it.jsonObject.str("agent") } ?: emptyList(),
        )
        fun parseMachines(o: JsonObject): List<Machine> = o["machines"]?.jsonArray?.map { parseMachine(it.jsonObject) } ?: emptyList()
        fun parsePairing(o: JsonObject): Pairing {
            val cmds = o["commands"]?.jsonObject
            return Pairing(
                code = o.str("code") ?: "", display = o.str("display") ?: "", expires = o["expires"]?.jsonPrimitive?.longOrNull ?: 0L, url = o.str("url") ?: "", link = o.str("link") ?: "",
                rows = o["rows"]?.let { r -> runCatching { r.jsonArray.map { it.jsonPrimitive.content } }.getOrNull() },
                sh = cmds?.str("sh") ?: "", powershell = cmds?.str("powershell") ?: "", node = cmds?.str("node") ?: "",
            )
        }
        fun parsePairingState(o: JsonObject): PairingState = when (o.str("state")) {
            "paired" -> PairingState.Paired(o["machine"]?.let { parseMachine(it.jsonObject) })
            "expired" -> PairingState.Expired
            else -> PairingState.Waiting
        }
        fun parseShareable(o: JsonObject) = Shareable(
            o.str("link") ?: "", o["rows"]?.let { r -> runCatching { r.jsonArray.map { it.jsonPrimitive.content } }.getOrNull() },
            o["id"]?.let { Invite(o.str("id") ?: "", o["expires"]?.jsonPrimitive?.longOrNull ?: 0L, false) },
        )
        fun parseInvites(o: JsonObject): List<Invite> = o["invites"]?.jsonArray?.map { val i = it.jsonObject; Invite(i.str("id") ?: "", i["expires"]?.jsonPrimitive?.longOrNull ?: 0L, i.bool("used") ?: false) } ?: emptyList()
        fun parseAdminUsers(o: JsonObject): List<AdminUser> = o["users"]?.jsonArray?.map { val u = it.jsonObject; AdminUser(u.str("id") ?: "", u.str("username") ?: "?", u.str("role") ?: "user", u.bool("disabled") ?: false) } ?: emptyList()
        fun parseDevices(o: JsonObject): List<Device> = o["devices"]?.jsonArray?.map { el ->
            val d = el.jsonObject
            Device(d.str("id") ?: "", d.str("name") ?: "Device", d.str("kind") ?: "web", d["lastSeen"]?.jsonPrimitive?.longOrNull ?: 0L, d.bool("current") ?: false)
        } ?: emptyList()

        fun parseKinds(obj: JsonObject): List<AgentKind> = obj["kinds"]?.jsonArray?.map { el ->
            val k = el.jsonObject
            AgentKind(
                kind = k.str("kind") ?: "?", label = k.str("label") ?: "?", summary = k.str("summary").orEmpty(), planned = k.bool("planned") ?: false,
                auth = k["auth"]?.jsonArray?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
                warnings = k["warnings"]?.jsonArray?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
                fields = k["fields"]?.jsonArray?.map { f ->
                    val o = f.jsonObject
                    KindField(o.str("key") ?: "", o.str("label") ?: "", o.str("type") ?: "text", o.bool("required") ?: false,
                        o.bool("writeOnly") ?: false, o.str("default"), o.bool("advanced") ?: false, o.str("help"),
                        options = o["options"]?.jsonArray?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
                        whenKey = o["when"]?.jsonObject?.entries?.firstOrNull()?.key, whenValue = o["when"]?.jsonObject?.entries?.firstOrNull()?.value?.let { runCatching { it.jsonPrimitive.content }.getOrNull() })
                } ?: emptyList(),
            )
        } ?: emptyList()

        fun parseSaved(o: JsonObject): SavedAgent {
            val values = mutableMapOf<String, String>(); val saved = mutableSetOf<String>()
            for ((k, v) in o) {
                if (k.startsWith("has") && k.length > 3) { if (o.bool(k) == true) saved += k[3].lowercase() + k.substring(4); continue }
                if (k == "name" || k == "kind") continue
                runCatching { v.jsonPrimitive.contentOrNull }.getOrNull()?.let { values[k] = it }
            }
            return SavedAgent(o.str("name") ?: "?", o.str("kind") ?: "hermes", values, saved)
        }

        fun parseTest(o: JsonObject): TestResult {
            val checks = o["checks"]?.let { runCatching { it.jsonObject }.getOrNull() }?.map { (k, v) ->
                val c = v.jsonObject; k to CheckResult(c.bool("ok") ?: false, scrubAddresses(c.str("message").orEmpty()))
            } ?: emptyList()
            return TestResult(o.bool("ok") ?: checks.all { it.second.ok }, checks)
        }

        fun jsonOf(fields: Map<String, Any>): String = buildJsonObject {
            for ((k, v) in fields) when (v) {
                is Number -> put(k, v); is Boolean -> put(k, v); else -> put(k, v.toString())
            }
        }.toString()
    }
}

/** A hub link to one media file (absolute URL; the app's HTTP client adds the sign-in). */
data class MediaLink(val url: String, val kind: String, val name: String)
