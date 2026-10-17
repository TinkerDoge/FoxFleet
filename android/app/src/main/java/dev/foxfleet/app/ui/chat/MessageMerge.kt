package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.MessageStatus

/**
 * How two copies of one message become one (0.4.1). The streamed reply knows the thinking, its timing and the steps; the hub's
 * copy (message.new, a history page) knows the ids and the stored text. Neither may wipe what only the other has.
 */
object MessageMerge {
    /** [new] wins for text and ids; thinking, timing, steps, local pictures and the run id stay when [new] has none. Ticks only on your own messages. */
    fun merge(old: UiMessage, new: UiMessage): UiMessage = new.copy(
        reasoning = new.reasoning.ifEmpty { old.reasoning }, reasoningMs = if (new.reasoningMs > 0) new.reasoningMs else old.reasoningMs,
        tools = new.tools.ifEmpty { old.tools }, steps = new.steps.ifEmpty { old.steps },
        images = old.images, imageUrls = new.imageUrls.ifEmpty { old.imageUrls }, id = new.id ?: old.id, ts = if (new.ts > 0) new.ts else old.ts,
        hubId = new.hubId ?: old.hubId, n = new.n ?: old.n, runId = new.runId ?: old.runId,
        status = if (new.role == "user") MessageStatus.advance(old.status, new.status) else null,
    )

    /** Which shown agent message (no hub id yet, at the end of the list) a live [m] is: same run first, else the same text. */
    fun replyIndex(messages: List<UiMessage>, m: UiMessage): Int? {
        val tail = (messages.lastIndex downTo maxOf(0, messages.size - 3)).filter { messages[it].role == "assistant" && messages[it].hubId == null }
        m.runId?.let { r -> tail.firstOrNull { messages[it].runId == r }?.let { return it } }
        return tail.firstOrNull { messages[it].content.trim() == m.content.trim() }
    }

    /**
     * A page from the hub replaces the list (load, reconcile, catch-up): its agent messages that carry no thinking or steps get the
     * ones the shown copy had (matched by hub id, provider id, run id, then same text).
     */
    fun carry(shown: List<UiMessage>, page: List<UiMessage>): List<UiMessage> {
        val rich = shown.filter { it.role == "assistant" && (it.reasoning.isNotEmpty() || it.steps.isNotEmpty()) }
        if (rich.isEmpty()) return page
        val used = HashSet<Int>()
        return page.map { m ->
            if (m.role != "assistant" || (m.reasoning.isNotEmpty() && m.steps.isNotEmpty())) return@map m
            val k = rich.indices.firstOrNull { it !in used && m.hubId != null && rich[it].hubId == m.hubId }
                ?: rich.indices.firstOrNull { it !in used && m.id != null && rich[it].id == m.id }
                ?: rich.indices.firstOrNull { it !in used && m.runId != null && rich[it].runId == m.runId }
                ?: rich.indices.firstOrNull { it !in used && rich[it].content.trim() == m.content.trim() && m.content.isNotBlank() }
                ?: return@map m
            used += k; val o = rich[k]
            m.copy(reasoning = m.reasoning.ifEmpty { o.reasoning }, reasoningMs = if (m.reasoningMs > 0) m.reasoningMs else o.reasoningMs, steps = m.steps.ifEmpty { o.steps }, runId = m.runId ?: o.runId)
        }
    }
}
