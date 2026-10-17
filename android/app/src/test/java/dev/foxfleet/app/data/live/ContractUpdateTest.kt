package dev.foxfleet.app.data.live

import dev.foxfleet.app.ui.ChatRows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The hub implementation (70a0140): lenient parsing, nullable last_message.hub_id, media labels, run_id keying, typing cadence, send reads. */
class ContractUpdateTest {
    private fun o(s: String) = Contract.obj(s)!!

    @Test fun messageWithMissingNullFieldsAndNoImagesParses() {
        val m = Contract.message(o("""{"hub_id":"m1","n":3,"role":"assistant","text":"hi"}"""))
        assertNotNull(m); assertEquals(3, m!!.n); assertNull(m.status); assertNull(m.runId); assertNull(m.editedAt); assertTrue(m.images.isEmpty())
        assertNotNull(Contract.message(o("""{"hub_id":"m2","n":4,"role":"user","text":"x","images":null,"status":null,"reply_to":null,"future":{"a":1}}""")))
        assertEquals(5, Contract.message(o("""{"hub_id":"m3","n":5.0,"role":"user"}"""))?.n)
    }

    @Test fun chatRowWithNullHubIdAndMediaPreview() {
        val r = Contract.chat(o("""{"agent":"nova","label":"Nova","last_message":{"hub_id":null,"role":"assistant","sender":"Nova","preview":"Photo","at":5},"unread_count":2}"""))!!
        assertNull(r.last!!.hubId); assertEquals("Photo", r.last!!.preview)
        assertEquals(ChatRows.Preview("Nova", "Photo"), ChatRows.preview(r))
        val f = Contract.chat(o("""{"agent":"a","last_message":{"role":"user","sender":"you","preview":"File: report.pdf"}}"""))!!
        assertEquals(ChatRows.Preview("You", "File: report.pdf"), ChatRows.preview(f))
    }

    @Test fun sendingReadsTheChat() {
        val r = Contract.chat(o("""{"agent":"nova","unread_count":4,"manual_unread":true}"""))!!
        val after = ChatRows.afterSend(r)
        assertEquals(0, after.badge); assertFalse(after.manualUnread)
        assertTrue(ChatRows.afterSend(after) === after)
    }

    @Test fun runStartedBeforeMessageNewIsKeyedOnRunId() {
        val runs = RunTracker()
        assertTrue(runs.started("r1", "nova", null))          // run.started before the chat's message.new
        assertFalse(runs.started("r1", "nova", "c_new"))     // replay / repeat: not followed twice, learns the chat
        assertEquals(RunTracker.Run("nova", "c_new"), runs.finished("r1", "nova", null))
        assertFalse("a replayed start after its finish is ignored", runs.started("r1", "nova", "c_new"))
        assertNull(runs.finished("r2", "nova", "c"))           // finish of a run never seen here
        assertTrue(runs.started("r3", "nova", "c")); assertTrue(runs.running("nova"))
    }

    @Test fun typingRepeatedEvery4sWithTtl6sStaysUntil6sAfterTheLastRepeat() {
        var now = 0L; val t = TypingTracker { now }
        val ty = Typing("nova", "c", "typing", null, 6000)
        t.on(ty)
        for (step in 1..5) { now = step * 4000L; assertNotNull("at $now", t.get("nova", "c")); t.on(ty) }
        now = 20_000L + 5_999; assertNotNull(t.get("nova", "c"))
        now = 20_000L + 6_000; assertNull(t.get("nova", "c"))
    }

    @Test fun typingClearsOnRunFinishedAndOnAgentMessage() {
        val t = TypingTracker { 0L }
        t.on(Typing("nova", "c", "thinking", null, 6000)); assertTrue(t.clear("nova", "c")); assertNull(t.get("nova", "c"))
        t.on(Typing("nova", "c", "tool", "bash", 6000)); assertEquals("running bash…", TypingTracker.label(t.get("nova", "c")))
        t.on(Typing("nova", "c", "idle", null, 6000)); assertNull(t.get("nova", "c"))
    }
}
