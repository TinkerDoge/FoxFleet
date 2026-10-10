package dev.foxfleet.app.data

import android.content.Context
import android.content.SharedPreferences

enum class ThemeMode { System, Light, Dark }
enum class TextSize(val scale: Float) { Small(0.9f), Medium(1f), Large(1.15f) }

/** Appearance and behaviour preferences shown on the Settings screen. */
data class AppPrefs(
    val theme: ThemeMode = ThemeMode.System,
    val accent: Int = 0,
    val textSize: TextSize = TextSize.Medium,
    val reduceMotion: Boolean = false,
    val haptics: Boolean = true,
)

/** Persisted app settings. Passwords are NEVER stored — only a per-hub session token. */
class SettingsStore(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("foxfleet", Context.MODE_PRIVATE))

    // ---- hubs: user-provided only; no default address ships with the app ----
    private fun readHubs(): List<HubEntry> = (prefs.getString("hubs", null) ?: "").lines().mapNotNull { line ->
        val p = line.split('\t'); if (p.size >= 3 && p[1].isNotBlank()) HubEntry(p[0], p[1], p[2]) else null
    }
    private fun writeHubs(list: List<HubEntry>) = prefs.edit().putString("hubs", list.joinToString("\n") { "${it.id}\t${it.url}\t${it.name.replace('\t', ' ').replace('\n', ' ')}" }).apply()

    val hubs: List<HubEntry> get() = readHubs()
    var activeHubId: String
        get() = prefs.getString("active_hub", null)?.takeIf { id -> readHubs().any { it.id == id } } ?: readHubs().firstOrNull()?.id ?: ""
        set(value) = prefs.edit().putString("active_hub", value).apply()
    var allowHttp: Boolean
        get() = prefs.getBoolean("allow_http", false)
        set(value) = prefs.edit().putBoolean("allow_http", value).apply()

    /** Adds (or re-uses) a hub for a normalized address and makes it active. */
    fun addHub(url: String, name: String = HubAddress.nameFor(url)): HubEntry {
        val list = readHubs(); val existing = list.firstOrNull { it.url == url }
        val entry = existing ?: HubEntry(Integer.toHexString(url.hashCode()) + Integer.toHexString(list.size), url, name)
        if (existing == null) writeHubs(list + entry)
        activeHubId = entry.id; return entry
    }
    fun switchHub(id: String) { if (readHubs().any { it.id == id }) activeHubId = id }
    fun removeHub(id: String) {
        val list = readHubs(); val wasActive = activeHubId == id
        writeHubs(list.filterNot { it.id == id }); prefs.edit().remove("token_$id").apply()
        if (wasActive) activeHubId = readHubs().firstOrNull()?.id ?: ""
    }

    /** The active hub's address, or "" before the user has added one. */
    var baseUrl: String
        get() = readHubs().firstOrNull { it.id == activeHubId }?.url ?: ""
        set(value) { if (value.isNotBlank()) addHub(value.trim().trimEnd('/')) }

    /** Bearer session token of the ACTIVE hub (rotated by the hub; never the password). */
    var sessionToken: String?
        get() = prefs.getString("token_$activeHubId", null)?.takeIf { it.isNotBlank() }
        set(value) { if (activeHubId.isNotBlank()) prefs.edit().putString("token_$activeHubId", value ?: "").apply() }

    var lastAgent: String
        get() = prefs.getString("last_agent", null) ?: ""
        set(value) = prefs.edit().putString("last_agent", value).apply()

    /** Per hub and agent: survives process death so reopening the app returns to the same chat (and its running reply). */
    fun savedChat(agent: String): SavedChat = SavedChat(
        prefs.getString("chat_s_${activeHubId}_$agent", null)?.takeIf { it.isNotBlank() },
        prefs.getString("chat_r_${activeHubId}_$agent", null)?.takeIf { it.isNotBlank() },
        prefs.getString("chat_u_${activeHubId}_$agent", null)?.takeIf { it.isNotBlank() })
    fun saveChat(agent: String, chat: SavedChat) {
        prefs.edit().putString("chat_s_${activeHubId}_$agent", chat.session ?: "").putString("chat_r_${activeHubId}_$agent", chat.run ?: "").putString("chat_u_${activeHubId}_$agent", chat.user ?: "").apply()
    }
    fun forgetChats() { val e = prefs.edit(); prefs.all.keys.filter { it.startsWith("chat_") }.forEach { e.remove(it) }; e.apply() }

    var appPrefs: AppPrefs
        get() = AppPrefs(
            theme = enumOr(prefs.getString("theme", null), ThemeMode.System),
            accent = prefs.getInt("accent", 0).coerceIn(0, ACCENT_COUNT - 1),
            textSize = enumOr(prefs.getString("text_size", null), TextSize.Medium),
            reduceMotion = prefs.getBoolean("reduce_motion", false),
            haptics = prefs.getBoolean("haptics", true),
        )
        set(v) = prefs.edit()
            .putString("theme", v.theme.name)
            .putInt("accent", v.accent.coerceIn(0, ACCENT_COUNT - 1))
            .putString("text_size", v.textSize.name)
            .putBoolean("reduce_motion", v.reduceMotion)
            .putBoolean("haptics", v.haptics)
            .apply()

    /** Sign out locally: drop the session token, keep the hub. */
    fun clearSession() { sessionToken = null; forgetChats(); forgetSeen() }

    /** Per hub and agent: the hub timestamp of the last reply you have seen on this device (drives the unread dot in the list). */
    fun seenAt(agent: String): Long? = prefs.getLong("seen_${activeHubId}_$agent", -1L).takeIf { it >= 0 }
    fun markSeen(agent: String, at: Long?) { if (at != null && at > (seenAt(agent) ?: -1L)) prefs.edit().putLong("seen_${activeHubId}_$agent", at).apply() }
    private fun forgetSeen() { val e = prefs.edit(); prefs.all.keys.filter { it.startsWith("seen_${activeHubId}_") }.forEach { e.remove(it) }; e.apply() }

    companion object {
        const val ACCENT_COUNT = 5
        private inline fun <reified E : Enum<E>> enumOr(name: String?, fallback: E): E =
            name?.let { n -> enumValues<E>().firstOrNull { it.name == n } } ?: fallback
    }
}
