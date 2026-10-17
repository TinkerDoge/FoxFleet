package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.live.HubChat
import dev.foxfleet.app.data.live.LinkState

/** Chat-list logic over the hub's rows (feature `chats`), JVM-testable. */
object ChatRows {
    /** The launcher badge: unread over rows that are neither archived nor muted (the contract's `total_unread`). */
    fun badgeTotal(rows: Collection<HubChat>, now: Long): Int = rows.filter { !it.archived && !it.mutedAt(now) }.sumOf { it.unread }

    /** Main list or archived view: agents filtered by their row; agents without a row (new, hub without `chats`) stay in the main list. */
    fun visible(agents: List<AgentStatus>, rows: Map<String, HubChat>, archived: Boolean): List<AgentStatus> =
        agents.filter { (rows[it.name]?.archived == true) == archived }

    /** "You: text" / "Atlas: text": the sender as the hub names it. */
    data class Preview(val sender: String?, val text: String)
    fun preview(r: HubChat): Preview? {
        val m = r.last ?: return null
        if (m.preview.isBlank()) return null
        val sender = when { m.role == "user" || m.sender == "you" -> "You"; else -> m.sender?.takeIf { it.isNotBlank() } ?: r.label }
        return Preview(sender, m.preview)
    }

    /** Badge text: up to 999, then "999+". */
    fun badgeText(n: Int) = if (n > 999) "999+" else n.toString()

    /** What the title says while the link is not live; null when live (no indicator). */
    fun linkLabel(s: LinkState?): String? = when (s) {
        null, LinkState.Live -> null
        LinkState.Connecting -> "Connecting…"
        LinkState.Updating -> "Updating…"
        LinkState.Offline -> "Offline"
    }
    /** The row after you sent a message in it: the hub reads the chat up to your message, so no badge and no manual unread. */
    fun afterSend(r: HubChat): HubChat = if (r.unread == 0 && !r.manualUnread) r else r.copy(unread = 0, manualUnread = false)
}
