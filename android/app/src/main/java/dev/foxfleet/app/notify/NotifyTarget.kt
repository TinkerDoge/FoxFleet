package dev.foxfleet.app.notify

import java.net.URLDecoder
import java.net.URLEncoder

/** Where a notification leads: `foxfleet://chat?hub=<hubId>&agent=<name>&chat=<session>[&approval=<request id>]`. Ids only, never message text. */
data class NotifyTarget(val hub: String, val agent: String, val chat: String, val approval: String? = null) {
    fun toUri(): String = "foxfleet://chat?hub=${enc(hub)}&agent=${enc(agent)}&chat=${enc(chat)}" + (approval?.let { "&approval=${enc(it)}" } ?: "")

    companion object {
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        fun parse(link: String?): NotifyTarget? {
            val m = Regex("^foxfleet://chat\\?(.*)$", RegexOption.IGNORE_CASE).matchEntire(link?.trim().orEmpty()) ?: return null
            val kv = m.groupValues[1].split('&').map { it.split('=', limit = 2) }.filter { it.size == 2 }
                .associate { it[0] to (runCatching { URLDecoder.decode(it[1], "UTF-8") }.getOrNull() ?: "") }
            val ok = Regex("[\\w.:@-]{1,128}")
            val hub = kv["hub"]?.takeIf { it.matches(ok) } ?: return null
            val agent = kv["agent"]?.takeIf { it.matches(ok) } ?: return null
            val chat = kv["chat"]?.takeIf { it.matches(ok) } ?: return null
            return NotifyTarget(hub, agent, chat, kv["approval"]?.takeIf { it.matches(ok) })
        }
    }
}
