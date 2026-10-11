package dev.foxfleet.app.notify

import dev.foxfleet.app.data.SessionInfo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

private class FakeEnv : NotifyEnv {
    var signed = true; var perm = PermissionState.Granted; var on = false; var blocked = false; var cats = NotifyCategory.entries.toSet(); var linkNow: NotifyLink = NotifyLink.Off
    var hub = HubNotifyPrefs(); var prefsError: NotifyHttpException? = null; var testResult: () -> NotifyEvent = { ev(false) }; var startOk = true
    val calls = ArrayList<String>(); var cached: List<MuteRule> = emptyList()
    fun ev(muted: Boolean) = NotifyEvent(1, NotifyType.Test, null, null, false, 0, muted)
    override fun signedIn() = signed
    override fun permission() = perm
    override fun channels() = NotifyChannel.entries.map { ChannelStatus(it, true, false, false) }
    override fun serviceEnabled() = on
    override fun setServiceEnabled(on: Boolean): Boolean { calls.add("service:$on"); if (on && !startOk) return false; this.on = on; return true }
    override fun startBlocked() = blocked
    override fun categories() = cats
    override fun setCategory(c: NotifyCategory, on: Boolean) { cats = if (on) cats + c else cats - c }
    override fun link() = linkNow
    override fun cacheMutes(list: List<MuteRule>) { cached = list }
    override fun now() = 1_000L
    override suspend fun prefs(): HubNotifyPrefs { prefsError?.let { throw it }; return hub }
    override suspend fun setHubEnabled(on: Boolean): HubNotifyPrefs { calls.add("hub:$on"); hub = hub.copy(enabled = on); return hub }
    override suspend fun mute(agent: String, chat: String?, muted: Boolean, forMs: Long?): HubNotifyPrefs {
        calls.add("mute:$agent:$chat:$muted:$forMs")
        hub = hub.copy(mutes = hub.mutes.filterNot { it.agent == agent && it.chat == chat } + if (muted) listOf(MuteRule(agent, chat, forMs?.let { 1_000L + it })) else emptyList()); return hub
    }
    override suspend fun test() = testResult()
    override suspend fun agents() = listOf("nova" to "Nova", "echo" to "Echo")
    override suspend fun sessions(agent: String) = listOf(SessionInfo("h_1", "Deploy", 0), SessionInfo("h_2", null, 0))
}

@OptIn(ExperimentalCoroutinesApi::class)
class NotifySettingsModelTest {
    private fun TestScope.model(env: FakeEnv) = NotifySettingsModel(env, this)

    @Test fun masterOnStartsTheServiceAndTurnsAHubSideOffSwitchBackOn() = runTest {
        val env = FakeEnv().apply { hub = HubNotifyPrefs(enabled = false) }; val m = model(env)
        m.refresh(); advanceUntilIdle(); m.toggleMaster(true); advanceUntilIdle()
        assertTrue(m.ui.serviceOn); assertEquals(listOf("service:true", "hub:true"), env.calls); assertTrue(m.ui.hub.enabled)
    }
    @Test fun masterOffStopsTheServiceOnly() = runTest {
        val env = FakeEnv().apply { on = true }; val m = model(env); m.refresh(); advanceUntilIdle()
        m.toggleMaster(false); assertFalse(m.ui.serviceOn); assertEquals(listOf("service:false"), env.calls)
    }
    @Test fun withoutPermissionTheRationaleIsAskedAndTheServiceDoesNotStart() = runTest {
        val env = FakeEnv().apply { perm = PermissionState.NeedsRequest }; val m = model(env)
        m.toggleMaster(true); assertTrue(m.ui.askPermission); assertFalse(m.ui.serviceOn); assertTrue(env.calls.isEmpty())
        env.perm = PermissionState.Granted; m.onPermissionResult(true); advanceUntilIdle(); assertTrue(m.ui.serviceOn); assertFalse(m.ui.askPermission)
    }
    @Test fun deniedAnswerLeavesItOffAndShowsNothingStuck() = runTest {
        val env = FakeEnv().apply { perm = PermissionState.Blocked }; val m = model(env)
        m.toggleMaster(true); m.onPermissionResult(false); assertFalse(m.ui.askPermission); assertFalse(m.ui.serviceOn); assertEquals("Off", NotifyStatus.line(m.ui))
    }
    @Test fun startFailureSaysSo() = runTest {
        val env = FakeEnv().apply { startOk = false }; val m = model(env); m.toggleMaster(true); advanceUntilIdle()
        assertFalse(m.ui.serviceOn); assertNotNull(m.ui.message)
    }
    @Test fun statusLinePerState() {
        fun s(on: Boolean = true, p: PermissionState = PermissionState.Granted, l: NotifyLink = NotifyLink.Connected, blocked: Boolean = false, supported: Boolean = true) = NotifyUiState(serviceOn = on, permission = p, link = l, startBlocked = blocked, hubSupported = supported)
        assertEquals("Connected", NotifyStatus.line(s())); assertEquals("Connecting…", NotifyStatus.line(s(l = NotifyLink.Connecting)))
        assertEquals("Reconnecting…", NotifyStatus.line(s(l = NotifyLink.Reconnecting(2)))); assertEquals("Offline. Retrying.", NotifyStatus.line(s(l = NotifyLink.Offline)))
        assertEquals("Permission missing", NotifyStatus.line(s(p = PermissionState.Blocked))); assertEquals("Off", NotifyStatus.line(s(on = false)))
        assertTrue(NotifyStatus.line(s(blocked = true)).startsWith("Paused by Android")); assertTrue(NotifyStatus.line(s(supported = false)).contains("too old"))
        assertEquals(NotifyStatus.Tone.Good, NotifyStatus.tone(s())); assertEquals(NotifyStatus.Tone.Bad, NotifyStatus.tone(s(p = PermissionState.Blocked))); assertEquals(NotifyStatus.Tone.Neutral, NotifyStatus.tone(s(on = false)))
    }
    @Test fun categoriesPersistThroughTheEnv() = runTest {
        val env = FakeEnv(); val m = model(env); m.setCategory(NotifyCategory.Errors, false)
        assertEquals(setOf(NotifyCategory.Replies, NotifyCategory.Approvals), m.ui.categories); assertEquals(m.ui.categories, env.cats)
    }
    @Test fun muteAnAgentForAnHourThenUnmute() = runTest {
        val env = FakeEnv(); val m = model(env); m.refresh(); advanceUntilIdle()
        val nova = m.ui.agents.first { it.name == "nova" }; m.askMute(nova); assertEquals(nova, m.ui.muteFor)
        m.muteChosen(MuteDuration.all[0]); advanceUntilIdle()
        assertEquals("mute:nova:null:true:3600000", env.calls.last()); assertNotNull(m.ui.agents.first { it.name == "nova" }.mute); assertEquals(1, env.cached.size)
        m.unmute("nova", null); advanceUntilIdle(); assertNull(m.ui.agents.first { it.name == "nova" }.mute); assertTrue(env.cached.isEmpty())
    }
    @Test fun muteOneChatUntilUnmutedSendsNoDuration() = runTest {
        val env = FakeEnv(); val m = model(env); m.refresh(); advanceUntilIdle()
        m.toggleChats("nova"); advanceUntilIdle(); assertEquals(2, m.ui.agents.first { it.name == "nova" }.chats!!.size)
        m.askMuteChat(m.ui.agents.first { it.name == "nova" }, "h_1"); m.muteChosen(MuteDuration.all.last()); advanceUntilIdle()
        assertEquals("mute:nova:h_1:true:null", env.calls.last()); assertEquals(1, m.ui.agents.first { it.name == "nova" }.chatMutes.size)
    }
    @Test fun anOldHubHidesTheControls() = runTest {
        val env = FakeEnv().apply { prefsError = NotifyHttpException(404, "nope") }; val m = model(env); m.refresh(); advanceUntilIdle()
        assertFalse(m.ui.hubSupported)
    }
    @Test fun unreachableHubKeepsTheScreenUsable() = runTest {
        val env = FakeEnv().apply { prefsError = NotifyHttpException(0, "x", network = true) }; val m = model(env); m.refresh(); advanceUntilIdle()
        assertTrue(m.ui.hubSupported); assertNotNull(m.ui.hubError)
    }
    @Test fun testButtonStates() = runTest {
        val env = FakeEnv().apply { on = true }; val m = model(env)
        assertEquals(TestOutcome.Idle, m.ui.test)
        m.sendTest(); assertEquals(TestOutcome.Sending, m.ui.test); advanceUntilIdle(); assertEquals(TestOutcome.Sent, m.ui.test)
        env.testResult = { env.ev(true) }; m.sendTest(); advanceUntilIdle(); assertEquals(TestOutcome.HubMuted, m.ui.test)
        env.testResult = { throw NotifyHttpException(429, "slow", retryAfterSec = 60) }; m.sendTest(); advanceUntilIdle(); assertEquals(TestOutcome.RateLimited(60), m.ui.test)
        env.testResult = { throw NotifyHttpException(0, "x", network = true) }; m.sendTest(); advanceUntilIdle(); assertEquals(TestOutcome.Failed("Can't reach your hub."), m.ui.test)
        env.testResult = { throw NotifyHttpException(401, "login") }; m.sendTest(); advanceUntilIdle(); assertTrue((m.ui.test as TestOutcome.Failed).message.contains("signed out"))
        env.on = false; env.testResult = { env.ev(false) }; m.sendTest(); advanceUntilIdle(); assertEquals(TestOutcome.SentWhileOff, m.ui.test)
    }
    @Test fun testIsRefusedWhenAndroidBlocksNotifications() = runTest {
        val env = FakeEnv().apply { on = true; perm = PermissionState.Blocked }; val m = model(env); m.sendTest(); advanceUntilIdle()
        assertTrue(m.ui.test is TestOutcome.Failed)
    }
    @Test fun muteDescriptions() {
        val zone = java.util.TimeZone.getTimeZone("UTC")
        assertEquals("Muted until you turn it back on", NotifyStatus.until(null, 0, zone)); assertTrue(NotifyStatus.until(3600_000L * 2, 0, zone).startsWith("Muted until 02:00"))
    }
}
