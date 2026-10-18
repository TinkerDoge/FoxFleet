package dev.foxfleet.app

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubAddress
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubApiException
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.AgentList
import dev.foxfleet.app.ui.chat.ChatState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface Route {
    data object Fleet : Route
    data class Chat(val agent: String) : Route
    /** The agent dossier (0.4.3 C3): identity, recent chats and the device's cached media. */
    data class Dossier(val agent: String) : Route
    data object Settings : Route
    data class Screen(val agent: String) : Route
    data object Agents : Route
    data object Hubs : Route
    data object Devices : Route
    data object Admin : Route
    /** Machines list; [code] is set when a foxfleet://pair link opened the app. */
    data class Machines(val code: String? = null) : Route
    /** Add (agent = null) or edit an agent in the hub registry. */
    data class AgentEditor(val agent: String? = null) : Route
}

/** Screen depth used to pick the slide direction between routes. */
fun Route.depth(): Int = when (this) { Route.Fleet -> 0; is Route.Chat -> 1; is Route.Dossier -> 1; Route.Settings -> 1; is Route.Screen -> 2; Route.Agents -> 2; Route.Hubs -> 2; Route.Devices -> 2; Route.Admin -> 2; is Route.Machines -> 3; is Route.AgentEditor -> 3 }

/** App state that must outlive rotation: auth, fleet, chats, in-flight streams, route. */
class HubViewModel(app: Application) : AndroidViewModel(app) {
    val settings = SettingsStore(app)
    val api = HubApi(settings)
    /** Durable, app-private media store (0.4.3 C1): filesDir, not cacheDir, so Android does not evict it. */
    private val mediaRepository = dev.foxfleet.app.media.MediaRepository(java.io.File(app.filesDir, "media-cache"))
    var mediaHost by mutableStateOf<dev.foxfleet.app.ui.components.MediaHost?>(null); private set
    var mediaCacheBytes by mutableStateOf(0L); private set
    var clearingMedia by mutableStateOf(false); private set
    private var authGeneration = 0L

    private fun activateMedia(account: String) {
        deactivateMedia()
        val client = dev.foxfleet.app.media.scopedMediaClient(settings.baseUrl, settings.sessionToken)
        mediaHost = dev.foxfleet.app.ui.components.MediaHost(client, mediaRepository.session(settings.baseUrl, account)) { agent, ref -> api.media(agent, ref) }
            .also { host -> host.diagnose = { url -> api.mediaDiagnose(url) } }
    }
    private fun deactivateMedia(purge: Boolean = false) {
        mediaHost?.cache?.close(purge)
        mediaHost?.client?.dispatcher?.cancelAll()
        mediaHost = null
    }
    // ---- device cache (0.4.0): Room, per account + hub; the hub stays the source of truth ----
    private val cacheOwner = dev.foxfleet.app.data.local.CacheOwner(app)
    /** Null until a sign-in (or an offline start) names the owner; every read and write goes through the owner's [ChatCache]. */
    private var cache: dev.foxfleet.app.data.local.ChatCache? = null
    /** Started from the device cache because the hub could not be reached; the boot keeps retrying in the background. */
    var offline by mutableStateOf(false); private set

    private suspend fun claimCache(key: String, account: String) = withContext(kotlinx.coroutines.Dispatchers.IO) {
        val db = dev.foxfleet.app.data.local.CacheDb.get(getApplication())
        if (cacheOwner.claim(key, account, settings.baseUrl)) db.admin().wipeAll()
        cache = dev.foxfleet.app.data.local.ChatCache(db, key)
    }
    private fun wipeCache() {
        cache = null; cacheOwner.forget()
        val app = getApplication<Application>()
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch { runCatching { dev.foxfleet.app.data.local.CacheDb.get(app).admin().wipeAll() } }
    }
    /** Cache writes never fail a screen: the next hub page writes again. */
    private suspend fun cached(block: suspend dev.foxfleet.app.data.local.ChatCache.() -> Unit) {
        val c = cache ?: return
        try { withContext(kotlinx.coroutines.Dispatchers.IO) { c.block() } } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    }
    private suspend fun <T> fromCache(block: suspend dev.foxfleet.app.data.local.ChatCache.() -> T?): T? {
        val c = cache ?: return null
        return try { withContext(kotlinx.coroutines.Dispatchers.IO) { c.block() } } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    /** The hub's newest page, written through to the cache. */
    private suspend fun newestPage(agent: String, sid: String): dev.foxfleet.app.data.HistoryPage {
        val p = api.messages(agent, sid)
        cached { saveNewest(agent, sid, p.messages, p.hasMore) }
        return p
    }
    /** Show the saved copy of [sid] while the hub answers. True when something was shown. */
    private suspend fun showCachedChat(state: ChatState, agent: String, sid: String): Boolean {
        val c = fromCache { open(agent, sid) } ?: return false
        val shown = state.showCached(c.messages, sid, c.hasOlder)
        // the chips and "delete for me" saved with it (v4): there at once, and offline
        if (shown && agent(agent)?.capabilities?.reactions == true) fromCache { reactions(agent, sid) }?.let { state.showCachedReactions(sid, it) }
        return shown
    }

    fun refreshMediaUsage() { viewModelScope.launch { mediaCacheBytes = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { mediaRepository.usageBytes() } } }
    fun clearMediaCache() {
        if (clearingMedia) return
        clearingMedia = true
        viewModelScope.launch {
            try {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { mediaRepository.clear() }
                coil3.SingletonImageLoader.get(getApplication<Application>()).memoryCache?.clear()
                mediaCacheBytes = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { mediaRepository.usageBytes() }
            } finally { clearingMedia = false }
        }
    }
    // ---- auto-update (0.4.3 C4): a manifest JSON, a direct HTTPS APK, a sha256 check, then PackageInstaller ----
    val updateStore = dev.foxfleet.app.update.UpdateStore(app)
    var updateUi by mutableStateOf<dev.foxfleet.app.update.UpdateUi>(dev.foxfleet.app.update.UpdateUi.Idle); private set
    private var updateJob: Job? = null

    /** Cold start: at most once per 12 h, and only on an unmetered network (never burns mobile data). */
    fun quietUpdateCheck() {
        if (!updateStore.due(System.currentTimeMillis())) return
        if (!unmetered()) return
        checkForUpdates()
    }
    private fun unmetered(): Boolean {
        val cm = getApplication<Application>().getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }
    fun checkForUpdates() {
        if (updateJob?.isActive == true) return
        updateUi = dev.foxfleet.app.update.UpdateUi.Checking
        updateJob = viewModelScope.launch {
            try {
                val url = dev.foxfleet.app.update.UpdateManifests.DEFAULT_URL
                val body = withContext(kotlinx.coroutines.Dispatchers.IO) {
                    require(dev.foxfleet.app.update.UpdatePolicy.isHttps(url)) { "Updates need an HTTPS link." }
                    api.httpClient.newCall(okhttp3.Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { r ->
                        if (!r.isSuccessful) throw java.io.IOException("Update check failed (${r.code})")
                        r.body?.string() ?: throw java.io.IOException("The update file was empty")
                    }
                }
                withContext(kotlinx.coroutines.Dispatchers.IO) { updateStore.markChecked(System.currentTimeMillis()) }
                val manifest = dev.foxfleet.app.update.UpdateManifests.parse(body)
                updateUi = if (manifest == null) dev.foxfleet.app.update.UpdateUi.Failed("The update file could not be read.")
                else when (val plan = dev.foxfleet.app.update.UpdatePlan.decide(BuildConfig.VERSION_CODE, manifest)) {
                    is dev.foxfleet.app.update.UpdatePlan.Update -> dev.foxfleet.app.update.UpdateUi.Available(plan.manifest)
                    dev.foxfleet.app.update.UpdatePlan.UpToDate -> dev.foxfleet.app.update.UpdateUi.UpToDate
                    is dev.foxfleet.app.update.UpdatePlan.Refused -> dev.foxfleet.app.update.UpdateUi.Failed(plan.why)
                }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                updateUi = dev.foxfleet.app.update.UpdateUi.Failed(scrubAddresses(e.message ?: "Couldn't check for updates"))
            }
        }
    }
    fun installUpdate() {
        val manifest = (updateUi as? dev.foxfleet.app.update.UpdateUi.Available)?.manifest ?: return
        if (updateJob?.isActive == true) return
        updateJob = viewModelScope.launch {
            val apk = java.io.File(getApplication<Application>().filesDir, "updates/foxfleet-${manifest.versionCode}.apk")
            try {
                updateUi = dev.foxfleet.app.update.UpdateUi.Downloading(0)
                withContext(kotlinx.coroutines.Dispatchers.IO) {
                    dev.foxfleet.app.update.ApkUpdater.download(api.httpClient, manifest, apk) { done, total ->
                        updateUi = dev.foxfleet.app.update.UpdateUi.Downloading(if (total != null && total > 0) ((done * 100 / total).toInt()).coerceIn(0, 100) else 0)
                    }
                    val actual = dev.foxfleet.app.update.ApkUpdater.sha256(apk)
                    if (!dev.foxfleet.app.update.UpdatePolicy.shaMatches(manifest.sha256, actual)) {
                        apk.delete()
                        throw java.io.IOException("The downloaded update did not match its checksum.")
                    }
                }
                updateUi = dev.foxfleet.app.update.UpdateUi.Installing(manifest)
                val started = withContext(kotlinx.coroutines.Dispatchers.Main) { dev.foxfleet.app.update.ApkUpdater.install(getApplication(), apk) }
                if (!started) updateUi = dev.foxfleet.app.update.UpdateUi.Failed("The installer could not be started.")
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                updateUi = dev.foxfleet.app.update.UpdateUi.Failed(scrubAddresses(e.message ?: "The update could not be installed"))
            }
        }
    }
    fun dismissUpdate() { if (updateUi is dev.foxfleet.app.update.UpdateUi.Available) updateUi = dev.foxfleet.app.update.UpdateUi.Idle }

    override fun onCleared() { dev.foxfleet.app.notify.NotifyForeground.chatIdOf = { null }; stopLive(); deactivateMedia(); super.onCleared() }

    // ---- agent dossier (0.4.3 C3): recent chats + the media this device has cached for one agent ----
    var dossierMedia by mutableStateOf<Map<String, List<dev.foxfleet.app.ui.chat.MediaRef>>>(emptyMap()); private set
    var dossierFiles by mutableStateOf<Map<String, List<dev.foxfleet.app.ui.chat.DossierFile>>>(emptyMap()); private set
    var dossierLinks by mutableStateOf<Map<String, List<dev.foxfleet.app.ui.chat.DossierLink>>>(emptyMap()); private set
    /** Rebuild the agent's grid from the device cache (no hub call); a warm open only reads the .media files. */
    fun loadDossier(agent: String) {
        viewModelScope.launch {
            val msgs = fromCache { messages(agent) }.orEmpty()
            dossierMedia = dossierMedia + (agent to dev.foxfleet.app.ui.chat.DossierMedia.refs(agent, msgs))
            dossierFiles = dossierFiles + (agent to dev.foxfleet.app.ui.chat.DossierMedia.files(agent, msgs))
            dossierLinks = dossierLinks + (agent to dev.foxfleet.app.ui.chat.DossierMedia.links(msgs))
        }
    }
    /** Delete for everyone (0.4.3): revoke on the hub, then drop the phone copy. A hub error keeps the local file and is rethrown. */
    suspend fun deleteMedia(agent: String, ref: String, instance: String) {
        try { api.deleteMedia(agent, ref) } catch (e: HubApiException) { if (e.status != 404) throw e }
        withContext(kotlinx.coroutines.Dispatchers.IO) { mediaHost?.delete(agent, ref, instance) }
        coil3.SingletonImageLoader.get(getApplication<Application>()).memoryCache?.clear()
        if (dossierMedia.containsKey(agent)) loadDossier(agent)
    }
    /** Device-only delete of every cached media file of [agent], then reload its grid. */
    fun clearAgentMedia(agent: String) {
        viewModelScope.launch {
            try { withContext(kotlinx.coroutines.Dispatchers.IO) { mediaHost?.deleteAgent(agent) }; coil3.SingletonImageLoader.get(getApplication<Application>()).memoryCache?.clear() }
            catch (e: CancellationException) { throw e } catch (_: Exception) {}
            dossierMedia = dossierMedia + (agent to emptyList())
            refreshMediaUsage()
        }
    }


    var prefs by mutableStateOf(settings.appPrefs); private set
    var authed by mutableStateOf<Boolean?>(null); private set
    var bootError by mutableStateOf<String?>(null); private set
    /** True while the user must give a hub address: first launch, "Add hub", or an opened connect link. */
    var hubSetup by mutableStateOf(settings.baseUrl.isBlank()); private set
    var addingHub by mutableStateOf(false); private set
    var hubDraft by mutableStateOf(""); private set
    var hubError by mutableStateOf<String?>(null); private set
    var username by mutableStateOf("")
    var isOwner by mutableStateOf(false); private set
    /** What the hub says it can do (null version = a hub older than 0.3.5 that does not say). Refreshed whenever auth info is read. */
    var hubVersion by mutableStateOf<String?>(null); private set
    var hubFeatures by mutableStateOf<List<String>>(emptyList()); private set
    val hubKnown get() = hubVersion != null
    fun hubHas(feature: String) = feature in hubFeatures
    /** Invite code from an foxfleet://connect?...&invite= link; pre-fills the join form once the hub is connected. */
    var inviteDraft by mutableStateOf(""); private set
    val hubName get() = settings.hubs.firstOrNull { it.id == settings.activeHubId }?.name.orEmpty()

    /** foxfleet://connect?hub=… opened the app: prefill the address screen (the user still confirms). */
    /** A foxfleet://pair code waiting for the owner to be signed in; shown on the Machines screen. */
    var pendingPair by mutableStateOf<String?>(null)
    fun consumePendingPair() { val c = pendingPair ?: return; if (authed == true) { pendingPair = null; navigate(Route.Machines(c)) } }
    fun openConnectLink(link: String) {
        HubAddress.parsePairLink(link)?.let { p -> pendingPair = p.code; return }
        val parsed = HubAddress.parseLink(link) ?: return
        val hub = parsed.hub; inviteDraft = parsed.invite.orEmpty()
        hubDraft = hub; addingHub = true; hubSetup = true
    }
    fun startAddHub() { hubDraft = ""; addingHub = true; hubSetup = true; hubError = null }
    fun cancelAddHub() { addingHub = false; hubSetup = settings.baseUrl.isBlank(); hubDraft = "" }

    /** Stores a validated address, then asks it who it is. A hub that doesn't answer like Foxfleet is not kept. */
    suspend fun connectHub(url: String, allowHttp: Boolean) {
        settings.allowHttp = allowHttp
        val previous = settings.activeHubId
        val entry = settings.addHub(url)
        try { api.probeHub() } catch (e: CancellationException) { throw e } catch (e: Exception) {
            if (entry.id != previous) { settings.removeHub(entry.id); if (previous.isNotBlank()) settings.switchHub(previous) }
            throw HubApiException(0, "That address didn't answer like an Foxfleet. Check it and try again.")
        }
        addingHub = false; hubSetup = false; hubDraft = ""; resetForHubChange(); boot()
    }
    fun switchHub(id: String) { settings.switchHub(id); resetForHubChange(); boot() }
    fun removeHub(id: String) { settings.removeHub(id); resetForHubChange(); route = Route.Fleet; boot() }
    private fun resetForHubChange() {
        authGeneration++; deactivateMedia(); stopLive()
        dev.foxfleet.app.notify.NotifyController.onHubChanged(getApplication())
        jobs.values.forEach { it.cancel() }; jobs.clear(); chats.clear(); sessions.clear(); sessionTotals.clear(); skills.clear()
        agents = emptyList(); fleetLoadedOnce = false; route = Route.Fleet; username = ""; isOwner = false
    }
    var agents by mutableStateOf<List<AgentStatus>>(emptyList()); private set
    var fleetLoading by mutableStateOf(false); private set
    var fleetLoadedOnce by mutableStateOf(false); private set
    var fleetError by mutableStateOf<String?>(null); private set
    var route by mutableStateOf<Route>(Route.Fleet); private set
    val sessions = mutableStateMapOf<String, List<SessionInfo>>()
    val sessionTotals = mutableStateMapOf<String, Int>()
    val sessionsLoading = mutableStateMapOf<String, Boolean>()
    var historyError by mutableStateOf<String?>(null)
    private val chats = dev.foxfleet.app.notify.AgentChats<ChatState>() // the notification service reads it from another thread
    private val jobs = HashMap<String, Job>()

    init {
        dev.foxfleet.app.notify.NotifyForeground.chatIdOf = { chats.peek(it)?.sessionId }
        boot()
    }

    /** A notification tapped (foxfleet://chat?...). Held until the user is signed in and the fleet is loaded, then the chat opens. */
    var pendingOpen by mutableStateOf<dev.foxfleet.app.notify.NotifyTarget?>(null); private set
    fun openNotification(link: String?) { dev.foxfleet.app.notify.NotifyTarget.parse(link)?.let { pendingOpen = it } }
    fun consumePendingOpen() {
        val t = pendingOpen ?: return
        if (authed != true || !fleetLoadedOnce) return
        pendingOpen = null
        if (t.hub != settings.activeHubId || agent(t.agent) == null) { // a notification of another hub, or an agent that is gone: say so instead of doing nothing
            android.widget.Toast.makeText(getApplication(), "That chat isn't available any more.", android.widget.Toast.LENGTH_SHORT).show(); return
        }
        navigate(Route.Chat(t.agent)); openSession(t.agent, t.chat)
        dev.foxfleet.app.notify.NotifyController.onChatOpened(getApplication(), t.agent, t.chat)
        if (t.approval != null) viewModelScope.launch { // the open question or approval card comes from the queue
            var n = 0; while (chatFor(t.agent).sessionId != t.chat && n++ < 25) delay(200)
            runCatching { chatFor(t.agent).syncQueue(api, t.agent) }
        }
    }

    /** True while the first contact with the hub is being retried after a blip. */
    var bootReconnecting by mutableStateOf(false)

    fun boot() {
        val generation = ++authGeneration
        deactivateMedia()
        bootError = null
        hubSetup = settings.baseUrl.isBlank()
        if (hubSetup) { authed = false; offline = false; return }
        if (!offline) authed = null // an offline start stays on its cached screens while the boot retries
        viewModelScope.launch {
            // A tunnel blip (502/503/504, timeout) while opening the app is not a sign-out: keep trying quietly before showing anything.
            var attempt = 0
            while (true) {
                try {
                    val info = api.authInfo(); if (generation != authGeneration) return@launch; username = info.username.orEmpty(); isOwner = info.isOwner; hubVersion = info.hubVersion; hubFeatures = info.hubFeatures
                    val signedIn = !info.required || info.authenticated
                    // Only a real, signed-in session claims the backgrounds (a failed or cancelled sign-in never does); done before any chat can draw.
                    if (signedIn) withContext(kotlinx.coroutines.Dispatchers.IO) { dev.foxfleet.app.data.ChatBackgroundStore(getApplication()).claimOwner(dev.foxfleet.app.data.ChatBgOwner.key(info.userId ?: info.username, settings.baseUrl)) }
                    if (signedIn) claimCache(dev.foxfleet.app.data.ChatBgOwner.key(info.userId ?: info.username, settings.baseUrl), username.ifBlank { "anonymous-hub" }) else cache = null
                    offline = false
                    if (generation != authGeneration) return@launch
                    authed = signedIn; if (authed == true) activateMedia(username.ifBlank { "anonymous-hub" }); bootReconnecting = false; break
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    val transient = (e as? dev.foxfleet.app.data.HubApiException)?.transient == true
                    if (transient && attempt < 7) { bootReconnecting = true; delay(dev.foxfleet.app.data.backoffMs(attempt++, 700, 8000)); continue }
                    bootReconnecting = false
                    if (startOffline(generation, e)) return@launch
                    bootError = "Can't reach your hub — ${scrubAddresses(e.message ?: "network error")}"
                    authed = false; break
                }
            }
            if (authed == true) { dev.foxfleet.app.notify.NotifyController.onAuthed(getApplication(), settings.activeHubId, username); refreshFleet() }
            syncLive()
        }
    }

    /**
     * The hub is out of reach but this device holds the last signed-in account's cache for this hub: open on it (fleet, chats,
     * messages read-only until the hub answers) instead of the sign-in screen, and keep retrying the boot quietly.
     * Never for an auth answer: only a network or gateway failure, and only with a saved session.
     */
    private suspend fun startOffline(generation: Long, e: Exception): Boolean {
        if (e is AuthRequiredException || (e as? dev.foxfleet.app.data.HubApiException)?.transient != true) return false
        if (settings.sessionToken.isNullOrBlank()) return false
        val key = cacheOwner.offlineOwner(settings.baseUrl) ?: return false
        val account = cacheOwner.account ?: return false
        cache = dev.foxfleet.app.data.local.ChatCache.forOwner(getApplication(), key)
        username = account.takeIf { it != "anonymous-hub" }.orEmpty()
        offline = true; authed = true; activateMedia(account)
        refreshFleet(silent = true)
        viewModelScope.launch {
            var n = 0
            while (generation == authGeneration && offline) {
                delay(dev.foxfleet.app.data.backoffMs(minOf(n++, 5), 2000, 30000))
                if (generation != authGeneration) return@launch
                try { api.authInfo() } catch (e: CancellationException) { throw e } catch (_: Exception) { continue }
                if (generation == authGeneration) boot() // reachable again: the normal boot claims, refreshes and starts the live stream
                return@launch
            }
        }
        return true
    }

    fun updatePrefs(p: AppPrefs) { prefs = p; settings.appPrefs = p }

    fun onLoggedIn() { inviteDraft = ""; boot() }

    fun signOut() {
        authGeneration++; deactivateMedia(purge = true); stopLive()
        dev.foxfleet.app.notify.NotifyController.onSignedOut(getApplication())
        jobs.values.forEach { it.cancel() }; jobs.clear(); chats.clear(); sessions.clear(); sessionTotals.clear()
        viewModelScope.launch { api.logout() }
        chatRows = emptyMap(); archivedRows = emptyList(); showArchived = false; totalUnread = 0; publishBadge()
        wipeCache(); offline = false // the cache holds message text: it never outlives the sign-in
        settings.clearSession() // chat backgrounds stay: they are cleared only when a different account or hub signs in (see claimBackgroundOwner)
        agents = emptyList(); fleetLoadedOnce = false; route = Route.Fleet; authed = false
    }

    /** Refresh the list. `silent` (the periodic poll, leaving a chat) shows no spinner and no error: the list just updates. */
    fun refreshFleet(silent: Boolean = false) {
        if (fleetLoading) return
        if (!silent) { fleetLoading = true; fleetError = null } else fleetLoading = false
        viewModelScope.launch {
            if (agents.isEmpty()) fromCache { agents() }?.takeIf { it.isNotEmpty() && agents.isEmpty() }?.let { saved ->
                agents = saved; fleetLoadedOnce = true; restoreLastChat() // the saved list draws at once; the hub's answer replaces it
            }
            try {
                val fresh = api.agents().map { dev.foxfleet.app.ui.LocalLast.merge(it, settings.lastLocal(it.name)) }
                val open = (route as? Route.Chat)?.agent
                fresh.forEach { a -> if (a.name == open) settings.markSeen(a.name, a.lastActivityAt) else if (settings.seenAt(a.name) == null) settings.markSeen(a.name, a.lastActivityAt) } // a new device starts out read
                agents = AgentList.sort(fresh); fleetLoadedOnce = true; restoreLastChat()
                val sorted = agents; cached { saveAgents(sorted) }
                if (features.chats) loadChats()
            } catch (e: AuthRequiredException) {
                deactivateMedia(purge = true)
                authed = false
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                if (!silent && !(offline && agents.isNotEmpty())) fleetError = e.message?.let(::scrubAddresses) ?: "Fleet sync failed"
            } finally { if (!silent) fleetLoading = false }
        }
    }

    /** Is there a reply in this agent's chat that you have not seen on this device? */
    fun unreadFor(a: AgentStatus): Boolean = chatRows[a.name]?.let { it.badge > 0 && (route as? Route.Chat)?.agent != a.name } ?: chatFor(a.name).unread || AgentList.unread(a, settings.seenAt(a.name), (route as? Route.Chat)?.agent == a.name)

    /** Pin or unpin: the row moves at once; the hub's answer (or the next refresh) is the truth. */
    fun pin(a: AgentStatus) {
        val on = !a.pinned; val before = agents
        agents = AgentList.sort(agents.map { x -> if (x.name == a.name) x.copy(pinOrder = if (on) (agents.maxOfOrNull { it.pinOrder ?: -1 } ?: -1) + 1 else null) else x })
        viewModelScope.launch {
            try { api.pinAgent(a.name, on); refreshFleet(silent = true) }
            catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { agents = before; fleetError = "Couldn't change the pin. Try again." }
        }
    }

    fun navigate(r: Route) {
        val leaving = (route as? Route.Chat)?.agent
        if (leaving != null && (r as? Route.Chat)?.agent != leaving) viewModelScope.launch { delay(900); refreshFleet(silent = true); delay(600); settings.markSeen(leaving, agents.firstOrNull { it.name == leaving }?.lastActivityAt) } // what arrived while you were in the chat is read
        if (r is Route.Chat) { settings.lastAgent = r.agent; chatFor(r.agent).markRead(); restore(r.agent); catchUp(r.agent); /* reopening a chat already in memory used to show it as it was when you left */ settings.savedChat(r.agent).session?.let { dev.foxfleet.app.notify.NotifyController.onChatOpened(getApplication(), r.agent, it) } }
        dev.foxfleet.app.notify.NotifyForeground.agent = (r as? Route.Chat)?.agent
        route = r
    }

    /** Back: returns false when there is nowhere to go (let the system finish). */
    fun back(): Boolean = when (val r = route) {
        is Route.Screen -> { route = Route.Chat(r.agent); true }
        Route.Agents, Route.Hubs, Route.Devices, Route.Admin -> { route = Route.Settings; true }
        is Route.AgentEditor -> { route = Route.Agents; true }
        is Route.Machines -> { route = Route.Agents; true }
        Route.Fleet -> false
        else -> { navigate(Route.Fleet); true }
    }

    fun chatFor(agent: String): ChatState = chats.getOrPut(agent) { ChatState().also { s ->
        s.persist = { c -> settings.saveChat(agent, c) }
        s.onReactionsSaved = { sid, snap -> viewModelScope.launch { cached { saveReactions(agent, sid, snap) } } }
    } }.also { it.hubIdReactions = features.reactionEvents }

    fun agent(name: String): AgentStatus? = agents.firstOrNull { it.name == name }

    // ---- live updates (0.3.14): the hub pushes run/approval events; the open chat catches up without a reload ----
    private var foreground = false
    private var liveJob: Job? = null
    private var liveRunner: dev.foxfleet.app.data.LiveStreamRunner? = null
    private var pollJob: Job? = null
    private var fleetSoon: Job? = null
    private val catchUps = HashMap<String, Job>()
    /** True while the live stream is connected (a hub without the `live` feature never connects; the fallback poll covers it). */
    var liveConnected by mutableStateOf(false); private set

    /** MainActivity onStart / onStop: the stream and the poll only run while the app is on screen (the notification service covers the rest). */
    fun onForeground(on: Boolean) {
        foreground = on; syncLive()
        if (on) { liveRunner?.nudge(); openChatAgent()?.let { catchUp(it) }; if (authed == true) refreshFleet(silent = true) }
    }

    private fun openChatAgent(): String? = (route as? Route.Chat)?.agent

    private fun syncLive() {
        val want = foreground && authed == true
        if (!want) { stopLive(); return }
        if (pollJob?.isActive != true) pollJob = viewModelScope.launch {
            // Fallback for what the hub cannot push (a message that reached the agent from another app, an older hub): a cheap newest-page check.
            while (true) { delay(if (liveConnected) POLL_LIVE_MS else POLL_MS); openChatAgent()?.let { catchUp(it) } }
        }
        if (liveJob?.isActive == true) return
        if (features.live2 && !v2Unsupported && cache != null) { startLiveV2(); return }
        if (!hubHas("live")) return
        val gen = authGeneration
        val runner = dev.foxfleet.app.data.LiveStreamRunner(api.liveTransport, object : dev.foxfleet.app.data.LiveSink {
            override suspend fun onEvent(e: dev.foxfleet.app.data.LiveEvent) = withContext(kotlinx.coroutines.Dispatchers.Main) { if (gen == authGeneration) onLiveEvent(e) }
            override suspend fun onConnected(catchUp: Boolean) = withContext(kotlinx.coroutines.Dispatchers.Main) {
                if (gen != authGeneration) return@withContext
                liveConnected = true
                if (catchUp) { openChatAgent()?.let { catchUp(it) }; fleetSoon() }
            }
        })
        liveRunner = runner
        liveJob = viewModelScope.launch {
            val end = try { withContext(kotlinx.coroutines.Dispatchers.IO) { runner.run() } } finally { liveConnected = false }
            if (end == dev.foxfleet.app.data.LiveEnd.SignedOut && gen == authGeneration) boot() // let boot decide: a real sign-out shows the login
        }
    }

    private fun stopLive() {
        v2Runner?.close(); v2Runner = null; link = null; typing.clearAll(); typingTick++; runs.clear()
        liveRunner?.close(); liveRunner = null; liveJob?.cancel(); liveJob = null; pollJob?.cancel(); pollJob = null; liveConnected = false
        catchUps.values.forEach { it.cancel() }; catchUps.clear()
    }

    /** Many events in a burst cost one list refresh. */
    private fun fleetSoon() { if (fleetSoon?.isActive == true) return; fleetSoon = viewModelScope.launch { delay(400); refreshFleet(silent = true) } }

    internal fun onLiveEvent(e: dev.foxfleet.app.data.LiveEvent) {
        fleetSoon()
        val open = openChatAgent()
        if (open == null || !dev.foxfleet.app.data.LiveCatchUp.touchesChat(e, open, chatFor(open).sessionId)) { if (e.type == "run_finished" && open != e.agent) chats.peek(e.agent)?.markUnread(); return }
        val state = chatFor(open); val run = e.runId
        when (e.type) {
            // A reply started elsewhere (web, another phone) in the chat you are looking at: follow it live, as if you had sent it.
            "run_started" -> if (run != null && !state.streaming && !state.loading && jobs[open]?.isActive != true && state.sessionId != null) {
                followRun(open, run)
            } else if (run != null && !state.streaming && state.loading) state.missedRun = run // 0.4.0 dropped it for good: follow it once the page is in
            "run_finished" -> { if (run != null && state.missedRun == run) state.missedRun = null; state.runEnded(run, e.state); catchUp(open) }
            "approval" -> viewModelScope.launch { runCatching { state.syncQueue(api, open) } }
            else -> catchUp(open)
        }
    }

    /** Follow a reply that runs in [agent]'s open chat (started elsewhere, or missed while the chat loaded): live thinking and steps, then the commit. */
    private fun followRun(agent: String, run: String) {
        val state = chatFor(agent)
        jobs[agent] = viewModelScope.launch {
            try { catchUpNow(agent); state.resume(api, agent, run, null); storeReply(agent) }
            catch (x: CancellationException) { throw x } catch (x: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    /** A run that started while [agent]'s chat was loading: follow it now, unless something else already did. */
    private fun followMissed(agent: String) {
        val state = chatFor(agent); val run = state.missedRun ?: return
        if (state.streaming || state.loading || jobs[agent]?.isActive == true || state.sessionId == null) return
        state.missedRun = null
        if (state.messages.any { it.runId == run }) return
        followRun(agent, run)
    }

    /** The reply just committed keeps its thinking and steps in the device cache (the hub's message.new may carry neither). */
    private fun storeReply(agent: String) {
        val state = chatFor(agent); val sid = state.sessionId ?: return; val m = state.lastCommitted ?: return
        viewModelScope.launch { cached { upsertLive(agent, sid, m) } }
    }

    /** Fetch the newest page of [agent]'s open chat and add what is new (no spinner, no error: the next event or poll retries). */
    fun catchUp(agent: String) {
        val state = chatFor(agent)
        if (state.sessionId == null || state.streaming || state.loading || jobs[agent]?.isActive == true || catchUps[agent]?.isActive == true) return
        catchUps[agent] = viewModelScope.launch {
            try { catchUpNow(agent) }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    private suspend fun catchUpNow(agent: String) {
        val state = chatFor(agent); val sid = state.sessionId ?: return
        val page = newestPage(agent, sid)
        if (state.sessionId != sid || state.streaming || state.loading) return
        when (val plan = dev.foxfleet.app.data.LiveCatchUp.plan(state.messages, page.messages)) {
            dev.foxfleet.app.data.CatchUp.None -> {}
            is dev.foxfleet.app.data.CatchUp.Append -> { state.appendLive(plan.messages); if (openChatAgent() != agent && plan.messages.any { !dev.foxfleet.app.ui.chat.MessageActions.emptyReply(it) }) state.markUnread() }
            dev.foxfleet.app.data.CatchUp.Replace -> state.load(page.messages, sid, page.hasMore)
            dev.foxfleet.app.data.CatchUp.Reconcile -> state.reconcile(api, agent)
        }
    }

    val avatars = dev.foxfleet.app.media.AvatarStore(app)
    val skills = mutableStateMapOf<String, List<String>>()
    /** Agent whose avatar is being changed (long-press menu → picker → crop). */
    var avatarTarget by mutableStateOf<String?>(null)

    /** The hub's per-agent command catalog (what this agent can execute); the bundled list is the fallback. */
    val commandDefs = mutableStateMapOf<String, List<dev.foxfleet.app.ui.chat.CommandDef>>()
    fun loadSkills(agent: String) {
        if (skills.containsKey(agent)) return
        viewModelScope.launch {
            val json = runCatching { api.commandsJson(agent) }.getOrNull() ?: return@launch
            runCatching { dev.foxfleet.app.ui.chat.HermesCatalog.parseDefs(json) }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { commandDefs[agent] = it }
            val extra = dev.foxfleet.app.ui.chat.HermesCatalog.parseSkills(json)
            if (extra.isNotEmpty()) skills[agent] = (skills[agent].orEmpty() + extra).distinct()
        }
        skills[agent] = emptyList()
        viewModelScope.launch {
            try { skills[agent] = (skills[agent].orEmpty() + api.skills(agent)).distinct() } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    /** What a plain message means while the agent works. There is no picker (Telegram/Discord style): native Hermes applies its own profile setting and says what it did; every other agent is stopped and the message sent. */
    fun sendMode(agent: dev.foxfleet.app.data.AgentStatus): String = dev.foxfleet.app.ui.screens.plainMode(agent.capabilities.nativeUi, agent.capabilities.busy)

    fun send(agent: String, text: String, images: List<dev.foxfleet.app.data.ImageAttachment> = emptyList(), mode: String? = null) {
        val state = chatFor(agent)
        if (text.isBlank() && images.isEmpty()) return
        readOnSend(agent) // the hub reads the chat on any send (it pushes `read` too)
        val m = mode ?: agents.firstOrNull { it.name == agent }?.let { sendMode(it) } ?: "interrupt"
        if (state.streaming || state.queue.isNotEmpty()) { // busy: the hub takes it (queue / steer / interrupt) and the reply keeps streaming
            viewModelScope.launch {
                try { state.sendBusy(api, agent, text.trim(), images, m)?.let { lastRejected[agent] = it }; state.syncQueue(api, agent) }
                catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) { }
            }
            return
        }
        settings.rememberLast(agent, "user", text.trim())
        jobs[agent] = viewModelScope.launch {
            try {
                state.send(api, agent, text.trim(), images)
                storeReply(agent)
                state.messages.lastOrNull()?.takeIf { it.role == "assistant" }?.let { settings.rememberLast(agent, "assistant", it.content) }
                if ((route as? Route.Chat)?.agent != agent) state.markUnread()
                state.syncQueue(api, agent)
            } catch (e: CancellationException) {
            } catch (e: AuthRequiredException) {
                deactivateMedia(purge = true)
                authed = false
            } catch (_: Exception) { /* surfaced by ChatState.error */ }
        }
    }

    /** Leaving the screen while in control: hand back so the agent can continue (best effort). */
    fun handBackScreen(agent: String) {
        viewModelScope.launch { runCatching { api.screen(agent, "handback") } }
    }

    /** Copies a picked document to the agent through the hub (streamed, ≤ 90 MB). */
    suspend fun uploadFile(agent: String, uri: android.net.Uri, onProgress: (Float) -> Unit): dev.foxfleet.app.data.FileRef {
        val resolver = getApplication<Application>().contentResolver
        var name = "file"; var size = -1L
        resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { cur ->
            if (cur.moveToFirst()) {
                cur.getString(0)?.let { name = it }
                if (!cur.isNull(1)) size = cur.getLong(1)
            }
        }
        if (size < 0) size = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        if (size < 0) throw HubApiException(0, "Can't read that file's size")
        return api.uploadFile(agent, name, resolver.getType(uri), size, { resolver.openInputStream(uri) ?: throw java.io.IOException("Can't open file") }, onProgress)
    }

    // ---- agent registry (Settings → Agents) ----
    var savedAgents by mutableStateOf<List<dev.foxfleet.app.data.SavedAgent>?>(null); private set
    var agentKinds by mutableStateOf<List<dev.foxfleet.app.data.AgentKind>>(emptyList()); private set
    var registryError by mutableStateOf<String?>(null); private set

    fun loadRegistry() {
        registryError = null
        viewModelScope.launch {
            try {
                if (agentKinds.isEmpty()) agentKinds = api.agentKinds()
                savedAgents = api.savedAgents()
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (e: Exception) {
                registryError = scrubAddresses(e.message ?: "Couldn't load agents"); if (savedAgents == null) savedAgents = emptyList()
            }
        }
    }

    fun moveAgent(index: Int, delta: Int) {
        val list = savedAgents ?: return
        val names = dev.foxfleet.app.data.Registry.moved(list.map { it.name }, index, delta)
        if (names == list.map { it.name }) return
        savedAgents = names.map { n -> list.first { it.name == n } }
        viewModelScope.launch {
            try { api.reorderAgents(names); refreshFleet() } catch (e: CancellationException) { throw e } catch (e: Exception) {
                savedAgents = list; registryError = scrubAddresses(e.message ?: "Couldn't reorder")
            }
        }
    }

    suspend fun saveAgent(existing: String?, fields: Map<String, Any>): dev.foxfleet.app.data.SaveResult {
        val r = if (existing == null) api.addAgent(fields) else api.editAgent(existing, fields)
        loadRegistry(); refreshFleet(); return r
    }

    suspend fun deleteAgent(name: String) { api.deleteAgent(name); loadRegistry(); refreshFleet() }

    /** Leaving a chat never cancels the agent: the hub keeps the run going and the reply is picked up when we come back. */
    private fun detach(agent: String) { jobs.remove(agent)?.cancel() }

    /** The explicit Stop button: cancels the agent's run on the hub, then the local stream. */
    fun stop(agent: String) {
        val state = chatFor(agent); val run = state.runId
        if (run != null) viewModelScope.launch { runCatching { api.stopRun(agent, run) }; runCatching { state.syncQueue(api, agent) } }
        detach(agent); state.finishRun()
    }
    /** Text the hub refused (e.g. steer with nothing running): handed back to the composer so nothing is lost. */
    val lastRejected = mutableMapOf<String, String>()
    fun resumeQueue(agent: String) { viewModelScope.launch { runCatching { api.resumeQueue(agent, chatFor(agent).sessionId) }; runCatching { chatFor(agent).syncQueue(api, agent) } } }
    fun cancelQueued(agent: String, id: String) { viewModelScope.launch { runCatching { api.cancelQueued(agent, id, chatFor(agent).sessionId) }; chatFor(agent).dropQueued(id) } }

    /** Native Hermes sessions only: cards answer through the hub, the model is per conversation, the busy default is profile-wide. */
    fun nativeControls(agent: String): dev.foxfleet.app.ui.screens.NativeControls = dev.foxfleet.app.ui.screens.NativeControls(
        models = { api.models(agent) },
        setModel = { m, p -> api.setModel(agent, chatFor(agent).sessionId ?: error("No conversation yet"), m, p) },
        confirmModel = { m, p -> api.setModel(agent, chatFor(agent).sessionId ?: error("No conversation yet"), m, p, confirm = true) },
        busy = { api.profileBusy(agent) }, setBusy = { api.setProfileBusy(agent, it) },
    )
    /** What /model talks to (0.4.1): the native gateway, the hub's per-chat model ("request"), or nothing. */
    fun modelControls(agent: dev.foxfleet.app.data.AgentStatus): dev.foxfleet.app.ui.screens.NativeControls? = when (agent.capabilities.modelsMode) {
        "native" -> nativeControls(agent.name)
        "request" -> dev.foxfleet.app.ui.screens.NativeControls(
            models = { api.agentModels(agent.name, chatFor(agent.name).sessionId) },
            setModel = { m, p -> api.setChatModel(agent.name, chatFor(agent.name).sessionId ?: error("No conversation yet"), m, p) },
            busy = { "" }, setBusy = { error("Not available for this agent") },
        )
        else -> dev.foxfleet.app.ui.screens.NativeControls(
            models = { runCatching { api.agentModels(agent.name, chatFor(agent.name).sessionId) }.getOrDefault(emptyList()) },
            setModel = { m, p -> sendModelCommand(agent.name, m, p, global = false) },
            setGlobalModel = { m, p -> sendModelCommand(agent.name, m, p, global = true) },
            busy = { "" }, setBusy = {},
        )
    }
    private suspend fun sendModelCommand(agent: String, model: String, provider: String?, global: Boolean): String {
        val cmd = buildString {
            append("/model "); append(model)
            if (!provider.isNullOrBlank()) append(" --provider ").append(provider)
            if (global) append(" --global")
        }
        send(agent, cmd)
        return if (global) "Asked the agent to use $model as default" else "Asked the agent to use $model"
    }
    suspend fun answerRequest(agent: String, id: String, result: kotlinx.serialization.json.JsonObject): String? = chatFor(agent).answerRequest(api, agent, id, result)

    fun newChat(agent: String) { detach(agent); chatFor(agent).newConversation() }

    /** /retry: drop the last assistant reply and send the last user message again. */
    fun retry(agent: String) {
        val state = chatFor(agent); if (state.streaming) return
        val last = state.messages.lastOrNull { it.role == "user" } ?: return
        state.dropAfterLastUser(); send(agent, last.content, last.images)
    }

    private var restoredOnce = false
    /** After a process restart, open straight into the chat that was open (and its running reply) instead of the fleet list. */
    private fun restoreLastChat() {
        if (restoredOnce) return; restoredOnce = true
        val a = settings.lastAgent; val saved = if (a.isNotEmpty()) settings.savedChat(a) else return
        if (route == Route.Fleet && agents.any { it.name == a } && (saved.session != null || saved.run != null)) navigate(Route.Chat(a))
    }

    /** Reopen the remembered session of [agent] and, if its reply was still being written, reattach to it. */
    fun restore(agent: String) {
        val state = chatFor(agent)
        if (state.streaming || state.messages.isNotEmpty() || state.sessionId != null || jobs.containsKey(agent)) return
        val saved = settings.savedChat(agent); val session = saved.session ?: return
        state.beginLoad()
        jobs[agent] = viewModelScope.launch {
            try {
                showCachedChat(state, agent, session)
                val page = try { newestPage(agent, session) } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (e: Exception) {
                    if (state.fromCache && state.sessionId == session) { state.keepCached(OFFLINE_NOTICE); return@launch } else throw e
                }
                page.let { state.load(it.messages, session, it.hasMore) }
                val run = runCatching { api.runs(agent, session).maxByOrNull { it.started } }.getOrNull()
                val endsWithReply = state.messages.lastOrNull()?.role == "assistant"
                if (run == null || (run.state != "running" && endsWithReply)) { state.finishRun(); state.missedRun = null; return@launch }
                state.missedRun = null; state.resume(api, agent, run.id, saved.user); storeReply(agent)
            } catch (e: CancellationException) {
            } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false
            } catch (e: Exception) { if (state.sessionId == null) state.loadFailed(e.message?.let(::scrubAddresses) ?: "Couldn't load") }
        }
    }

    /** History list: the first page (pull-to-refresh) or the next page appended. */
    fun loadSessions(agent: String, more: Boolean = false) {
        if (sessionsLoading[agent] == true) return
        sessionsLoading[agent] = true; historyError = null
        viewModelScope.launch {
            try {
                val have = if (more) sessions[agent].orEmpty() else emptyList()
                if (!more && sessions[agent].isNullOrEmpty()) fromCache { chats(agent) }?.takeIf { it.isNotEmpty() }?.let { if (sessions[agent].isNullOrEmpty()) sessions[agent] = it }
                val page = api.sessions(agent, offset = have.size)
                sessions[agent] = have + page.sessions.filter { n -> have.none { it.id == n.id } }; sessionTotals[agent] = page.total
                if (!more) cached { saveChats(agent, page.sessions) }
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (e: Exception) {
                historyError = scrubAddresses(e.message ?: "Couldn't load history")
            } finally { sessionsLoading[agent] = false }
        }
    }

    fun renameSession(agent: String, id: String, title: String) {
        viewModelScope.launch {
            try { api.renameSession(agent, id, title); sessions[agent] = sessions[agent].orEmpty().map { if (it.id == id) it.copy(title = title) else it } }
            catch (e: CancellationException) { throw e } catch (e: Exception) { historyError = scrubAddresses(e.message ?: "Couldn't rename") }
        }
    }

    fun deleteSession(agent: String, id: String) {
        viewModelScope.launch {
            try {
                api.deleteSession(agent, id); sessions[agent] = sessions[agent].orEmpty().filterNot { it.id == id }
                cached { forgetChat(agent, id) }
                sessionTotals[agent] = ((sessionTotals[agent] ?: 1) - 1).coerceAtLeast(0)
                if (chatFor(agent).sessionId == id) newChat(agent)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { historyError = scrubAddresses(e.message ?: "Couldn't delete") }
        }
    }

    /** Scrolled to the top of a long conversation: fetch the next older page. */
    fun loadOlder(agent: String) {
        val state = chatFor(agent); val id = state.sessionId ?: return
        if (!state.hasOlder || state.loadingOlder || state.loading) return
        state.beginOlder()
        viewModelScope.launch {
            // Keyset over the device cache first (no network, works offline); the hub's offset paging once the device runs out.
            val oldestKey = state.messages.firstOrNull()?.let { dev.foxfleet.app.data.MessageKeys.keys(state.messages).first() }
            val local = oldestKey?.let { k -> fromCache { olderThan(agent, id, k) } }
            if (local != null && local.messages.isNotEmpty()) {
                if (state.sessionId == id) state.prependCached(local.messages, local.moreOnDevice || local.hubHasOlder, local.hubOffset) else state.olderFailed()
                return@launch
            }
            try {
                val offset = state.olderOffset; val p = api.messages(agent, id, offset = offset)
                cached { saveOlder(agent, id, p.messages, p.hasMore, offset) }
                if (state.sessionId == id) state.prepend(p.messages, p.hasMore) else state.olderFailed()
            }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false; state.olderFailed() } catch (_: Exception) { state.olderFailed() }
        }
    }

    private val reactionSyncs = HashMap<String, Job>()

    /**
     * After a reply or on open: give live messages their provider ids, then read the reactions (no-op for agents without them).
     * Hermes stores a turn after its stream closed, so right after a run the newest messages may not be in its transcript yet:
     * without `reactionEvents` (no live event brings the agent's REACT: or the ids), try again a few times, 1.5 s to 12 s apart.
     */
    fun syncReactions(agent: String) {
        if (agent(agent)?.capabilities?.reactions != true) return
        val state = chatFor(agent)
        reactionSyncs[agent]?.cancel()
        reactionSyncs[agent] = viewModelScope.launch {
            try {
                for ((i, wait) in REACTION_RETRY_MS.withIndex()) {
                    if (wait > 0) delay(wait)
                    if (state.streaming) return@launch
                    state.reconcile(api, agent); state.refreshReactions(api, agent)
                    if (features.reactionEvents || !dev.foxfleet.app.ui.chat.MessageMerge.needsIds(state.messages) || i == REACTION_RETRY_MS.lastIndex) return@launch
                }
            }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    /** Pills: [present] is what the chip shows you gave. */
    fun react(agent: String, messageId: String, emoji: String, present: Boolean) = reactWith(agent) { s -> s.react(api, agent, messageId, emoji, present) }
    fun react(agent: String, m: UiMessage, emoji: String, present: Boolean) = reactWith(agent) { s -> s.react(api, agent, m, emoji, present) }
    /** Quick row, picker, double tap: add the emoji, or take yours back. */
    fun toggleReaction(agent: String, m: UiMessage, emoji: String) = reactWith(agent) { s -> s.toggleReaction(api, agent, m, emoji) }

    private fun reactWith(agent: String, block: suspend (ChatState) -> Unit) {
        if (agent(agent)?.capabilities?.reactions != true) return // bot agents: no reactions at all
        val state = chatFor(agent)
        viewModelScope.launch {
            try { block(state) }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
            // a refused or failed change rolled back: say why, briefly
            state.reactionError?.let { msg -> state.reactionError = null; android.widget.Toast.makeText(getApplication(), msg, android.widget.Toast.LENGTH_SHORT).show() }
        }
    }

    fun hide(agent: String, messageId: String, present: Boolean) {
        val state = chatFor(agent)
        viewModelScope.launch {
            try { state.hide(api, agent, messageId, present) }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    /**
     * Edit (Hermes): /undo takes the last exchange back from the agent and the history reloads. Only when [target] is really gone
     * does [onUndone] put its text back in the composer; otherwise the chat says the message could not be taken back.
     */
    fun editLast(agent: String, target: dev.foxfleet.app.data.UiMessage, onUndone: () -> Unit) {
        val state = chatFor(agent); val sid = state.sessionId ?: return
        if (state.streaming || state.loading || state.queuePending) return
        val before = state.userCopies(target)
        jobs[agent] = viewModelScope.launch {
            try {
                state.send(api, agent, "/undo", emptyList())
                if (state.error != null || state.sessionId != sid) return@launch // a failed /undo leaves the composer alone
                // The reload is a load: the composer waits (as on web), so no new turn can start before the page lands.
                state.beginLoad()
                // cancelled: whoever cancelled (another chat, a new chat) owns the loading flag now
                val page = try { newestPage(agent, sid) } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    if (state.sessionId == sid) state.endLoad()
                    if (e is AuthRequiredException) throw e
                    state.addNotice("Couldn't take that message back."); return@launch
                }
                when (state.applyUndo(sid, page.messages, page.hasMore, target, before)) {
                    true -> onUndone()
                    false -> state.addNotice("Couldn't take that message back.")
                    null -> {}
                }
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    fun openSession(agent: String, id: String) {
        detach(agent)
        val state = chatFor(agent)
        state.beginLoad()
        viewModelScope.launch {
            try {
                showCachedChat(state, agent, id)
                newestPage(agent, id).let { if (state.sessionId == id || !state.fromCache) state.load(it.messages, id, it.hasMore) }
                followMissed(agent)
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) {
                deactivateMedia(purge = true)
                authed = false
            } catch (e: Exception) {
                if (state.fromCache && state.sessionId == id) state.keepCached(OFFLINE_NOTICE)
                else state.loadFailed(e.message?.let(::scrubAddresses) ?: "Couldn't load")
            }
        }
    }


    // ---- phase 1 (0.4.0): live v2, chat list rows, typing, read receipts, badge. Every part is gated by hub.features ----

    val features: dev.foxfleet.app.data.live.HubFeatures get() = dev.foxfleet.app.data.live.HubFeatures.of(hubFeatures)
    /** The hub answered 404/400 to `?v=2` although it listed `live2`: v1 for the rest of this login. */
    private var v2Unsupported = false
    private var v2Runner: dev.foxfleet.app.data.live.LiveV2Runner? = null
    /** Connection indicator: null = nothing to show (live, or a hub without a live stream). */
    var link by mutableStateOf<dev.foxfleet.app.data.live.LinkState?>(null); private set
    /** What the title bars show: offline start wins, then the v2 state, then v1 (connected or connecting). */
    val linkIndicator: dev.foxfleet.app.data.live.LinkState? get() = when {
        offline -> dev.foxfleet.app.data.live.LinkState.Offline
        link != null -> link.takeIf { it != dev.foxfleet.app.data.live.LinkState.Live }
        hubHas("live") && authed == true && foreground && !liveConnected && liveJob?.isActive == true -> dev.foxfleet.app.data.live.LinkState.Connecting
        else -> null
    }
    /** Chat-list rows by agent (feature `chats`), main list and archived; empty on hubs without it (the agent list is then the list). */
    var chatRows by mutableStateOf<Map<String, dev.foxfleet.app.data.live.HubChat>>(emptyMap()); private set
    var archivedRows by mutableStateOf<List<dev.foxfleet.app.data.live.HubChat>>(emptyList()); private set
    var showArchived by mutableStateOf(false); private set
    /** Unread over rows that are neither muted nor archived: the launcher badge. */
    var totalUnread by mutableStateOf(0); private set
    val typing = dev.foxfleet.app.data.live.TypingTracker()
    var typingTick by mutableStateOf(0); private set
    private var typingJob: Job? = null
    private val readSent = HashMap<String, Int>()

    /** The header line for [agent]'s chat [chat]: "typing…", "thinking…", "running bash…", or null. */
    fun typingLabel(agent: String, chat: String?): String? { typingTick; return dev.foxfleet.app.data.live.TypingTracker.label(typing.get(agent, chat)) }

    private fun bumpTyping() {
        typingTick++
        typingJob?.cancel()
        val next = typing.nextExpiryIn() ?: return
        typingJob = viewModelScope.launch { delay(next + 50); bumpTyping() }
    }

    private val runs = dev.foxfleet.app.data.live.RunTracker()

    private fun startLiveV2() {
        val c = cache ?: return; val gen = authGeneration
        val reducer = dev.foxfleet.app.data.live.LiveReducer(c)
        val sink = object : dev.foxfleet.app.data.live.V2Sink {
            override suspend fun onLink(state: dev.foxfleet.app.data.live.LinkState) = withContext(kotlinx.coroutines.Dispatchers.Main) {
                if (gen != authGeneration) return@withContext
                link = state; liveConnected = state == dev.foxfleet.app.data.live.LinkState.Live
            }
            override suspend fun onEvent(e: dev.foxfleet.app.data.live.V2Event) {
                val effects = withContext(kotlinx.coroutines.Dispatchers.IO) { reducer.apply(e) }
                withContext(kotlinx.coroutines.Dispatchers.Main) { if (gen == authGeneration) effects.forEach { onEffect(it) } }
            }
            override fun onTyping(t: dev.foxfleet.app.data.live.Typing) { viewModelScope.launch { if (gen == authGeneration && typing.on(t)) bumpTyping() } }
            override fun onStep(s: dev.foxfleet.app.data.live.RunStep) { viewModelScope.launch { if (gen == authGeneration) onRunStep(s) } }
            override suspend fun onResync(reason: String) = withContext(kotlinx.coroutines.Dispatchers.Main) { if (gen == authGeneration) resyncNow(reason) }
        }
        val cursors = object : dev.foxfleet.app.data.live.CursorStore {
            override suspend fun load() = withContext(kotlinx.coroutines.Dispatchers.IO) { c.sync()?.cursor }
            override suspend fun save(cursor: String) = withContext(kotlinx.coroutines.Dispatchers.IO) { c.saveCursor(cursor) }
            override suspend fun owed() = withContext(kotlinx.coroutines.Dispatchers.IO) { c.sync()?.owedResync }
            override suspend fun markOwed(cursor: String?, reason: String) = withContext(kotlinx.coroutines.Dispatchers.IO) { c.saveOwed(cursor, reason) }
            override suspend fun resynced() = withContext(kotlinx.coroutines.Dispatchers.IO) { c.clearOwed() }
        }
        val runner = dev.foxfleet.app.data.live.LiveV2Runner(api.liveV2Transport, cursors, sink)
        v2Runner = runner
        liveJob = viewModelScope.launch {
            // No cursor yet: take the chat-list snapshot first and start the stream at its cursor, so nothing between the two is lost.
            if (features.chats && withContext(kotlinx.coroutines.Dispatchers.IO) { c.sync()?.cursor } == null) loadChats(takeCursor = true)
            val end = try { withContext(kotlinx.coroutines.Dispatchers.IO) { runner.run() } } finally { liveConnected = false; if (v2Runner === runner) link = null }
            if (gen != authGeneration) return@launch
            when (end) {
                dev.foxfleet.app.data.live.V2End.SignedOut -> boot()
                dev.foxfleet.app.data.live.V2End.Unsupported -> { v2Unsupported = true; v2Runner = null; liveJob = null; syncLive() } // feature fallback: v1 + polling
            }
        }
    }

    /** `run.step` (0.4.1 hubs): a step of the reply streaming in that chat; a run of the open chat that nobody follows yet is followed now. */
    internal fun onRunStep(s: dev.foxfleet.app.data.live.RunStep) {
        val state = chats.peek(s.agent)?.takeIf { it.sessionId == s.chat } ?: return
        if (state.streaming) { state.applyRunStep(s); return }
        val run = s.runId ?: return
        if (openChatAgent() != s.agent || !runs.isLive(run)) return
        if (state.loading) { state.missedRun = run; return }
        if (jobs[s.agent]?.isActive != true && state.messages.none { it.runId == run }) followRun(s.agent, run)
    }

    /** One reducer effect on the screens (main thread). */
    internal fun onEffect(f: dev.foxfleet.app.data.live.LiveEffect) {
        val open = openChatAgent()
        when (f) {
            is dev.foxfleet.app.data.live.LiveEffect.Upserted -> {
                val state = chats.peek(f.agent)
                if (state != null && state.sessionId == f.chat && state.applyLive(f.message.toUi(), f.edited)) {
                    // the merged copy keeps the streamed thinking and steps: store that, not the text-only event
                    state.messages.firstOrNull { it.hubId == f.message.hubId }?.takeIf { it.role == "assistant" && (it.reasoning.isNotEmpty() || it.steps.isNotEmpty()) }?.let { m -> viewModelScope.launch { cached { upsertLive(f.agent, f.chat, m) } } }
                    if (open == f.agent && foreground) sendRead(f.agent, f.chat, f.message.n)
                    else if (f.message.role == "assistant" && !f.edited && !f.message.reactionOnly) state.markUnread() // a reaction is not a reply
                }
            }
            is dev.foxfleet.app.data.live.LiveEffect.Reactions -> chats.peek(f.agent)?.takeIf { it.sessionId == f.chat }?.applyReactionEvent(f.hubId, f.upstreamId, f.groups)
            is dev.foxfleet.app.data.live.LiveEffect.Deleted -> chats.peek(f.agent)?.takeIf { it.sessionId == f.chat }?.applyDeleted(f.hubIds)
            is dev.foxfleet.app.data.live.LiveEffect.Status -> chats.peek(f.agent)?.takeIf { it.sessionId == f.chat }?.applyStatus(f.hubIds, f.status)
            is dev.foxfleet.app.data.live.LiveEffect.FetchAfter -> fetchAfter(f.agent, f.chat, f.afterN)
            dev.foxfleet.app.data.live.LiveEffect.ListChanged -> reloadRows()
            is dev.foxfleet.app.data.live.LiveEffect.Read -> {
                // read on another device: the notification for that chat goes too (as messengers do)
                if (f.state.agentUnread == 0) dev.foxfleet.app.notify.NotifyController.onChatOpened(getApplication(), f.agent, null)
                if (f.state.agentUnread == 0) chats.peek(f.agent)?.markRead()
            }
            is dev.foxfleet.app.data.live.LiveEffect.Notice -> {
                // Keyed on run_id: a repeat (replay) or a start after its finish is not followed twice.
                when (f.type) {
                    "run_started" -> if (f.runId != null && !runs.started(f.runId, f.agent, f.chat)) return
                    "run_finished" -> runs.finished(f.runId, f.agent, f.chat)?.chat?.let { c -> if (typing.clear(f.agent, c)) bumpTyping() }
                }
                onLiveEvent(dev.foxfleet.app.data.LiveEvent("", f.type, f.agent, f.chat, f.runId, f.state))
            }
            is dev.foxfleet.app.data.live.LiveEffect.StopTyping -> if (typing.clear(f.agent, f.chat)) bumpTyping()
        }
    }

    /** Messages after [afterN] for a cached chat (a gap inside one chat); null = the chat is not numbered: drop its cache. Errors are retried by the next event. */
    private fun fetchAfter(agent: String, chat: String, afterN: Int?) {
        val key = "after:$agent\u0000$chat"
        if (catchUps[key]?.isActive == true) return
        catchUps[key] = viewModelScope.launch {
            try { fetchAfterNow(agent, chat, afterN) }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    /** [fetchAfter]'s work; throws on failure (the resync keeps itself owed). A hub without `after_n` (404/400) drops that chat's cache. */
    private suspend fun fetchAfterNow(agent: String, chat: String, afterN: Int?) {
        if (afterN == null) { cached { dropChatMessages(agent, chat) }; return }
        var from: Int = afterN; var pages = 0
        try {
            while (pages++ < MAX_AFTER_PAGES) {
                val p = api.messagesAfter(agent, chat, from)
                for (m in p.messages) {
                    cached { upsertLive(agent, chat, m) }
                    chats.peek(agent)?.takeIf { it.sessionId == chat }?.applyLive(m, edited = false)
                }
                from = p.messages.mapNotNull { it.n }.maxOrNull() ?: return
                if (!p.hasMore) return
            }
            // Still more after MAX_AFTER_PAGES: too far behind to page in, start this chat over (the next open reloads it).
            if (chats.peek(agent)?.sessionId != chat) cached { dropChatMessages(agent, chat) }
        } catch (e: dev.foxfleet.app.data.HubApiException) {
            if (e.status == 404 || e.status == 400) cached { dropChatMessages(agent, chat) } else throw e
        }
    }

    /**
     * After a gap, a 410, the first connect or the stuck escape: the list, then EVERY cached chat by `after_n` (4 at a time),
     * then the open chat's newest page. Returns when all of it finished and throws when any part failed, so the runner keeps
     * the resync owed (in Room, with the cursor) and redoes it: after a backoff, on the next connect, or after process death.
     * Cancelled with the live job when the app goes to the background; still owed then too.
     */
    private suspend fun resyncNow(@Suppress("UNUSED_PARAMETER") reason: String) {
        try {
            if (features.chats) loadChats(strict = true)
            val refs = fromCache { cachedChats() }.orEmpty()
            val gate = kotlinx.coroutines.sync.Semaphore(RESYNC_PARALLEL)
            val failures = kotlinx.coroutines.coroutineScope {
                refs.map { r ->
                    async {
                        gate.acquire()
                        try {
                            val numbered = fromCache { numbered(r.agent, r.chatId) } == true
                            if (numbered && r.maxN != null) fetchAfterNow(r.agent, r.chatId, r.maxN)
                            else if (chats.peek(r.agent)?.sessionId != r.chatId) cached { dropChatMessages(r.agent, r.chatId) }
                            null
                        } catch (e: CancellationException) { throw e } catch (e: Exception) { e } finally { gate.release() }
                    }
                }.awaitAll().filterNotNull()
            }
            failures.firstOrNull { it is AuthRequiredException }?.let { throw it }
            if (failures.isNotEmpty()) throw java.io.IOException("resync: ${failures.size} of ${refs.size} chats failed", failures.first())
            openChatAgent()?.let { catchUp(it) }
            fleetSoon()
        } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false; throw java.io.IOException("signed out during resync") }
    }

    /** `GET /api/chats` (main, and archived when that view is open): rows to the cache, then to the screen. */
    private suspend fun loadChats(takeCursor: Boolean = false, strict: Boolean = false) {
        if (!features.chats) return
        try {
            val main = api.chats(archived = false)
            cached { saveSnapshot(false, main, takeCursor) }
            if (showArchived) { val arch = api.chats(archived = true); cached { saveSnapshot(true, arch, false) } }
            reloadRows()
        } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false; if (strict) throw e } catch (e: Exception) { if (strict) throw e }
    }

    private var rowsJob: Job? = null
    /** Rows from the cache (the single source the list draws from), coalesced. */
    private fun reloadRows() {
        if (rowsJob?.isActive == true) return
        rowsJob = viewModelScope.launch {
            delay(60)
            val main = fromCache { chatRows(false) }.orEmpty(); val arch = fromCache { chatRows(true) }.orEmpty()
            chatRows = (main + arch).associateBy { it.agent }; archivedRows = arch
            val now = System.currentTimeMillis()
            totalUnread = dev.foxfleet.app.ui.ChatRows.badgeTotal(main, now)
            publishBadge()
        }
    }

    private fun publishBadge() {
        val per = chatRows.values.filter { !it.archived && !it.mutedAt(System.currentTimeMillis()) }.associate { it.agent to it.badge }
        dev.foxfleet.app.notify.NotifyController.setBadge(getApplication(), totalUnread, per)
    }

    fun setArchivedView(on: Boolean) { showArchived = on; if (on) viewModelScope.launch { loadChats() } }

    /** Optimistic row change, the hub's row replaces it; on failure the old row comes back. */
    private fun rowAction(agent: String, local: (dev.foxfleet.app.data.live.HubChat) -> dev.foxfleet.app.data.live.HubChat, call: suspend () -> dev.foxfleet.app.data.live.HubChat?, failText: String) {
        val before = chatRows[agent] ?: return
        val after = local(before)
        chatRows = chatRows + (agent to after); archivedRows = chatRows.values.filter { it.archived }
        totalUnread = dev.foxfleet.app.ui.ChatRows.badgeTotal(chatRows.values.filter { !it.archived }, System.currentTimeMillis())
        viewModelScope.launch {
            try { val row = call() ?: after; cached { saveChatRow(row) }; reloadRows() }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false
            } catch (e: Exception) { cached { saveChatRow(before) }; reloadRows(); fleetError = failText }
        }
    }

    fun archiveChat(agent: String, archived: Boolean) {
        if (!features.chats) return
        rowAction(agent, { it.copy(archived = archived) }, { api.archiveChat(agent, archived) }, if (archived) "Couldn't archive the chat" else "Couldn't unarchive the chat")
    }

    fun toggleMute(agent: String) {
        val row = chatRows[agent] ?: return
        val on = !row.mutedAt(System.currentTimeMillis())
        rowAction(agent, { it.copy(muted = on, mutedUntil = null) }, { api.muteAgent(agent, on); null }, if (on) "Couldn't mute the chat" else "Couldn't unmute the chat")
    }

    /** Mark unread / read from the list. Without `chats` it is the device-local unread mark, as before. */
    fun setUnread(agent: String, unread: Boolean) {
        if (!features.chats || chatRows[agent] == null) { if (unread) chatFor(agent).markUnread() else chatFor(agent).markRead(); return }
        if (unread) rowAction(agent, { it.copy(manualUnread = true) }, { api.markChatUnread(agent, true) }, "Couldn't mark as unread")
        else rowAction(agent, { it.copy(manualUnread = false, unread = 0) }, {
            if (features.readReceipts) { api.markChatRead(agent, null, null); null } else api.markChatUnread(agent, false)
        }, "Couldn't mark as read")
    }

    /** Sending reads the chat on the hub (it pushes `read`): clear the row's badge now instead of waiting for the event. */
    private fun readOnSend(agent: String) {
        if (!features.chats) return
        val before = chatRows[agent] ?: return
        val after = dev.foxfleet.app.ui.ChatRows.afterSend(before); if (after == before) return
        chatRows = chatRows + (agent to after); archivedRows = chatRows.values.filter { it.archived }
        totalUnread = dev.foxfleet.app.ui.ChatRows.badgeTotal(chatRows.values.filter { !it.archived }, System.currentTimeMillis())
        viewModelScope.launch { cached { saveChatRow(after) }; publishBadge() }
    }

    /** Read receipts: the open chat is read up to its newest numbered message (monotonic; one request per new position). */
    fun sendRead(agent: String, chat: String, upTo: Int? = chats.peek(agent)?.messages?.mapNotNull { it.n }?.maxOrNull()) {
        if (!features.readReceipts || upTo == null) return
        val key = "$agent\u0000$chat"; if ((readSent[key] ?: 0) >= upTo) return
        readSent[key] = upTo
        viewModelScope.launch {
            try {
                val st = api.markChatRead(agent, chat, upTo)
                chatRows[agent]?.let { r -> val nr = r.copy(unread = st.agentUnread, readUpTo = maxOf(r.readUpTo, st.readUpTo), manualUnread = false); cached { saveChatRow(nr) }; reloadRows() }
            } catch (e: CancellationException) { throw e } catch (_: Exception) { readSent.remove(key) }
        }
    }

    companion object {
        /** Chats refreshed at once during a resync (all cached chats are refreshed). */
        const val RESYNC_PARALLEL = 4
        /** after_n pages per chat before the chat is reloaded on open instead. */
        const val MAX_AFTER_PAGES = 10
        const val OFFLINE_NOTICE = "Offline. Showing saved messages."
        /** Open-chat newest-page check: every 20 s without the live stream, every 60 s with it (covers messages that never pass through the hub). */
        const val POLL_MS = 20_000L
        /** syncReactions: now, then again while the newest messages still wait for their provider ids (hubs without reactionEvents). */
        val REACTION_RETRY_MS = longArrayOf(0L, 1_500L, 3_000L, 6_000L, 12_000L)
        const val POLL_LIVE_MS = 60_000L
    }
}
