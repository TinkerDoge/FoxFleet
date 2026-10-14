package dev.foxfleet.app.notify

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.UiMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicReference

/**
 * End-to-end against a REAL hub (server/index.js), driving the real stream client. Skipped unless the harness is running:
 *   FOXFLEET_E2E_HUB, FOXFLEET_E2E_TOKEN, FOXFLEET_E2E_TOKEN2, FOXFLEET_E2E_DEVICE2, FOXFLEET_E2E_CONTROL (see notifications report),
 *   and FOXFLEET_E2E_AGENT: a Hermes agent whose model is server/test/fake-llm.js (default "atlas").
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotifyHubE2ETest {
    private val agent = System.getenv("FOXFLEET_E2E_AGENT") ?: "atlas"
    private val hub = System.getenv("FOXFLEET_E2E_HUB"); private val token = System.getenv("FOXFLEET_E2E_TOKEN"); private val token2 = System.getenv("FOXFLEET_E2E_TOKEN2")
    private val device2 = System.getenv("FOXFLEET_E2E_DEVICE2"); private val control = System.getenv("FOXFLEET_E2E_CONTROL")
    private val http = OkHttpClient()

    private class Mem(override var lastId: Long? = null, var token: String) : NotifyCursorStore, TokenSource {
        override fun saveToken(token: String) { this.token = token }
        override fun get() = token
        override fun set(token: String) { this.token = token }
    }
    private class Rec : NotifySink {
        val events = java.util.concurrent.CopyOnWriteArrayList<Pair<NotifyEvent, Boolean>>(); val gaps = java.util.concurrent.CopyOnWriteArrayList<NotifyFrame.Gap>()
        override suspend fun onEvents(events: List<NotifyEvent>, replay: Boolean) { this.events.addAll(events.map { it to replay }) }
        override suspend fun onGap(gap: NotifyFrame.Gap) { gaps.add(gap) }
    }

    private fun skew(ms: Long) { http.newCall(Request.Builder().url("$control/skew?ms=$ms").build()).execute().close() }
    private suspend fun until(what: String, ms: Long = 8000, cond: () -> Boolean) { withTimeout(ms) { while (!cond()) kotlinx.coroutines.delay(25) } }

    @Test fun streamResumeRotationAuthAndGapAgainstTheRealHub() = runBlocking(Dispatchers.IO) {
        assumeTrue("no e2e hub", hub != null && token != null && control != null)
        val mem = Mem(null, token!!)
        val api = NotifyApi(hub!!, mem)
        val links = java.util.concurrent.CopyOnWriteArrayList<NotifyLink>()

        fun runner(m: Mem, sink: NotifySink, tok: TokenSource = m) = NotifyStreamRunner(OkHttpNotifyTransport(hub, tok), m, sink, { links.add(it) })

        // 1. first connect = baseline, then a live event arrives with its id
        val sink1 = Rec()
        var job = launch { runner(mem, sink1).run() }
        until("connected") { NotifyLink.Connected in links }
        assertNotNull("baseline cursor is stored from foxfleet.ready", mem.lastId)
        val before = mem.lastId!!
        val t1 = api.test(); until("live test event") { sink1.events.any { it.first.id == t1.id } }
        assertEquals(t1.id, mem.lastId); assertTrue(t1.id > before); assertFalse(sink1.events.first { it.first.id == t1.id }.second)

        // 2. a REAL reply: send a chat message to the Hermes agent (fake LLM model), get reply_finished with ids only, then fetch the content from the hub
        val settings = SettingsStore(ApplicationProvider.getApplicationContext<android.app.Application>().getSharedPreferences("e2e", 0)).also { it.addHub(hub); it.sessionToken = mem.token }
        val hubApi = HubApi(settings)
        val sent = hubApi.sendMessage(agent, UiMessage("user", "hello e2e"), null, "queue", "cid-e2e-1")
        until("reply_finished", 20000) { sink1.events.any { it.first.type == NotifyType.ReplyFinished } }
        val reply = sink1.events.first { it.first.type == NotifyType.ReplyFinished }.first
        assertEquals(agent, reply.agent); assertNotNull(reply.chat); assertNull("event carries no text", reply.message)
        val content = HubNotifyContent(hubApi, seenAt = { null }).lastReply(agent, reply.chat!!)
        assertNotNull(content); assertTrue("fetched text: ${content!!.text}", content.text.contains("ok: hello e2e"))

        // 3. resume: stop, make two events while away, reconnect with the stored id: exactly those two come back, as replay, in order
        job.cancel(); job.join()
        val away1 = api.test(); val away2 = api.test()
        val sink2 = Rec(); val saved = mem.lastId
        job = launch { runner(mem, sink2).run() }
        until("replay") { sink2.events.size >= 2 }
        assertEquals(listOf(away1.id, away2.id), sink2.events.map { it.first.id }); assertTrue(sink2.events.all { it.second }); assertTrue(away1.id > saved!!)
        assertEquals(away2.id, mem.lastId)
        job.cancel(); job.join()

        // 4. token rotation: the hub's clock jumps 25 h, the next stream request carries the old token and the response header carries the new one
        val old = mem.token; skew(25 * 3600_000L)
        val sink3 = Rec(); job = launch { runner(mem, sink3).run() }
        until("rotated token stored") { mem.token != old }
        assertNotEquals(old, mem.token); until("connected after rotation", 8000) { links.count { it == NotifyLink.Connected } >= 3 }
        job.cancel(); job.join()
        skew(25 * 3600_000L + 120_000L) // the old token's 60 s grace is over: it must be refused, the stored one must work
        assertEquals(401, http.newCall(Request.Builder().url("$hub/api/notify/prefs").header("Authorization", "Bearer $old").build()).execute().use { it.code })
        val ok = mem.token
        val sink4 = Rec(); job = launch { runner(mem, sink4).run() }
        val n = links.count { it == NotifyLink.Connected }
        until("reconnect with the stored token") { links.count { it == NotifyLink.Connected } > n }
        assertEquals("no further rotation needed", ok, mem.token); assertTrue(api.prefs().enabled)
        job.cancel(); job.join()

        // 5. gap: a cursor newer than the hub's means the hub's data was reset: gap frame, no replay, restart from the hub's cursor
        val far = Mem(99_999L, mem.token); val sink5 = Rec(); job = launch { runner(far, sink5).run() }
        until("gap") { sink5.gaps.isNotEmpty() }; until("reset cursor") { far.lastId != 99_999L }
        assertTrue(far.lastId!! < 99_999L); assertEquals(far.lastId, sink5.gaps.first().cursor); assertTrue(sink5.events.isEmpty())
        job.cancel(); job.join()

        // 6. sign-out: revoking the device ends its stream with foxfleet.auth and the runner does NOT reconnect
        val dev = Mem(null, token2!!); val sinkA = Rec(); val end = AtomicReference<RunEnd>()
        val j6 = launch { end.set(runner(dev, sinkA).run()) }
        until("device2 connected") { links.count { it == NotifyLink.Connected } > n + 1 }
        val del = http.newCall(Request.Builder().url("$hub/api/auth/devices/$device2").delete().header("Authorization", "Bearer ${mem.token}").build()).execute().use { it.code }
        assertTrue("revoke answered $del", del in 200..204)
        until("runner ended") { end.get() != null }; assertEquals(RunEnd.SignedOut, end.get()); j6.join()

        // 7. mute + prefs round trip through the real routes
        val p = api.mute(agent, null, true, 60_000); assertNotNull(p.agentMute(agent, System.currentTimeMillis())); assertTrue(api.test().muted.not())
        val p2 = api.mute(agent, null, false); assertNull(p2.agentMute(agent, System.currentTimeMillis()))
        val off = api.setEnabled(false); assertFalse(off.enabled); assertTrue("test is muted while the master switch is off", api.test().muted); api.setEnabled(true)
        skew(0)
    }
}
