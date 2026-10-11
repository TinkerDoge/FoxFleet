package dev.foxfleet.app.notify

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SettingsStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service (type remoteMessaging) that holds `/api/notify/stream` open. Its own notification is a quiet "Connected" line.
 * The loop itself is [NotifyStreamRunner]; this class only wires Android around it.
 */
class NotifyService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private lateinit var notifier: AndroidNotifier

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotifyChannels.create(this)
        notifier = AndroidNotifier(this)
    }

    private fun show(link: NotifyLink) {
        NotifyController.setLink(link)
        runCatching { getSystemService(android.app.NotificationManager::class.java).notify(AndroidNotifier.SERVICE_ID, notifier.serviceNotification(link)) }
    }

    private fun foreground(link: NotifyLink) {
        val n: Notification = notifier.serviceNotification(link)
        ServiceCompat.startForeground(this, AndroidNotifier.SERVICE_ID, n, if (android.os.Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try { foreground(NotifyLink.Connecting) } catch (e: Exception) { // Android refused the foreground start: nothing runs, the status says so
            NotifyStore(this).startBlocked = true; NotifyController.setLink(NotifyLink.Blocked); stopSelf(); return START_NOT_STICKY
        }
        if (job?.isActive != true) job = scope.launch { runService() }
        return START_STICKY
    }

    private suspend fun runService() {
        val store = NotifyStore(this); val settings = SettingsStore(this)
        val b = store.binding
        val hub = b?.let { x -> settings.hubs.firstOrNull { it.id == x.hubId } }
        val tokens = b?.let { HubTokens(getSharedPreferences("foxfleet", Context.MODE_PRIVATE), it.hubId) }
        // Only for the pair that turned notifications on, on the hub the app is using (HubApi follows the active hub), with a login.
        if (b == null || hub == null || tokens?.get() == null || !store.enabled(b) || settings.activeHubId != b.hubId) { NotifyController.setLink(NotifyLink.Off); stopSelf(); return }
        val api = HubApi(settings)
        val content = HubNotifyContent(api, seenAt = { settings.seenAt(it) }, chatOpen = { NotifyForeground.visible && NotifyForeground.agent == it })
        val dispatcher = NotifyDispatcher(b.hubId, content, notifier, categories = { store.categories(b) }, mutes = { store.mutes(b) }, chatOpen = NotifyForeground::isOpen)
        val cursor = object : NotifyCursorStore {
            override var lastId: Long? get() = store.lastId(b); set(v) = store.setLastId(b, v)
            override fun saveToken(token: String) = tokens.set(token)
        }
        val runner = NotifyStreamRunner(OkHttpNotifyTransport(hub.url, tokens), cursor, dispatcher, onLink = { l -> show(l); if (l == NotifyLink.Connected) refreshMutes(b, hub.url, tokens, store) })
        while (true) {
            try {
                when (runner.run()) {
                    RunEnd.SignedOut -> signedOut()
                    RunEnd.Unsupported -> { show(NotifyLink.Unsupported); stopSelf() }
                }
                return
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { signedOut(); return } catch (_: Exception) { delay(5_000) }
        }
    }

    private fun signedOut() { NotifyController.onServerSignedOut(this); stopSelf() }

    /** Keep a local copy of the hub's mutes so a mute set after an event was created still applies to a replay. */
    private fun refreshMutes(b: NotifyBinding, url: String, tokens: TokenSource, store: NotifyStore) {
        scope.launch { runCatching { store.setMutes(b, NotifyApi(url, tokens).prefs().mutes) } }
    }

    /** Android 15+ may end a foreground service of a limited type. remoteMessaging has no such limit today; if one appears we stop cleanly and say so. */
    override fun onTimeout(startId: Int, fgsType: Int) { NotifyStore(this).startBlocked = true; NotifyController.setLink(NotifyLink.Blocked); stopSelf() }
    override fun onTimeout(startId: Int) = onTimeout(startId, 0)

    override fun onDestroy() {
        scope.cancel()
        if (NotifyController.link.value !is NotifyLink.SignedOut && NotifyController.link.value != NotifyLink.Unsupported && NotifyController.link.value != NotifyLink.Blocked) NotifyController.setLink(NotifyLink.Off)
        super.onDestroy()
    }
}
