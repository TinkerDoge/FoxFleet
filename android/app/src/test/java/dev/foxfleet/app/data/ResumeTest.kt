package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The app keeps its reply when the connection drops: it reconnects to the hub's run from the last event id. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResumeTest {
    private fun ev(id: Int, text: String) = "id: $id\ndata: {\"choices\":[{\"delta\":{\"content\":\"$text\"}}]}\n\n"

    /** A tiny raw HTTP server (the JDK's HttpServer is not on the Android test classpath). */
    class Fake(val first: String, val resumed: String, val seen: MutableList<String>) : AutoCloseable {
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        val port get() = sock.localPort
        private val t = Thread {
            while (!sock.isClosed) {
                val c = try { sock.accept() } catch (_: Exception) { break }
                val line = c.getInputStream().bufferedReader().let { r -> val l = r.readLine(); while (r.readLine().orEmpty().isNotEmpty()) { }; l }
                val path = line.split(" ")[1]
                val body = if (path.contains("/runs/")) { seen += path; resumed } else first
                val head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n" + (if (path.endsWith("/chat")) "X-Foxfleet-Run: run1\r\nX-Hermes-Session-Id: sess-1\r\n" else "") + "\r\n"
                c.getOutputStream().apply { write((head + body).toByteArray()); flush() }; c.close()
            }
        }.also { it.isDaemon = true; it.start() }
        override fun close() { sock.close() }
    }
    private fun server(first: String, resumed: String, seen: MutableList<String>) = Fake(first, resumed, seen)

    @Test fun resumesFromTheLastEventIdWithoutRepeatingText() = runBlocking {
        val seen = mutableListOf<String>()
        val s = server(ev(1, "Hel") + ev(2, "lo "), ev(3, "wor") + ev(4, "ld") + "data: [DONE]\n\n", seen)
        try {
            val store = SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()); store.allowHttp = true; store.baseUrl = "http://127.0.0.1:${s.port}"
            val got = StringBuilder(); var run: String? = null; var sess: String? = null
            val text = HubApi(store).chat("atlas", listOf(UiMessage("user", "hi")), null, { got.append(it) }, {}, {}, { sess = it }, { run = it })
            assertEquals("Hello world", text); assertEquals("Hello world", got.toString()); assertEquals("run1", run); assertEquals("sess-1", sess)
            assertTrue(seen.single().endsWith("/runs/run1/events?after=2"))
        } finally { s.close() }
    }

    @Test fun followReplaysFromTheStart() = runBlocking {
        val seen = mutableListOf<String>()
        val s = server("", ev(1, "All ") + ev(2, "done") + "data: [DONE]\n\n", seen)
        try {
            val store = SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()); store.allowHttp = true; store.baseUrl = "http://127.0.0.1:${s.port}"
            val text = HubApi(store).follow("atlas", "run1", 0, HubApi.StreamCallbacks({}, {}, {}, {}))
            assertEquals("All done", text); assertTrue(seen.single().endsWith("after=0"))
        } finally { s.close() }
    }

    @Test fun savedChatSurvivesANewSettingsStore() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val a = SettingsStore(ctx); a.baseUrl = "https://hub.example.com"; a.saveChat("atlas", SavedChat("s1", "r1", "hello"))
        val b = SettingsStore(ctx); assertEquals(SavedChat("s1", "r1", "hello"), b.savedChat("atlas"))
        b.clearSession(); assertEquals(SavedChat(), SettingsStore(ctx).savedChat("atlas"))
    }
}
