package dev.foxfleet.app.data.local

import android.content.Context
import android.content.SharedPreferences

/**
 * Who the cache belongs to: the account + hub key of the last real sign-in ([dev.foxfleet.app.data.ChatBgOwner.key]) and the
 * account name (the media cache is per account). A different owner signing in wipes the cache first; a sign-out wipes it too
 * (it holds message text). An offline start may open the cache only for the owner of the active hub.
 */
class CacheOwner(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("foxfleet_cache", Context.MODE_PRIVATE))

    val key: String? get() = prefs.getString("owner", null)
    val account: String? get() = prefs.getString("account", null)
    val hub: String? get() = prefs.getString("hub", null)

    /** A real sign-in. True when a different owner held the cache, so the caller must wipe it before use. */
    fun claim(key: String, account: String, hub: String): Boolean {
        val changed = this.key != null && this.key != key
        prefs.edit().putString("owner", key).putString("account", account).putString("hub", hub).apply()
        return changed
    }

    /** The owner whose cache may open offline for [hub] (the active hub URL), or null: never another hub's cache. */
    fun offlineOwner(hub: String): String? = key?.takeIf { this.hub == hub }

    fun forget() { prefs.edit().clear().apply() }
}
