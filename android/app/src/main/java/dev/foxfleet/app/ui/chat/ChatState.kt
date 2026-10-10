package dev.foxfleet.app.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubApiException
import dev.foxfleet.app.data.SavedChat
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.UiMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

const val PAGE = 80

/** Per-agent conversation state: message history, streaming overlays, session id. */
class ChatState {
    var messages by mutableStateOf<List<UiMessage>>(emptyList())
        private set
    var streaming by mutableStateOf(false)
        private set
    var streamText by mutableStateOf("")
        private set
    var streamReasoning by mutableStateOf("")
        private set
    var toolLabel by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var sessionId by mutableStateOf<String?>(null)
        private set
    /** Small bot-style lines (a confirmation such as the model change). Local to this screen: never sent to the agent. */
    var notices by mutableStateOf<List<String>>(emptyList())
        private set
    fun addNotice(text: String) { notices = (notices + text).takeLast(5) }

    /** The hub run behind the reply being streamed, and where to remember it (set by the ViewModel). */
    var runId: String? = null
        private set
    var persist: (SavedChat) -> Unit = {}

    var loading by mutableStateOf(false)
        private set
    /** Older pages exist on the hub; [olderOffset] is where the next page starts (counted back from the newest message). */
    var hasOlder by mutableStateOf(false)
        private set
    var loadingOlder by mutableStateOf(false)
        private set
    var olderOffset = 0
        private set
    /** Stable list keys: prepending older messages must not shift the keys of the ones already on screen. */
    var keyBase = 0
        private set
    var unread by mutableStateOf(false)
        private set
    /** What the hub holds for this conversation (queued, waiting for a stop, guidance accepted) and whether draining is paused. */
    var queue by mutableStateOf<List<HubApi.QueuedMessage>>(emptyList())
        private set
    var halted by mutableStateOf(false)
        private set
    /** Questions and approvals the agent waits on (native sessions): one card each, answered once by id. */
    var requests by mutableStateOf<List<HubApi.OpenRequest>>(emptyList())
        private set
    /** Tools used in the current reply, newest last. */
    var toolLog by mutableStateOf<List<String>>(emptyList())
        private set
    /** False when the agent keeps the queue itself (Hermes): a queued message cannot be taken back from here. */
    var canCancel by mutableStateOf(true)
        private set
    /** Bumped whenever the screen moves to another chat or stream: callbacks of an older stream are ignored. */
    private var gen = 0
    private var submitting = 0

    /** Previews/screenshot tests: put the live overlays into a mid-stream state. */
    internal fun simulateStream(text: String, reasoning: String = "", tool: String? = null) {
        streaming = true; streamText = text; streamReasoning = reasoning; toolLabel = tool
    }

    /** Previews/screenshot tests: what a native session shows (cards, the queue as Hermes holds it, tools used). */
    internal fun simulateNative(requests: List<HubApi.OpenRequest> = emptyList(), queue: List<HubApi.QueuedMessage> = emptyList(), canCancel: Boolean = true, tools: List<String> = emptyList()) {
        this.requests = requests; this.queue = queue; this.canCancel = canCancel; this.toolLog = tools
    }

    fun markRead() { unread = false }
    fun markUnread() { unread = true }
    fun beginLoad() { loading = true; error = null }
    fun loadFailed(msg: String) { loading = false; error = msg }

    /** Append a fully-formed message (history load or user send). */
    fun push(m: UiMessage) { messages = messages + m }

    private fun resetStream() {
        streaming = false; streamText = ""; streamReasoning = ""; toolLabel = null; toolLog = emptyList(); requests = emptyList()
    }

    fun adopt(sessionId: String?) {
        if (sessionId != null && sessionId.isNotBlank()) this.sessionId = sessionId
    }

    fun load(messages: List<UiMessage>, sessionId: String?, hasMore: Boolean = false) {
        gen++; queue = emptyList(); halted = false; requests = emptyList(); notices = emptyList()
        this.messages = messages; keyBase = 0; hasOlder = hasMore; olderOffset = PAGE; loadingOlder = false
        this.sessionId = sessionId
        if (!sessionId.isNullOrBlank()) persist(SavedChat(sessionId, null, null))
        loading = false
        resetStream(); error = null
    }

    /** Retry: forget everything from the last user message on; it is sent again. */
    fun dropAfterLastUser() { val i = messages.indexOfLast { it.role == "user" }; if (i >= 0) messages = messages.take(i) }

    fun beginOlder() { loadingOlder = true }
    fun prepend(older: List<UiMessage>, hasMore: Boolean) {
        keyBase -= older.size; messages = older + messages; hasOlder = hasMore; olderOffset += PAGE; loadingOlder = false
    }
    fun olderFailed() { loadingOlder = false }

    fun newConversation() {
        gen++; queue = emptyList(); halted = false; requests = emptyList(); notices = emptyList()
        messages = emptyList(); keyBase = 0; hasOlder = false; sessionId = null; runId = null; persist(SavedChat())
        resetStream(); error = null
    }

    /** True while the hub or the tunnel is briefly unreachable and we are resuming quietly (shown as a small status, never an error). */
    var reconnecting by mutableStateOf(false)

    private fun callbacks(g: Int) = HubApi.StreamCallbacks(
        onReconnecting = { if (g == gen) reconnecting = true },
        onContent = { if (g == gen) { reconnecting = false; streamText += it } }, onReasoning = { if (g == gen) streamReasoning += it }, onTool = { if (g == gen) { toolLabel = it; if (toolLog.lastOrNull() != it) toolLog = (toolLog + it).takeLast(12) } },
        onRequest = { r -> if (g == gen && requests.none { it.id == r.id }) requests = requests + r },
        onRequestClosed = { id, _ -> if (g == gen) requests = requests.filter { it.id != id } },
        onAck = { id, ack -> if (g == gen) queue = queue.map { if (it.id == id) it.copy(ack = ack) else it } },
        onSession = { if (g == gen) { adopt(it); persist(SavedChat(sessionId, runId, pendingUser)) } },
        onRun = { if (g == gen) { runId = it; persist(SavedChat(sessionId, it, pendingUser)) } },
        onGap = { if (g == gen) streamText = "" },
    )
    private var pendingUser: String? = null

    /** Streams one assistant turn into the live overlays, then commits it. */
    suspend fun send(api: HubApi, agent: String, userText: String, images: List<dev.foxfleet.app.data.ImageAttachment> = emptyList()) {
        push(UiMessage(role = "user", content = userText, images = images))
        pendingUser = userText; runId = null
        val sentAt = System.currentTimeMillis(); val before = messages
        try { stream { cb -> api.chat(agent, messages, sessionId, cb.onContent, cb.onReasoning, cb.onTool, cb.onSession, cb.onRun, cb.onGap, cb.onRequest, cb.onRequestClosed, cb.onAck, cb.onReconnecting) } }
        catch (e: dev.foxfleet.app.data.HubApiException) {
            if (!e.transient || runId != null || !autoResubmit(api, agent, UiMessage(role = "user", content = userText, images = images), sentAt)) throw e
        }
    }

    /**
     * The submit died in a tunnel blip before a run id was seen. The hub may or may not have started the run: look first (a run that
     * began after we sent is ours), and only otherwise send again through the idempotent /messages path (one client_id for every retry).
     */
    private suspend fun autoResubmit(api: HubApi, agent: String, user: UiMessage, sentAt: Long): Boolean {
        val clientId = java.util.UUID.randomUUID().toString(); error = null; reconnecting = true; streaming = true
        try {
            for (n in 0 until 10) {
                delay(dev.foxfleet.app.data.backoffMs(n, 600, 10_000))
                try {
                    val mine = api.runs(agent, sessionId).firstOrNull { it.started >= sentAt - 3000 }
                    val run = mine?.id ?: api.sendMessage(agent, user, sessionId, "queue", clientId).also { r -> r.sessionId?.let { adopt(it) } }.runId
                    reconnecting = false
                    if (run != null) { resume(api, agent, run, null) } else { streaming = false; syncQueue(api, agent) }
                    return true
                } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (e: dev.foxfleet.app.data.HubApiException) { if (!e.transient) return false }
            }
            return false
        } finally { reconnecting = false; if (!messages.isEmpty() && runId == null) streaming = false }
    }

    /** Reattach to a reply that was still being written (or just finished) while the app was away. */
    suspend fun resume(api: HubApi, agent: String, run: String, userText: String?) {
        if (userText != null && messages.lastOrNull()?.content != userText) push(UiMessage(role = "user", content = userText))
        pendingUser = userText; runId = run
        stream { cb -> api.follow(agent, run, 0, cb) }
    }

    private suspend fun stream(block: suspend (HubApi.StreamCallbacks) -> String) {
        val g = ++gen
        streaming = true; error = null; streamText = ""; streamReasoning = ""; toolLabel = null
        try {
            val text = block(callbacks(g))
            if (g != gen) return // another chat is open now: this stream's end changes nothing
            toolLabel = null
            if (text.isNotEmpty() || streamReasoning.isNotEmpty()) push(UiMessage(role = "assistant", content = text))
            resetStream(); finishRun()
        } catch (e: CancellationException) {
            // The app left the screen or the process is going away. The hub keeps the run alive, so keep what we have and
            // leave the saved run id in place: the next launch reattaches and fills in the rest.
            val partial = streamText
            if (g != gen) throw e
            resetStream()
            if (partial.isNotBlank()) push(UiMessage(role = "assistant", content = partial))
            throw e
        } catch (e: AuthRequiredException) {
            if (g == gen) resetStream(); error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) }; throw e
        } catch (e: Exception) {
            if (g != gen) throw e
            resetStream(); error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Chat failed"
            throw e
        }
    }

    fun finishRun() { runId = null; pendingUser = null; persist(SavedChat(sessionId, null, null)) }

    // ---- sending while the agent works ----

    /** The hub stores the message first; the mode decides what happens if the agent is busy. A rejected send returns its text so nothing is lost. */
    suspend fun sendBusy(api: HubApi, agent: String, userText: String, images: List<dev.foxfleet.app.data.ImageAttachment>, mode: String): String? {
        val clientId = java.util.UUID.randomUUID().toString()
        val local = HubApi.QueuedMessage(clientId, if (mode == "interrupt") "awaiting_stop" else if (mode == "queue") "queued" else "sending", mode, userText)
        queue = queue + local; submitting++
        try {
            val r = api.sendMessage(agent, UiMessage(role = "user", content = userText, images = images), sessionId, mode, clientId)
            queue = queue.map { if (it.id == clientId) r.message else it }
        } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { queue = queue.filter { it.id != clientId }; throw e } catch (e: Exception) {
            queue = queue.filter { it.id != clientId }; error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Not sent"; return userText
        } finally { submitting-- }
        return null
    }

    /**
     * Reads the hub's queue for this conversation: shows what is waiting and follows the next reply when the hub has started one
     * (a queued message, or the replacement after Interrupt & send). Call after a send, a finished reply, a reload or a reconnect.
     */
    suspend fun syncQueue(api: HubApi, agent: String, attempts: Int = 0) {
        val s = sessionId; val q = try { api.queue(agent, s) } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
        if (s != sessionId) return
        val running = q.items.firstOrNull { it.runId != null && it.runId == q.activeRun }
        // the run ended (guidance) or Hermes started the queued turn itself: the text joins the transcript
        val gone = queue.filter { (it.state == "guidance_accepted" || (it.state == "queued" && it.ack == "queued")) && q.items.none { i -> i.id == it.id } }
        if (gone.isNotEmpty()) messages = messages + gone.map { UiMessage(role = "user", content = it.text) }
        if (submitting == 0) { queue = q.items.filter { it.id !in dismissed && it !== running && it.state != "sending" && it.state != "running" }; halted = q.halted; canCancel = q.canCancel; requests = q.openRequests }
        if (q.activeRun != null && !streaming && runId == null) { resume(api, agent, q.activeRun, running?.text); syncQueue(api, agent); return }
        if (q.activeRun == null && !q.halted && attempts < 12 && q.items.any { it.state == "queued" || it.state == "awaiting_stop" }) { delay(300); syncQueue(api, agent, attempts + 1) }
    }
    private val dismissed = mutableSetOf<String>()
    /** Taking a message back, or hiding one Hermes refused (Hermes keeps no copy of that). */
    fun dropQueued(id: String) { dismissed.add(id); queue = queue.filter { it.id != id } }

    /** Answers a card. It disappears once the hub took the answer, or said it was already closed (404). Returns an error text, or null. */
    suspend fun answerRequest(api: HubApi, agent: String, id: String, result: kotlinx.serialization.json.JsonObject): String? {
        val s = sessionId ?: return "No conversation yet"
        return try { api.answerRequest(agent, s, id, result); requests = requests.filter { it.id != id }; null }
        catch (e: CancellationException) { throw e }
        catch (e: HubApiException) { if (e.status == 404) { requests = requests.filter { it.id != id }; null } else e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Could not send the answer" }
        catch (e: AuthRequiredException) { throw e } catch (_: Exception) { "Could not send the answer" }
    }
}
