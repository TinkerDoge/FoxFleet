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
    /** Bumped whenever the screen moves to another chat or stream: callbacks of an older stream are ignored. */
    private var gen = 0
    private var submitting = 0

    /** Previews/screenshot tests: put the live overlays into a mid-stream state. */
    internal fun simulateStream(text: String, reasoning: String = "", tool: String? = null) {
        streaming = true; streamText = text; streamReasoning = reasoning; toolLabel = tool
    }

    fun markRead() { unread = false }
    fun markUnread() { unread = true }
    fun beginLoad() { loading = true; error = null }
    fun loadFailed(msg: String) { loading = false; error = msg }

    /** Append a fully-formed message (history load or user send). */
    fun push(m: UiMessage) { messages = messages + m }

    private fun resetStream() {
        streaming = false; streamText = ""; streamReasoning = ""; toolLabel = null
    }

    fun adopt(sessionId: String?) {
        if (sessionId != null && sessionId.isNotBlank()) this.sessionId = sessionId
    }

    fun load(messages: List<UiMessage>, sessionId: String?, hasMore: Boolean = false) {
        gen++; queue = emptyList(); halted = false
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
        gen++; queue = emptyList(); halted = false
        messages = emptyList(); keyBase = 0; hasOlder = false; sessionId = null; runId = null; persist(SavedChat())
        resetStream(); error = null
    }

    private fun callbacks(g: Int) = HubApi.StreamCallbacks(
        onContent = { if (g == gen) streamText += it }, onReasoning = { if (g == gen) streamReasoning += it }, onTool = { if (g == gen) toolLabel = it },
        onSession = { if (g == gen) { adopt(it); persist(SavedChat(sessionId, runId, pendingUser)) } },
        onRun = { if (g == gen) { runId = it; persist(SavedChat(sessionId, it, pendingUser)) } },
        onGap = { if (g == gen) streamText = "" },
    )
    private var pendingUser: String? = null

    /** Streams one assistant turn into the live overlays, then commits it. */
    suspend fun send(api: HubApi, agent: String, userText: String, images: List<dev.foxfleet.app.data.ImageAttachment> = emptyList()) {
        push(UiMessage(role = "user", content = userText, images = images))
        pendingUser = userText; runId = null
        stream { cb -> api.chat(agent, messages, sessionId, cb.onContent, cb.onReasoning, cb.onTool, cb.onSession, cb.onRun, cb.onGap) }
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
        val local = HubApi.QueuedMessage(clientId, if (mode == "interrupt") "awaiting_stop" else if (mode == "steer") "sending" else "queued", mode, userText)
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
        val gone = queue.filter { it.state == "guidance_accepted" && q.items.none { i -> i.id == it.id } } // the run ended: the guidance joins the transcript
        if (gone.isNotEmpty()) messages = messages + gone.map { UiMessage(role = "user", content = it.text) }
        if (submitting == 0) { queue = q.items.filter { it !== running && it.state != "sending" && it.state != "running" }; halted = q.halted }
        if (q.activeRun != null && !streaming && runId == null) { resume(api, agent, q.activeRun, running?.text); syncQueue(api, agent); return }
        if (q.activeRun == null && !q.halted && attempts < 12 && q.items.any { it.state == "queued" || it.state == "awaiting_stop" }) { delay(300); syncQueue(api, agent, attempts + 1) }
    }
    fun dropQueued(id: String) { queue = queue.filter { it.id != id } }
}
