package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentStatus
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** The agent list rules. The same rules run in the hub and the web app; contract/agent-list.vectors.json pins them. */
object AgentList {
    /** Pinned first (in the order they were pinned), then newest activity, then quiet agents in registry order. */
    fun sort(list: List<AgentStatus>): List<AgentStatus> = list.sortedWith(Comparator { a, b ->
        val pa = a.pinOrder ?: -1; val pb = b.pinOrder ?: -1
        when {
            (pa >= 0) != (pb >= 0) -> if (pa >= 0) -1 else 1
            pa >= 0 -> pa.compareTo(pb)
            else -> {
                val ta = a.lastActivityAt ?: 0L; val tb = b.lastActivityAt ?: 0L
                if (ta != tb) tb.compareTo(ta) else a.order.compareTo(b.order)
            }
        }
    })

    /** Right-hand time: the clock today, "Yesterday", the weekday within the last week, a short date after that (with the year when it is not this year). */
    fun time(ms: Long?, now: Long = System.currentTimeMillis(), locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (ms == null || ms <= 0L) return ""
        val d = Instant.ofEpochMilli(ms).atZone(zone); val n = Instant.ofEpochMilli(now).atZone(zone)
        val days = java.time.temporal.ChronoUnit.DAYS.between(d.toLocalDate(), n.toLocalDate())
        return when {
            days <= 0 -> DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(d)
            days == 1L -> if (locale.language == "en") "Yesterday" else DateTimeFormatter.ofPattern("EEE", locale).format(d)
            days < 7 -> DateTimeFormatter.ofPattern("EEE", locale).format(d)
            d.year == n.year -> DateTimeFormatter.ofPattern("MMM d", locale).format(d)
            else -> DateTimeFormatter.ofPattern("MMM d, yyyy", locale).format(d)
        }
    }

    enum class Kind { Typing, Approval, Text, Empty }
    data class Preview(val kind: Kind, val text: String, val you: Boolean)

    /** Second line of a row. Running work and open requests win over the last message; "You: " marks your own. */
    fun preview(a: AgentStatus, runningHere: Boolean = false): Preview {
        if (a.needsInput) return Preview(Kind.Approval, "", false)
        if (a.working || runningHere) return Preview(Kind.Typing, "", false)
        a.lastMessagePreview?.trim()?.takeIf { it.isNotEmpty() }?.let { return Preview(Kind.Text, it, a.lastRole == "user") }
        a.lastSessionTitle?.trim()?.takeIf { it.isNotEmpty() }?.let { return Preview(Kind.Text, it, false) }
        return Preview(Kind.Empty, a.description.lineSequence().firstOrNull()?.trim().orEmpty(), false)
    }

    /** Unread = the agent spoke after you last looked at this chat (kept per hub on this device). A new device starts out read. */
    fun unread(a: AgentStatus, seenAt: Long?, open: Boolean): Boolean {
        if (open || a.lastRole != "assistant") return false
        val at = a.lastActivityAt ?: return false
        return seenAt != null && at > seenAt
    }
}
