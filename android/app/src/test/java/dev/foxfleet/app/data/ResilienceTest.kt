package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** "Cloudflare blips": a scripted server that returns 502s, resets connections and cuts event streams. Nothing here may sign the user out. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResilienceTest {
    sealed class R { object Reset : R(); class Http(val status: String, val type: String, val body: String, val extra: String = "") : R() }
    private fun bad() = R.Http("502 Bad Gateway", "application/json", """{"error":"Bad gateway"}""")
    private fun json(b: String) = R.Http("200 OK", "application/json", b)
    private fun ev(id: Int, text: String) = "id: $id\ndata: {\"choices\":[{\"delta\":{\"content\":\"$text\"}}]}\n\n"
    private fun sse(body: String, extra: String = "") = R.Http("200 OK", "text/event-stream", body, extra)

    /** Replies come from [script] per request, keyed by a path fragment; each key has its own queue (the last entry repeats). */
    private class Hub(val script: Map<String, MutableList<out R>>, val seen: MutableList<String>) : AutoCloseable {
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1")); val port get() = sock.localPort
        init {
            Thread {
                while (!sock.isClosed) {
                    val c = try { sock.accept() } catch (_: Exception) { break }
                    try {
                        val r = c.getInputStream().bufferedReader(); val line = r.readLine().orEmpty(); while (r.readLine().orEmpty().isNotEmpty()) { }
                        val path = line.split(" ").getOrElse(1) { "" }; seen += path
                        val q = script.entries.firstOrNull { path.contains(it.key) }?.value as MutableList<R>?
                        val reply = q?.let { if (it.size > 1) it.removeAt(0) else it[0] } ?: R.Http("404 Not Found", "application/json", "{}")
                        when (reply) {
                            is R.Reset -> c.close()
                            is R.Http -> { c.getOutputStream().apply { write("HTTP/1.1 ${reply.status}\r\nContent-Type: ${reply.type}\r\n${reply.extra}Connection: close\r\n\r\n${reply.body}".toByteArray()); flush() }; c.close() }
                        }
                    } catch (_: Exception) { runCatching { c.close() } }
                }
            }.also { it.isDaemon = true }.start()
        }
        override fun close() { sock.close() }
    }

    private fun api(port: Int) = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:$port" }).also { it.retryBaseMs = 1 }
    private val authOk = """{"required":true,"authenticated":true}"""

    @Test fun anIdempotentReadRidesOutTwoBadGatewaysAndAReset() = runBlocking {
        val seen = mutableListOf<String>()
        Hub(mapOf("/api/auth" to mutableListOf(bad(), R.Reset, bad(), json(authOk))), seen).use { h -> assertTrue(api(h.port).authInfo().authenticated); assertEquals(4, seen.size) }
    }

    @Test fun aLongOutageEndsAsATransientErrorNeverASignOut() = runBlocking {
        Hub(mapOf("/api/agents" to mutableListOf(R.Http("503 Service Unavailable", "application/json", "{}"))), mutableListOf()).use { h ->
            try { api(h.port).agents(); fail("expected an error") } catch (e: AuthRequiredException) { fail("signed out by an outage") } catch (e: HubApiException) { assertTrue(e.transient); assertEquals(503, e.status) }
        }
    }

    @Test fun aWriteIsNeverReplayedByTheTransport() = runBlocking {
        val seen = mutableListOf<String>()
        Hub(mapOf("/stop" to mutableListOf(bad())), seen).use { h -> try { api(h.port).stopRun("a", "r"); fail() } catch (e: HubApiException) { }; assertEquals(1, seen.count { it.contains("/stop") }) }
    }

    @Test fun a401WhileTheHubCannotBeReachedIsNotASignOut() = runBlocking {
        for (authReply in listOf(bad(), R.Reset)) Hub(mapOf("/api/agents" to mutableListOf(R.Http("401 Unauthorized", "application/json", """{"error":"x"}""")), "/api/auth" to mutableListOf(authReply)), mutableListOf()).use { h ->
            try { api(h.port).agents(); fail("expected an error") } catch (e: AuthRequiredException) { fail("signed out while the hub was unreachable") } catch (e: HubApiException) { assertTrue(e.network) }
        }
    }

    @Test fun onlyTheHubSayingNotAuthenticatedSignsOut() = runBlocking {
        Hub(mapOf("/api/agents" to mutableListOf(R.Http("401 Unauthorized", "application/json", """{"error":"Login required"}""")), "/api/auth" to mutableListOf(json("""{"required":true,"authenticated":false}"""))), mutableListOf()).use { h ->
            try { api(h.port).agents(); fail() } catch (e: AuthRequiredException) { assertTrue(true) }
        }
    }

    @Test fun theStreamDropsAndTheResumeSurvives502sAndAReset() = runBlocking {
        val seen = mutableListOf<String>()
        val script = mapOf(
            "/chat" to mutableListOf<R>(sse(ev(1, "Hel") + ev(2, "lo "), "X-Foxfleet-Run: run1\r\nX-Hermes-Session-Id: sess-1\r\n")),
            "/runs/run1/events" to mutableListOf(bad(), bad(), R.Reset, R.Http("524 Timeout", "text/html", "<html>timeout</html>"), sse(ev(3, "wor") + ev(4, "ld") + "data: [DONE]\n\n")),
        )
        Hub(script, seen).use { h ->
            var text = ""; var reconnecting = 0; var run = ""
            val full = api(h.port).chat("atlas", listOf(UiMessage(role = "user", content = "hi")), null, { text += it }, {}, {}, {}, { run = it }, {}, {}, { _, _ -> }, { _, _ -> }, { reconnecting++ })
            assertEquals("Hello world", text); assertEquals("Hello world", full); assertEquals("run1", run); assertTrue(reconnecting >= 5)
            assertEquals(1, seen.count { it.endsWith("/chat") }); assertEquals(5, seen.count { it.contains("/events?after=2") })
        }
    }

    @Test fun followRidesOutABadGatewayOnTheFirstAttempt() = runBlocking {
        val script = mapOf("/runs/r/events" to mutableListOf<R>(bad(), sse(ev(1, "a") + ev(2, "b") + "data: [DONE]\n\n")))
        Hub(script, mutableListOf()).use { h -> var text = ""; api(h.port).follow("x", "r", 0, HubApi.StreamCallbacks({ text += it }, {}, {}, {})); assertEquals("ab", text) }
    }

    @Test fun mediaLinkIsAbsoluteAndOnlyHubMediaPathsAreAccepted() = runBlocking {
        Hub(mapOf("/agents/a/media" to mutableListOf(json("""{"url":"/api/media/abc.def","kind":"video","name":"v.mp4"}"""))), mutableListOf()).use { h ->
            val l = api(h.port).media("a", "/tmp/v.mp4"); assertEquals("http://127.0.0.1:${h.port}/api/media/abc.def", l.url); assertEquals("video", l.kind); assertEquals("v.mp4", l.name)
        }
        Hub(mapOf("/agents/a/media" to mutableListOf(json("""{"url":"https://evil.example/x","kind":"image","name":"x"}"""))), mutableListOf()).use { h ->
            try { api(h.port).media("a", "/tmp/x.png"); fail("accepted a foreign url") } catch (e: HubApiException) { assertEquals(502, e.status) }
        }
    }
}
