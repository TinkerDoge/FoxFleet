package dev.foxfleet.app.notify

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.foxfleet.app.data.SettingsStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The one place that decides whether the notification service runs. The app calls it when the login changes; Settings calls it for the master switch.
 * Rules: the service runs only for the signed-in account + hub that turned it on, only while Android lets the app show notifications,
 * and never survives a sign-out or an account/hub switch (everything stored for the old pair is cleared).
 */
object NotifyController {
    private val _link = MutableStateFlow<NotifyLink>(NotifyLink.Off)
    val link: StateFlow<NotifyLink> = _link
    fun setLink(l: NotifyLink) { _link.value = l }

    fun store(context: Context) = NotifyStore(context.applicationContext)

    // ---- permission ----
    fun permissionState(context: Context, activity: Activity? = null): PermissionState {
        val granted = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        val rationale = activity != null && Build.VERSION.SDK_INT >= 33 && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)
        return PermissionState.of(Build.VERSION.SDK_INT, granted, store(context).permissionAsked, rationale)
    }

    fun systemSettingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** The system battery-optimisation list (needs no permission; we never ask for the exemption ourselves). Falls back to this app's info page where the list is missing. */
    fun batterySettingsIntent(context: Context): Intent {
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (list.resolveActivity(context.packageManager) != null) list
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun channelSettingsIntent(context: Context, c: NotifyChannel): Intent =
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, c.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    // ---- login lifecycle (called from HubViewModel) ----
    /** The user is signed in to [hubId] as [account]. A different pair than before clears the old one; a pair that turned notifications on gets its service. */
    fun onAuthed(context: Context, hubId: String, account: String) {
        if (hubId.isBlank() || account.isBlank()) return
        val s = store(context); val b = NotifyBinding(hubId, account)
        val old = s.binding
        if (old != null && old != b) teardown(context, old)
        s.binding = b
        s.needsLogin = false // a successful login: the "Log in again" state is over and the service resumes below
        NotifyChannels.create(context)
        if (s.enabled(b) && permissionState(context).ok) start(context) else if (s.enabled(b)) setLink(NotifyLink.Off)
    }

    /** The user signed out (or the hub did): stop, clear notifications, forget the resume id and every setting of this pair. */
    fun onSignedOut(context: Context) {
        val s = store(context); s.binding?.let { teardown(context, it) }; s.binding = null
    }

    /** A different hub is being opened: stop the service now; [onAuthed] starts it again if that hub's pair had notifications on. */
    fun onHubChanged(context: Context) {
        stop(context); AndroidNotifier(context).clearAll()
    }

    private fun teardown(context: Context, b: NotifyBinding) {
        stop(context); AndroidNotifier(context).clearAll()
        store(context).clear(b); store(context).startBlocked = false; store(context).needsLogin = false
        setLink(NotifyLink.Off)
    }

    /**
     * The service saw `foxfleet.auth` or a 401. That can be a blip (the hub lost its sessions, a token past its grace), so the binding and the master
     * switch stay: the service stops, what we showed is cleared, and "Log in again" is persisted for the Settings status line. Only a real sign-out
     * ([onSignedOut]) or a different owner ([onAuthed] with another pair) clears them. The next successful login ([onAuthed]) resumes the service.
     */
    fun onServerSignedOut(context: Context) {
        store(context).needsLogin = true
        stop(context); AndroidNotifier(context).clearAll()
        setLink(NotifyLink.SignedOut)
    }

    // ---- master switch ----
    /** Turns notifications on or off for the signed-in pair. Returns false when it could not start (no permission, not signed in). */
    fun setEnabled(context: Context, on: Boolean): Boolean {
        val s = store(context); val b = s.binding ?: return false
        if (!on) { s.setEnabled(b, false); stop(context); setLink(NotifyLink.Off); return true }
        if (!permissionState(context).ok) return false
        s.setEnabled(b, true); s.startBlocked = false; s.needsLogin = false // a fresh try: a 401 sets it again
        return start(context)
    }

    fun start(context: Context): Boolean {
        val app = context.applicationContext
        return try {
            ContextCompat.startForegroundService(app, Intent(app, NotifyService::class.java)); true
        } catch (e: IllegalStateException) { // ForegroundServiceStartNotAllowedException: Android 12+ refuses a start from the background
            store(app).startBlocked = true; setLink(NotifyLink.Blocked); false
        } catch (e: SecurityException) { store(app).startBlocked = true; setLink(NotifyLink.Blocked); false }
    }

    fun stop(context: Context) { val app = context.applicationContext; app.stopService(Intent(app, NotifyService::class.java)) }

    /** After a reboot or an app update: restart only for a pair whose user turned notifications on, and only with a stored login. */
    fun onBoot(context: Context) {
        val s = store(context); val b = s.binding ?: return
        if (!s.enabled(b) || s.needsLogin || !permissionState(context).ok) return
        if (HubTokens(context.getSharedPreferences("foxfleet", Context.MODE_PRIVATE), b.hubId).get() == null) return
        start(context)
    }

    // ---- chats ----
    /** The user opened this chat (or its notification): clear what we showed for it. [chat] null = every chat of the agent. */
    fun onChatOpened(context: Context, agent: String, chat: String?) { AndroidNotifier(context).clearChat(agent, chat) }

    /** Mute action on a notification (runs off the main thread). */
    suspend fun muteFromNotification(context: Context, hub: String, agent: String, chat: String, forMs: Long): MuteOutcome {
        val s = store(context); val b = s.binding
        val hubEntry = SettingsStore(context).hubs.firstOrNull { it.id == hub }
        if (b == null || b.hubId != hub || hubEntry == null) return MuteOutcome.Failed("This notification belongs to a hub you are no longer signed in to.")
        val api = NotifyApi(hubEntry.url, HubTokens(context.getSharedPreferences("foxfleet", Context.MODE_PRIVATE), hub))
        val (outcome, prefs) = MuteOutcome.run { api.mute(agent, chat, true, forMs) }
        if (prefs != null) { s.setMutes(b, prefs.mutes); AndroidNotifier(context).clearChat(agent, chat) }
        return outcome
    }

    /** Launcher badge: the unread total (and per chat) the app knows from the hub's chat rows. */
    fun setBadge(context: Context, total: Int, perAgent: Map<String, Int>) { runCatching { AndroidNotifier(context.applicationContext).setBadge(total, perAgent) } }

    /** The hub entry and NotifyApi a notification action may use: only the hub this device is signed in to. */
    internal fun actionApi(context: Context, hub: String): NotifyApi? {
        val b = store(context).binding; val hubEntry = SettingsStore(context).hubs.firstOrNull { it.id == hub }
        if (b == null || b.hubId != hub || hubEntry == null) return null
        return NotifyApi(hubEntry.url, HubTokens(context.getSharedPreferences("foxfleet", Context.MODE_PRIVATE), hub))
    }

    /** The permission was revoked while the service ran: stop it (the switch stays on; the status line says "Permission missing", and it resumes when the app opens with permission). */
    fun onPermissionLost(context: Context) { stop(context); AndroidNotifier(context).clearAll(); setLink(NotifyLink.Off) }

    internal fun openAppSettings(context: Context) = context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
