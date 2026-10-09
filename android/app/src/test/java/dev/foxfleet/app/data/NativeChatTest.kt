package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.HubApi.Companion.str
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ackLabel
import dev.foxfleet.app.ui.screens.approvalAnswer
import dev.foxfleet.app.ui.screens.clarifyAnswers
import dev.foxfleet.app.ui.screens.modeHelp
import dev.foxfleet.app.ui.screens.modeLabel
import dev.foxfleet.app.ui.screens.queueItemLabel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Native Hermes sessions on the phone: cards answered once by id, closed by the agent, back after a reconnect; Hermes's own acknowledgements; honest labels. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NativeChatTest {
    private val clarify = """{"request_id":"srq-000000000001","kind":"clarify","questions":[{"id":"q0","question":"Which environment?","choices":["staging","production"],"multi_select":false}]}"""
    private val approval = """{"request_id":"srq-000000000002","kind":"approval","command":"rm -rf build","description":"Delete the build folder"}"""
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    /** Tiny raw HTTP server: [routes] maps "METHOD path-prefix" to (status, content-type, body); it records every request line and body. */
    class Fake(val routes: Map<String, Triple<Int, String, String>>, val seen: MutableList<String>) : AutoCloseable {
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        val port get() = sock.localPort
        private val t = Thread {
            while (!sock.isClosed) {
                val c = try { sock.accept() } catch (_: Exception) { break }
                val r = c.getInputStream().bufferedReader(); val line = r.readLine(); var len = 0
                while (true) { val h = r.readLine().orEmpty(); if (h.isEmpty()) break; if (h.startsWith("Content-Length:", true)) len = h.substringAfter(":").trim().toInt() }
                val body = if (len > 0) CharArray(len).also { r.read(it) }.concatToString() else ""
                val (m, p) = line.split(" ").let { it[0] to it[1] }; seen += "$m $p $body"
                val hit = routes.entries.firstOrNull { e -> val (rm, rp) = e.key.split(" "); rm == m && p.substringBefore("?").endsWith(rp) } ?.value ?: Triple(404, "application/json", "{}")
                val head = "HTTP/1.1 ${hit.first} X\r\nContent-Type: ${hit.second}\r\nContent-Length: ${hit.third.toByteArray().size}\r\nConnection: close\r\n" + (if (p.endsWith("/chat")) "X-Foxfleet-Run: run1\r\nX-Hermes-Session-Id: sess-1\r\n" else "") + "\r\n"
                c.getOutputStream().apply { write((head + hit.third).toByteArray()); flush() }; c.close()
            }
        }.also { it.isDaemon = true; it.start() }
        override fun close() { sock.close() }
    }
    private fun api(f: Fake) = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:${f.port}" })
    private fun sse(vararg frames: String) = frames.joinToString("") + "data: [DONE]\n\n"
    private fun fr(event: String, data: String) = "event: $event\ndata: $data\n\n"

    @Test fun onlyClarifyAndApprovalBecomeCardsAndOthersAreDropped() {
        assertEquals("clarify", HubApi.parseRequest(obj(clarify))?.kind); assertEquals(listOf("staging", "production"), HubApi.parseRequest(obj(clarify))?.questions?.single()?.choices)
        assertEquals("rm -rf build", HubApi.parseRequest(obj(approval))?.command)
        assertNull(HubApi.parseRequest(obj("""{"request_id":"x1","kind":"sudo"}""")))
        assertNull(HubApi.parseRequest(obj("""{"request_id":"../etc","kind":"clarify"}""")))
    }

    @Test fun cardsComeFromTheStreamAreDedupedByIdAndClosedByTheAgent() = runBlocking {
        val seen = mutableListOf<String>()
        val body = sse(fr("foxfleet.request", clarify), fr("foxfleet.request", clarify), fr("foxfleet.request", approval), fr("foxfleet.ack", """{"message_id":"m1","ack":"steered"}"""),
            fr("foxfleet.request_closed", """{"request_id":"srq-000000000001","reason":"cancelled"}"""), """data: {"choices":[{"delta":{"content":"hi"}}]}""" + "\n\n")
        Fake(mapOf("POST /chat" to Triple(200, "text/event-stream", body)), seen).use { f ->
            val st = ChatState(); val seenCards = mutableListOf<List<String>>()
            // the stream ends with the turn, which clears the cards: look at them as they arrive
            val acc = mutableListOf<String>(); var requestsSeen = emptyList<String>()
            val text = api(f).chat("a", listOf(UiMessage("user", "x")), null, {}, {}, {}, {}, {}, {}, { r -> acc += r.id }, { id, _ -> acc += "closed:$id" }, { id, a -> acc += "ack:$id:$a" })
            assertEquals("hi", text)
            assertEquals(listOf("srq-000000000001", "srq-000000000001", "srq-000000000002", "ack:m1:steered", "closed:srq-000000000001"), acc)
            assertTrue(requestsSeen.isEmpty() && seenCards.isEmpty() && st.requests.isEmpty())
        }
    }

    @Test fun answeringSendsOneAnswerByIdAnd404JustRemovesTheCard() = runBlocking {
        val seen = mutableListOf<String>()
        Fake(mapOf("POST /requests/srq-000000000001" to Triple(200, "application/json", """{"ok":true}"""), "POST /requests/srq-000000000002" to Triple(404, "application/json", """{"error":"closed"}"""),
            "POST /requests/srq-000000000003" to Triple(500, "application/json", """{"error":{"message":"Hermes is down"}}"""), "GET /queue" to Triple(200, "application/json", """{"items":[],"halted":false,"active_run":null,"modes":[],"open_requests":[$clarify,$approval],"can_cancel":false}""")), seen).use { f ->
            val a = api(f); val st = ChatState(); st.adopt("sess-1"); st.syncQueue(a, "a")
            assertEquals(listOf("srq-000000000001", "srq-000000000002"), st.requests.map { it.id }); assertFalse(st.canCancel)
            assertNull(st.answerRequest(a, "a", "srq-000000000001", clarifyAnswers(HubApi.parseRequest(obj(clarify))!!, mapOf("q0" to listOf("production")), emptyMap())))
            assertTrue(seen.any { it.startsWith("POST ") && it.contains("/native/sessions/sess-1/requests/srq-000000000001") && it.contains("\"answers\":{\"q0\":\"production\"}") })
            assertEquals(listOf("srq-000000000002"), st.requests.map { it.id })
            assertNull(st.answerRequest(a, "a", "srq-000000000002", approvalAnswer(false))); assertTrue(st.requests.isEmpty())
            val err = st.answerRequest(a, "a", "srq-000000000003", approvalAnswer(true)); assertTrue(err!!.contains("Hermes is down"))
            // a second device attaching to the same session sees the same open cards
            val other = ChatState(); other.adopt("sess-1"); other.syncQueue(a, "a"); assertEquals(2, other.requests.size)
        }
    }

    @Test fun answersAreBuiltFromWhatWasPickedOrTyped() {
        val r = HubApi.parseRequest(obj(clarify))!!
        assertEquals("""{"answers":{"q0":"staging"}}""", clarifyAnswers(r, mapOf("q0" to listOf("staging")), emptyMap()).toString())
        assertEquals("typing overrides", """{"answers":{"q0":"canary"}}""", clarifyAnswers(r, mapOf("q0" to listOf("staging")), mapOf("q0" to " canary ")).toString())
        assertEquals("""{"choice":"once"}""", approvalAnswer(true).toString()); assertEquals("""{"choice":"deny"}""", approvalAnswer(false).toString())
    }

    @Test fun ackLabelsShowWhatHermesAnsweredAndNothingPredicted() {
        listOf("queued" to "Hermes queued it", "steered" to "Hermes accepted it as guidance", "redirected" to "Hermes switched to it", "rejected" to "Hermes did not accept it", "streaming" to "Hermes started it").forEach { assertEquals(it.second, ackLabel(it.first)) }
        assertEquals("Hermes queued it", queueItemLabel(HubApi.QueuedMessage("a", "queued", "queue", "t", ack = "queued")))
        assertEquals("no ack yet: the hub's own word, not Hermes's", "Queued", queueItemLabel(HubApi.QueuedMessage("a", "queued", "queue", "t")))
        assertTrue(queueItemLabel(HubApi.QueuedMessage("a", "uncertain", "queue", "t")).startsWith("Not sure it arrived"))
        assertEquals("Hermes is busy", queueItemLabel(HubApi.QueuedMessage("a", "rejected", "interrupt", "t", error = "Hermes is busy", ack = "rejected")))
    }

    @Test fun sendModeLabelsDifferBetweenNativeAndHttp() {
        assertEquals("Redirect", modeLabel("interrupt", true)); assertEquals("Interrupt & send", modeLabel("interrupt", false)); assertEquals("Queue", modeLabel("queue", true))
        assertTrue(modeHelp("interrupt", true).contains("may refuse")); assertTrue(modeHelp("interrupt", false).startsWith("Stops the reply, waits"))
        assertTrue(Capabilities.forKind("hermes").nativeUi.not())
    }

    @Test fun capabilitiesAndQueueAreParsedFromTheHub() {
        val a = HubApi.parseAgent(obj("""{"id":"h","name":"h","kind":"hermes","capabilities":{"chat":true,"nativeUi":true,"busy":["queue","steer","interrupt"]}}"""))
        assertTrue(a.capabilities.nativeUi); assertEquals(listOf("queue", "steer", "interrupt"), a.capabilities.busy)
        assertEquals("x", obj("""{"a":"x"}""").str("a"))
    }
}
