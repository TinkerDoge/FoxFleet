package dev.foxfleet.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
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
class HubApiException(val status: Int, message: String, val network: Boolean = false, val refused: Boolean = false) : Exception(scrubAddresses(message)) {
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

    private fun errorBody(response: Response): String {
        val raw = runCatching { response.body?.string() }.getOrNull() ?: return ""
        return runCatching {
            val obj = json.parseToJsonElement(raw).jsonObject
            obj["error"]?.jsonPrimitive?.content?.take(250)
        }.getOrNull() ?: raw.take(250)
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
            if (!it.isSuccessful) throw HubApiException(it.code, errorBody(it).ifEmpty { "Request failed (${it.code})" })
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

    // ---- agent registry (owner) ----

    suspend fun agentKinds(): List<AgentKind> = withContext(Dispatchers.IO) {
        parseKinds(request("/api/agent-kinds"))
    }

    suspend fun savedAgents(): List<SavedAgent> = withContext(Dispatchers.IO) {
        request("/api/connections")["connections"]?.jsonArray?.map { parseSaved(it.jsonObject) } ?: emptyList()
    }

    suspend fun addAgent(fields: Map<String, Any>): SaveResult = withContext(Dispatchers.IO) {
        val obj = request("/api/connections", "POST", jsonOf(fields))
        SaveResult(parseSaved(obj["connection"]!!.jsonObject), obj["inboxToken"]?.jsonPrimitive?.contentOrNull)
    }

    suspend fun editAgent(name: String, fields: Map<String, Any>): SaveResult = withContext(Dispatchers.IO) {
        SaveResult(parseSaved(request("/api/connections/" + enc(name), "PUT", jsonOf(fields))["connection"]!!.jsonObject))
    }

    /** New connector token for a Hermes agent (the old one stops working immediately). */
    suspend fun newInboxToken(name: String): String? = withContext(Dispatchers.IO) { request("/api/connections/" + enc(name) + "/token", "POST", "{}")["inboxToken"]?.jsonPrimitive?.contentOrNull }

    suspend fun deleteAgent(name: String) = withContext(Dispatchers.IO) { request("/api/connections/" + enc(name), "DELETE"); Unit }

    suspend fun reorderAgents(names: List<String>) = withContext(Dispatchers.IO) {
        request("/api/connections/order", "POST", buildJsonObject { putJsonArray("names") { names.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } }.toString()); Unit
    }

    /** Probes a draft without saving; when editing, the hub reuses the saved endpoint and secrets. */
    suspend fun testAgent(fields: Map<String, Any>): TestResult = withContext(Dispatchers.IO) {
        parseTest(request("/api/connections/test", "POST", jsonOf(fields), timeoutSec = 45))
    }

    suspend fun rotateInboxToken(name: String): String = withContext(Dispatchers.IO) {
        request("/api/connections/" + enc(name) + "/token", "POST", "{}")["inboxToken"]?.jsonPrimitive?.content ?: throw HubApiException(0, "No token returned")
    }

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

    suspend fun renameSession(agent: String, id: String, title: String) = withContext(Dispatchers.IO) {
        request(agentPath(agent) + "/sessions/" + enc(id), "PATCH", buildJsonObject { put("title", title) }.toString()); Unit
    }
    suspend fun deleteSession(agent: String, id: String) = withContext(Dispatchers.IO) { request(agentPath(agent) + "/sessions/" + enc(id), "DELETE"); Unit }

    /** Days the hub keeps chat history for API-key agents (this user); 0 keeps nothing. */
    suspend fun historyRetention(): Int = withContext(Dispatchers.IO) { request("/api/history/settings")["retentionDays"]?.jsonPrimitive?.intOrNull ?: 90 }
    suspend fun setHistoryRetention(days: Int) = withContext(Dispatchers.IO) { request("/api/history/settings", "PUT", buildJsonObject { put("retentionDays", days) }.toString()); Unit }

    /** The hub sends normalised history (tool JSON, control tags and hidden rows already gone); anything odd is skipped. */
    internal fun historyMessage(el: kotlinx.serialization.json.JsonElement): UiMessage? {
        val m = runCatching { el.jsonObject }.getOrNull() ?: return null
        val role = m.str("role")?.takeIf { it == "user" || it == "assistant" } ?: return null
        val content = m.str("content").orEmpty(); val reasoning = m.str("reasoning").orEmpty()
        val steps = runCatching { m["tools"]?.jsonArray }.getOrNull()?.mapNotNull { t ->
            val o = runCatching { t.jsonObject }.getOrNull() ?: return@mapNotNull null
            ToolStep(o.str("name") ?: return@mapNotNull null, o.str("args").orEmpty(), o.str("result").orEmpty(), o.bool("ok") != false)
        }.orEmpty()
        val urls = runCatching { m["images"]?.jsonArray }.getOrNull()?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
        if (content.isEmpty() && reasoning.isEmpty() && steps.isEmpty() && urls.isEmpty()) return null
        return UiMessage(role = role, content = content, reasoning = reasoning, steps = steps, ts = m["ts"]?.jsonPrimitive?.longOrNull ?: 0L, imageUrls = urls)
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
        else request(agentPath(agent) + "/screen/" + action, "POST", "{}", timeoutSec = 45)
    }

    fun parseScreen(obj: JsonObject) = ScreenStatus(
        running = obj["running"]?.jsonPrimitive?.booleanOrNull ?: false,
        supported = obj["supported"]?.jsonPrimitive?.booleanOrNull ?: true,
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
    ): String = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("model", "hermes-agent")
            put("stream", true)
            if (!sessionId.isNullOrBlank()) put("session_id", sessionId)
            put("messages", ChatPayload.messages(history))
        }.toString()
        val url = base().newBuilder().encodedPath(agentPath(agent) + "/chat").build()
        val response = await(client.newCall(Request.Builder().url(url).post(payload.toRequestBody(jsonMedia)).build()))
        pump(agent, response, StreamCallbacks(onContent, onReasoning, onTool, onSession, onRun, onGap, onRequest = onRequest, onRequestClosed = onRequestClosed, onAck = onAck, onReconnecting = onReconnecting), null, 0)
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
    /** Session-scoped: this conversation only. The profile default is never touched from here. */
    suspend fun setModel(agent: String, session: String, model: String, provider: String?): String = withContext(Dispatchers.IO) {
        val value = if (provider.isNullOrBlank()) model else "$model --provider $provider"
        val r = request(agentPath(agent) + "/native/sessions/" + enc(session) + "/model", "POST", buildJsonObject { put("model", value) }.toString(), timeoutSec = 30)
        if (r.bool("confirm_required") == true) r.str("confirm_message") ?: "Confirm in Hermes" else "Model for this chat: $model"
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
                        e.event == "foxfleet.gap" -> { builder.setLength(0); cb.onGap(); true }
                        e.event == "foxfleet.run" -> { runCatching { json.parseToJsonElement(e.data).jsonObject["state"]?.jsonPrimitive?.contentOrNull }.getOrNull()?.let(cb.onRunState); finished = true; false } // stopped or failed on the hub
                        e.event == "foxfleet.request" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let(::parseRequest)?.let(cb.onRequest); true }
                        e.event == "foxfleet.request_closed" -> { runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()?.let { v -> v.str("request_id")?.let { id -> cb.onRequestClosed(id, v.str("reason") ?: "closed") } }; true }
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
                capabilities = if (caps != null && caps.containsKey("chat")) Capabilities(
                    chat = caps.bool("chat") ?: true, images = caps.bool("images") ?: false, files = caps.bool("files") ?: false,
                    screen = caps.bool("screen") ?: false, voice = caps.bool("voice") ?: false, skills = caps.bool("skills") ?: false,
                    sessions = caps.bool("sessions") ?: false, mailbox = caps.bool("mailbox") ?: false,
                    nativeUi = caps.bool("nativeUi") ?: false,
                    busy = runCatching { caps["busy"]!!.jsonArray.map { it.jsonPrimitive.content }.filter { it in listOf("queue", "steer", "interrupt") } }.getOrNull()?.ifEmpty { null } ?: listOf("queue"),
                ) else Capabilities.forKind(kind),
            )
        }

        fun parseAgents(text: String) = parser.parseToJsonElement(text).jsonObject["agents"]!!.jsonArray.map { parseAgent(it.jsonObject) }

        fun parseAuthInfo(o: JsonObject) = AuthInfo(
            required = o.bool("required") ?: true, authenticated = o.bool("authenticated") ?: false, setupRequired = o.bool("setupRequired") ?: false,
            setupCodeRequired = o.bool("setupCodeRequired") ?: false, registration = o.str("registration") ?: "closed", termsVersion = o.str("termsVersion"), username = o["user"]?.jsonObject?.str("username"), role = o["user"]?.jsonObject?.str("role"),
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
