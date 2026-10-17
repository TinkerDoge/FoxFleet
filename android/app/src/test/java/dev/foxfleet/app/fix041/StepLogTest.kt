package dev.foxfleet.app.fix041

import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.ToolEvent
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.live.Contract
import dev.foxfleet.app.ui.chat.StepLog
import dev.foxfleet.app.ui.components.stepLabel
import dev.foxfleet.app.ui.components.stepsSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** 0.4.1 bug 3: the live step list, merged from the run stream and live v2 without doubles. */
class StepLogTest {
    @Test fun aToolIsOneRowWhicheverSourceSaysItFirst() {
        var log = StepLog().legacyTool("terminal", now = 100)                                   // hermes.tool.progress
        log = log.tool("tool.start", "call_1", "terminal", "ls -la", now = 110)                 // foxfleet.tool start: adopts that row
        log = log.tool("tool.start", "call_1", "terminal", "ls -la", now = 120)                 // run.step for the same call
        assertEquals(1, log.steps.size); assertEquals("running", log.steps[0].state); assertEquals(100L, log.steps[0].startedAt)
        log = log.tool("tool.end", "call_1", "terminal", ok = true, durationMs = 1240, result = "a\nb", now = 1500)
        val again = log.tool("tool.end", "call_1", "terminal", ok = true, durationMs = 1240, result = "a\nb", now = 1600)
        assertSame("a repeated end changes nothing", log, again)
        assertSame("a start replayed after its end changes nothing", log, log.tool("tool.start", "call_1", "terminal", now = 1700))
        assertEquals("ok", log.steps[0].state); assertEquals(1240L, log.steps[0].durationMs); assertEquals("a b", log.steps[0].result)
        assertEquals(listOf(ToolStep("terminal", "ls -la", "a b", true)), log.toToolSteps())
    }

    @Test fun failuresDurationsNotesAndSettle() {
        var log = StepLog().tool("tool.start", "c1", "web_search", "foxes", now = 0).tool("tool.end", "c1", "web_search", ok = false, now = 2500)
        assertEquals("failed", log.steps[0].state); assertEquals(2500L, log.steps[0].durationMs)
        log = log.note("status", "Retrying with a smaller query", "warn").note("status", "Retrying with a smaller query", "warn").note("bogus", "x")
        assertEquals(2, log.steps.size); assertEquals("warn", log.steps[1].state)
        log = log.tool("tool.start", "c2", "read_file", "notes.md", now = 3000)
        assertEquals("c2", log.current!!.key.removePrefix("t:"))
        val settled = log.settle(now = 4000); assertEquals(0, settled.running.size); assertEquals(1000L, settled.steps.last().durationMs)
        assertEquals("1.2 s", StepLog.duration(1240)); assertEquals("850 ms", StepLog.duration(850)); assertEquals("2 min 5 s", StepLog.duration(125_000)); assertNull(StepLog.duration(null))
    }

    @Test fun legacyOnlyHubsStillGetAStepList() {
        val log = StepLog().legacyTool("terminal", now = 0).legacyTool("terminal", now = 50).legacyTool("read_file", now = 900)
        assertEquals(listOf("terminal", "read_file"), log.steps.map { it.name }); assertEquals("ok", log.steps[0].state); assertEquals(900L, log.steps[0].durationMs)
        assertEquals("running", log.steps[1].state)
    }

    @Test fun labelsAndSummary() {
        val log = StepLog().tool("tool.start", "c1", "terminal", "npm test", now = 0)
        assertEquals("Running a command · npm test", stepLabel(log.steps[0]))
        assertEquals("Running a command · npm test", stepsSummary(log, live = true))
        assertEquals("Used 1 tool", stepsSummary(log.settle(), live = false))
        assertEquals("Used 2 tools, 1 failed", stepsSummary(StepLog.of(listOf(ToolStep("a"), ToolStep("b", ok = false))), live = false))
    }

    @Test fun runStreamToolEventsParseLenientlyWithTheNewFields() {
        val e = HubApi.toolEvent(Contract.obj("""{"type":"tool.end","tool_id":"c1","name":"terminal","turn_id":"t","ok":false,"duration_ms":12.7,"result_preview":"exit 1","extra":[1]}""")!!)
        assertEquals(ToolEvent("tool.end", "t", "c1", "terminal", null, false, 12, "exit 1"), e)
        assertNull(HubApi.toolEvent(Contract.obj("""{"type":"tool.wat","name":"x"}""")!!))
        assertEquals(ToolEvent("tool.start", null, null, "x"), HubApi.toolEvent(Contract.obj("""{"type":"tool.start","name":"x","ok":"yes","duration_ms":"5"}""")!!))
    }
}
