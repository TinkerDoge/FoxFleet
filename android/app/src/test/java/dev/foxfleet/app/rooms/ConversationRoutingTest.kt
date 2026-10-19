package dev.foxfleet.app.rooms

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.Route
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.Conversation
import dev.foxfleet.app.data.ConversationMember
import dev.foxfleet.app.data.ConversationMentions
import dev.foxfleet.app.data.ConversationMessage
import dev.foxfleet.app.data.ConversationOrder
import dev.foxfleet.app.data.ConversationRepository
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.NativeChatTest
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.depth
import dev.foxfleet.app.data.live.Contract
import dev.foxfleet.app.data.live.LiveEffect
import dev.foxfleet.app.data.live.LiveReducer
import dev.foxfleet.app.data.live.V2Event
import dev.foxfleet.app.data.local.CacheDb
import dev.foxfleet.app.data.local.ChatCache
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Rooms are a separate route, a separate list and a separate cache namespace from DMs. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConversationRoutingTest {
    private lateinit var db: CacheDb
    private val owner = ConversationMember("u1", "Ada", "human", false)
    private val members = listOf(ConversationMember("agent:helper", "helper", "agent", true), ConversationMember("agent:reviewer", "reviewer", "agent", true))
    private fun room(id: String, title: String, activity: Long) = Conversation(
        id = id, threadId = "fcr_" + id.removePrefix("fc_"), title = title, owner = owner, members = members,
        createdAt = 1, updatedAt = activity, lastMessageAt = activity,
    )

    @After fun close() { if (::db.isInitialized) db.close() }

    @Test fun roomRoutesAreNotTheDmAgentRoute() {
        val fleet = Route.Fleet
        val rooms = Route.Conversations
        val room = Route.ConversationRoom("fc_abcdefghijklmnop")
        val dm = Route.Chat("helper")
        assertNotEquals(fleet, rooms); assertNotEquals(room, dm); assertTrue(room.id.startsWith("fc_"))
        assertFalse(room.details)
        assertEquals(2, room.depth()); assertEquals(1, rooms.depth())
        assertEquals(Route.ConversationRoom("fc_abcdefghijklmnop", details = true), room.copy(details = true))
    }

    @Test fun mentionsAreExplicitSpansAtWordBoundaries() {
        val text = "@helper and @reviewer, not @helperly"
        val spans = ConversationMentions.mentionsIn(text, members)
        assertEquals(listOf("agent:helper", "agent:reviewer"), spans.map { it.id })
        assertEquals(0, spans[0].offset); assertEquals(7, spans[0].length)
        assertEquals(text.indexOf("@reviewer"), spans[1].offset)
        assertFalse(spans.any { it.id == "agent:helperly" })
        // Same name twice, at both word boundaries.
        val twice = ConversationMentions.mentionsIn("@helper @helper", members)
        assertEquals(listOf(0, 8), twice.map { it.offset })
        // Email-like text is not a mention.
        assertTrue(ConversationMentions.mentionsIn("mail@helper", members).isEmpty())
    }

    @Test fun mentionIdsAreActorIdsNotDisplayNames() {
        val native = listOf(ConversationMember("agent:sumi-native", "Sumi", "agent", true))
        val spans = ConversationMentions.mentionsIn("@Sumi check this", native)
        assertEquals(listOf("agent:sumi-native"), spans.map { it.id })
        assertEquals(0, spans[0].offset)
        assertEquals(5, spans[0].length)
        assertEquals("agent:sumi-native", ConversationMentions.mentionsIn("@sumi too", native).single().id)
        assertTrue(ConversationMentions.mentionsIn("mail@Sumi", native).isEmpty())
    }

    @Test fun typedMentionTokenOnlyStartsAfterWhitespaceOrAtTheStart() {
        assertEquals(ConversationMentions.Token(0, "hel"), ConversationMentions.tokenAt("@hel", 4))
        assertEquals(ConversationMentions.Token(6, "rev"), ConversationMentions.tokenAt("hello @rev", 10))
        assertEquals(null, ConversationMentions.tokenAt("mail@hel", 8))
        assertEquals(null, ConversationMentions.tokenAt("@hel lo", 7))
        assertEquals(null, ConversationMentions.tokenAt("hello", 5))
    }

    @Test fun roomListOrdersByActivityThenTitle() {
        val sorted = ConversationOrder.sorted(listOf(room("fc_bbbbbbbbbbbbbbbb", "Bravo", 5), room("fc_aaaaaaaaaaaaaaaa", "Alpha", 9), room("fc_cccccccccccccccc", "Zulu", 5)))
        assertEquals(listOf("Alpha", "Bravo", "Zulu"), sorted.map { it.title })
    }

    @Test fun liveConversationEventsWriteTheRoomCacheAndEmitRoomEffects() = runBlocking {
        db = CacheDb.build(ApplicationProvider.getApplicationContext(), name = null)
        val cache = ChatCache(db, "o")
        val reducer = LiveReducer(cache)
        val r = room("fc_abcdefghijklmnop", "Launch room", 10)
        val created = Contract.event(Contract.obj("""{"seq":1,"type":"conversation.created","conversation":{"id":"${r.id}","thread_id":"${r.threadId}","chat_type":"group","title":"${r.title}","owner":{"id":"u1","name":"Ada","kind":"human","is_bot":false},"members":[{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true}],"created_at":1,"updated_at":10,"last_message_at":10}}""")!!)!!
        val createdEffects = reducer.apply(created)
        assertTrue(createdEffects.single() is LiveEffect.ConversationChanged)
        assertEquals("Launch room", cache.conversation(r.id)!!.title)

        val messageJson = """{"id":"fm_aaaaaaaaaaaaaaaa","conversation_id":"${r.id}","sender":{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true},"text":"On it","created_at":11,"seq":2}"""
        val new = Contract.event(Contract.obj("""{"seq":2,"type":"conversation.message.new","conversation_id":"${r.id}","message":$messageJson}""")!!)!!
        val effects = reducer.apply(new)
        val upserted = effects.filterIsInstance<LiveEffect.ConversationMessageUpserted>().single()
        assertEquals(r.id, upserted.conversationId); assertEquals("helper", upserted.message.sender.name)
        assertEquals(listOf("On it"), cache.roomNewest(r.id)!!.messages.map { it.text })

        // An agent author is never collapsed into one room-wide name.
        val reviewed = ConversationMessage("fm_bbbbbbbbbbbbbbbb", r.id, members[1], "Checked", 12, seq = 3)
        cache.upsertRoomMessage(reviewed)
        assertEquals(listOf("helper", "reviewer"), cache.roomNewest(r.id)!!.messages.map { it.sender.name })

        val deleted = Contract.event(Contract.obj("""{"seq":4,"type":"conversation.message.deleted","conversation_id":"${r.id}","message_id":"fm_aaaaaaaaaaaaaaaa"}""")!!)!!
        assertTrue(reducer.apply(deleted).single() is LiveEffect.ConversationMessageDeleted)
        assertEquals(listOf("Checked"), cache.roomNewest(r.id)!!.messages.map { it.text })
    }

    @Test fun repositoryWritesTheHubPageThroughToTheRoomCache() = runBlocking {
        db = CacheDb.build(ApplicationProvider.getApplicationContext(), name = null)
        val cache = ChatCache(db, "o")
        val seen = mutableListOf<String>()
        val message = """{"id":"fm_aaaaaaaaaaaaaaaa","conversation_id":"fc_abcdefghijklmnop","sender":{"id":"agent:helper","name":"helper","kind":"agent","is_bot":true},"text":"hi","created_at":5,"seq":1}"""
        NativeChatTest.Fake(mapOf("GET /api/conversations/fc_abcdefghijklmnop/messages" to Triple(200, "application/json", """{"messages":[$message],"has_more":true,"next_cursor":1}""")), seen).use { f ->
            val api = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:${f.port}" })
            val repo = ConversationRepository(api, cache)
            val page = repo.page("fc_abcdefghijklmnop")
            assertTrue(page.hasMore); assertEquals(1, page.nextCursor)
            assertEquals(listOf("hi"), cache.roomNewest("fc_abcdefghijklmnop")!!.messages.map { it.text })
            // The room's own columns, never the DM agent's: no agent named fc_… exists.
            assertTrue(db.chatList().agents("o").isEmpty())
            assertTrue(seen.single().startsWith("GET /api/conversations/fc_abcdefghijklmnop/messages"))
        }
    }
}
