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
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.chat.ChatState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

sealed interface Route {
    data object Fleet : Route
    data class Chat(val agent: String) : Route
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
fun Route.depth(): Int = when (this) { Route.Fleet -> 0; is Route.Chat -> 1; Route.Settings -> 1; is Route.Screen -> 2; Route.Agents -> 2; Route.Hubs -> 2; Route.Devices -> 2; Route.Admin -> 2; is Route.Machines -> 3; is Route.AgentEditor -> 3 }

/** App state that must outlive rotation: auth, fleet, chats, in-flight streams, route. */
class HubViewModel(app: Application) : AndroidViewModel(app) {
    val settings = SettingsStore(app)
    val api = HubApi(settings)

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
        jobs.values.forEach { it.cancel() }; jobs.clear(); chats.clear(); sessions.clear(); skills.clear()
        agents = emptyList(); fleetLoadedOnce = false; route = Route.Fleet; username = ""; isOwner = false
    }
    var agents by mutableStateOf<List<AgentStatus>>(emptyList()); private set
    var fleetLoading by mutableStateOf(false); private set
    var fleetLoadedOnce by mutableStateOf(false); private set
    var fleetError by mutableStateOf<String?>(null); private set
    var route by mutableStateOf<Route>(Route.Fleet); private set
    val sessions = mutableStateMapOf<String, List<SessionInfo>>()
    private val chats = HashMap<String, ChatState>()
    private val jobs = HashMap<String, Job>()

    init { boot() }

    fun boot() {
        bootError = null
        hubSetup = settings.baseUrl.isBlank()
        if (hubSetup) { authed = false; return }
        authed = null
        viewModelScope.launch {
            authed = try {
                val info = api.authInfo(); username = info.username.orEmpty(); isOwner = info.isOwner
                !info.required || info.authenticated
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                bootError = "Can't reach your hub — ${scrubAddresses(e.message ?: "network error")}"
                false
            }
            if (authed == true) refreshFleet()
        }
    }

    fun updatePrefs(p: AppPrefs) { prefs = p; settings.appPrefs = p }

    fun onLoggedIn() { authed = true; bootError = null; viewModelScope.launch { runCatching { val i = api.authInfo(); username = i.username.orEmpty(); isOwner = i.isOwner; inviteDraft = "" } }; refreshFleet() }

    fun signOut() {
        jobs.values.forEach { it.cancel() }; jobs.clear(); chats.clear(); sessions.clear()
        viewModelScope.launch { api.logout() }
        settings.clearSession()
        agents = emptyList(); fleetLoadedOnce = false; route = Route.Fleet; authed = false
    }

    fun refreshFleet() {
        if (fleetLoading) return
        fleetLoading = true; fleetError = null
        viewModelScope.launch {
            try {
                agents = api.agents(); fleetLoadedOnce = true; restoreLastChat()
            } catch (e: AuthRequiredException) {
                authed = false
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                fleetError = e.message?.let(::scrubAddresses) ?: "Fleet sync failed"
            } finally { fleetLoading = false }
        }
    }

    fun navigate(r: Route) {
        if (r is Route.Chat) { settings.lastAgent = r.agent; chatFor(r.agent).markRead(); restore(r.agent) }
        route = r
    }

    /** Back: returns false when there is nowhere to go (let the system finish). */
    fun back(): Boolean = when (val r = route) {
        is Route.Screen -> { route = Route.Chat(r.agent); true }
        Route.Agents, Route.Hubs, Route.Devices, Route.Admin -> { route = Route.Settings; true }
        is Route.AgentEditor -> { route = Route.Agents; true }
        is Route.Machines -> { route = Route.Agents; true }
        Route.Fleet -> false
        else -> { route = Route.Fleet; true }
    }

    fun chatFor(agent: String): ChatState = chats.getOrPut(agent) { ChatState().also { s -> s.persist = { c -> settings.saveChat(agent, c) } } }

    fun agent(name: String): AgentStatus? = agents.firstOrNull { it.name == name }

    val avatars = dev.foxfleet.app.media.AvatarStore(app)
    val skills = mutableStateMapOf<String, List<String>>()
    /** Agent whose avatar is being changed (long-press menu → picker → crop). */
    var avatarTarget by mutableStateOf<String?>(null)

    fun loadSkills(agent: String) {
        if (skills.containsKey(agent)) return
        skills[agent] = emptyList()
        viewModelScope.launch {
            try { skills[agent] = api.skills(agent) } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { authed = false } catch (_: Exception) {}
        }
    }

    fun send(agent: String, text: String, images: List<dev.foxfleet.app.data.ImageAttachment> = emptyList()) {
        val state = chatFor(agent)
        if (state.streaming || (text.isBlank() && images.isEmpty())) return
        jobs[agent] = viewModelScope.launch {
            try {
                state.send(api, agent, text.trim(), images)
                if ((route as? Route.Chat)?.agent != agent) state.markUnread()
            } catch (e: CancellationException) {
            } catch (e: AuthRequiredException) {
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

    /** Mailbox agents (Scribe) answer later: refresh the open thread while the chat is visible. */
    suspend fun pollInbox(agent: String) {
        val state = chatFor(agent)
        val id = state.sessionId ?: return
        if (state.streaming) return
        val fresh = runCatching { api.messages(agent, id) }.getOrNull() ?: return
        if (fresh.size != state.messages.size && !state.streaming && state.sessionId == id) state.load(fresh, id)
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
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { authed = false } catch (e: Exception) {
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
        if (run != null) viewModelScope.launch { runCatching { api.stopRun(agent, run) } }
        detach(agent); state.finishRun()
    }

    fun newChat(agent: String) { detach(agent); chatFor(agent).newConversation() }

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
                state.load(api.messages(agent, session), session)
                val run = runCatching { api.runs(agent, session).maxByOrNull { it.started } }.getOrNull()
                val endsWithReply = state.messages.lastOrNull()?.role == "assistant"
                if (run == null || (run.state != "running" && endsWithReply)) { state.finishRun(); return@launch }
                state.resume(api, agent, run.id, saved.user)
            } catch (e: CancellationException) {
            } catch (e: AuthRequiredException) { authed = false
            } catch (e: Exception) { if (state.sessionId == null) state.loadFailed(e.message?.let(::scrubAddresses) ?: "Couldn't load") }
        }
    }

    fun loadSessions(agent: String) {
        viewModelScope.launch {
            runCatching { api.sessions(agent) }.onSuccess { sessions[agent] = it }
        }
    }

    fun openSession(agent: String, id: String) {
        detach(agent)
        val state = chatFor(agent)
        state.beginLoad()
        viewModelScope.launch {
            try {
                state.load(api.messages(agent, id), id)
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) {
                authed = false
            } catch (e: Exception) {
                state.loadFailed(e.message?.let(::scrubAddresses) ?: "Couldn't load")
            }
        }
    }
}
