package dev.foxfleet.app.data.live

import dev.foxfleet.app.data.LiveCancel
import dev.foxfleet.app.data.LiveOpen
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.StringReader

/** v2 connection loop: resume, gap, repeats, typing, feature fallback, sign-out. Plain JVM, scripted streams. */
class LiveV2RunnerTest {
    private fun ev(seq: Long, type: String = "chat.removed", store: String = "s1", extra: String = "") =
        "id: $store:$seq\nevent: $type\ndata: {\"seq\":$seq,\"type\":\"$type\",\"at\":1,\"agent\":\"nova\"$extra}\n\n"
    private fun ready(cursor: String) = "event: foxfleet.ready\ndata: {\"contract\":\"foxfleet.live/2\",\"cursor\":\"$cursor\",\"heartbeat_ms\":15000}\n\n"
    private fun gap(reason: String, cursor: String) = "event: foxfleet.gap\ndata: {\"reason\":\"$reason\",\"cursor\":\"$cursor\"}\n\n"
    private fun stream(body: String) = LiveOpen(200, "text/event-stream", StringReader("retry: 2000\n\n$body"))

    private class Store(var c: String?) : CursorStore {
        val saved = ArrayList<String>()
        override suspend fun load() = c
        override suspend fun save(cursor: String) { c = cursor; saved += cursor }
    }
    private class Sink : V2Sink {
        val log = ArrayList<String>()
        override suspend fun onLink(state: LinkState) { if (log.lastOrNull() != "link:$state") log += "link:$state" }
        override suspend fun onEvent(e: V2Event) { log += "event:${e.seq}" }
        override fun onTyping(t: Typing) { log += "typing:${t.state}" }
        override suspend fun onResync(reason: String) { log += "resync:$reason" }
    }

    /** Opens the scripted responses in order; after them, 401 ends the run. */
    private fun transport(vararg answers: LiveOpen, seen: MutableList<String?> = ArrayList()): (String?, LiveCancel) -> LiveOpen {
        val it = answers.iterator()
        return { cursor, _ -> seen += cursor; if (it.hasNext()) it.next() else LiveOpen(401, null, null) }
    }

    @Test fun resumesFromTheStoredCursorAndSavesEachEvent() = runBlocking {
        val store = Store("s1:10"); val sink = Sink(); val seen = ArrayList<String?>()
        val r = LiveV2Runner(transport(stream(ev(11) + ev(12) + ready("s1:12")), seen = seen), store, sink, sleep = {})
        assertEquals(V2End.SignedOut, r.run())
        assertEquals("s1:10", seen[0])
        assertEquals(listOf("s1:11", "s1:12"), store.saved)
        assertTrue(sink.log.toString(), sink.log.containsAll(listOf("event:11", "event:12", "link:Live")))
        assertTrue("no resync on a clean resume", sink.log.none { it.startsWith("resync") })
    }

    @Test fun reconnectResumesFromTheLastAppliedEvent() = runBlocking {
        val store = Store("s1:1"); val seen = ArrayList<String?>()
        val r = LiveV2Runner(transport(stream(ready("s1:1") + ev(2) + ev(3)), stream(ready("s1:3")), seen = seen), store, Sink(), sleep = {})
        r.run()
        assertEquals(listOf("s1:1", "s1:3", "s1:3"), seen) // the stream closed after seq 3: the next connect asks from 3
    }

    @Test fun repeatsAtOrBelowTheCursorAreDropped() = runBlocking {
        val sink = Sink()
        LiveV2Runner(transport(stream(ev(5) + ev(6) + ev(5) + ev(7) + ready("s1:7"))), Store("s1:5"), sink, sleep = {}).run()
        assertEquals(listOf("event:6", "event:7"), sink.log.filter { it.startsWith("event") })
    }

    @Test fun gapStoresTheNewCursorAndResyncsBeforeLive() = runBlocking {
        val store = Store("s1:3"); val sink = Sink()
        LiveV2Runner(transport(stream(gap("expired", "s1:900") + ready("s1:900") + ev(901))), store, sink, sleep = {}).run()
        assertEquals("s1:901", store.c)
        assertEquals("s1:900", store.saved.first())
        val i = sink.log.indexOf("resync:expired"); val live = sink.log.indexOf("link:Live")
        assertTrue(sink.log.toString(), i in 0 until live)
        assertTrue(sink.log.indexOf("event:901") > live)
    }

    @Test fun storeResetGapAcceptsLowerSeqFromTheNewStore() = runBlocking {
        val store = Store("old:500"); val sink = Sink()
        LiveV2Runner(transport(stream(gap("reset", "new:2") + ready("new:2") + ev(3, store = "new"))), store, sink, sleep = {}).run()
        assertEquals("new:3", store.c); assertTrue(sink.log.contains("event:3")); assertTrue(sink.log.contains("resync:reset"))
    }

    @Test fun firstConnectWithoutCursorTakesReadyCursorAndResyncs() = runBlocking {
        val store = Store(null); val sink = Sink(); val seen = ArrayList<String?>()
        LiveV2Runner(transport(stream(ready("s1:40")), seen = seen), store, sink, sleep = {}).run()
        assertEquals(null, seen[0]); assertEquals("s1:40", store.c); assertTrue(sink.log.contains("resync:start"))
    }

    @Test fun typingIsEphemeralAndNeverMovesTheCursor() = runBlocking {
        val store = Store("s1:1"); val sink = Sink()
        val typing = "event: typing\ndata: {\"agent\":\"nova\",\"chat\":\"c\",\"state\":\"typing\",\"tool\":null,\"ttl_ms\":6000}\n\n"
        LiveV2Runner(transport(stream(ready("s1:1") + typing)), store, sink, sleep = {}).run()
        assertTrue(sink.log.contains("typing:typing")); assertTrue(store.saved.isEmpty())
    }

    @Test fun unknownTypesAreSkippedButAdvanceTheCursor() = runBlocking {
        val store = Store("s1:1"); val sink = Sink()
        LiveV2Runner(transport(stream(ready("s1:1") + ev(2, "reaction.added", extra = ",\"future\":true"))), store, sink, sleep = {}).run()
        assertEquals("s1:2", store.c)
    }

    @Test fun featureFallbackOn404And400() = runBlocking {
        assertEquals(V2End.Unsupported, LiveV2Runner(transport(LiveOpen(404, null, null)), Store(null), Sink(), sleep = {}).run())
        assertEquals(V2End.Unsupported, LiveV2Runner(transport(LiveOpen(400, "application/json", null)), Store(null), Sink(), sleep = {}).run())
    }

    @Test fun authFrameEndsWithoutReconnect() = runBlocking {
        var opens = 0
        val r = LiveV2Runner({ _, _ -> opens++; stream("event: foxfleet.auth\ndata: {\"reason\":\"signed_out\"}\n\n") }, Store(null), Sink(), sleep = {})
        assertEquals(V2End.SignedOut, r.run()); assertEquals(1, opens)
    }

    @Test fun failuresTurnConnectingIntoOfflineAnd429WaitsLonger() = runBlocking {
        val sink = Sink(); val waits = ArrayList<Long>()
        LiveV2Runner(transport(LiveOpen(503, null, null), LiveOpen(429, null, null), stream(ready("s1:1"))), Store("s1:1"), sink, sleep = { waits += it }, random = { 0.0 }).run()
        assertTrue(sink.log.toString(), sink.log.contains("link:Offline"))
        assertTrue(waits.toString(), waits[1] >= 10_000)
        assertEquals("link:Live", sink.log.last { it.startsWith("link") && it != "link:Connecting" && it != "link:Offline" })
    }

    @Test fun cursorParsing() {
        assertEquals(LiveCursor("a:b", 7), LiveCursor.parse("a:b:7"))
        assertEquals(null, LiveCursor.parse("7")); assertEquals(null, LiveCursor.parse("s:x")); assertEquals(null, LiveCursor.parse(null))
    }
}
