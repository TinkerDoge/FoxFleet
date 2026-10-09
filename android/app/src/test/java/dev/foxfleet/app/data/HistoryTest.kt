package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** History from the hub (normalised Hermes rows) maps into the same UiMessage the live pipeline renders. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HistoryTest {
    /** Raw one-shot-per-connection JSON server that records request lines. */
    class Json(val body: (String) -> String, val seen: MutableList<String> = mutableListOf()) : AutoCloseable {
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        val port get() = sock.localPort
        init {
            Thread {
                while (!sock.isClosed) {
                    val c = try { sock.accept() } catch (_: Exception) { break }
                    val r = c.getInputStream().bufferedReader(); val line = r.readLine(); while (r.readLine().orEmpty().isNotEmpty()) { }
                    seen += line; val b = body(line)
                    c.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${b.toByteArray().size}\r\nConnection: close\r\n\r\n$b".toByteArray()); flush() }; c.close()
                }
            }.also { it.isDaemon = true }.start()
        }
        override fun close() { sock.close() }
    }

    private fun api(port: Int): HubApi {
        val store = SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()); store.allowHttp = true; store.baseUrl = "http://127.0.0.1:$port"
        return HubApi(store)
    }

    private val transcript = """{"messages":[
      {"role":"user","content":"What is in this picture?\n\n📎 /tmp/report.pdf","images":["data:image/png;base64,AAAA"],"ts":1790000001500},
      {"role":"assistant","content":"It shows **a red fox**:\n\n| trait | value |\n|---|---|\n| color | red |","reasoning":"Fox. Answer briefly.",
       "tools":[{"name":"vision_analyze","args":"image: /tmp/x.png","result":"ok","ok":true},{"name":"terminal","ok":false}],"ts":1790000004000},
      {"role":"tool","content":"{\"raw\":\"json\"}"},{"role":"system","content":"x"},{"role":"assistant","content":""},5],"has_more":true}"""

    @Test fun messagesKeepToolsReasoningImagesAndTime_andDropRawRows() = runBlocking {
        Json({ transcript }).use { s ->
            val page = api(s.port).messages("atlas", "s1", offset = 80, limit = 40)
            assertTrue(page.hasMore); assertEquals(2, page.messages.size)
            val (u, a) = page.messages
            assertEquals("user", u.role); assertEquals(1790000001500L, u.ts); assertTrue(u.imageUrls.single().startsWith("data:image/png"))
            assertEquals("Fox. Answer briefly.", a.reasoning); assertEquals(2, a.steps.size); assertFalse(a.steps[1].ok); assertEquals("vision_analyze", a.steps[0].name)
            assertTrue(a.content.contains("| trait | value |")); assertFalse(page.messages.any { it.content.contains("\"raw\"") })
            assertTrue("query goes in the query string", s.seen.single().contains("/sessions/s1/messages?limit=40&offset=80") || s.seen.single().contains("offset=80"))
        }
    }

    @Test fun sessionListHasTitleTimePreviewAndTotal() = runBlocking {
        Json({ """{"sessions":[{"id":"a","title":"Plan","updated":1790000000000,"preview":"hello there","messages":4},{"nope":1},{"id":"b","title":null}],"total":31}""" }).use { s ->
            val p = api(s.port).sessions("atlas", offset = 30)
            assertEquals(31, p.total); assertEquals(listOf("a", "b"), p.sessions.map { it.id })
            assertEquals("hello there", p.sessions[0].preview); assertEquals(1790000000000L, p.sessions[0].updated); assertNull(p.sessions[1].title)
            assertTrue(s.seen.single().contains("offset=30"))
        }
    }

    @Test fun agoLabels() {
        val now = 1_800_000_000_000L
        assertEquals("just now", dev.foxfleet.app.ui.screens.agoLabel(now - 5_000, now)); assertEquals("5 min ago", dev.foxfleet.app.ui.screens.agoLabel(now - 300_000, now))
        assertEquals("yesterday", dev.foxfleet.app.ui.screens.agoLabel(now - 26 * 3600_000L, now)); assertEquals("", dev.foxfleet.app.ui.screens.agoLabel(0, now))
    }

    @Test fun olderPagesPrependWithStableKeys() {
        val st = dev.foxfleet.app.ui.chat.ChatState()
        st.load(listOf(UiMessage("user", "c"), UiMessage("assistant", "d")), "s1", hasMore = true)
        assertTrue(st.hasOlder); assertEquals(0, st.keyBase)
        st.prepend(listOf(UiMessage("user", "a"), UiMessage("assistant", "b")), hasMore = false)
        assertEquals(listOf("a", "b", "c", "d"), st.messages.map { it.content }); assertEquals(-2, st.keyBase); assertFalse(st.hasOlder)
        // keyBase + index is the same number for the same message before and after: c was index 0 (key 0), now index 2 (key -2+2)
    }
}
