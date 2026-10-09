package dev.foxfleet.app.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubApiException
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
        loading = false
        resetStream(); error = null
    }

    fun newConversation() {
        messages = emptyList(); sessionId = null
        resetStream(); error = null
    }

    /** Streams one assistant turn into the live overlays, then commits it. */
    suspend fun send(api: HubApi, agent: String, userText: String, images: List<dev.foxfleet.app.data.ImageAttachment> = emptyList()) {
        val user = UiMessage(role = "user", content = userText, images = images)
        push(user)
        streaming = true; error = null; streamText = ""; streamReasoning = ""; toolLabel = null
        val history = messages // includes the just-pushed user message
        try {
            val text = api.chat(
                agent = agent,
                history = history,
                sessionId = sessionId,
                onContent = { streamText += it },
                onReasoning = { streamReasoning += it },
                onTool = { toolLabel = it },
                onSession = { adopt(it) },
            )
            toolLabel = null
            push(UiMessage(role = "assistant", content = text))
            resetStream()
        } catch (e: CancellationException) {
            // keep partial text as a committed message so the turn isn't lost
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
}
