package dev.foxfleet.app.notify

import android.content.Context
import android.content.SharedPreferences

/** The (hub, account) a notification service belongs to. Everything stored for notifications is keyed by it, and cleared when either changes. */
data class NotifyBinding(val hubId: String, val account: String) {
    val key: String get() = "$hubId|${account.replace('|', '_')}"
}

/** Reads and writes the session token of one hub in the app's settings file (the same `token_<hubId>` key SettingsStore and HubApi use), so a rotation seen by any of them is seen by all. */
class HubTokens(private val prefs: SharedPreferences, private val hubId: String) : TokenSource {
    override fun get(): String? = prefs.getString("token_$hubId", null)?.takeIf { it.isNotBlank() }
    override fun set(token: String) { if (token.isNotBlank()) prefs.edit().putString("token_$hubId", token).apply() }
}

/** Notification preferences on this device. Per account + hub: the master switch, categories, the resume id and a copy of the hub's mutes. */
class NotifyStore(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("foxfleet_notify", Context.MODE_PRIVATE))

    var binding: NotifyBinding?
        get() = prefs.getString("binding_hub", null)?.takeIf { it.isNotBlank() }?.let { h -> NotifyBinding(h, prefs.getString("binding_account", "").orEmpty()) }
        set(v) { prefs.edit().apply { if (v == null) { remove("binding_hub"); remove("binding_account") } else { putString("binding_hub", v.hubId); putString("binding_account", v.account) } }.apply() }

    fun enabled(b: NotifyBinding) = prefs.getBoolean("on_${b.key}", false)
    fun setEnabled(b: NotifyBinding, on: Boolean) = prefs.edit().putBoolean("on_${b.key}", on).apply()

    fun categories(b: NotifyBinding): Set<NotifyCategory> {
        val raw = prefs.getString("cats_${b.key}", null) ?: return NotifyCategory.entries.toSet()
        return raw.split(',').mapNotNull { n -> NotifyCategory.entries.firstOrNull { it.name == n } }.toSet()
    }
    fun setCategory(b: NotifyBinding, c: NotifyCategory, on: Boolean) =
        prefs.edit().putString("cats_${b.key}", (categories(b).let { if (on) it + c else it - c }).joinToString(",") { it.name }).apply()

    fun lastId(b: NotifyBinding): Long? = prefs.getLong("last_${b.key}", -1L).takeIf { it >= 0 }
    fun setLastId(b: NotifyBinding, id: Long?) = prefs.edit().apply { if (id == null) remove("last_${b.key}") else putLong("last_${b.key}", id) }.apply()

    /** Local copy of the hub's mutes (refreshed whenever the service connects or Settings changes one). */
    fun mutes(b: NotifyBinding): List<MuteRule> = (prefs.getString("mutes_${b.key}", null) ?: "").lines().mapNotNull { l ->
        val p = l.split('\t'); if (p.size == 3 && p[0].isNotEmpty()) MuteRule(p[0], p[1].ifEmpty { null }, p[2].toLongOrNull()) else null
    }
    fun setMutes(b: NotifyBinding, list: List<MuteRule>) = prefs.edit().putString("mutes_${b.key}", list.joinToString("\n") { "${it.agent.clean()}\t${it.chat.orEmpty().clean()}\t${it.until ?: ""}" }).apply()
    private fun String.clean() = replace('\t', ' ').replace('\n', ' ')

    /** True once the system permission dialog has been shown at least once (needed to tell "never asked" from "don't ask again"). */
    var permissionAsked: Boolean
        get() = prefs.getBoolean("permission_asked", false)
        set(v) = prefs.edit().putBoolean("permission_asked", v).apply()

    /** Set when Android refused to start or kept the service from running; the status line says so. */
    var startBlocked: Boolean
        get() = prefs.getBoolean("start_blocked", false)
        set(v) = prefs.edit().putBoolean("start_blocked", v).apply()

    /** Set when the hub rejected the stored login (401 or `foxfleet.auth`). Keeps the binding and the master switch; the status line says "Log in again" until the next successful login. */
    var needsLogin: Boolean
        get() = prefs.getBoolean("needs_login", false)
        set(v) = prefs.edit().putBoolean("needs_login", v).apply()

    /** Forget everything stored for one binding (sign-out, account or hub switch). The master switch goes too: a different account starts with notifications off. */
    fun clear(b: NotifyBinding) {
        val e = prefs.edit(); val tail = "_${b.key}"
        prefs.all.keys.filter { it.endsWith(tail) }.forEach { e.remove(it) }
        e.apply()
    }
}
