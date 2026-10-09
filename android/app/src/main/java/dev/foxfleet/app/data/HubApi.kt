package dev.foxfleet.app.data

import kotlinx.coroutines.Dispatchers
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
class HubApiException(val status: Int, message: String) : Exception(scrubAddresses(message))

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
                if (cont.isActive) cont.resumeWithException(HubApiException(0, "The hub could not be reached (${e.message})"))
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

    private suspend fun request(path: String, method: String = "GET", body: String? = null, timeoutSec: Long = 30, query: Map<String, String> = emptyMap(), plain401: Boolean = false): JsonObject {
        val url = base().newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val builder = Request.Builder().url(url).method(method, body?.toRequestBody(jsonMedia))
        val call = client.newCall(builder.build())
        call.timeout().timeout(timeoutSec, TimeUnit.SECONDS)
        val response = await(call)
        response.use {
            if (it.code == 401 && !plain401) throw AuthRequiredException()
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

    suspend fun sessions(agent: String): List<SessionInfo> = withContext(Dispatchers.IO) {
        val obj = request(agentPath(agent) + "/sessions", timeoutSec = 30)
        val arr = obj["sessions"]?.jsonArray ?: throw HubApiException(0, "Invalid response from the relay")
        arr.map { el ->
            val s = el.jsonObject
            SessionInfo(
                id = s["id"]?.jsonPrimitive?.content ?: "",
                title = s["title"]?.jsonPrimitive?.contentOrNull,
            )
        }.filter { it.id.isNotEmpty() }
    }

    suspend fun messages(agent: String, sessionId: String): List<UiMessage> = withContext(Dispatchers.IO) {
        val obj = request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/messages", timeoutSec = 60)
        val arr = obj["messages"]?.jsonArray ?: throw HubApiException(0, "Invalid response from the relay")
        arr.map { el ->
            val m = el.jsonObject
            val role = m["role"]?.jsonPrimitive?.content ?: "assistant"
            UiMessage(role = role, content = contentToString(m["content"]))
        }
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
            if (it.code == 401) throw AuthRequiredException()
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

    /**
     * Streams a chat turn. Returns the full assistant text.
     * [onSession] fires when the relay assigns/returns a session id.
     */
    suspend fun chat(
        agent: String,
        history: List<UiMessage>,
        sessionId: String?,
        onContent: (String) -> Unit,
        onReasoning: (String) -> Unit,
        onTool: (String) -> Unit,
        onSession: (String) -> Unit,
    ): String = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("model", "hermes-agent")
            put("stream", true)
            if (!sessionId.isNullOrBlank()) put("session_id", sessionId)
            put("messages", ChatPayload.messages(history))
        }.toString()

        val url = base().newBuilder().encodedPath(agentPath(agent) + "/chat").build()
        val call = client.newCall(
            Request.Builder().url(url).post(payload.toRequestBody(jsonMedia)).build()
        )
        val response = await(call)
        response.use {
            if (it.code == 401) throw AuthRequiredException()
            if (!it.isSuccessful) throw HubApiException(it.code, errorBody(it).ifEmpty { "Chat failed (${it.code})" })
            val contentType = it.header("Content-Type") ?: ""
            if (!contentType.contains("text/event-stream")) throw HubApiException(0, "Invalid reply stream")

            it.header("X-Hermes-Session-Id")?.let { id ->
                if (id.matches(Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}"))) onSession(id)
            }

            val builder = StringBuilder()
            val parser = SseParser(onEvent = { e ->
                when {
                    e.data == "[DONE]" -> false // web parity: stop reading
                    e.event == "error" -> throw HubApiException(0, "The agent reply failed. Check the agent and try again.")
                    else -> {
                        val value = runCatching { json.parseToJsonElement(e.data).jsonObject }.getOrNull()
                        if (value == null) true
                        else if (value.containsKey("error")) throw HubApiException(0, "The agent reply failed. Check the agent and try again.")
                        else if (e.event == "hermes.tool.progress") {
                            val label = value["tool"]?.jsonPrimitive?.contentOrNull
                                ?: value["name"]?.jsonPrimitive?.contentOrNull
                                ?: "tool"
                            onTool(label)
                            true
                        } else {
                            val choices = runCatching { value["choices"]?.jsonArray }.getOrNull()
                            if (choices != null) {
                                for (choice in choices) {
                                    val delta = runCatching { choice.jsonObject["delta"]?.jsonObject }.getOrNull() ?: continue
                                    delta["content"]?.jsonPrimitive?.contentOrNull?.let { text ->
                                        if (text.isNotEmpty()) { builder.append(text); onContent(text) }
                                    }
                                    delta["reasoning_content"]?.jsonPrimitive?.contentOrNull?.let { text ->
                                        if (text.isNotEmpty()) onReasoning(text)
                                    }
                                }
                            }
                            true
                        }
                    }
                }
            })
            val stream = it.body?.byteStream() ?: throw HubApiException(0, "Invalid reply stream")
            val reader = InputStreamReader(stream, Charsets.UTF_8)
            val chars = CharArray(8192)
            try {
                while (!parser.isStopped) {
                    val n = reader.read(chars)
                    if (n < 0) break
                    if (n > 0) {
                        parser.feed(String(chars, 0, n))
                        coroutineContext.ensureActive() // cooperative cancel mid-stream
                    }
                }
                parser.end()
            } finally {
                runCatching { reader.close() }
            }
            builder.toString()
        }
    }

    companion object {
        private val parser = Json { ignoreUnknownKeys = true }

        private fun JsonObject.str(k: String) = this[k]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
        private fun JsonObject.bool(k: String) = this[k]?.let { runCatching { it.jsonPrimitive.booleanOrNull }.getOrNull() }

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
