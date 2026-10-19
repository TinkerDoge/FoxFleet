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
    /** How this agent changes models (hub 0.4.1): "native", "request" or "none". Null: an older hub that does not say. */
    val models: String? = null,
) {
    val canAnswerRequests get() = nativeUi || bot
    /** The model picker's path: the hub's own word, else (older hubs) only the native gateway has one. */
    val modelsMode: String get() = models?.takeIf { it in MODEL_MODES } ?: if (nativeUi) "native" else "none"

    companion object {
        val MODEL_MODES = setOf("native", "request", "none")
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
/** One tool call of a finished reply. [ok] is null when the agent never reported an outcome (shown neutral, not as a success). */
data class ToolStep(val name: String, val args: String = "", val result: String = "", val ok: Boolean? = true)

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
    /** The hub run that wrote this reply (0.4.1): the live reply's message.new is merged into the streamed bubble by it. */
    val runId: String? = null,
    /** 0.4.1 hubs (`reaction_only`): an agent reply that is only its REACT: line. Its reaction shows on your message; it draws no bubble. */
    val reactionOnly: Boolean = false,
)

/**
 * A group room is its own thing, never an [AgentStatus]: it has members, not one agent. The hub's
 * `/api/conversations…` models (web `Conversation`) are mirrored here field for field.
 */
data class ConversationMember(
    val id: String,
    val name: String,
    /** "human" or "agent". */
    val kind: String,
    val isBot: Boolean = kind == "agent",
    val joinedAt: Long = 0L,
) {
    val isAgent get() = kind == "agent"
}

/** One group room. [owner] is a human member; [members] are the active agent members (never the owner). */
data class Conversation(
    val id: String,
    val threadId: String,
    val chatType: String = "group",
    val title: String,
    val owner: ConversationMember,
    val members: List<ConversationMember>,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
    val archived: Boolean = false,
    val unreadCount: Int = 0,
    val lastMessageAt: Long? = null,
    val paused: Boolean = false,
    val epoch: Long = 1L,
) {
    val agentMembers get() = members.filter { it.isAgent }
    fun memberFor(idOrName: String): ConversationMember? = members.firstOrNull { it.id == idOrName || it.name == idOrName }
    /** Owner controls (Stop/cards) require a known signed-in id. A missing id is not "I am the owner". */
    fun ownedBy(userId: String?) = userId != null && owner.id == userId
    /** The room list order: newest activity first, then title (same as the web client). */
    val activityAt get() = maxOf(lastMessageAt ?: 0L, updatedAt)
}

/** One explicit typed mention. [id] is `agent:<name>`; offsets are character spans into the message text. */
data class ConversationMention(val kind: String = "agent", val id: String, val offset: Int, val length: Int)

data class ConversationMedia(
    val id: String,
    val kind: String,
    val mime: String,
    val name: String,
    val size: Long = 0L,
    val sha256: String? = null,
)

/** One room message. [sender] identifies the author: each agent keeps its own name and bubbles. */
data class ConversationMessage(
    val id: String,
    val conversationId: String,
    val sender: ConversationMember,
    val text: String,
    val createdAt: Long,
    val replyTo: String? = null,
    val mentions: List<ConversationMention> = emptyList(),
    val edited: Boolean = false,
    val media: List<ConversationMedia> = emptyList(),
    val system: Boolean = false,
    val code: String? = null,
    val deliveryState: String? = null,
    val dispatchId: String? = null,
    val rootId: String? = null,
    val seq: Int? = null,
    val deleted: Boolean = false,
) {
    fun isMine(meId: String?) = meId != null && sender.id == meId
}

data class ConversationPage(val messages: List<ConversationMessage>, val hasMore: Boolean, val nextCursor: Int? = null, val total: Int = 0)
data class ConversationList(val conversations: List<Conversation>, val total: Int = 0)
data class ConversationStopResult(val stopped: Boolean, val confirmed: Boolean, val state: String? = null, val epoch: Long? = null, val paused: Boolean? = null)
data class ConversationPreferences(val muted: Boolean = false, val notify: String = "all", val archived: Boolean = false, val pinned: Boolean? = null)

/** A downscaled JPEG kept in the app cache; [dataUrl] is what goes to the hub. */
data class ImageAttachment(val localPath: String, val dataUrl: String, val bytes: Int)

/** One tool lifecycle event from the hub stream (foxfleet.tool). [type] is tool.start, tool.progress or tool.end. */
data class ToolEvent(
    val type: String, val turnId: String?, val toolId: String?, val name: String,
    /** 0.4.1 hubs: short argument preview; on tool.end whether it worked, how long it took and a short result. */
    val preview: String? = null, val ok: Boolean? = null, val durationMs: Long? = null, val resultPreview: String? = null,
)

/** Who reacted: the signed-in person ("user:…") or an agent ("agent:…"), bound by the hub, never by the client. */
data class ReactionActor(val id: String, val name: String, val kind: String)
data class ReactionGroup(val emoji: String, val actors: List<ReactionActor>)
/**
 * The hub's reactions for one conversation: who "you" are, the reactions on each provider message id, and what you hid ("delete for me").
 * [byHub] (0.4.1 hubs, `by_hub_id`): the same reactions keyed by hub id, for every message the hub numbered, so a message that only
 * arrived live has them too. Null on older hubs. A key with an empty list means "none" (it overrides [messages]).
 */
data class ReactionSnapshot(val actor: ReactionActor, val messages: Map<String, List<ReactionGroup>>, val hidden: Set<String>? = null, val byHub: Map<String, List<ReactionGroup>>? = null) {
    /** The reactions shown under [m]: by hub id when the hub keys them so, else by provider id. */
    fun groupsFor(m: UiMessage): List<ReactionGroup> {
        val h = m.hubId; val b = byHub
        if (h != null && b != null && b.containsKey(h)) return b[h].orEmpty()
        return m.id?.let { messages[it] }.orEmpty()
    }
    /** `message.reaction` (and a message's own `reactions`): the full set on one message REPLACES what was there ([] = none). */
    fun replace(hubId: String?, upstreamId: String?, groups: List<ReactionGroup>): ReactionSnapshot {
        val clean = groups.filter { it.actors.isNotEmpty() }
        return copy(
            messages = if (upstreamId == null) messages else if (clean.isEmpty()) messages - upstreamId else messages + (upstreamId to clean),
            byHub = if (hubId == null) byHub else (byHub.orEmpty()) + (hubId to clean),
        )
    }
}
