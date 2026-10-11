package dev.foxfleet.app.ui

import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionSnapshot
import dev.foxfleet.app.data.ToolEvent
import dev.foxfleet.app.ui.chat.ToolActivity
import dev.foxfleet.app.ui.chat.apply
import dev.foxfleet.app.ui.chat.toolPresentation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Tool activity, reactions and stable ids: the same rules as the web app (web/tests/tool-activity.test.ts). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MessengerTest {
    private fun start(id: String, name: String, turn: String = "t") = ToolEvent("tool.start", turn, id, name)
    private fun end(id: String, name: String, turn: String = "t") = ToolEvent("tool.end", turn, id, name)

    @Test fun overlappingCallsEndSeparately_andAReplayedStartStaysGone() {
        var s = ToolActivity().update(start("a", "web_search")).update(start("b", "read_file"))
        s = s.update(end("a", "web_search"))
        assertEquals(listOf("read_file"), s.active.map { it.name })
        s = s.update(start("a", "web_search")) // replay after the end: ignored
        assertEquals(listOf("read_file"), s.active.map { it.name })
        s = s.update(ToolEvent("tool.progress", "t", "b", "read_file"))
        assertEquals(1, s.active.size)
        assertTrue(s.update(end("b", "read_file")).active.isEmpty())
    }

    @Test fun sameCallIdInAnotherTurnIsAnotherCall() {
        val s = ToolActivity().update(start("a", "terminal", "t1")).update(end("a", "terminal", "t1")).update(start("a", "terminal", "t2"))
        assertEquals(1, s.active.size)
    }

    @Test fun descriptionsAreSafe() {
        assertEquals("Running a command", toolPresentation("terminal").second)
        assertEquals("Reading a file", toolPresentation("read_file").second)
        assertEquals("Searching the web", toolPresentation("web_search").second)
        assertEquals("Using a tool", toolPresentation("/private/secret?token=abc").second)
        assertEquals("Using my tool", toolPresentation("my_tool").second)
    }

    @Test fun reactionsApplyIdempotently() {
        val me = ReactionActor("user:u", "Owner", "human"); val bot = ReactionActor("agent:a", "Atlas", "agent")
        var s = ReactionSnapshot(me, mapOf("m" to listOf(dev.foxfleet.app.data.ReactionGroup("❤️", listOf(bot)))))
        s = s.apply("m", "❤️", true).apply("m", "❤️", true)
        assertEquals(listOf(bot, me), s.messages["m"]!!.single().actors)
        s = s.apply("m", "👍", true)
        assertEquals(2, s.messages["m"]!!.size)
        s = s.apply("m", "❤️", false).apply("m", "❤️", false).apply("m", "👍", false)
        assertEquals(listOf(bot), s.messages["m"]!!.single().actors)
    }

    @Test fun parsesTheHubSnapshot_andSkipsMalformedRows() {
        val o = Json.parseToJsonElement("""{"actor":{"id":"user:u","name":"Owner","kind":"human"},"messages":{
            "m1":[{"emoji":"🦊","actors":[{"id":"agent:a","name":"Atlas","kind":"agent"},{"nope":1}]},{"actors":[]}],
            "m2":[{"emoji":"👍","actors":[]}], "m3":"bad"}}""").jsonObject
        val s = HubApi.parseReactions(o)
        assertEquals("user:u", s.actor.id)
        assertEquals(setOf("m1"), s.messages.keys)
        assertEquals("agent", s.messages["m1"]!!.single().actors.single().kind)
    }

    @Test fun historyKeepsIds_andHidesToolOnlyRows() {
        val api = HubApi(dev.foxfleet.app.data.SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()))
        val withId = api.historyMessage(Json.parseToJsonElement("""{"id":"msg_1","role":"assistant","content":"hi"}"""))
        assertEquals("msg_1", withId!!.id)
        assertEquals("42", api.historyMessage(Json.parseToJsonElement("""{"id":42,"role":"user","content":"x"}"""))!!.id)
        assertNull(api.historyMessage(Json.parseToJsonElement("""{"id":"t","role":"assistant","content":"","tools":[{"name":"terminal"}]}""")))
    }
}
