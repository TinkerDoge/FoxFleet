package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.FileMarker
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.UiMessage

const val HEART = "❤️"

/** Who wrote the quoted message and a one-line excerpt of it. */
data class ReplyTarget(val author: String, val excerpt: String)
data class Quoted(val quote: String, val body: String)

/** Menu entries, in menu order. */
enum class MessageAction(val label: String, val icon: String) {
    Reply("Reply", "reply"), Copy("Copy", "copy"), Select("Select text", "selectAll"), Share("Share", "share"),
    Retry("Retry", "retry"), Edit("Edit", "edit"), Delete("Delete for me", "delete"),
}

/** Message actions without UI: quotes, excerpts, what is shown, what the menu offers. Same rules as web/src/chat/messageActions.ts. */
object MessageActions {
    /** The quote line, then a blank line; or the quote alone (a reply with only pictures: the send trims the blank line away). */
    private val quote = Regex("^> ([^\\n]*)(?:\\n\\n|\\z)")

    fun splitQuote(text: String): Quoted? = quote.find(text)?.let { Quoted(it.groupValues[1], text.substring(it.range.last + 1)) }
    fun withQuote(reply: ReplyTarget?, text: String) = if (reply == null) text else "> ${reply.excerpt}\n\n$text"

    /** What a person sees of a message as plain text: tags, REACT: lines, file lines and a reply quote removed. */
    fun displayText(m: UiMessage): String =
        if (m.role == "assistant") MediaTags.parse(m.content).text else FileMarker.split(m.content).first.let { splitQuote(it)?.body ?: it }

    /** One line, at most 140 characters, for the quote line of a reply. */
    fun excerpt(m: UiMessage): String {
        val t = displayText(m).replace(Regex("\\s+"), " ").trim()
        if (t.isNotEmpty()) { val cps = t.codePoints().toArray(); return if (cps.size > 140) String(cps, 0, 139) + "…" else t }
        val media = if (m.role == "assistant") MediaTags.parse(m.content).media else emptyList()
        return when {
            m.images.isNotEmpty() || m.imageUrls.isNotEmpty() || media.any { it.kind == TagMedia.Kind.Image || it.kind == TagMedia.Kind.Video } -> "[image]"
            media.any { it.kind == TagMedia.Kind.Audio } -> "[voice]"
            else -> "[file]"
        }
    }

    /** A finished reply that is only a REACT: line (or nothing) draws no row; its reaction shows on the user's message. */
    fun emptyReply(m: UiMessage): Boolean {
        if (m.role != "assistant" || m.reasoning.isNotBlank() || m.imageUrls.isNotEmpty()) return false
        val p = MediaTags.parse(m.content); return p.text.isBlank() && p.media.isEmpty()
    }

    /** Messages to draw, with their index in the full list (list keys stay stable when one is hidden). */
    fun visible(messages: List<UiMessage>, hidden: Set<String>): List<IndexedValue<UiMessage>> =
        messages.withIndex().filter { (_, m) -> (m.id == null || m.id !in hidden) && !emptyReply(m) }

    /** What Retry and Edit apply to (null when nothing qualifies). */
    data class Targets(val assistant: UiMessage?, val user: UiMessage?)

    /**
     * The messages Retry and Edit apply to. Retry: the newest reply, only while it is the last message (notices aside), since it
     * sends the last user message again. Edit: the newest user message, only once a reply follows it (/undo takes back a whole exchange).
     */
    fun newestTargets(messages: List<UiMessage>): Targets {
        val turns = messages.filter { it.role != "system" }
        var user: UiMessage? = null; var replied = false
        for (i in turns.indices.reversed()) { if (turns[i].role == "assistant") replied = true else if (turns[i].role == "user") { user = turns[i]; break } }
        return Targets(turns.lastOrNull()?.takeIf { it.role == "assistant" }, if (replied) user else null)
    }

    /** Which actions a message offers, in menu order. Delete needs a hub id; Retry/Edit only on [newestTargets], and never while busy (a reply streaming or messages waiting). */
    fun actions(m: UiMessage, newestAssistant: Boolean, newestUser: Boolean, busy: Boolean, hermes: Boolean, canHide: Boolean): List<MessageAction> = buildList {
        add(MessageAction.Reply)
        if (displayText(m).isNotBlank()) { add(MessageAction.Copy); add(MessageAction.Select); add(MessageAction.Share) }
        if (m.role == "assistant" && newestAssistant && !busy) add(MessageAction.Retry)
        if (m.role == "user" && newestUser && hermes && !busy) add(MessageAction.Edit)
        if (m.id != null && canHide) add(MessageAction.Delete)
    }

    /** Picking an emoji adds it, or takes yours back when you already reacted with it (like a pill). Returns the `present` value to send. */
    fun nextReaction(groups: List<ReactionGroup>, me: String, emoji: String) = groups.none { g -> g.emoji == emoji && g.actors.any { it.id == me } }

    /** Double-tap: add a heart, or take yours back. Returns the `present` value to send. */
    fun nextHeart(groups: List<ReactionGroup>, me: String) = nextReaction(groups, me, HEART)

    /** A drag that starts within [edgePx] of the screen's left edge belongs to the system back gesture. */
    fun swipeAllowed(startXInWindow: Float, edgePx: Float) = startXInWindow > edgePx
    fun swipeFires(dragPx: Float, thresholdPx: Float) = dragPx >= thresholdPx
}
