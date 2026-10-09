package dev.foxfleet.app.data

/** What an agent can do; sent by the hub (derived from its kind). The UI shows only what's true here. */
data class Capabilities(
    val chat: Boolean = true,
    val images: Boolean = false,
    val files: Boolean = false,
    val screen: Boolean = false,
    val voice: Boolean = false,
    val skills: Boolean = false,
    val sessions: Boolean = false,
    val mailbox: Boolean = false,
) {
    companion object {
        /** Fallback for hubs older than 0.5 that don't send capabilities. */
        fun forKind(kind: String) = when (kind) {
            "hermes" -> Capabilities(images = true, files = true, screen = true, voice = true, skills = true, sessions = true)
            "openai" -> Capabilities(images = true, sessions = true)
            "mcp-inbox" -> Capabilities(sessions = true, mailbox = true)
            else -> Capabilities()
        }
    }
}

/**
 * One agent as the hub shows it to clients. By design there is no host, port, URL or profile here:
 * only the hub knows where an agent lives (privacy contract, hub v0.5).
 */
data class AgentStatus(
    val name: String,
    val online: Boolean,
    val chatReady: Boolean,
    val managementReady: Boolean,
    val activeSessions: Int? = null,
    /** "hermes", "openai" (OpenAI-compatible) or "mcp-inbox" (mailbox agent such as Scribe). */
    val kind: String = "hermes",
    val label: String? = null,
    val description: String = "",
    val capabilities: Capabilities = Capabilities.forKind(kind),
) {
    val id get() = name
    val displayName get() = label ?: name
    val isHermes get() = kind == "hermes"
    val isInbox get() = kind == "mcp-inbox"
    /** Short badge for non-Hermes agents in lists; null for Hermes. */
    val badge: String? get() = when (kind) { "mcp-inbox" -> "Inbox"; "openai" -> "API"; "hermes" -> null; else -> kind.replaceFirstChar { it.uppercase() } }
}

data class SessionInfo(val id: String, val title: String?, val updated: Long = 0L, val preview: String = "", val messages: Int = 0)
data class SessionPage(val sessions: List<SessionInfo>, val total: Int)
data class HistoryPage(val messages: List<UiMessage>, val hasMore: Boolean)

/** One tool call folded into an assistant turn (name, short args, short result). */
data class ToolStep(val name: String, val args: String = "", val result: String = "", val ok: Boolean = true)

/** A chat run on the hub (an agent reply that outlives the app's connection). state: running | done | error | stopped. */
data class RunInfo(val id: String, val sessionId: String?, val state: String, val started: Long)

/** What the app remembers per agent across process death: the open session, the in-flight run and the pending user text. */
data class SavedChat(val session: String? = null, val run: String? = null, val user: String? = null)

data class UiMessage(
    val role: String,
    val content: String,
    val reasoning: String = "",
    val tools: List<String> = emptyList(),
    val steps: List<ToolStep> = emptyList(),
    /** Message time (ms) for history; 0 for messages typed in this session. */
    val ts: Long = 0L,
    /** Image URLs from loaded history (data: or https:), shown in the same cards as live images. */
    val imageUrls: List<String> = emptyList(),
    /** Images the user attached: local cache file path + ready-to-send data URL. */
    val images: List<ImageAttachment> = emptyList(),
)

/** A downscaled JPEG kept in the app cache; [dataUrl] is what goes to the hub. */
data class ImageAttachment(val localPath: String, val dataUrl: String, val bytes: Int)
