package dev.foxfleet.app.fix041

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.RunStep
import dev.foxfleet.app.data.local.CacheDb
import dev.foxfleet.app.data.local.ChatCache
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.chat.StepLog
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** 0.4.1 bug 1: the reply's thinking and tools survive a reload (the cache), and run.step joins the live step list without doubles. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplyCacheRegressionTest {
    private lateinit var db: CacheDb
    private lateinit var cache: ChatCache
    @Before fun open() { db = CacheDb.build(ApplicationProvider.getApplicationContext(), name = null); cache = ChatCache(db, "owner-a", now = { 42L }) }
    @After fun close() { db.close() }

    private val q = UiMessage("user", "check the log", hubId = "h.1", n = 1, status = "read", ts = 1)
    private val streamed = UiMessage("assistant", "Two warnings.", reasoning = "Let me check.", steps = listOf(ToolStep("terminal", "tail deploy.log", "2 warnings", true)), hubId = "h.2", n = 2, ts = 2, runId = "r1")

    @Test fun aTextOnlyMessageNewOrPageKeepsTheStoredThinking() = runBlocking {
        cache.saveNewest("atlas", "s1", listOf(q), hasMore = false)
        assertTrue(cache.upsertLive("atlas", "s1", streamed)) // what HubViewModel.storeReply writes after the reply streamed
        // the hub's own message.new (0.4.0 hubs: text only, and a status) arrives again, e.g. on resync
        assertTrue(cache.upsertLive("atlas", "s1", UiMessage("assistant", "Two warnings.", hubId = "h.2", n = 2, ts = 2, status = "read")))
        // and the next history page has no thinking either
        cache.saveNewest("atlas", "s1", listOf(q, UiMessage("assistant", "Two warnings.", hubId = "h.2", n = 2, ts = 2)), hasMore = false)
        val reply = cache.open("atlas", "s1")!!.messages.last()
        assertEquals("Let me check.", reply.reasoning); assertEquals(streamed.steps, reply.steps)
        assertNull("no tick on an agent message", reply.status)
        assertEquals("read", cache.open("atlas", "s1")!!.messages.first().status)
    }

    @Test fun newThinkingFromTheHubReplacesTheOld() = runBlocking {
        cache.saveNewest("atlas", "s1", listOf(q, streamed), hasMore = false)
        cache.upsertLive("atlas", "s1", streamed.copy(content = "Edited.", reasoning = "Second look.", steps = listOf(ToolStep("read_file"))))
        val reply = cache.open("atlas", "s1")!!.messages.last()
        assertEquals("Edited.", reply.content); assertEquals("Second look.", reply.reasoning); assertEquals("read_file", reply.steps.single().name)
    }

    @Test fun runStepAndTheRunStreamMakeOneRowPerTool() {
        val s = ChatState()
        s.simulateStream("", steps = StepLog().tool("tool.start", "call_1", "terminal", "ls -la", now = 100))
        s.applyRunStep(RunStep("atlas", "s1", null, "tool.start", "call_1", "terminal", "ls -la", null, null, null, 100)) // the v2 copy
        s.applyRunStep(RunStep("atlas", "s1", null, "commentary", null, null, null, null, null, "Listing files", 110))
        s.applyRunStep(RunStep("atlas", "s1", null, "tool.end", "call_1", "terminal", "a b", true, 420, null, 520))
        s.applyRunStep(RunStep("atlas", "s1", null, "tool.end", "call_1", "terminal", "a b", true, 420, null, 520)) // replayed
        assertEquals(listOf("tool", "commentary"), s.steps.steps.map { it.kind })
        assertEquals("ok", s.steps.steps[0].state); assertEquals(420L, s.steps.steps[0].durationMs)
        assertEquals("the end's preview is the result, the arguments stay", "ls -la", s.steps.steps[0].preview); assertEquals("a b", s.steps.steps[0].result)
        s.applyRunStep(RunStep("atlas", "s1", null, "bogus", null, null, null, null, null, null, 1)) // unknown kind: ignored
        assertEquals(2, s.steps.steps.size)
    }
}
