package dev.foxfleet.app.ui

/** What this app needs from the hub. Hubs before 0.3.5 report no feature list, which is itself the answer ("update your hub"). */
object HubCompat {
    val needs = mapOf(
        "agentActivity" to "previews and times on the agent list",
        "media" to "pictures, videos and files from agents",
        "screenErrors" to "clear messages when a computer view cannot open",
        "mediaTags" to "media cards for tool-made files",
    )
    /** Null = the hub reported no version (older than 0.3.5): assume all are missing. */
    fun missing(version: String?, features: List<String>): List<String>? = if (version == null) null else needs.keys.filter { it !in features }
    fun isOld(version: String?, features: List<String>): Boolean = missing(version, features).let { it == null || it.isNotEmpty() }
}

/** The last message of each chat, kept on this device. The agent list falls back to it when the hub does not know (older hub, unseeded chat). */
object LocalLast {
    data class Entry(val at: Long, val role: String, val text: String)
    fun preview(text: String): String {
        val s = text.replace(Regex("(?im)^\\s*MEDIA:.*$"), "").replace(Regex("```[\\s\\S]*?```"), " [code] ").replace(Regex("!\\[[^\\]]*]\\([^)]*\\)"), "[image]")
            .replace(Regex("[*_`#>]+"), "").replace(Regex("\\s+"), " ").trim()
        return if (s.length > 140) s.take(139) + "…" else s
    }
    fun encode(e: Entry) = "${e.at}|${e.role}|${e.text}"
    fun decode(raw: String?): Entry? {
        raw ?: return null; val a = raw.indexOf('|'); val b = raw.indexOf('|', a + 1); if (a < 0 || b < 0) return null
        val at = raw.substring(0, a).toLongOrNull() ?: return null; val role = raw.substring(a + 1, b); if (role != "user" && role != "assistant") return null
        return Entry(at, role, raw.substring(b + 1))
    }
    /** The hub's answer wins when it is at least as new and has a preview; otherwise this device knows better. Never invents anything. */
    fun merge(a: dev.foxfleet.app.data.AgentStatus, l: Entry?): dev.foxfleet.app.data.AgentStatus {
        l ?: return a
        val hubAt = a.lastActivityAt ?: 0L
        if (hubAt >= l.at && !a.lastMessagePreview.isNullOrBlank()) return a
        if (hubAt > l.at) return a
        return a.copy(lastActivityAt = l.at, lastMessagePreview = l.text, lastRole = l.role)
    }
}
