package dev.foxfleet.app.rooms

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.ChatBackgroundStore
import dev.foxfleet.app.data.ChatBg
import dev.foxfleet.app.data.Conversation
import dev.foxfleet.app.data.ConversationMedia
import dev.foxfleet.app.data.ConversationMember
import dev.foxfleet.app.data.ConversationMention
import dev.foxfleet.app.data.ConversationMessage
import dev.foxfleet.app.data.local.CacheDb
import dev.foxfleet.app.data.local.CacheOwner
import dev.foxfleet.app.data.local.ChatCache
import dev.foxfleet.app.data.local.ConversationCodec
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files

/** Cache v5 is additive: DMs survive the 4→5 migration, while rooms are keyed by account + fc id. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConversationCacheTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val dir = listOf("schemas", "app/schemas").map { File(it, CacheDb::class.java.name) }.first { it.isDirectory }
    private lateinit var db: CacheDb

    private fun schema(v: Int) = Json.parseToJsonElement(File(dir, "$v.json").readText()).jsonObject["database"]!!.jsonObject

    private fun createFromSchema(name: String, v: Int) {
        val file = context.getDatabasePath(name).also { it.parentFile?.mkdirs(); it.delete() }
        val s = schema(v)
        SQLiteDatabase.openOrCreateDatabase(file, null).use { d ->
            for (e in s["entities"]!!.jsonArray) {
                val t = e.jsonObject; val table = t["tableName"]!!.jsonPrimitive.content
                d.execSQL(t["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                t["indices"]?.jsonArray?.forEach { i -> d.execSQL(i.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table)) }
            }
            s["setupQueries"]?.jsonArray?.forEach { d.execSQL(it.jsonPrimitive.content) }
            d.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '${s["identityHash"]!!.jsonPrimitive.content}')")
            d.version = v
        }
    }

    private val owner = ConversationMember("u1", "Ada", "human", false)
    private fun room(id: String = "fc_abcdefghijklmnop", title: String = "Launch room", paused: Boolean = false) = Conversation(
        id = id, threadId = "fcr_" + id.removePrefix("fc_"), title = title, owner = owner,
        members = listOf(ConversationMember("agent:helper", "helper", "agent", true), ConversationMember("agent:reviewer", "reviewer", "agent", true)),
        createdAt = 1_000L, updatedAt = 2_000L, unreadCount = 2, lastMessageAt = 2_000L, paused = paused, epoch = 3L,
    )
    private fun message(id: String = "fm_aaaaaaaaaaaaaaaa", roomId: String = "fc_abcdefghijklmnop", sender: ConversationMember = ConversationMember("agent:helper", "helper", "agent", true), seq: Int = 1) =
        ConversationMessage(id = id, conversationId = roomId, sender = sender, text = "@reviewer look", createdAt = 1_500L + seq, seq = seq,
            mentions = listOf(ConversationMention("agent", "agent:reviewer", 0, 10)), media = listOf(ConversationMedia("fbm_1", "image", "image/png", "shot.png", 42)))

    @After fun close() { if (::db.isInitialized) db.close() }

    @Test fun v4DmCacheSurvivesTheAdditiveV5Migration() = runBlocking {
        createFromSchema("rooms-keep.db", 4)
        SQLiteDatabase.openDatabase(context.getDatabasePath("rooms-keep.db").path, null, SQLiteDatabase.OPEN_READWRITE).use { d ->
            d.execSQL("INSERT INTO agents (owner,name,position,online,chat_ready,management_ready,active_sessions,kind,label,description,caps,registry_order,last_activity_at,last_session_title,last_message_preview,last_role,pin_order,working,needs_input) VALUES ('o','nova',0,1,1,0,NULL,'hermes','Nova','','chat',0,NULL,NULL,NULL,NULL,NULL,0,0)")
            d.execSQL("INSERT INTO chats (owner,agent,chat_id,title,updated,preview,messages) VALUES ('o','nova','c','Kept chat',7,'kept dm',1)")
            d.execSQL("INSERT INTO messages (owner,agent,chat_id,msg_key,hub_id,ord,ts,role,content,reasoning,steps,images,kind,live_id,n,status) VALUES ('o','nova','c','h:h1','m1',1,5,'user','kept dm','','','','user','h1',1,'read')")
            d.execSQL("INSERT INTO sync_state (owner,cursor,total_unread,total_unread_all,synced_at) VALUES ('o','s1:7',3,4,1)")
            d.execSQL("INSERT INTO reactions (owner,agent,chat_id,snapshot,synced_at) VALUES ('o','nova','c','{}',1)")
        }
        assertEquals(5, CacheDb.VERSION)
        val expected = schema(5)["entities"]!!.jsonArray.map { it.jsonObject }
            .filter { it["tableName"]!!.jsonPrimitive.content in setOf("conversations", "conversation_messages") }
            .flatMap { e ->
                val table = e["tableName"]!!.jsonPrimitive.content
                listOf(e["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table)) +
                    (e["indices"]?.jsonArray?.map { i -> i.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table) }.orEmpty())
            }
        assertEquals(expected.toSet(), CacheDb.MIGRATION_4_5_SQL.toSet())
        db = CacheDb.build(context, "rooms-keep.db", destructive = false)
        try {
            val cache = ChatCache(db, "o")
            // Row counts and keys, not just "it opened": the DM chat row and its message are all still there.
            assertEquals(1, db.chatList().chats("o", "nova", 10).size)
            assertEquals(1, db.messages().count("o", "nova", "c"))
            assertEquals(listOf("h:h1"), db.messages().keys("o", "nova", "c"))
            val keptChat = cache.chats("nova").single()
            assertEquals("c", keptChat.id); assertEquals("Kept chat", keptChat.title)
            assertEquals("kept dm", keptChat.preview); assertEquals(1, keptChat.messages)
            val keptMessage = cache.open("nova", "c")!!.messages.single()
            assertEquals("kept dm", keptMessage.content); assertEquals("m1", keptMessage.id); assertEquals("h1", keptMessage.hubId)
            assertEquals("s1:7", cache.sync()!!.cursor)
            assertTrue(cache.agents().any { it.name == "nova" })
            assertTrue(cache.conversations().isEmpty())
            assertNull(cache.roomNewest("fc_abcdefghijklmnop"))
        } finally { db.close() }
    }

    @Test fun roomsAreKeyedByAccountAndRoomNotByAnAgent() = runBlocking {
        db = CacheDb.build(context, name = null)
        val a = ChatCache(db, "owner-a")
        a.saveConversation(room())
        a.upsertRoomMessage(message())
        val b = ChatCache(db, "owner-b")
        assertTrue(b.conversations().isEmpty())
        assertNull(b.roomNewest("fc_abcdefghijklmnop"))
        // The same fc id is a different row for another account.
        b.saveConversation(room(title = "Ops night"))
        assertEquals("Launch room", a.conversation("fc_abcdefghijklmnop")!!.title)
        assertEquals("Ops night", b.conversation("fc_abcdefghijklmnop")!!.title)
        assertEquals(2, a.conversation("fc_abcdefghijklmnop")!!.unreadCount)
    }

    @Test fun roomTranscriptKeepsAuthorMentionsReplyAndMedia() = runBlocking {
        db = CacheDb.build(context, name = null)
        val cache = ChatCache(db, "o")
        cache.saveConversation(room())
        val helper = message(seq = 1)
        val reviewer = message(id = "fm_bbbbbbbbbbbbbbbb", sender = ConversationMember("agent:reviewer", "reviewer", "agent", true), seq = 2).copy(replyTo = helper.id)
        cache.upsertRoomMessages(listOf(helper, reviewer))
        val page = cache.roomNewest("fc_abcdefghijklmnop")!!
        assertEquals(listOf("helper", "reviewer"), page.messages.map { it.sender.name })
        assertEquals(helper.id, page.messages[1].replyTo)
        assertEquals(listOf("shot.png"), page.messages[0].media.map { it.name })
        assertEquals(ConversationMention("agent", "agent:reviewer", 0, 10), page.messages[0].mentions.single())
        assertFalse(page.hasMore)
        assertEquals(1, cache.roomNewest("fc_abcdefghijklmnop", limit = 1)!!.messages.size)
        assertTrue(cache.roomNewest("fc_abcdefghijklmnop", limit = 1)!!.hasMore)
    }

    @Test fun roomJsonColumnsRoundTripMembersMentionsAndMedia() {
        val members = room().members
        assertEquals(members.map { it.name to it.id }, ConversationCodec.parseMembers(ConversationCodec.members(members)).map { it.name to it.id })
        val mentions = listOf(ConversationMention("agent", "agent:helper", 3, 7))
        assertEquals(mentions, ConversationCodec.parseMentions(ConversationCodec.mentions(mentions)))
        val media = listOf(ConversationMedia("fbm_1", "file", "text/plain", "notes.txt", 12))
        assertEquals(media, ConversationCodec.parseMedia(ConversationCodec.media(media)))
    }

    @Test fun signOutWipeRemovesRoomsButAnAccountSwitchCannotLeakThem() = runBlocking {
        db = CacheDb.build(context, name = null)
        val cache = ChatCache(db, "o")
        cache.saveConversation(room()); cache.upsertRoomMessage(message())
        db.admin().wipeAll()
        assertTrue(cache.conversations().isEmpty()); assertNull(cache.roomNewest("fc_abcdefghijklmnop"))
    }

    @Test fun cacheOwnerClaimStillForcesTheWipeOnAnAccountSwitchAndSignOut() = runBlocking {
        val prefs = context.getSharedPreferences("cache-owner-${System.nanoTime()}", Context.MODE_PRIVATE)
        val owner = CacheOwner(prefs)
        db = CacheDb.build(context, name = null)
        val cache = ChatCache(db, "owner-a")
        cache.saveConversation(room()); cache.upsertRoomMessage(message())
        assertFalse(owner.claim("a@hub", "owner-a", "https://hub")) // first claim owns what is already there
        assertFalse(owner.claim("a@hub", "owner-a", "https://hub")) // same account: no wipe
        assertEquals(1, cache.conversations().size)
        // The caller wipes exactly when claim says the owner changed (HubViewModel's claimCache).
        if (owner.claim("b@hub", "owner-b", "https://hub")) db.admin().wipeAll()
        assertTrue(cache.conversations().isEmpty()); assertNull(cache.roomNewest("fc_abcdefghijklmnop"))
        // Sign-out forgets the owner and the cache (it holds message text), so a later offline start cannot reopen it.
        cache.saveConversation(room()); cache.upsertRoomMessage(message())
        owner.forget(); db.admin().wipeAll()
        assertNull(owner.key); assertNull(owner.offlineOwner("https://hub"))
        assertTrue(cache.conversations().isEmpty()); assertNull(cache.roomNewest("fc_abcdefghijklmnop"))
    }

    @Test fun roomBackgroundKeyNeverLandsOnAMemberAgentsDm() {
        val prefs = context.getSharedPreferences("bg-room-${System.nanoTime()}", Context.MODE_PRIVATE)
        val store = ChatBackgroundStore(prefs, Files.createTempDirectory("roombg").toFile())
        val helper = store.key("helper")
        val reviewer = store.key("reviewer")
        val group = store.roomKey("fc_abcdefghijklmnop")
        assertNotEquals(helper, group); assertNotEquals(reviewer, group)
        assertTrue(store.isRoomKey(group)); assertFalse(store.isRoomKey(helper))
        // Give both member agents a DM look first, then write the room look: their raw prefs must not move.
        store.save(helper, ChatBg.normalize("Pattern", "sky", "paws", 0, 0.1f, false))
        store.save(reviewer, ChatBg.normalize("Solid", "sand", null, 0, 0.3f, false))
        val helperPref = prefs.getString("bg.$helper", null)
        val reviewerPref = prefs.getString("bg.$reviewer", null)
        store.save(group, ChatBg.normalize("Solid", "sage", null, 0, 0.2f, false))
        assertEquals(helperPref, prefs.getString("bg.$helper", null))
        assertEquals(reviewerPref, prefs.getString("bg.$reviewer", null))
        assertEquals("paws", store.load(helper).pattern); assertEquals("sand", store.load(reviewer).solid)
        // The room lives under its own prefix and on its own key, never under an agent key.
        assertEquals(setOf("bg.$helper", "bg.$reviewer", "bg.$group"), prefs.all.keys)
        assertEquals("sage", store.load(group).solid)
        store.reset(group)
        assertEquals(ChatBg(), store.load(group)); assertEquals("paws", store.load(helper).pattern); assertEquals("sand", store.load(reviewer).solid)
    }
}
