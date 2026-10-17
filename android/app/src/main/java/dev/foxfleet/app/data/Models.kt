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
    /** Send modes while the agent is replying: "queue", "steer", "interrupt" (only what the agent can really do). */
    val busy: List<String> = listOf("queue"),
    /** The agent runs through Hermes's native session gateway: approval/question cards, a model picker and a real Redirect exist. */
    val nativeUi: Boolean = false,
    /** The hub keeps emoji reactions for this agent's conversations (hub 0.3.6+). */
    val reactions: Boolean = false,
    /** The agent itself can react (it has an authenticated reaction action). */
    val agentReactions: Boolean = false,
    /** Bot API transport; cards are available without the native Hermes controls. */
    val bot: Boolean = false,
) {
    val canAnswerRequests get() = nativeUi || bot

    companion object {
        /** Fallback for hubs older than 0.5 that don't send capabilities. */
        fun forKind(kind: String) = when (kind) {
            "hermes" -> Capabilities(images = true, files = true, screen = true, voice = true, skills = true, sessions = true, busy = listOf("queue", "interrupt"))
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
    /** "hermes" (the only kind today; kept so other kinds can return). */
    val kind: String = "hermes",
    val label: String? = null,
    val description: String = "",
    val capabilities: Capabilities = Capabilities.forKind(kind),
    /** Registry position on the hub: the tie-break for agents with no activity. */
    val order: Int = 0,
    /** Per-user list line (hub 0.3.4): when, what and which chat was last active; pin state; running / waiting flags. */
    val lastActivityAt: Long? = null,
    val lastSessionTitle: String? = null,
    val lastMessagePreview: String? = null,
    /** "user" or "assistant". */
    val lastRole: String? = null,
    val pinOrder: Int? = null,
    val working: Boolean = false,
    val needsInput: Boolean = false,
) {
    val pinned get() = pinOrder != null
    val id get() = name
    val displayName get() = label ?: name
    val isHermes get() = kind == "hermes"
    /** Short badge for non-Hermes agents in lists; null for Hermes. */
    val badge: String? get() = if (kind == "hermes") null else kind.replaceFirstChar { it.uppercase() }
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
    /** Stable hub/provider message identity, absent until the live turn is reconciled with history. */
    val id: String? = null,
    val reasoning: String = "",
    /** How long the agent thought (ms) when known: shown in the Reasoning header. */
    val reasoningMs: Long = 0L,
    val tools: List<String> = emptyList(),
    val steps: List<ToolStep> = emptyList(),
    /** Message time (ms) for history; 0 for messages typed in this session. */
    val ts: Long = 0L,
    /** Image URLs from loaded history (data: or https:), shown in the same cards as live images. */
    val imageUrls: List<String> = emptyList(),
    /** Images the user attached: local cache file path + ready-to-send data URL. */
    val images: List<ImageAttachment> = emptyList(),
    /** Phase 1 (0.4.0, `readReceipts`/`live2`): the hub's own id (never changes; the cache key), its gap-free number in the chat, and for your own messages sent/delivered/read/failed. */
    val hubId: String? = null,
    val n: Int? = null,
    val status: String? = null,
)

/** A downscaled JPEG kept in the app cache; [dataUrl] is what goes to the hub. */
data class ImageAttachment(val localPath: String, val dataUrl: String, val bytes: Int)

/** One tool lifecycle event from the hub stream (foxfleet.tool). [type] is tool.start, tool.progress or tool.end. */
data class ToolEvent(val type: String, val turnId: String?, val toolId: String?, val name: String)

/** Who reacted: the signed-in person ("user:…") or an agent ("agent:…"), bound by the hub, never by the client. */
data class ReactionActor(val id: String, val name: String, val kind: String)
data class ReactionGroup(val emoji: String, val actors: List<ReactionActor>)
/** The hub's reactions for one conversation: who "you" are, the reactions on each stable message id, and what you hid ("delete for me"). */
data class ReactionSnapshot(val actor: ReactionActor, val messages: Map<String, List<ReactionGroup>>, val hidden: Set<String>? = null)
