package dev.foxfleet.app.notify

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.foxfleet.app.data.SessionInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** What the model needs from the device and the hub. The real one is [AndroidNotifyEnv]; tests use a fake. */
interface NotifyEnv {
    fun signedIn(): Boolean
    fun permission(): PermissionState
    fun channels(): List<ChannelStatus>
    fun serviceEnabled(): Boolean
    /** Starts or stops the service. False = it could not start. */
    fun setServiceEnabled(on: Boolean): Boolean
    fun startBlocked(): Boolean
    fun categories(): Set<NotifyCategory>
    fun setCategory(c: NotifyCategory, on: Boolean)
    fun link(): NotifyLink
    fun cacheMutes(list: List<MuteRule>)
    fun now(): Long
    suspend fun prefs(): HubNotifyPrefs
    suspend fun setHubEnabled(on: Boolean): HubNotifyPrefs
    suspend fun mute(agent: String, chat: String?, muted: Boolean, forMs: Long?): HubNotifyPrefs
    suspend fun test(): NotifyEvent
    suspend fun agents(): List<Pair<String, String>>
    suspend fun sessions(agent: String): List<SessionInfo>
}

data class MuteDuration(val label: String, val ms: Long?) {
    companion object { val all = listOf(MuteDuration("1 hour", 3600_000L), MuteDuration("8 hours", 8 * 3600_000L), MuteDuration("24 hours", 24 * 3600_000L), MuteDuration("Until I turn it back on", null)) }
}

data class AgentRow(val name: String, val label: String, val mute: MuteRule?, val chatMutes: List<MuteRule>, val chats: List<SessionInfo>? = null, val expanded: Boolean = false)

data class NotifyUiState(
    val loaded: Boolean = false,
    val signedIn: Boolean = true,
    val serviceOn: Boolean = false,
    val permission: PermissionState = PermissionState.Granted,
    val link: NotifyLink = NotifyLink.Off,
    val startBlocked: Boolean = false,
    val categories: Set<NotifyCategory> = NotifyCategory.entries.toSet(),
    val channels: List<ChannelStatus> = emptyList(),
    val hub: HubNotifyPrefs = HubNotifyPrefs(),
    /** The hub has no /api/notify (404): hide the controls that need it. */
    val hubSupported: Boolean = true,
    val hubError: String? = null,
    val agents: List<AgentRow> = emptyList(),
    val test: TestOutcome = TestOutcome.Idle,
    /** Settings asks the screen to show the permission rationale (then the system dialog). */
    val askPermission: Boolean = false,
    val muteFor: AgentRow? = null,
    val muteChat: Pair<AgentRow, String>? = null,
    val message: String? = null,
)

/** Fixed user-facing text that is not state-dependent. */
object NotifyText {
    const val BATTERY_HINT = "Phones in battery saver or deep sleep can delay alerts when idle. If they arrive late, set FoxFleet to \"Unrestricted\" or \"Never sleeping\" in the battery settings."
    const val BATTERY_ACTION = "Open battery settings"
}

object NotifyStatus {
    /** One line for the Settings status row. */
    fun line(s: NotifyUiState): String = when {
        !s.hubSupported -> "Your hub is too old for notifications. Update it."
        s.serviceOn && !s.permission.ok -> "Permission missing"
        !s.serviceOn -> "Off"
        s.startBlocked || s.link == NotifyLink.Blocked -> "Paused by Android. Open FoxFleet to restart it."
        else -> when (val l = s.link) {
            NotifyLink.Connected -> "Connected"
            NotifyLink.Connecting, NotifyLink.Off -> "Connecting…"
            is NotifyLink.Reconnecting -> "Reconnecting…"
            NotifyLink.Offline -> "Offline. Retrying."
            NotifyLink.SignedOut -> "Log in again to get notifications."
            NotifyLink.Unsupported -> "Your hub is too old for notifications. Update it."
            NotifyLink.Blocked -> "Paused by Android. Open FoxFleet to restart it."
        }
    }
    enum class Tone { Good, Warn, Bad, Neutral }
    fun tone(s: NotifyUiState): Tone = when {
        s.serviceOn && !s.permission.ok -> Tone.Bad
        !s.serviceOn -> Tone.Neutral
        s.link == NotifyLink.Connected -> Tone.Good
        s.link is NotifyLink.Reconnecting || s.link == NotifyLink.Connecting || s.link == NotifyLink.Off -> Tone.Warn
        else -> Tone.Bad
    }
    fun until(ms: Long?, now: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        if (ms == null) return "Muted until you turn it back on"
        val f = java.text.SimpleDateFormat(if (ms - now > 20 * 3600_000L) "EEE HH:mm" else "HH:mm", java.util.Locale.getDefault()).apply { timeZone = zone }
        return "Muted until ${f.format(java.util.Date(ms))}"
    }
}

/** Settings state and actions for the Notifications section. Pure Kotlin around [NotifyEnv] so it runs in unit tests. */
class NotifySettingsModel(private val env: NotifyEnv, private val scope: CoroutineScope) {
    var ui by mutableStateOf(NotifyUiState())
        private set

    private fun local(): NotifyUiState = ui.copy(
        signedIn = env.signedIn(), serviceOn = env.serviceEnabled(), permission = env.permission(), link = env.link(), startBlocked = env.startBlocked(),
        categories = env.categories(), channels = env.channels(),
    )

    /** Re-read the device state (cheap; call on resume, after the permission dialog, after coming back from the system settings). */
    fun refreshLocal() { ui = local() }

    fun setLink(l: NotifyLink) { ui = ui.copy(link = l) }

    fun refresh() {
        ui = local().copy(loaded = true)
        if (!env.signedIn()) return
        scope.launch {
            try {
                val prefs = env.prefs(); env.cacheMutes(prefs.mutes)
                val agents = runCatching { env.agents() }.getOrDefault(emptyList())
                ui = ui.copy(hub = prefs, hubSupported = true, hubError = null, agents = rows(agents, prefs, ui.agents))
            } catch (e: CancellationException) { throw e } catch (e: NotifyHttpException) {
                ui = if (e.status == 404) ui.copy(hubSupported = false, hubError = null) else ui.copy(hubError = if (e.network) "Can't reach your hub. Mutes may be out of date." else e.message)
            }
        }
    }

    private fun rows(agents: List<Pair<String, String>>, p: HubNotifyPrefs, old: List<AgentRow>): List<AgentRow> {
        val now = env.now()
        val names = (agents.map { it.first } + p.mutes.map { it.agent }).distinct()
        return names.map { n ->
            val prev = old.firstOrNull { it.name == n }
            AgentRow(n, agents.firstOrNull { it.first == n }?.second ?: n, p.agentMute(n, now), p.mutes.filter { it.agent == n && it.chat != null && it.activeAt(now) }, prev?.chats, prev?.expanded ?: false)
        }
    }

    // ---- master switch and permission ----
    fun toggleMaster(on: Boolean) {
        if (!on) { env.setServiceEnabled(false); ui = local(); return }
        if (!env.permission().ok) { ui = local().copy(askPermission = true); return }
        startAfterPermission()
    }

    private fun startAfterPermission() {
        val ok = env.setServiceEnabled(true)
        ui = local().copy(askPermission = false, message = if (ok) null else "Couldn't start the connection. Open FoxFleet and try again.")
        scope.launch { if (!ui.hub.enabled && ui.hubSupported) runCatching { env.setHubEnabled(true) }.onSuccess { ui = ui.copy(hub = it) } }
    }

    fun dismissPermissionAsk() { ui = ui.copy(askPermission = false) }

    /** The system permission dialog returned. */
    fun onPermissionResult(granted: Boolean) {
        ui = local().copy(askPermission = false)
        if (granted) startAfterPermission()
    }

    fun setCategory(c: NotifyCategory, on: Boolean) { env.setCategory(c, on); ui = ui.copy(categories = env.categories()) }

    // ---- mutes ----
    fun askMute(a: AgentRow) { ui = ui.copy(muteFor = a, muteChat = null) }
    fun askMuteChat(a: AgentRow, chat: String) { ui = ui.copy(muteChat = a to chat, muteFor = null) }
    fun dismissMute() { ui = ui.copy(muteFor = null, muteChat = null) }

    fun muteChosen(d: MuteDuration) {
        val agent = ui.muteFor; val chat = ui.muteChat
        ui = ui.copy(muteFor = null, muteChat = null)
        when { agent != null -> applyMute(agent.name, null, true, d.ms); chat != null -> applyMute(chat.first.name, chat.second, true, d.ms) }
    }
    fun unmute(agent: String, chat: String?) = applyMute(agent, chat, false, null)

    private fun applyMute(agent: String, chat: String?, muted: Boolean, forMs: Long?) {
        scope.launch {
            try {
                val p = env.mute(agent, chat, muted, forMs); env.cacheMutes(p.mutes)
                ui = ui.copy(hub = p, agents = rows(ui.agents.map { it.name to it.label }, p, ui.agents), message = null)
            } catch (e: CancellationException) { throw e } catch (e: NotifyHttpException) {
                ui = ui.copy(message = if (e.network) "Can't reach your hub. The mute was not saved." else "Couldn't change the mute: ${e.message}")
            }
        }
    }

    fun toggleChats(agent: String) {
        val row = ui.agents.firstOrNull { it.name == agent } ?: return
        ui = ui.copy(agents = ui.agents.map { if (it.name == agent) it.copy(expanded = !it.expanded) else it })
        if (!row.expanded && row.chats == null) scope.launch {
            val list = runCatching { env.sessions(agent).take(10) }.getOrDefault(emptyList())
            ui = ui.copy(agents = ui.agents.map { if (it.name == agent) it.copy(chats = list) else it })
        }
    }

    // ---- test ----
    fun sendTest() {
        if (ui.test == TestOutcome.Sending) return
        ui = ui.copy(test = TestOutcome.Sending)
        scope.launch {
            ui = ui.copy(test = try {
                if (env.serviceEnabled() && !env.permission().ok) TestOutcome.Failed("Notifications are blocked on this phone. Allow them first.")
                else if (env.test().muted) TestOutcome.HubMuted else if (!env.serviceEnabled()) TestOutcome.SentWhileOff else TestOutcome.Sent
            } catch (e: CancellationException) { throw e } catch (e: NotifyHttpException) {
                when {
                    e.status == 429 -> TestOutcome.RateLimited(e.retryAfterSec ?: 60)
                    e.status == 404 -> TestOutcome.Failed("Your hub is too old for notifications.")
                    e.network -> TestOutcome.Failed("Can't reach your hub.")
                    e.status == 401 -> TestOutcome.Failed("You are signed out. Log in again.")
                    else -> TestOutcome.Failed(e.message ?: "The hub said no.")
                }
            })
        }
    }
}
