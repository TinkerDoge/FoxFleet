package dev.foxfleet.app.data.live

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.LiveCancel
import dev.foxfleet.app.data.LiveOpen
import dev.foxfleet.app.data.local.CacheDb
import dev.foxfleet.app.data.local.ChatCache
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.io.StringReader

/**
 * QA A1 (Soran, fa37c6b): a resync owed after a gap / 410 survives a failed resync, background cancellation and process
 * death (it lives in Room with the cursor), and is retried. Plus the stuck-cursor escape (A1b).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResyncDurabilityTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
    private fun ev(seq: Long, store: String = "s1") = "id: $store:$seq\nevent: chat.removed\ndata: {\"seq\":$seq,\"type\":\"chat.removed\",\"at\":1,\"agent\":\"nova\"}\n\n"
    private fun ready(c: String) = "event: foxfleet.ready\ndata: {\"contract\":\"foxfleet.live/2\",\"cursor\":\"$c\",\"heartbeat_ms\":15000}\n\n"
    private fun gap(r: String, c: String) = "event: foxfleet.gap\ndata: {\"reason\":\"$r\",\"cursor\":\"$c\"}\n\n"
    private fun stream(b: String) = LiveOpen(200, "text/event-stream", StringReader("retry: 2000\n\n$b"))

    /** The same adapter as HubViewModel's: the Room sync row of the owner. */
    private class RoomCursors(val c: ChatCache) : CursorStore {
        override suspend fun load() = c.sync()?.cursor
        override suspend fun save(cursor: String) = c.saveCursor(cursor)
        override suspend fun owed() = c.sync()?.owedResync
        override suspend fun markOwed(cursor: String?, reason: String) = c.saveOwed(cursor, reason)
        override suspend fun resynced() = c.clearOwed()
    }
    private class Sink(val fail: (Int) -> Exception? = { null }) : V2Sink {
        val log = ArrayList<String>(); var calls = 0
        override suspend fun onLink(state: LinkState) { if (log.lastOrNull() != "link:$state") log += "link:$state" }
        override suspend fun onEvent(e: V2Event) { log += "event:${e.seq}" }
        override fun onTyping(t: Typing) {}
        override suspend fun onResync(reason: String) { val x = fail(calls++); if (x != null) { log += "resync-failed:$reason"; throw x }; log += "resync:$reason" }
    }
    private fun script(vararg a: () -> LiveOpen, seen: MutableList<String?> = ArrayList()): (String?, LiveCancel) -> LiveOpen {
        var i = 0; return { c, _ -> seen += c; a.getOrNull(i++)?.invoke() ?: LiveOpen(401, null, null) }
    }
    private fun db(name: String) = CacheDb.build(ctx, name, destructive = false)

    @Test fun failedResyncAfterAGapIsRetriedWithBackoffOnTheNextConnect() = runBlocking {
        val d = db("r1.db"); val c = ChatCache(d, "o"); c.saveCursor("s1:3")
        val sink = Sink(fail = { if (it == 0) IOException("chats 503") else null }); val waits = ArrayList<Long>(); val seen = ArrayList<String?>()
        LiveV2Runner(script({ stream(gap("expired", "s1:900") + ready("s1:900")) }, { stream(ready("s1:900") + ev(901)) }, seen = seen), RoomCursors(c), sink, sleep = { waits += it }, random = { 1.0 }).run()
        assertEquals(listOf("resync-failed:expired", "resync:expired"), sink.log.filter { it.startsWith("resync") })
        assertEquals(listOf("s1:3", "s1:900"), seen.take(2)) // the retry resumes from the gap cursor
        assertTrue("backoff before the retry", waits.first() >= 1000)
        assertNull(c.sync()!!.owedResync); assertEquals("s1:901", c.sync()!!.cursor)
        d.close()
    }

    @Test fun backgroundCancellationDuringResyncKeepsItOwedForTheNextRunner() = runBlocking {
        val d = db("r2.db"); val c = ChatCache(d, "o"); c.saveCursor("s1:3")
        val r1 = LiveV2Runner(script({ stream(gap("expired", "s1:900") + ready("s1:900")) }), RoomCursors(c), Sink(fail = { CancellationException("app to background") }), sleep = {})
        assertTrue(runCatching { r1.run() }.exceptionOrNull() is CancellationException)
        assertEquals("expired", c.sync()!!.owedResync); assertEquals("s1:900", c.sync()!!.cursor)
        // Back to the foreground: a clean resume (no gap this time) still resyncs before Live.
        val sink = Sink()
        LiveV2Runner(script({ stream(ready("s1:900")) }), RoomCursors(c), sink, sleep = {}).run()
        assertTrue(sink.log.toString(), sink.log.indexOf("resync:expired") in 0 until sink.log.indexOf("link:Live"))
        assertNull(c.sync()!!.owedResync)
        d.close()
    }

    @Test fun processDeathBetweenGapAndResyncIsRecoveredFromRoom() = runBlocking {
        val first = db("r3.db"); val c1 = ChatCache(first, "o"); c1.saveCursor("s1:3")
        // The gap arrives and is stored; the process dies before ready (stream cut, then the coroutine is gone).
        val r1 = LiveV2Runner(script({ stream(gap("reset", "s2:10")) }), RoomCursors(c1), Sink(), sleep = { throw CancellationException("process killed") })
        runCatching { r1.run() }
        first.close()
        val second = db("r3.db"); val c2 = ChatCache(second, "o") // a new process opens the same file
        assertEquals("reset", c2.sync()!!.owedResync); assertEquals("s2:10", c2.sync()!!.cursor)
        val sink = Sink(); val seen = ArrayList<String?>()
        LiveV2Runner(script({ stream(ready("s2:10")) }, seen = seen), RoomCursors(c2), sink, sleep = {}).run()
        assertEquals("s2:10", seen[0]); assertEquals(1, sink.log.count { it == "resync:reset" }); assertNull(c2.sync()!!.owedResync)
        second.close()
    }

    @Test fun owed410SurvivesANewRunner() = runBlocking {
        val d = db("r4.db"); val c = ChatCache(d, "o"); c.saveCursor("s1:3")
        val r1 = LiveV2Runner(script({ LiveOpen(410, "application/json", StringReader("{\"code\":\"cursor_expired\",\"cursor\":\"s1:900\"}")) }), RoomCursors(c), Sink(), sleep = { throw CancellationException("backgrounded") })
        runCatching { r1.run() }
        val sink = Sink()
        LiveV2Runner(script({ stream(ready("s1:900")) }), RoomCursors(c), sink, sleep = {}).run()
        assertEquals(listOf("resync:expired"), sink.log.filter { it.startsWith("resync") })
        d.close()
    }

    @Test fun stuckCursorEscapesToNowWithAFullResync() = runBlocking {
        val d = db("r5.db"); val c = ChatCache(d, "o"); c.saveCursor("s1:100")
        val seen = ArrayList<String?>(); val sink = Sink()
        val resets = Array(LiveV2Runner.STUCK_AFTER) { { throw IOException("ECONNRESET") } as () -> LiveOpen }
        LiveV2Runner(script(*resets, { stream(ready("s1:7000") + ev(7001)) }, seen = seen), RoomCursors(c), sink, sleep = {}).run()
        assertEquals(List(LiveV2Runner.STUCK_AFTER) { "s1:100" } + listOf(null), seen.take(LiveV2Runner.STUCK_AFTER + 1))
        assertTrue(sink.log.toString(), sink.log.indexOf("resync:stuck") in 0 until sink.log.indexOf("link:Live"))
        assertEquals("s1:7001", c.sync()!!.cursor); assertNull(c.sync()!!.owedResync)
        d.close()
    }

    @Test fun replayCutBeforeReadyCountsTowardTheEscapeButNoNetworkDoesNot() = runBlocking {
        val d = db("r6.db"); val c = ChatCache(d, "o"); c.saveCursor("s1:100")
        val seen = ArrayList<String?>()
        val offline = Array(8) { { throw java.net.UnknownHostException("no network") } as () -> LiveOpen }
        LiveV2Runner(script(*offline, seen = seen), RoomCursors(c), Sink(), sleep = {}).run()
        assertTrue("offline is not a stuck replay", seen.all { it == "s1:100" }); assertNull(c.sync()!!.owedResync)
        val seen2 = ArrayList<String?>()
        val cut = Array(LiveV2Runner.STUCK_AFTER) { { stream(ev(101)) } as () -> LiveOpen } // same cursor? no: 101 is applied, so it moves
        LiveV2Runner(script(*cut, seen = seen2), RoomCursors(c), Sink(), sleep = {}).run()
        assertEquals("progress resets the count", "s1:101", c.sync()!!.cursor); assertNull(c.sync()!!.owedResync)
        val seen3 = ArrayList<String?>()
        val empty = Array(LiveV2Runner.STUCK_AFTER) { { stream("") } as () -> LiveOpen } // 200, then closed before ready
        LiveV2Runner(script(*empty, { stream(ready("s1:500")) }, seen = seen3), RoomCursors(c), Sink(), sleep = {}).run()
        assertNull(seen3[LiveV2Runner.STUCK_AFTER]); assertEquals("s1:500", c.sync()!!.cursor)
        d.close()
    }
}
