package dev.foxfleet.app.ui.chat

/**
 * Whether a chat sticks to the newest message and what the "go to bottom" control says. Same rules as web/src/chat/scrollFollow.ts;
 * contract/scroll-follow.vectors.json runs against both.
 */
class ScrollFollow {
    data class Result(val pinned: Boolean, val far: Boolean, val unread: Int, val scroll: Boolean) {
        /** "none", "arrow" (round button) or "pill" (New message). */
        val control: String get() = if (pinned) "none" else if (unread > 0) "pill" else if (far) "arrow" else "none"
    }

    private var pinned = true; private var far = false; private var unread = 0; private var count = 0; private var streaming = false; private var ready = false; private var counted = false // counted: the reply now streaming already added to unread
    private fun snap(scroll: Boolean) = Result(pinned, far, unread, scroll)

    /** The user scrolled: distance in px between the viewport's bottom and the end of the content. */
    fun scroll(distance: Float): Result {
        if (distance <= PIN) { pinned = true; far = false; unread = 0 } else { pinned = false; if (distance > FAR) far = true }
        return snap(false)
    }

    /** The message list or the streaming reply changed. [prepending]: older history was added above; [loading]: history is still loading. */
    fun content(count: Int, streaming: Boolean, lastRole: String?, prepending: Boolean = false, loading: Boolean = false): Result {
        if (loading) { this.count = count; this.streaming = streaming; return snap(false) }
        if (!ready) { ready = true; pinned = true; far = false; unread = 0; this.count = count; this.streaming = streaming; return snap(true) }
        if (prepending) { this.count = count; this.streaming = streaming; return snap(false) }
        val added = maxOf(0, count - this.count); val started = streaming && !this.streaming; val committed = this.streaming && !streaming && added > 0
        if (added > 0 && lastRole == "user") { pinned = true; far = false; unread = 0 }
        else if (!pinned) {
            val fromStream = if (committed && counted) 1 else 0 // a streamed reply counts once: when it starts, or when it is committed if you scrolled away meanwhile
            unread += maxOf(0, added - fromStream) + (if (started && added == 0) 1 else 0)
            if (started && added == 0) counted = true
        }
        if (!streaming || (started && pinned)) counted = false
        this.count = count; this.streaming = streaming
        return snap(pinned)
    }

    fun jump(): Result { pinned = true; far = false; unread = 0; return snap(true) }
    fun reset(): Result { pinned = true; far = false; unread = 0; count = 0; streaming = false; ready = false; counted = false; return snap(false) }

    companion object { const val PIN = 80f; const val FAR = 120f }
}
