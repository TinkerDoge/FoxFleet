package dev.foxfleet.app.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Terms of Use / Privacy Policy acceptance. The hub records the version and time when the account is created;
 * the app also remembers locally, per hub, which version this device accepted.
 */
object Terms {
    const val DOCS = "https://tinkerdoge.github.io/FoxFleet/legal/"
    const val TERMS_URL = DOCS + "terms"
    const val PRIVACY_URL = DOCS + "privacy"
    const val FALLBACK_VERSION = "1.0"

    fun key(hub: String) = "terms.$hub"
    fun prefs(context: Context): SharedPreferences = context.getSharedPreferences("foxfleet_terms", Context.MODE_PRIVATE)
    fun accepted(prefs: SharedPreferences, hub: String, version: String) = prefs.getString(key(hub), null) == version
    fun remember(prefs: SharedPreferences, hub: String, version: String) { prefs.edit().putString(key(hub), version).apply() }
}
