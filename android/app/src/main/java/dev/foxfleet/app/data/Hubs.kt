package dev.foxfleet.app.data

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** A hub the user has added. The app has NO built-in hub address: every address comes from the user. */
data class HubEntry(val id: String, val url: String, val name: String)

/** What GET /api/auth says about the hub and this device. */
data class AuthInfo(
    val required: Boolean = true,
    val authenticated: Boolean = false,
    val setupRequired: Boolean = false,
    val setupCodeRequired: Boolean = false,
    val registration: String = "closed",
    val username: String? = null,
    val role: String? = null,
    val termsVersion: String? = null,
) { val isOwner get() = role == "owner" }

data class ConnectLink(val hub: String, val invite: String? = null)

data class AdminUser(val id: String, val username: String, val role: String, val disabled: Boolean)
data class Invite(val id: String, val expires: Long, val used: Boolean)
/** A freshly made code: [link] is what gets shared; [rows] is the QR matrix ('1' dark, '0' light) or null when too long. */
data class Shareable(val link: String, val rows: List<String>?, val invite: Invite? = null)

data class Device(val id: String, val name: String, val kind: String, val lastSeen: Long, val current: Boolean)

object HubAddress {
    const val PLACEHOLDER = "https://hub.example.com"

    /** Lowercase hosts that count as "your own network": http is acceptable there once the user opts in. */
    fun isLocalHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']')
        if (h == "localhost" || h == "::1" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true
        if (!h.contains('.') && !h.contains(':')) return true // single-label LAN names
        val p = h.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size == 4 && h.all { it.isDigit() || it == '.' }) {
            return p[0] == 10 || p[0] == 127 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && p[1] in 16..31) || (p[0] == 169 && p[1] == 254)
        }
        return h.startsWith("fd") || h.startsWith("fe80")
    }

    /** Returns the cleaned hub origin, or an error message. https is required unless [allowHttp] and the host is local. */
    fun normalize(input: String, allowHttp: Boolean): Pair<String?, String?> {
        var text = input.trim()
        if (text.isEmpty()) return null to "Enter your hub address"
        if (text.any { it.isWhitespace() }) return null to "That address has spaces in it"
        if (!text.contains("://")) text = "https://$text"
        val url = text.toHttpUrlOrNull() ?: return null to "That doesn't look like an address"
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null to "Don't put a username or password in the address"
        if (url.encodedPath != "/" || url.query != null || url.fragment != null) return null to "Use just the address, like $PLACEHOLDER"
        if (url.scheme == "http") {
            if (!isLocalHost(url.host)) return null to "Use https:// — plain http is only for your own network"
            if (!allowHttp) return null to "Turn on \"Allow http on this network\" to use a local hub"
        }
        val port = if (url.port == HttpUrlDefault.of(url.scheme)) "" else ":${url.port}"
        val host = if (url.host.contains(':')) "[${url.host}]" else url.host
        return "${url.scheme}://$host$port" to null
    }

    /** foxfleet://connect?hub=https://host[&name=Home] → the raw hub address (still goes through [normalize]). */
    fun fromLink(link: String): String? {
        val m = Regex("^foxfleet://connect\\?(.*)$", RegexOption.IGNORE_CASE).matchEntire(link.trim()) ?: return null
        val hub = m.groupValues[1].split('&').map { it.split('=', limit = 2) }.firstOrNull { it[0] == "hub" && it.size == 2 }?.get(1) ?: return null
        return runCatching { java.net.URLDecoder.decode(hub, "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    fun parseLink(link: String): ConnectLink? {
        val m = Regex("^foxfleet://connect\\?(.*)$", RegexOption.IGNORE_CASE).matchEntire(link.trim()) ?: return null
        val kv = m.groupValues[1].split('&').map { it.split('=', limit = 2) }.filter { it.size == 2 }.associate { it[0] to (runCatching { java.net.URLDecoder.decode(it[1], "UTF-8") }.getOrNull() ?: "") }
        val hub = kv["hub"]?.takeIf { it.isNotBlank() } ?: return null
        return ConnectLink(hub, kv["invite"]?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{8,64}")) })
    }

    /** Short display name for a hub that never shows a path or credentials: the host. */
    fun nameFor(url: String): String = url.toHttpUrlOrNull()?.host ?: "Hub"
}

private object HttpUrlDefault { fun of(scheme: String) = if (scheme == "https") 443 else 80 }
