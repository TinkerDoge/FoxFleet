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
    var unread by mutableStateOf(false)
        private set

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

    fun load(messages: List<UiMessage>, sessionId: String?) {
        this.messages = messages
        this.sessionId = sessionId
        if (!sessionId.isNullOrBlank()) persist(SavedChat(sessionId, null, null))
        loading = false
        resetStream(); error = null
    }

    fun newConversation() {
        messages = emptyList(); sessionId = null; runId = null; persist(SavedChat())
        resetStream(); error = null
    }

    private fun callbacks() = HubApi.StreamCallbacks(
        onContent = { streamText += it }, onReasoning = { streamReasoning += it }, onTool = { toolLabel = it },
        onSession = { adopt(it); persist(SavedChat(sessionId, runId, pendingUser)) },
        onRun = { runId = it; persist(SavedChat(sessionId, it, pendingUser)) },
        onGap = { streamText = "" },
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
        streaming = true; error = null; streamText = ""; streamReasoning = ""; toolLabel = null
        try {
            val text = block(callbacks())
            toolLabel = null
            push(UiMessage(role = "assistant", content = text))
            resetStream(); finishRun()
        } catch (e: CancellationException) {
            // The app left the screen or the process is going away. The hub keeps the run alive, so keep what we have and
            // leave the saved run id in place: the next launch reattaches and fills in the rest.
            val partial = streamText
            resetStream()
            if (partial.isNotBlank()) push(UiMessage(role = "assistant", content = partial))
            throw e
        } catch (e: AuthRequiredException) {
            resetStream(); error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) }; throw e
        } catch (e: Exception) {
            resetStream(); error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Chat failed"
            throw e
        }
    }

    fun finishRun() { runId = null; pendingUser = null; persist(SavedChat(sessionId, null, null)) }
}
