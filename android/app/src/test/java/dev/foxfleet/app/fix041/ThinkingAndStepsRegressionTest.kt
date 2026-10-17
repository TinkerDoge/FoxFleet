package dev.foxfleet.app.fix041

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.Contract
import dev.foxfleet.app.data.live.RunStep
import dev.foxfleet.app.data.live.V2Frame
import dev.foxfleet.app.data.live.V2Frames
import dev.foxfleet.app.ui.chat.ChatState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 0.4.1 bug 1 (thinking) and bug 3 (live progress), end to end through the real stream client and ChatState:
 * a scripted hub run stream (`/chat`) that holds its last frames until the test has delivered the reply's message.new,
 * exactly the order the hub uses (runs.finish announces the reply before the run stream closes).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ThinkingAndStepsRegressionTest {
    private fun data(o: String) = "data: $o\n\n"
    private val head = data("""{"choices":[{"delta":{"reasoning_content":"Let me check the log. "}}]}""") +
        "event: hermes.tool.progress\ndata: {\"tool\":\"terminal\"}\n\n" +
        "event: foxfleet.tool\ndata: {\"type\":\"tool.start\",\"turn_id\":\"t1\",\"tool_id\":\"call_1\",\"name\":\"terminal\",\"preview\":\"tail -n 50 deploy.log\"}\n\n" +
        "event: foxfleet.step\ndata: {\"kind\":\"commentary\",\"text\":\"Reading the last 50 lines\",\"turn_id\":\"t1\",\"future\":1}\n\n" + ": keepalive\n\n"
    private val tail = "event: foxfleet.tool\ndata: {\"type\":\"tool.end\",\"turn_id\":\"t1\",\"tool_id\":\"call_1\",\"name\":\"terminal\",\"ok\":true,\"duration_ms\":1240,\"result_preview\":\"2 warnings\"}\n\n" +
        "event: foxfleet.something_new\ndata: {\"x\":1}\n\n" +
        data("""{"choices":[{"delta":{"content":"Two warnings, "}}]}""") + data("""{"choices":[{"delta":{"content":"nothing blocking."}}]}""") + "data: [DONE]\n\n"

    /** Raw one-shot HTTP server: /chat streams [head], waits for [gate], then streams [tail]. */
    private class Hub(val head: String, val tail: String, val gate: CountDownLatch) : AutoCloseable {
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        val port get() = sock.localPort
        init {
            Thread {
                while (!sock.isClosed) {
                    val c = try { sock.accept() } catch (_: Exception) { break }
                    Thread {
                        c.getInputStream().bufferedReader().let { r -> r.readLine(); while (r.readLine().orEmpty().isNotEmpty()) { } }
                        val out = c.getOutputStream()
                        out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Foxfleet-Run: run1\r\nX-Hermes-Session-Id: sess-1\r\nConnection: close\r\n\r\n$head".toByteArray()); out.flush()
                        gate.await(10, TimeUnit.SECONDS)
                        out.write(tail.toByteArray()); out.flush(); c.close()
                    }.start()
                }
            }.also { it.isDaemon = true }.start()
        }
        override fun close() { sock.close() }
    }

    private fun api(port: Int) = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:$port" })
    private val replyNew = Contract.message(Contract.obj("""{"hub_id":"h.2","n":2,"role":"assistant","text":"Two warnings, nothing blocking.","at":5,"source":"agent","run_id":"run1","status":"read"}"""))!!

    @Test fun thinkingAndStepsStreamAndSurviveTheReplysMessageNew() = runBlocking {
        val gate = CountDownLatch(1)
        Hub(head, tail, gate).use { hub ->
            val state = ChatState().apply { load(listOf(UiMessage("user", "check the log", hubId = "h.1", n = 1, status = "read")), "sess-1") }
            val job = async(Dispatchers.Default) { state.send(api(hub.port), "atlas", "check the deploy log") }
            try { withTimeout(5000) { while (state.steps.running.isEmpty() || state.streamReasoning.isEmpty()) delay(10) } }
            catch (e: Exception) { throw AssertionError("streaming=${state.streaming} r='${state.streamReasoning}' steps=${state.steps} label=${state.toolLabel} err=${state.error} job=${job.isCompleted}", e) }
            // while it streams: thinking text, a live step row (adopted from the legacy line, not doubled) and the commentary line
            assertEquals("Let me check the log. ", state.streamReasoning)
            try { withTimeout(5000) { while (state.steps.steps.none { it.kind == "commentary" }) delay(10) } }
            catch (e: Exception) { throw AssertionError("steps=${state.steps.steps} text=${state.streamText} job=${job.isCompleted}", e) }
            assertEquals(listOf("tool", "commentary"), state.steps.steps.map { it.kind })
            assertEquals("tail -n 50 deploy.log", state.steps.running.single().preview)
            assertEquals("Reading the last 50 lines", state.steps.steps.last().text)
            assertEquals("the running tool is the live line", "call_1", state.steps.current!!.key.removePrefix("t:"))
            // the hub announces the reply (text only) before its run stream closes: 0.4.0 dropped it here
            assertEquals(false, state.applyLive(replyNew.toUi(), edited = false))
            gate.countDown(); job.await()
            val reply = state.messages.last()
            assertEquals("assistant", reply.role)
            assertEquals("Let me check the log. ", reply.reasoning)
            assertEquals("h.2", reply.hubId); assertEquals(2, reply.n); assertEquals("run1", reply.runId)
            assertNull("no tick on an agent message", reply.status)
            assertEquals(listOf(ToolStep("terminal", "tail -n 50 deploy.log", "2 warnings", true)), reply.steps)
            assertEquals(3, state.messages.size) // the earlier question, the one just sent, the reply
            // the same event replayed (reconnect) merges by hub id: still one reply, thinking kept
            assertTrue(state.applyLive(replyNew.toUi(), edited = false))
            assertEquals(1, state.messages.count { it.role == "assistant" }); assertEquals("Let me check the log. ", state.messages.last().reasoning)
        }
    }

    @Test fun aLateMessageNewMergesByRunIdEvenWhenTheTextDiffers() {
        val state = ChatState().apply { load(listOf(UiMessage("user", "q", hubId = "h.1", n = 1)), "s") }
        // the committed bubble (as stream() leaves it): no ids yet, the run it came from
        state.load(state.messages + UiMessage("assistant", "Done.\n\n![chart](/out/c.png)", reasoning = "thought", steps = listOf(ToolStep("terminal")), runId = "r9"), "s")
        val late = Contract.message(Contract.obj("""{"hub_id":"h.2","n":2,"role":"assistant","text":"Done.","at":7,"run_id":"r9"}"""))!!.toUi()
        assertTrue(state.applyLive(late, edited = false))
        assertEquals(2, state.messages.size)
        val m = state.messages.last(); assertEquals("h.2", m.hubId); assertEquals("thought", m.reasoning); assertEquals(1, m.steps.size)
    }

    @Test fun aHubPageWithoutThinkingDoesNotWipeIt() {
        val state = ChatState()
        state.load(listOf(UiMessage("user", "q", hubId = "h.1", n = 1), UiMessage("assistant", "A.", reasoning = "why", reasoningMs = 1500, steps = listOf(ToolStep("web_search", "foxes")), hubId = "h.2", n = 2)), "s")
        state.load(listOf(UiMessage("user", "q", hubId = "h.1", n = 1), UiMessage("assistant", "A.", hubId = "h.2", n = 2)), "s") // catch-up Replace / reopen
        assertEquals("why", state.messages.last().reasoning); assertEquals(1500L, state.messages.last().reasoningMs); assertEquals("web_search", state.messages.last().steps.single().name)
        state.load(listOf(UiMessage("assistant", "Other chat.")), "other") // another chat: nothing carried over
        assertEquals("", state.messages.single().reasoning)
    }

    @Test fun messageNewCarriesReasoningAndToolsFromNewHubsAndIsLenient() {
        val m = Contract.message(Contract.obj("""{"hub_id":"h.4","n":4,"role":"assistant","text":"ok","reasoning":"r","reasoning_truncated":true,"tools":[{"name":"terminal","args":"ls","result":"a b","ok":false},{"bad":1},"x",{"name":"read_file"}],"status":"read"}"""))!!
        val ui = m.toUi()
        assertEquals("r", ui.reasoning); assertEquals(listOf(ToolStep("terminal", "ls", "a b", false), ToolStep("read_file")), ui.steps); assertNull(ui.status)
        val user = Contract.message(Contract.obj("""{"hub_id":"h.3","n":3,"role":"user","text":"hi","reasoning":"no","tools":[{"name":"x"}],"status":"read"}"""))!!.toUi()
        assertEquals("", user.reasoning); assertTrue(user.steps.isEmpty()); assertEquals("read", user.status)
    }

    @Test fun runStepAndTypingLabelParseAndDedupeWithTheRunStream() {
        val f = V2Frames.decode("run.step", """{"agent":"atlas","chat":"s","run_id":"r1","kind":"tool.start","tool_id":"call_1","name":"terminal","preview":"ls","at":1,"new_field":true}""", null)
        val step = (f as V2Frame.StepFrame).step
        assertEquals(RunStep("atlas", "s", "r1", "tool.start", "call_1", "terminal", "ls", null, null, null, 1), step)
        val t = (V2Frames.decode("typing", """{"agent":"atlas","chat":"s","state":"tool","tool":"terminal","label":"ls -la","tool_id":"call_1","ttl_ms":6000}""", null) as V2Frame.TypingFrame).typing
        assertEquals("ls -la", t.label); assertEquals("call_1", t.toolId)
        assertNull(V2Frames.decode("run.step", """{"agent":"atlas"}""", null))
    }
}
