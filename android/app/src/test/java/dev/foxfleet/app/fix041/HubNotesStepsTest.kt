package dev.foxfleet.app.fix041

import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.Contract
import dev.foxfleet.app.data.live.RunStep
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.chat.StepLog
import dev.foxfleet.app.ui.components.stepsSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rennyn's four client notes on the 0.4.1 hub (fix/0.4.1-hub 02d4eaa): sub-agent kinds, end previews, starts-only agents, native ticks. */
class HubNotesStepsTest {
    private fun rs(kind: String, toolId: String? = null, name: String? = null, preview: String? = null, ok: Boolean? = null, ms: Long? = null, text: String? = null) =
        RunStep("atlas", "s1", "r1", kind, toolId, name, preview, ok, ms, text, 1)

    /** (1) the run stream says `subagent`, live v2 says `status` for the same line: one row, rendered the same way. */
    @Test fun subagentAndStatusAreOneRow() {
        val log = StepLog().note("subagent", "Subagent started: research the API", "info")
            .tool("tool.start", "c1", "web_search", "fox api", now = 0)
            .note("status", "Subagent started: research the API") // the v2 copy, after another row
            .note("subagent", "Subagent failed: research the API", "error")
            .note("status", "Subagent failed: research the API", "error")
        assertEquals(listOf("status", "tool", "status"), log.steps.map { it.kind })
        assertEquals(listOf("info", "error"), log.steps.filter { !it.isTool }.map { it.state })
        // v2 first, then the run stream copy with a level: still one row, the level is kept
        val other = StepLog().note("status", "Subagent finished: x").note("subagent", "Subagent finished: x", "warn")
        assertEquals(1, other.steps.size); assertEquals("warn", other.steps.single().state)
        // commentary from both sources, interleaved with a tool row
        val c = StepLog().note("commentary", "Looking at the log").tool("tool.start", "c1", "terminal", now = 0).note("commentary", "Looking at the log")
        assertEquals(2, c.steps.size)
        // a genuinely new status line still appears
        assertEquals(2, StepLog().note("status", "Retrying").note("status", "Compressing context").steps.size)
    }

    /** (2) run.step tool.end `preview` is the result: shown as the result, the start's args stay. */
    @Test fun endPreviewIsTheResult() {
        val s = ChatState(); s.simulateStream("")
        s.applyRunStep(rs("tool.start", "c1", "terminal", preview = "ls -la /tmp"))
        s.applyRunStep(rs("tool.end", "c1", "terminal", preview = "a b c", ok = true, ms = 250))
        val row = s.steps.steps.single()
        assertEquals("ls -la /tmp", row.preview); assertEquals("a b c", row.result); assertEquals("ok", row.state)
        // an end that only says so through a run-stream `preview` (lenient) is read the same way
        val e = HubApi.toolEvent(Contract.obj("""{"type":"tool.end","tool_id":"c1","name":"terminal","ok":true,"preview":"out"}""")!!)!!
        assertEquals(null, e.preview); assertEquals("out", e.resultPreview)
        // an end seen first (the other source was faster): a late start only adds the args, it does not restart the call
        val late = StepLog().tool("tool.end", "c2", "read_file", null, true, 10, "file body", now = 5).tool("tool.start", "c2", "read_file", "a.txt", now = 6)
        assertEquals("a.txt", late.steps.single().preview); assertEquals("file body", late.steps.single().result); assertEquals("ok", late.steps.single().state)
        assertEquals(late, late.tool("tool.start", "c2", "read_file", "other args", now = 7)) // args already known: unchanged
    }

    /** (3) chat-completions agents: starts only (hermes.tool.progress + run.step without tool_id). Spinners settle as "done" when the run ends. */
    @Test fun startsOnlyAreSettledNeutralWhenTheRunEnds() {
        val s = ChatState(); s.load(listOf(UiMessage("user", "q", hubId = "h.1", n = 1)), "s1"); s.simulateStream("")
        s.applyRunStep(rs("tool.start", name = "terminal", preview = "ls"))   // v2 first
        s.toolTick("terminal")                              // then the run stream's frame for the same start
        s.toolTick("read_file"); s.applyRunStep(rs("tool.start", name = "read_file", preview = "a.txt"))
        assertEquals(listOf("terminal", "read_file"), s.steps.steps.map { it.name })
        assertEquals(listOf("ls", "a.txt"), s.steps.steps.map { it.preview })
        assertEquals(listOf("done", "running"), s.steps.steps.map { it.state }) // a new start ends the one before: outcome unknown
        // the same with live v2 first for the second call too (the order the real hub sends them in): still one spinner
        val v = ChatState(); v.simulateStream("")
        v.applyRunStep(rs("tool.start", name = "terminal", preview = "git status")); v.toolTick("terminal")
        v.applyRunStep(rs("tool.start", name = "read_file", preview = "README.md")); v.toolTick("read_file")
        assertEquals(listOf("done", "running"), v.steps.steps.map { it.state }); assertEquals(listOf("git status", "README.md"), v.steps.steps.map { it.preview })
        // or both run-stream ticks first and the v2 starts late (the first row is already settled): the args still arrive, nothing doubles
        val w = ChatState(); w.simulateStream("")
        w.toolTick("terminal"); w.toolTick("read_file")
        w.applyRunStep(rs("tool.start", name = "terminal", preview = "git status")); w.applyRunStep(rs("tool.start", name = "read_file", preview = "README.md"))
        assertEquals(listOf("done", "running"), w.steps.steps.map { it.state }); assertEquals(listOf("git status", "README.md"), w.steps.steps.map { it.preview })
        s.runEnded("r1", "done")                                                 // live v2 run.finished
        assertTrue(s.steps.running.isEmpty()); assertEquals(listOf("done", "done"), s.steps.steps.map { it.state })
        assertEquals("Used 2 tools", stepsSummary(s.steps, live = false))
        // what the message keeps: no outcome, so no success check after a reload either
        assertEquals(listOf(null, null), s.steps.toToolSteps().map { it.ok })
        assertEquals(listOf("done", "done"), StepLog.of(s.steps.toToolSteps()).steps.map { it.state })
    }

    @Test fun theReplysMessageNewAndAFailedRunSettleToo() {
        val s = ChatState(); s.load(emptyList(), "s1"); s.simulateStream("")
        s.applyRunStep(rs("tool.start", "c1", "terminal", "make"))
        s.applyLive(UiMessage("assistant", "Done.", hubId = "h.2", n = 2, runId = null), edited = false) // message.new final
        assertEquals("done", s.steps.steps.single().state)
        s.applyRunStep(rs("tool.end", "c1", "terminal", "ok", ok = true, ms = 10)) // a real end still arriving wins
        assertEquals("ok", s.steps.steps.single().state)
        val f = ChatState(); f.load(emptyList(), "s1"); f.simulateStream("")
        f.applyRunStep(rs("tool.start", "c1", "terminal", "make")); f.runEnded("r1", "failed")
        assertEquals("failed", f.steps.steps.single().state)
        // run.finished for another run changes nothing
        val o = ChatState(); o.simulateStream("", run = "r1"); o.applyRunStep(rs("tool.start", "c1", "terminal")); o.runEnded("someone-else", "done")
        assertEquals("running", o.steps.steps.single().state)
        // an end without `ok` is not a success either
        assertEquals("done", StepLog().tool("tool.start", "c1", "x", now = 0).tool("tool.end", "c1", "x", now = 5).steps.single().state)
    }

    /** (4) the native gateway's own hermes.tool.progress ticks never add rows next to foxfleet.tool / run.step. */
    @Test fun nativeTicksAddNoRows() {
        var log = StepLog().legacyTool("terminal", now = 0)              // tool.generating tick before the start
            .tool("tool.start", "call_1", "terminal", "npm test", now = 1)  // adopted, not a second row
        log = log.legacyTool("terminal").legacyTool("terminal")           // progress ticks while it runs
        log = log.tool("tool.end", "call_1", "terminal", ok = true, durationMs = 900, now = 901)
        log = log.legacyTool("terminal").legacyTool("read_file")          // ticks after the end, and of the next call before its start
        log = log.tool("tool.start", "call_2", "read_file", "a.txt", now = 950).tool("tool.start", "call_2", "read_file", "a.txt", now = 951) // run stream + run.step
        log = log.legacyTool("read_file")
        assertEquals(listOf("t:call_1", "t:call_2"), log.steps.map { it.key })
        assertEquals(listOf("ok", "running"), log.steps.map { it.state })
        // a tick for a tool whose keyed start never adopted it (another name) is dropped once keyed events start
        val mixed = StepLog().legacyTool("skills_list").tool("tool.start", "c1", "terminal", now = 0)
        assertEquals(listOf("t:c1"), mixed.steps.map { it.key })
        // commentary text the hub also sends as hermes.tool.progress is not a tool
        assertTrue(StepLog().legacyTool("Let me look at the deploy log first").isEmpty)
    }

    @Test fun cachedToolsKeepAnUnknownOutcome() {
        val m = Contract.message(Contract.obj("""{"hub_id":"h.2","n":2,"role":"assistant","text":"x","tools":[{"name":"terminal","args":"ls"},{"name":"read_file","ok":true}]}"""))!!.toUi()
        assertEquals(listOf(ToolStep("terminal", "ls", ok = null), ToolStep("read_file", ok = true)), m.steps)
    }

    /** The run stream (IO thread) and live v2 (main thread) change the list at the same moment: no update is lost. */
    @Test fun concurrentSourcesLoseNothing() {
        val s = ChatState(); s.simulateStream("", run = "r1")
        val a = Thread { for (i in 0 until 15) s.applyRunStep(rs("tool.start", "a$i", "terminal", "a$i")) }
        val b = Thread { for (i in 0 until 15) { s.applyRunStep(rs("tool.start", "b$i", "read_file", "b$i")); s.applyRunStep(rs("tool.end", "b$i", "read_file", "ok", ok = true)) } }
        a.start(); b.start(); a.join(); b.join()
        assertEquals(30, s.steps.steps.size); assertEquals(15, s.steps.steps.count { it.state == "ok" })
    }
}
