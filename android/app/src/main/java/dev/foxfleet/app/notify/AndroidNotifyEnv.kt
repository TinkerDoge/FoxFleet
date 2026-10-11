package dev.foxfleet.app.notify

import android.app.Activity
import android.content.Context
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.SettingsStore

/** The real device and hub behind [NotifySettingsModel]. [activity] is only used to tell "denied once" from "don't ask again". */
class AndroidNotifyEnv(private val context: Context, private val settings: SettingsStore, private val api: HubApi, private val activity: () -> Activity? = { null }) : NotifyEnv {
    private val store get() = NotifyController.store(context)
    private fun binding() = store.binding
    private fun hubApi(): NotifyApi {
        val b = settings.activeHubId
        return NotifyApi(settings.baseUrl, HubTokens(context.getSharedPreferences("foxfleet", Context.MODE_PRIVATE), b))
    }
    private fun notifyHttp(e: Exception): Nothing = throw e

    override fun signedIn() = binding() != null && binding()!!.hubId == settings.activeHubId && settings.sessionToken != null
    override fun permission() = NotifyController.permissionState(context, activity())
    override fun channels() = NotifyChannels.status(context)
    override fun serviceEnabled() = binding()?.let { store.enabled(it) } ?: false
    override fun setServiceEnabled(on: Boolean) = NotifyController.setEnabled(context, on)
    override fun startBlocked() = store.startBlocked
    override fun categories() = binding()?.let { store.categories(it) } ?: NotifyCategory.entries.toSet()
    override fun setCategory(c: NotifyCategory, on: Boolean) { binding()?.let { store.setCategory(it, c, on) } }
    override fun link() = NotifyController.link.value
    override fun cacheMutes(list: List<MuteRule>) { binding()?.let { store.setMutes(it, list) } }
    override fun now() = System.currentTimeMillis()
    override suspend fun prefs() = hubApi().prefs()
    override suspend fun setHubEnabled(on: Boolean) = hubApi().setEnabled(on)
    override suspend fun mute(agent: String, chat: String?, muted: Boolean, forMs: Long?) = hubApi().mute(agent, chat, muted, forMs)
    override suspend fun test() = hubApi().test()
    override suspend fun agents(): List<Pair<String, String>> = api.agents().map { it.name to it.displayName }
    override suspend fun sessions(agent: String): List<SessionInfo> = api.sessions(agent, limit = 10).sessions
}
