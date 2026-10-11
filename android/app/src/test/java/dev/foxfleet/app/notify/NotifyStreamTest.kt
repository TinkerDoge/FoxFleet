package dev.foxfleet.app.notify

import dev.foxfleet.app.data.SseParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.Reader
import java.io.StringReader

private fun ev(id: Long, type: String = "reply_finished", agent: String = "nova", chat: String = "h_1", extra: String = "") =
    """{"id":$id,"v":1,"type":"$type","agent":"$agent","chat":"$chat","priority":"normal","at":1791400000000,"muted":false$extra}"""

private fun frame(id: Long, json: String) = "id: $id\nevent: notify\ndata: $json\n\n"

class NotifySseFramesTest {
    private fun parse(vararg chunks: String): List<NotifyFrame> {
        val out = ArrayList<NotifyFrame>()
        val p = SseParser({ e -> NotifyFrames.decode(e.event, e.data, e.id)?.let(out::add); true })
        chunks.forEach { p.feed(it) }; p.end(); return out
    }

    @Test fun decodesTheDocumentedFrames() {
        val f = parse("retry: 3000\n\nevent: foxfleet.gap\ndata: {\"first\":4,\"cursor\":503}\n\n" + frame(7, ev(7)) + "event: foxfleet.ready\ndata: {\"contract\":\"foxfleet.notify/1\",\"cursor\":7}\n\n: keep-alive\n\n")
        assertEquals(NotifyFrame.Gap(4, 503), f[0])
        val e = f[1] as NotifyFrame.Event
        assertEquals(7L, e.sseId); assertEquals(NotifyType.ReplyFinished, e.event.type); assertEquals("nova", e.event.agent); assertEquals("h_1", e.event.chat)
        assertEquals(NotifyFrame.Ready(7), f[2]); assertEquals(3, f.size) // retry: and the keep-alive comment are not frames
    }

    @Test fun authFrameCarriesItsReason() = assertEquals(NotifyFrame.Auth("signed_out"), parse("event: foxfleet.auth\ndata: {\"reason\":\"signed_out\"}\n\n").single())

    @Test fun multiLineDataIsJoinedWithNewlines() {
        val f = parse("id: 9\nevent: notify\ndata: {\"id\":9,\"v\":1,\n data: \"type\":\"error\",\"agent\":\"a\",\"chat\":\"c\",\"priority\":\"high\",\"at\":1,\"muted\":false,\"message\":\"The agent turn failed\"}\n\n")
        // the second "data:" has a leading space before the field name, so it is not a data line: the JSON is cut and ignored (never crashes)
        assertTrue(f.isEmpty() || f.single() is NotifyFrame.Event)
        val g = parse("id: 9\nevent: notify\ndata: {\"id\":9,\"v\":1,\"type\":\"error\",\ndata: \"agent\":\"a\",\"chat\":\"c\",\"priority\":\"high\",\"at\":1,\"muted\":false,\"message\":\"The agent turn failed\"}\n\n")
        val e = (g.single() as NotifyFrame.Event).event
        assertEquals(NotifyType.Error, e.type); assertTrue(e.high); assertEquals("The agent turn failed", e.message)
    }

    @Test fun chunkAndCrlfSplitsDoNotMatter() {
        val whole = frame(5, ev(5)) + frame(6, ev(6))
        val text = whole.replace("\n", "\r\n")
        for (cut in 1 until text.length step 7) {
            val f = parse(text.substring(0, cut), text.substring(cut))
            assertEquals("cut $cut", listOf(5L, 6L), f.map { (it as NotifyFrame.Event).event.id })
        }
    }

    @Test fun resumeIdComesFromTheIdFieldElseFromTheEvent() {
        val f = parse("id: 12\nevent: notify\ndata: " + ev(12) + "\n\nevent: notify\ndata: " + ev(13) + "\n\n")
        assertEquals(12L, (f[0] as NotifyFrame.Event).sseId); assertEquals(13L, (f[1] as NotifyFrame.Event).sseId)
    }

    @Test fun unknownEventsAndTypesAreIgnoredButKeepTheirId() {
        val f = parse("event: foxfleet.future\ndata: {}\n\n" + frame(20, ev(20, type = "cron_failed")) + "event: notify\ndata: not json\n\n")
        val e = (f.single() as NotifyFrame.Event).event
        assertEquals(NotifyType.Other, e.type); assertEquals(20L, e.id)
    }

    @Test fun cursorMustBePlainDigits() {
        assertEquals(10L, NotifyFrames.parseId("10"))
        listOf("abc", "-5", "1e3", "0x10", "", null, "12345678901234567890").forEach { assertNull(it, NotifyFrames.parseId(it)) }
    }

    @Test fun eventExtraFields() {
        val e = NotifyFrames.parseEvent(kotlinx.serialization.json.Json.parseToJsonElement(ev(3, "approval", extra = ",\"request_id\":\"srq-1\",\"kind\":\"clarify\"").replace("\"priority\":\"normal\"", "\"priority\":\"high\"")) as kotlinx.serialization.json.JsonObject)!!
        assertEquals("srq-1", e.requestId); assertEquals("clarify", e.kind); assertTrue(e.high)
    }
}

class NotifyBackoffTest {
    @Test fun growsFromOneSecondToAMinuteWithJitter() {
        val full = (0..9).map { NotifyBackoff.delayMs(it, 1.0) }
        assertEquals(listOf(1000L, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000), full)
        val low = (0..9).map { NotifyBackoff.delayMs(it, 0.0) }
        assertEquals(500L, low[0]); assertEquals(30000L, low[9])
        for (a in 0..20) { val d = NotifyBackoff.delayMs(a); assertTrue(d in 500..60000) }
    }
    @Test fun hugeAttemptsNeverOverflow() { assertEquals(60000L, NotifyBackoff.delayMs(10_000, 1.0)); assertEquals(1000L, NotifyBackoff.delayMs(-3, 1.0)) }
}

private class FakeStore(override var lastId: Long? = null) : NotifyCursorStore {
    val tokens = ArrayList<String>(); val order = ArrayList<String>()
    override fun saveToken(token: String) { tokens.add(token); order.add("token") }
}
private class RecSink(val order: ArrayList<String>? = null) : NotifySink {
    val live = ArrayList<NotifyEvent>(); val replayed = ArrayList<NotifyEvent>(); val gaps = ArrayList<NotifyFrame.Gap>()
    override suspend fun onEvents(events: List<NotifyEvent>, replay: Boolean) { order?.add("events"); (if (replay) replayed else live).addAll(events) }
    override suspend fun onGap(gap: NotifyFrame.Gap) { gaps.add(gap) }
}
private fun open(body: String, status: Int = 200, token: String? = null, ct: String? = "text/event-stream", retryAfter: Int? = null) = NotifyOpen(status, ct, token, retryAfter, StringReader(body))
private fun readyFrame(c: Long) = "event: foxfleet.ready\ndata: {\"contract\":\"foxfleet.notify/1\",\"cursor\":$c}\n\n"
/** A reader that delivers [text], then fails like OkHttp's read timeout after 45 s of silence. */
private fun silentAfter(text: String): Reader = object : Reader() {
    private val r = StringReader(text); private var done = false
    override fun read(cbuf: CharArray, off: Int, len: Int): Int { val n = r.read(cbuf, off, len); if (n >= 0) return n; throw java.net.SocketTimeoutException("timeout") }
    override fun close() {}
}

@OptIn(ExperimentalCoroutinesApi::class)
class NotifyStreamRunnerTest {
    private class Script(val steps: MutableList<(Long?) -> NotifyOpen>) : NotifyTransport {
        val asked = ArrayList<Long?>()
        override fun open(lastId: Long?): NotifyOpen { asked.add(lastId); if (steps.isEmpty()) throw CancellationException("script over"); return steps.removeAt(0)(lastId) }
    }
    private fun runner(t: NotifyTransport, store: FakeStore, sink: RecSink, sleeps: MutableList<Long> = ArrayList(), links: MutableList<NotifyLink> = ArrayList(), clock: () -> Long = { 0L }) =
        NotifyStreamRunner(t, store, sink, { links.add(it) }, { sleeps.add(it) }, { 1.0 }, clock = clock)

    @Test fun firstRunIsABaselineNothingOldIsNotified() = runTest {
        val store = FakeStore(); val sink = RecSink()
        val t = Script(mutableListOf({ _ -> open(frame(1, ev(1)) + frame(2, ev(2)) + readyFrame(2) + frame(3, ev(3))) }))
        try { runner(t, store, sink).run() } catch (_: CancellationException) {}
        assertEquals(listOf(null), t.asked.take(1))
        assertTrue(sink.replayed.isEmpty()); assertEquals(listOf(3L), sink.live.map { it.id }); assertEquals(3L, store.lastId)
    }

    @Test fun resumeSendsLastIdAndReplayIsDeliveredOnceInOrder() = runTest {
        val store = FakeStore(5); val sink = RecSink()
        val t = Script(mutableListOf({ _ -> open(frame(6, ev(6)) + frame(7, ev(7, chat = "h_2")) + readyFrame(9) + frame(10, ev(10)) + frame(10, ev(10))) }))
        try { runner(t, store, sink).run() } catch (_: CancellationException) {}
        assertEquals(5L, t.asked[0])
        assertEquals(listOf(6L, 7L), sink.replayed.map { it.id }); assertEquals(listOf(10L), sink.live.map { it.id }) // the duplicate 10 is dropped
        assertEquals(10L, store.lastId)
    }

    @Test fun rotatedTokenIsStoredBeforeAnyFrameIsHandled() = runTest {
        val store = FakeStore(1); val order = store.order; val sink = RecSink(order)
        val t = Script(mutableListOf({ _ -> open(readyFrame(1) + frame(2, ev(2)), token = "tok-new") }))
        try { runner(t, store, sink).run() } catch (_: CancellationException) {}
        assertEquals(listOf("tok-new"), store.tokens); assertEquals("token", order.first()); assertEquals("events", order[1])
    }

    @Test fun tokenOnAFailedAnswerIsStoredToo() = runTest {
        val store = FakeStore(1); val sink = RecSink()
        val t = Script(mutableListOf({ _ -> open("", status = 503, token = "tok-2") }, { _ -> open("", status = 401) }))
        assertEquals(RunEnd.SignedOut, runner(t, store, sink).run()); assertEquals(listOf("tok-2"), store.tokens)
    }

    @Test fun authFrameEndsTheLoopWithoutReconnecting() = runTest {
        val store = FakeStore(1); val sink = RecSink(); val sleeps = ArrayList<Long>()
        val t = Script(mutableListOf({ _ -> open(readyFrame(1) + "event: foxfleet.auth\ndata: {\"reason\":\"signed_out\"}\n\n" + frame(2, ev(2))) }))
        assertEquals(RunEnd.SignedOut, runner(t, store, sink, sleeps).run())
        assertEquals(1, t.asked.size); assertTrue(sleeps.isEmpty()); assertTrue(sink.live.isEmpty()) // the event after the auth frame is never handled
    }

    @Test fun http401And404EndTheLoop() = runTest {
        assertEquals(RunEnd.SignedOut, runner(Script(mutableListOf({ _ -> open("", 401) })), FakeStore(), RecSink()).run())
        assertEquals(RunEnd.Unsupported, runner(Script(mutableListOf({ _ -> open("", 404) })), FakeStore(), RecSink()).run())
    }

    @Test fun gapIsReportedAndAHubResetRestartsFromItsCursor() = runTest {
        val store = FakeStore(900); val sink = RecSink()
        val t = Script(mutableListOf({ _ -> open("event: foxfleet.gap\ndata: {\"first\":1,\"cursor\":40}\n\n" + readyFrame(40) + frame(41, ev(41))) }))
        try { runner(t, store, sink).run() } catch (_: CancellationException) {}
        assertEquals(listOf(NotifyFrame.Gap(1, 40)), sink.gaps); assertEquals(listOf(41L), sink.live.map { it.id }); assertEquals(41L, store.lastId)
    }

    @Test fun gapForAnOldCursorKeepsTheReplayThatFollows() = runTest {
        val store = FakeStore(2); val sink = RecSink()
        val t = Script(mutableListOf({ _ -> open("event: foxfleet.gap\ndata: {\"first\":400,\"cursor\":503}\n\n" + frame(400, ev(400)) + frame(503, ev(503)) + readyFrame(503)) }))
        try { runner(t, store, sink).run() } catch (_: CancellationException) {}
        assertEquals(1, sink.gaps.size); assertEquals(listOf(400L, 503L), sink.replayed.map { it.id }); assertEquals(503L, store.lastId)
    }

    @Test fun silentLinkAndClosedStreamReconnectWithBackoffAndTheLastId() = runTest {
        val store = FakeStore(); val sink = RecSink(); val sleeps = ArrayList<Long>(); val links = ArrayList<NotifyLink>()
        val t = Script(mutableListOf(
            { _ -> NotifyOpen(200, "text/event-stream", null, null, silentAfter(readyFrame(4) + frame(5, ev(5)))) }, // 45 s of nothing
            { _ -> throw IOException("connection reset") },
            { _ -> open("", 502) },
            { _ -> open(readyFrame(5) + frame(6, ev(6))) }, // ends: reconnect again
        ))
        var tick = 0L
        try { runner(t, store, sink, sleeps, links, clock = { tick += 60_000; tick }).run() } catch (_: CancellationException) {} // each connection counts as stable (>= 45 s up)
        assertEquals(listOf(null, 5L, 5L, 5L, 6L), t.asked)
        assertEquals(listOf(1000L, 2000L, 4000L, 1000L), sleeps) // connected resets the ladder, a failure climbs it
        assertTrue(links.contains(NotifyLink.Connected)); assertTrue(links.any { it is NotifyLink.Reconnecting }); assertTrue(links.contains(NotifyLink.Offline))
    }

    @Test fun rateLimitHonoursRetryAfter() = runTest {
        val sleeps = ArrayList<Long>()
        val t = Script(mutableListOf({ _ -> open("", 429, retryAfter = 60) }))
        try { runner(t, FakeStore(1), RecSink(), sleeps).run() } catch (_: CancellationException) {}
        assertEquals(60_000L, sleeps.single())
    }

    @Test fun aProxyPageIsNotAStream() = runTest {
        val sleeps = ArrayList<Long>(); val sink = RecSink()
        val t = Script(mutableListOf({ _ -> open("<html>captive portal</html>", ct = "text/html") }))
        try { runner(t, FakeStore(1), sink, sleeps).run() } catch (_: CancellationException) {}
        assertEquals(1, sleeps.size); assertTrue(sink.live.isEmpty())
    }

    @Test fun aHubThatAcceptsThenDropsKeepsGrowingTheBackoff() = runTest {
        val sleeps = ArrayList<Long>()
        val t = Script(MutableList(5) { { _: Long? -> open(readyFrame(1)) } }) // ready, then closed at once, five times; the clock never moves
        try { runner(t, FakeStore(1), RecSink(), sleeps).run() } catch (_: CancellationException) {}
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L), sleeps)
    }

    @Test fun aStableConnectionResetsTheBackoff() = runTest {
        val sleeps = ArrayList<Long>(); var now = 0L
        val t = Script(mutableListOf({ _ -> open("", 502) }, { _ -> open("", 502) }, { _ -> NotifyOpen(200, "text/event-stream", null, null, object : Reader() {
            private val r = StringReader(readyFrame(1))
            override fun read(cbuf: CharArray, off: Int, len: Int): Int { val n = r.read(cbuf, off, len); if (n < 0) now += 50_000; return n } // up for 50 s, then the hub closes
            override fun close() {}
        }) }, { _ -> open("", 502) }))
        try { runner(t, FakeStore(1), RecSink(), sleeps, clock = { now }).run() } catch (_: CancellationException) {}
        assertEquals(listOf(1000L, 2000L, 1000L, 2000L), sleeps) // 50 s up (>= 45 s): back to the first step
    }

    @Test fun networkNudgeWakesASleepingRetryAndResetsTheLadder() = runTest {
        val links = ArrayList<NotifyLink>()
        val t = Script(mutableListOf({ _ -> throw IOException("down") }, { _ -> throw IOException("down") }, { _ -> throw IOException("down") }))
        val r = NotifyStreamRunner(t, FakeStore(1), RecSink(), { links.add(it) }, null, { 1.0 })
        val job = launch { try { r.run() } catch (_: CancellationException) {} }
        runCurrent(); assertEquals(1, t.asked.size) // asleep in the backoff (virtual time has not moved)
        r.nudge(); runCurrent()
        assertEquals(2, t.asked.size); assertEquals(0L, testScheduler.currentTime) // retried now, no waiting
        assertEquals(NotifyLink.Reconnecting(1), links.last()) // the ladder restarted: attempt 1, not 2
        job.cancel()
    }

    @Test fun closeCancelsTheBlockedReadSoAStoppedServiceLeavesNoStream() {
        val released = java.util.concurrent.CountDownLatch(1); val opened = java.util.concurrent.CountDownLatch(1); val closed = java.util.concurrent.atomic.AtomicInteger()
        val blocked = object : Reader() {
            override fun read(cbuf: CharArray, off: Int, len: Int): Int { opened.countDown(); released.await(); throw IOException("socket closed") }
            override fun close() {}
        }
        val t = NotifyTransport { NotifyOpen(200, "text/event-stream", null, null, blocked, onClose = { closed.incrementAndGet(); released.countDown() }) }
        val r = NotifyStreamRunner(t, FakeStore(1), RecSink())
        kotlinx.coroutines.runBlocking {
            val job = launch(kotlinx.coroutines.Dispatchers.IO) { r.run() }
            assertTrue(opened.await(5, java.util.concurrent.TimeUnit.SECONDS))
            job.cancel(); r.close() // what NotifyService.onDestroy does
            kotlinx.coroutines.withTimeout(5_000) { job.join() }
            assertTrue(job.isCancelled); assertTrue(closed.get() >= 1)
        }
    }
}

class NotifyRetryAfterTest {
    @Test fun secondsAndHttpDatesAreBothUnderstood() {
        assertEquals(30, NotifyRetryAfter.parse("30")); assertEquals(0, NotifyRetryAfter.parse("-5"))
        val now = java.time.ZonedDateTime.parse("Mon, 12 Oct 2026 10:00:00 GMT", java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
        assertEquals(90, NotifyRetryAfter.parse("Mon, 12 Oct 2026 10:01:30 GMT", now)); assertEquals(0, NotifyRetryAfter.parse("Mon, 12 Oct 2026 09:00:00 GMT", now))
        assertNull(NotifyRetryAfter.parse("soon")); assertNull(NotifyRetryAfter.parse(null)); assertNull(NotifyRetryAfter.parse(" "))
    }
}
