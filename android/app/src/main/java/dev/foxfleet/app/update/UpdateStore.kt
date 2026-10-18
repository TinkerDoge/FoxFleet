package dev.foxfleet.app.update

import android.content.Context

/** Remembers the last cold-start update check so it runs at most once per 12 hours. */
class UpdateStore(context: Context) {
    private val prefs = context.getSharedPreferences("foxfleet_update", Context.MODE_PRIVATE)

    fun lastCheck(): Long = prefs.getLong(KEY_LAST_CHECK, 0L)
    fun markChecked(now: Long) { prefs.edit().putLong(KEY_LAST_CHECK, now).apply() }
    fun due(now: Long): Boolean = now - lastCheck() >= INTERVAL_MS

    companion object {
        const val INTERVAL_MS = 12L * 60 * 60 * 1000
        private const val KEY_LAST_CHECK = "lastCheck"
    }
}
