package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

/** The same vectors the hub and the web app pass (contract/agent-list.vectors.json). */
class AgentListTest {
    private val v: JsonObject by lazy {
        var dir = java.io.File(System.getProperty("user.dir")).absoluteFile
        while (!java.io.File(dir, "contract/agent-list.vectors.json").exists()) dir = dir.parentFile ?: error("contract/agent-list.vectors.json not found")
        Json.parseToJsonElement(java.io.File(dir, "contract/agent-list.vectors.json").readText()).jsonObject
    }
    private fun JsonObject.agent(): AgentStatus = AgentStatus(
        name = this["name"]?.jsonPrimitive?.contentOrNull ?: "x", online = true, chatReady = true, managementReady = false,
        description = this["description"]?.jsonPrimitive?.contentOrNull.orEmpty(), order = this["order"]?.jsonPrimitive?.intOrNull ?: 0,
        lastActivityAt = this["last_activity_at"]?.jsonPrimitive?.longOrNull, lastSessionTitle = this["last_session_title"]?.jsonPrimitive?.contentOrNull,
        lastMessagePreview = this["last_message_preview"]?.jsonPrimitive?.contentOrNull, lastRole = this["last_role"]?.jsonPrimitive?.contentOrNull,
        pinOrder = this["pin_order"]?.jsonPrimitive?.intOrNull, working = this["working"]?.jsonPrimitive?.booleanOrNull ?: false, needsInput = this["needs_input"]?.jsonPrimitive?.booleanOrNull ?: false,
    )

    @Test fun orderConformsToTheSharedVectors() {
        val input = v["sort"]!!.jsonObject["input"]!!.jsonArray.map { it.jsonObject.agent() }
        val want = v["sort"]!!.jsonObject["expect"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(want, AgentList.sort(input).map { it.name })
        assertEquals(want, AgentList.sort(AgentList.sort(input)).map { it.name })
    }

    @Test fun previewConformsToTheSharedVectors() {
        for ((i, p) in v["preview"]!!.jsonArray.withIndex()) {
            val o = p.jsonObject; val want = o["expect"]!!.jsonObject
            val got = AgentList.preview(o["agent"]!!.jsonObject.agent())
            assertEquals("preview $i kind", want["kind"]!!.jsonPrimitive.content, got.kind.name.lowercase())
            assertEquals("preview $i text", want["text"]!!.jsonPrimitive.content, got.text)
            assertEquals("preview $i you", want["you"]!!.jsonPrimitive.boolean(), got.you)
        }
    }
    private fun kotlinx.serialization.json.JsonPrimitive.boolean() = booleanOrNull ?: false

    @Test fun timeConformsToTheSharedVectors() {
        val now = v["now"]!!.jsonPrimitive.long()
        for (t in v["time"]!!.jsonArray) {
            val o = t.jsonObject; val at = o["at"]!!.jsonPrimitive.longOrNull
            assertEquals("time $at", o["expect"]!!.jsonPrimitive.content, AgentList.time(at, now, Locale.US, ZoneId.of("UTC")).replace('\u202f', ' '))
        }
    }
    private fun kotlinx.serialization.json.JsonPrimitive.long() = longOrNull!!

    @Test fun typingAndApprovalBeatTheLastMessage() {
        val a = AgentStatus("a", online = true, chatReady = true, managementReady = false, lastMessagePreview = "hi")
        assertEquals(AgentList.Kind.Typing, AgentList.preview(a.copy(working = true)).kind)
        assertEquals(AgentList.Kind.Typing, AgentList.preview(a, runningHere = true).kind)
        assertEquals(AgentList.Kind.Approval, AgentList.preview(a.copy(working = true, needsInput = true)).kind)
    }

    @Test fun unreadIsAReplyNewerThanWhatWasSeenAndNeverTheOpenChat() {
        val a = AgentStatus("a", online = true, chatReady = true, managementReady = false, lastActivityAt = 200, lastRole = "assistant")
        assertFalse("new device starts read", AgentList.unread(a, null, false))
        assertTrue(AgentList.unread(a, 100, false)); assertFalse(AgentList.unread(a, 200, false))
        assertFalse("open chat", AgentList.unread(a, 100, true)); assertFalse("own message", AgentList.unread(a.copy(lastRole = "user"), 100, false))
    }
}
