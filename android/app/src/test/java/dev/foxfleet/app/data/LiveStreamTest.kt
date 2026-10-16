package dev.foxfleet.app.data

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.StringReader

private fun live(id: String, type: String, agent: String = "atlas", chat: String = "s1", run: String = "r1") =
    "id: $id\nevent: live\ndata: {\"id\":${id.substringAfter(':')},\"type\":\"$type\",\"agent\":\"$agent\",\"chat\":\"$chat\",\"run_id\":\"$run\"}\n\n"
private fun ready(cursor: String) = "event: foxfleet.ready\ndata: {\"contract\":\"foxfleet.live/1\",\"cursor\":\"$cursor\"}\n\n"

class LiveFramesTest {
    @Test fun decodesEventsReadyGapAuth() {
        val e = LiveFrames.decode("live", """{"id":3,"type":"run_finished","agent":"atlas","chat":"s1","run_id":"r","state":"done"}""", "E:3") as LiveFrame.Event
        assertEquals(LiveEvent("E:3", "run_finished", "atlas", "s1", "r", "done"), e.event)
        assertEquals(LiveFrame.Ready("E:3"), LiveFrames.decode("foxfleet.ready", """{"cursor":"E:3"}""", null))
        assertEquals(LiveFrame.Gap, LiveFrames.decode("foxfleet.gap", "{}", null))
        assertEquals(LiveFrame.Auth, LiveFrames.decode("foxfleet.auth", """{"reason":"signed_out"}""", null))
        assertNull(LiveFrames.decode("live", """{"type":"run_started"}""", "E:1")) // no agent
        assertNull(LiveFrames.decode("live", "not json", "E:1"))
        assertNull(LiveFrames.decode("other", "{}", null))
    }
}

class LiveStreamRunnerTest {
    private class Sink : LiveSink {
        val events = mutableListOf<LiveEvent>(); val connects = mutableListOf<Boolean>()
        override suspend fun onEvent(e: LiveEvent) { events += e }
        override suspend fun onConnected(catchUp: Boolean) { connects += catchUp }
    }

    @Test fun firstConnectNoCatchUpThenReconnectResumesWithCursorAndCatchesUp() = runTest {
        val cursors = mutableListOf<String?>(); val sink = Sink(); val sleeps = mutableListOf<Long>()
        val bodies = ArrayDeque(listOf(
            "retry: 2000\n\n" + ready("E:0") + live("E:1", "run_started") + ": keep-alive\n\n",
            ready("E:2") + live("E:2", "run_finished"),
        ))
        val runner = LiveStreamRunner(LiveTransport { c, _ -> cursors += c; val b = bodies.removeFirstOrNull() ?: return@LiveTransport LiveOpen(401, null, null); LiveOpen(200, "text/event-stream", StringReader(b)) }, sink, sleep = { sleeps += it }, random = { 1.0 })
        assertEquals(LiveEnd.SignedOut, runner.run())
        assertEquals(listOf(null, "E:1"), cursors.take(2)) // resumes after the last event it saw
        assertEquals(listOf("run_started", "run_finished"), sink.events.map { it.type })
        assertEquals(listOf(false, true), sink.connects) // the reconnect asks for a catch-up
    }

    @Test fun gapAsksForCatchUpAndAdoptsHubCursor() = runTest {
        val sink = Sink(); var n = 0; val cursors = mutableListOf<String?>()
        val runner = LiveStreamRunner(LiveTransport { c, _ -> cursors += c; if (n++ == 0) LiveOpen(200, "text/event-stream", StringReader("event: foxfleet.gap\ndata: {}\n\n" + ready("NEW:5"))) else LiveOpen(401, null, null) }, sink, sleep = {}, random = { 0.0 })
        assertEquals(LiveEnd.SignedOut, runner.run())
        assertEquals(listOf(true), sink.connects)
        assertEquals("NEW:5", cursors[1])
    }

    @Test fun authFrameEndsSignedOutAnd404IsUnsupported() = runTest {
        val r1 = LiveStreamRunner(LiveTransport { _, _ -> LiveOpen(200, "text/event-stream", StringReader(ready("E:0") + "event: foxfleet.auth\ndata: {\"reason\":\"signed_out\"}\n\n")) }, Sink(), sleep = {})
        assertEquals(LiveEnd.SignedOut, r1.run())
        val r2 = LiveStreamRunner(LiveTransport { _, _ -> LiveOpen(404, "text/html", null) }, Sink(), sleep = {})
        assertEquals(LiveEnd.Unsupported, r2.run())
    }

    @Test fun failuresBackOffAndProxyPagesRetry() = runTest {
        val sleeps = mutableListOf<Long>(); var n = 0
        val runner = LiveStreamRunner(LiveTransport { _, _ ->
            when (n++) { 0 -> throw IOException("timeout"); 1 -> LiveOpen(502, "text/html", StringReader("<html>")); 2 -> throw HubApiException(0, "Set the server address first"); else -> LiveOpen(401, null, null) }
        }, Sink(), sleep = { sleeps += it }, random = { 1.0 })
        assertEquals(LiveEnd.SignedOut, runner.run())
        assertEquals(listOf(1000L, 2000L, 4000L), sleeps)
        assertEquals(30_000L, LiveStreamRunner.delayMs(20, 1.0)); assertEquals(500L, LiveStreamRunner.delayMs(0, 0.0))
    }

    @Test fun closeAbortsAConnectStillInProgress() {
        val entered = java.util.concurrent.CountDownLatch(1); val aborted = java.util.concurrent.CountDownLatch(1)
        lateinit var runner: LiveStreamRunner
        runner = LiveStreamRunner(LiveTransport { _, cancel ->
            val gate = java.util.concurrent.CountDownLatch(1)
            cancel.onCancel { aborted.countDown(); gate.countDown() }
            entered.countDown(); gate.await(5, java.util.concurrent.TimeUnit.SECONDS) // a blocking execute()
            throw IOException("Canceled")
        }, Sink(), sleep = { throw kotlinx.coroutines.CancellationException("stopped") })
        val t = Thread { runCatching { kotlinx.coroutines.runBlocking { runner.run() } } }; t.start()
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        runner.close()
        assertTrue("close() reached the in-flight call", aborted.await(1, java.util.concurrent.TimeUnit.SECONDS))
        t.join(5000); assertFalse(t.isAlive)
    }

    @Test fun cancelBeforeRegisterStillAborts() { val c = LiveCancel(); c.cancel(); var hit = false; c.onCancel { hit = true }; assertTrue(hit); assertTrue(c.cancelled) }

    @Test fun readTimeoutIsThreeHeartbeats() { assertEquals(45L, LiveStreamRunner.READ_TIMEOUT_SEC) }
}

class LiveCatchUpTest {
    private fun m(id: String?, role: String = "assistant", text: String = id ?: "live") = UiMessage(role, text, id)

    @Test fun appendsOnlyWhatIsNewAfterTheLastKnownId() {
        val have = listOf(m("1", "user"), m("2"))
        assertEquals(CatchUp.Append(listOf(m("3", "user"), m("4"))), LiveCatchUp.plan(have, listOf(m("1", "user"), m("2"), m("3", "user"), m("4"))))
        assertEquals(CatchUp.None, LiveCatchUp.plan(have, listOf(m("1", "user"), m("2"))))
        assertEquals(CatchUp.None, LiveCatchUp.plan(have, emptyList()))
    }
    @Test fun farBehindOrEmptyReplacesLiveTailReconciles() {
        assertEquals(CatchUp.Replace, LiveCatchUp.plan(listOf(m("1")), listOf(m("7"), m("8"))))
        assertEquals(CatchUp.Replace, LiveCatchUp.plan(emptyList(), listOf(m("1"))))
        assertEquals(CatchUp.Reconcile, LiveCatchUp.plan(listOf(m("1"), m(null)), listOf(m("1"), m("2"))))
    }
    @Test fun onlyTheOpenChatIsTouched() {
        val e = LiveEvent("E:1", "run_finished", "atlas", "s1", null, "done")
        assertTrue(LiveCatchUp.touchesChat(e, "atlas", "s1"))
        assertTrue(LiveCatchUp.touchesChat(e, "atlas", null)) // a new chat that has no id yet
        assertFalse(LiveCatchUp.touchesChat(e, "atlas", "s2"))
        assertFalse(LiveCatchUp.touchesChat(e, "nova", "s1"))
        assertFalse(LiveCatchUp.touchesChat(e, null, null))
        assertTrue(LiveCatchUp.touchesChat(e.copy(chat = null), "atlas", "s9"))
    }
}
