package dev.foxfleet.app.rooms

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.ConversationMention
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.NativeChatTest
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.live.Contract
import dev.foxfleet.app.data.live.V2Event
import dev.foxfleet.app.data.live.V2Frames
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The room wire shapes: the same JSON the web client sends and reads, with no actor/admit and per-member authors. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConversationTest {
    private val now = 1_700_000_000_000L
    private val roomJson = """
        {"id":"fc_abcdefghijklmnop","thread_id":"fcr_abcdefghijklmnop","chat_type":"group","title":"Launch room",
         "owner":{"id":"u1","name":"Ada","kind":"human","is_bot":false,"joined_at":1},
         "members":[{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true,"joined_at":2},
                    {"id":"agent:reviewer","name":"reviewer","kind":"agent","is_bot":true,"joined_at":3}],
         "created_at":$now,"updated_at":$now,"last_message_at":$now,"unread_count":2,"paused":false,"epoch":7}
    """.trimIndent()

    private fun api(port: Int) = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also {
        it.allowHttp = true; it.baseUrl = "http://127.0.0.1:$port"
    })

    @Test fun roomJsonKeepsItsOwnMemberNamesAndNeverBecomesAnAgent() {
        val room = HubApi.parseConversation(Contract.obj(roomJson)!!)!!
        assertEquals("fc_abcdefghijklmnop", room.id)
        assertEquals("Launch room", room.title)
        assertEquals(listOf("helper", "reviewer"), room.members.map { it.name })
        assertEquals("u1", room.owner.id)
        assertEquals(2, room.unreadCount); assertFalse(room.paused); assertEquals(7L, room.epoch)
        // There is no agent identity to accidentally put in the fleet: a room model only has member rows.
        assertFalse(room.javaClass.name.contains("AgentStatus"))
        assertTrue(room.ownedBy("u1"))
        assertFalse(room.ownedBy(null))
        assertFalse(room.ownedBy("someone-else"))
    }

    @Test fun messageCarriesTheAuthorMentionsReplyAndMedia() {
        val json = """
            {"id":"fm_aaaaaaaaaaaaaaaa","conversation_id":"fc_abcdefghijklmnop","sender":{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true},
             "text":"@reviewer see this","created_at":$now,"reply_to":"fm_bbbbbbbbbbbbbbbb","seq":9,"dispatch_id":"fd_aaaaaaaaaaaaaaaa",
             "mentions":[{"kind":"agent","id":"agent:reviewer","offset":0,"length":10}],
             "media":[{"id":"fbm_1","kind":"image","mime":"image/png","name":"shot.png","size":42}]}
        """.trimIndent()
        val m = HubApi.parseConversationMessage(Contract.obj(json)!!)!!
        assertEquals("helper", m.sender.name); assertTrue(m.sender.isAgent)
        assertEquals("fm_bbbbbbbbbbbbbbbb", m.replyTo)
        assertEquals(ConversationMention("agent", "agent:reviewer", 0, 10), m.mentions.single())
        assertEquals("shot.png", m.media.single().name)
        assertEquals("fd_aaaaaaaaaaaaaaaa", m.dispatchId)
        // No thinking was published: the block is simply empty.
        assertEquals("", m.reasoning)
    }

    @Test fun theThinkingAnAgentPublishedIsRead() {
        val json = """
            {"id":"fm_aaaaaaaaaaaaaaaa","conversation_id":"fc_abcdefghijklmnop","sender":{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true},
             "text":"Looks good.","created_at":$now,"seq":9,"reasoning":"Let me read the logs first."}
        """.trimIndent()
        val m = HubApi.parseConversationMessage(Contract.obj(json)!!)!!
        assertEquals("Let me read the logs first.", m.reasoning)
        // The thinking is a display field: the answer stands on its own.
        assertEquals("Looks good.", m.text)
    }

    @Test fun liveV2HasConversationEventsAndEphemeralTyping() {
        val created = Contract.event(Contract.obj("""{"seq":11,"type":"conversation.created","conversation":$roomJson}""")!!)!!
        assertTrue(created is V2Event.ConversationCreated)
        assertEquals("fc_abcdefghijklmnop", (created as V2Event.ConversationCreated).conversation.id)
        assertEquals("fc_abcdefghijklmnop", created.conversationId)
        assertNull(created.agent)

        val m = """{"id":"fm_aaaaaaaaaaaaaaaa","conversation_id":"fc_abcdefghijklmnop","sender":{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true},"text":"hi","created_at":$now,"seq":12}"""
        val new = Contract.event(Contract.obj("""{"seq":12,"type":"conversation.message.new","conversation_id":"fc_abcdefghijklmnop","message":$m}""")!!) as V2Event.ConversationMessageNew
        assertEquals("fc_abcdefghijklmnop", new.conversationId); assertEquals("helper", new.message.sender.name)

        val read = Contract.event(Contract.obj("""{"seq":13,"type":"conversation.read","conversation_id":"fc_abcdefghijklmnop","read_up_to":12}""")!!) as V2Event.ConversationRead
        assertEquals(12, read.readUpTo)

        val frame = V2Frames.decode("conversation.typing", """{"conversation_id":"fc_abcdefghijklmnop","agent":"agent:helper","state":"typing"}""", null) as dev.foxfleet.app.data.live.V2Frame.ConversationTypingFrame
        assertEquals("agent:helper", frame.typing.agent); assertEquals("typing", frame.typing.state)
    }

    @Test fun hubApiCallShapesMatchTheWebClient() = runBlocking {
        val seen = mutableListOf<String>()
        val message = """{"id":"fm_aaaaaaaaaaaaaaaa","conversation_id":"fc_abcdefghijklmnop","sender":{"id":"u1","name":"Ada","kind":"human","is_bot":false},"text":"hi","created_at":$now,"seq":1}"""
        val routes = mapOf(
            "GET /api/conversations" to Triple(200, "application/json", """{"conversations":[$roomJson],"total":1}"""),
            "GET /api/conversations/fc_abcdefghijklmnop/messages/fm_aaaaaaaaaaaaaaaa" to Triple(200, "application/json", message),
            "GET /api/conversations/fc_abcdefghijklmnop/messages" to Triple(200, "application/json", """{"messages":[$message],"has_more":false,"next_cursor":1}"""),
            "GET /api/conversations/fc_abcdefghijklmnop" to Triple(200, "application/json", roomJson),
            "POST /api/conversations/fc_abcdefghijklmnop/messages" to Triple(202, "application/json", """{"message":$message,"conversation_id":"fc_abcdefghijklmnop","dispatched_to":["helper"]}"""),
            "POST /api/conversations/fc_abcdefghijklmnop/read" to Triple(200, "application/json", roomJson),
            "POST /api/conversations/fc_abcdefghijklmnop/stop" to Triple(200, "application/json", """{"stopped":true,"confirmed":true,"state":"stopped","epoch":8,"paused":true}"""),
            "POST /api/conversations/fc_abcdefghijklmnop/resume" to Triple(200, "application/json", roomJson),
            "POST /api/agents/helper/native/sessions/fc_abcdefghijklmnop/requests/frq_aaaaaaaaaaaaaaaa" to Triple(200, "application/json", """{"ok":true}"""),
            "PUT /api/conversations/fc_abcdefghijklmnop/preferences" to Triple(200, "application/json", """{"muted":true,"notify":"mentions","archived":false}"""),
        )
        NativeChatTest.Fake(routes, seen).use { f ->
            val a = api(f.port)
            assertEquals(1, a.conversations().conversations.size)
            a.conversation("fc_abcdefghijklmnop")
            a.conversationMessages("fc_abcdefghijklmnop", limit = 20, cursor = 9)
            a.conversationMessage("fc_abcdefghijklmnop", "fm_aaaaaaaaaaaaaaaa")
            a.sendConversationMessage(
                "fc_abcdefghijklmnop", "hi", listOf(ConversationMention("agent", "agent:helper", 0, 7)),
                replyTo = "fm_bbbbbbbbbbbbbbbb", media = listOf("fbm_1"), clientId = "c1",
            )
            a.markConversationRead("fc_abcdefghijklmnop", 9)
            a.stopConversation("fc_abcdefghijklmnop")
            a.resumeConversation("fc_abcdefghijklmnop")
            a.answerRequest("helper", "fc_abcdefghijklmnop", "frq_aaaaaaaaaaaaaaaa", buildJsonObject { put("choice", "deny") })
            a.conversationPreferences("fc_abcdefghijklmnop", dev.foxfleet.app.data.ConversationPreferences(muted = true, notify = "mentions"))
        }
        val paths = seen.map { it.split(" ").take(2).joinToString(" ") }
        assertTrue(paths.any { it.startsWith("GET /api/conversations?limit=50&offset=0") })
        assertTrue(paths.contains("GET /api/conversations/fc_abcdefghijklmnop/messages?limit=20&cursor=9"))
        assertTrue(paths.contains("POST /api/conversations/fc_abcdefghijklmnop/messages"))
        assertTrue(paths.contains("POST /api/conversations/fc_abcdefghijklmnop/stop"))
        assertTrue(paths.contains("POST /api/conversations/fc_abcdefghijklmnop/resume"))
        // An owner card is answered as its member agent and addressed by the room id: the same hub route the web client uses.
        assertTrue(paths.contains("POST /api/agents/helper/native/sessions/fc_abcdefghijklmnop/requests/frq_aaaaaaaaaaaaaaaa"))
        val send = seen.first { it.startsWith("POST /api/conversations/fc_abcdefghijklmnop/messages ") }
        assertTrue(send.contains("\"mentions\":[{\"kind\":\"agent\",\"id\":\"agent:helper\",\"offset\":0,\"length\":7}]"))
        assertTrue(send.contains("\"reply_to\":\"fm_bbbbbbbbbbbbbbbb\""))
        assertTrue(send.contains("\"media\":[\"fbm_1\"]"))
        val body = send.split(" ", limit = 3)[2]
        assertFalse(body.contains("\"actor\"")); assertFalse(body.contains("\"admit\""))
    }
}
