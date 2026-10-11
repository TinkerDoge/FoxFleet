package dev.foxfleet.app.notify

/** What is open on screen right now. Set by the UI, read by the service. */
object NotifyForeground {
    @Volatile var visible: Boolean = false
    @Volatile var agent: String? = null
    /** The session id of the chat open for [agent], when the UI knows it. */
    @Volatile var chatIdOf: (String) -> String? = { null }
    fun isOpen(agent: String?, chat: String?): Boolean = visible && agent != null && chat != null && this.agent == agent && chatIdOf(agent) == chat
}

object NotifyPolicy {
    enum class Drop { HubMuted, CategoryOff, AgentMuted, ChatMuted, ChatOpen, Unknown }
    sealed interface Decision { data object Show : Decision; data class Skip(val why: Drop) : Decision }

    /**
     * Whether an event becomes a notification. The hub already withheld muted events from the stream, so most of this is a second check:
     * a mute set after the event was created, a replayed event, and the things only the device knows (categories, the chat that is open).
     * Approvals break through a chat mute and through "chat is open" (the contract's rule); they do not break through an agent mute.
     */
    fun decide(e: NotifyEvent, categories: Set<NotifyCategory>, mutes: List<MuteRule>, now: Long, chatOpen: Boolean): Decision {
        if (e.type == NotifyType.Other) return Decision.Skip(Drop.Unknown)
        if (e.muted) return Decision.Skip(Drop.HubMuted)
        if (e.type == NotifyType.Test) return Decision.Show
        val cat = NotifyCategory.of(e.type) ?: return Decision.Skip(Drop.Unknown)
        if (cat !in categories) return Decision.Skip(Drop.CategoryOff)
        if (mutes.any { it.chat == null && it.agent == e.agent && it.activeAt(now) }) return Decision.Skip(Drop.AgentMuted)
        if (e.type != NotifyType.Approval) {
            if (mutes.any { it.chat != null && it.agent == e.agent && it.chat == e.chat && it.activeAt(now) }) return Decision.Skip(Drop.ChatMuted)
            if (chatOpen) return Decision.Skip(Drop.ChatOpen)
        }
        return Decision.Show
    }

    /** Replayed events (a reconnect after the service was down): old ones are dropped, the rest collapse to the newest per chat and type. */
    fun coalesceReplay(events: List<NotifyEvent>, now: Long, maxAgeMs: Long = 6 * 3600_000L): List<NotifyEvent> =
        events.filter { it.type != NotifyType.Test && it.type != NotifyType.Other && (it.type == NotifyType.Approval || now - it.at <= maxAgeMs) }
            .groupBy { Triple(it.chatKey, it.type, if (it.type == NotifyType.Approval) it.requestId else null) }
            .map { (_, v) -> v.maxBy { it.id } }.sortedBy { it.id }
}

/** Permission state for POST_NOTIFICATIONS. The system gives no direct "don't ask again", so it is derived. */
enum class PermissionState {
    /** Android 12 and older, or already granted. */
    Granted,
    /** Never asked: show the rationale, then the system dialog. */
    NeedsRequest,
    /** Asked and denied once, the system will still show its dialog: show the rationale again. */
    Denied,
    /** Denied with "don't ask again" (or twice): only the system settings can change it. */
    Blocked;
    val ok get() = this == Granted

    companion object {
        /**
         * @param sdk Build.VERSION.SDK_INT; below 33 there is no runtime permission.
         * @param granted the permission is granted (or, below 33, notifications are not turned off in the system settings).
         * @param asked the dialog was shown before.
         * @param shouldShowRationale ActivityCompat.shouldShowRequestPermissionRationale: true after one denial.
         */
        fun of(sdk: Int, granted: Boolean, asked: Boolean, shouldShowRationale: Boolean): PermissionState = when {
            granted -> Granted
            sdk < 33 -> Blocked // notifications are off in the system settings: no dialog exists
            !asked -> NeedsRequest
            shouldShowRationale -> Denied
            else -> Blocked
        }
    }
}
