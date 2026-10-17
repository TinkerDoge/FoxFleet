package dev.foxfleet.app.data.local

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.MessageKeys
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.UiMessage
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Room cache on an in-memory database: DAO queries, the repository's page joins, owner isolation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatCacheTest {
    private lateinit var db: CacheDb
    private lateinit var cache: ChatCache

    @Before fun open() { db = CacheDb.build(ApplicationProvider.getApplicationContext(), name = null); cache = ChatCache(db, "owner-a", now = { 42L }) }
    @After fun close() { db.close() }

    private fun msg(i: Int, role: String = if (i % 2 == 0) "user" else "assistant") = UiMessage(role, "message $i", id = "m$i", ts = 1_000L * i)
    /** The hub's page at [offset] counted back from the newest of [total] messages (chronological), like GET …/messages. */
    private fun hubPage(total: Int, offset: Int, limit: Int = 80): Pair<List<UiMessage>, Boolean> {
        val end = total - offset; val start = maxOf(0, end - limit)
        return (start until end).map { msg(it) } to (start > 0)
    }

    @Test fun agentsRoundTripInOrderWithCapabilities() = runBlocking {
        val caps = Capabilities(chat = true, images = true, sessions = true, busy = listOf("queue", "interrupt"), reactions = true)
        val a = AgentStatus("Atlas", online = true, chatReady = true, managementReady = false, capabilities = caps, pinOrder = 0, lastMessagePreview = "hi", working = true)
        val b = AgentStatus("Bolt", online = false, chatReady = false, managementReady = false)
        cache.saveAgents(listOf(a, b))
        assertEquals(listOf(a, b), cache.agents())
        cache.saveAgents(listOf(b)) // replaced, not merged: a removed agent leaves the list
        assertEquals(listOf("Bolt"), cache.agents().map { it.name })
    }

    @Test fun chatListFirstPageReplacedNewestFirst() = runBlocking {
        cache.saveChats("Atlas", listOf(SessionInfo("s1", "One", 10, "a", 2), SessionInfo("s2", "Two", 20, "b", 3)))
        assertEquals(listOf("s2", "s1"), cache.chats("Atlas").map { it.id })
        cache.saveChats("Atlas", listOf(SessionInfo("s3", null, 30, "c", 1)))
        assertEquals(listOf("s3"), cache.chats("Atlas").map { it.id })
    }

    @Test fun newestPageRoundTripsWithStepsAndImages() = runBlocking {
        val rich = UiMessage("assistant", "done", id = "r1", reasoning = "think", steps = listOf(ToolStep("bash", "ls", "ok", true)), ts = 5, imageUrls = listOf("https://x/y.png"))
        cache.saveNewest("Atlas", "s1", listOf(msg(0), rich), hasMore = true)
        val c = cache.open("Atlas", "s1")!!
        assertEquals(listOf(msg(0), rich), c.messages)
        assertTrue(c.hasOlder); assertEquals(CACHE_PAGE, c.olderOffset)
        assertNull(cache.open("Atlas", "other"))
    }

    @Test fun overlappingNewestPageKeepsOlderRowsAndShiftsHubOffset() = runBlocking {
        val (p0, more0) = hubPage(200, 0); cache.saveNewest("A", "s", p0, more0)
        val (p1, more1) = hubPage(200, 80); cache.saveOlder("A", "s", p1, more1, offset = 80)
        assertEquals(160, cache.hubCursor("A", "s")!!.first)
        // three new messages arrived: the newest page now starts 3 later, and the hub's next older page starts 3 further back
        val (p2, more2) = hubPage(203, 0).let { (l, m) -> l to m }
        // the newest page of 203 starts at message 123, which is cached (anchor found)
        cache.saveNewest("A", "s", p2, more2)
        assertEquals(163, cache.hubCursor("A", "s")!!.first)
        val all = db.messages().newest("owner-a", "A", "s", 1000).asReversed().map { it.content }
        assertEquals((40 until 203).map { "message $it" }, all)
    }

    @Test fun disjointNewestPageReplacesTheChat() = runBlocking {
        cache.saveNewest("A", "s", (0 until 10).map { msg(it) }, false)
        cache.saveNewest("A", "s", (500 until 505).map { msg(it) }, true)
        assertEquals((500 until 505).map { msg(it) }, cache.open("A", "s")!!.messages)
        assertEquals(CACHE_PAGE, cache.hubCursor("A", "s")!!.first)
    }

    @Test fun keysetOlderPagesWalkBackChronologically() = runBlocking {
        val (p0, m0) = hubPage(200, 0); cache.saveNewest("A", "s", p0, m0)
        val (p1, m1) = hubPage(200, 80); cache.saveOlder("A", "s", p1, m1, 80)
        val (p2, m2) = hubPage(200, 160); cache.saveOlder("A", "s", p2, m2, 160)
        val first = cache.open("A", "s", limit = 50)!!
        assertEquals((150 until 200).map { msg(it) }, first.messages)
        val older = cache.olderThan("A", "s", MessageKeys.keys(first.messages).first(), limit = 100)!!
        assertEquals((50 until 150).map { msg(it) }, older.messages); assertTrue(older.moreOnDevice)
        val last = cache.olderThan("A", "s", MessageKeys.keys(older.messages).first(), limit = 100)!!
        assertEquals((0 until 50).map { msg(it) }, last.messages); assertFalse(last.moreOnDevice); assertFalse(last.hubHasOlder)
        assertNull(cache.olderThan("A", "s", "id:m0"))
    }

    @Test fun olderPageWithNothingToJoinIsNotStored() = runBlocking {
        cache.saveOlder("A", "s", listOf(msg(1)), true, 80)
        assertNull(cache.open("A", "s"))
    }

    @Test fun repeatedOlderPageSkipsKnownRows() = runBlocking {
        val (p0, m0) = hubPage(100, 0); cache.saveNewest("A", "s", p0, m0)
        val (p1, m1) = hubPage(100, 80); cache.saveOlder("A", "s", p1, m1, 80); cache.saveOlder("A", "s", p1, m1, 80)
        assertEquals(100, db.messages().count("owner-a", "A", "s"))
    }

    @Test fun ownersAreIsolatedAndWipeClearsEverything() = runBlocking {
        cache.saveNewest("A", "s", listOf(msg(1)), false)
        cache.saveAgents(listOf(AgentStatus("A", true, true, true)))
        val other = ChatCache(db, "owner-b")
        assertNull(other.open("A", "s")); assertTrue(other.agents().isEmpty())
        db.admin().wipeAll()
        assertNull(cache.open("A", "s")); assertTrue(cache.agents().isEmpty())
    }

    @Test fun forgetChatDropsRowsAndMeta() = runBlocking {
        cache.saveChats("A", listOf(SessionInfo("s", "t", 1, "p", 1)))
        cache.saveNewest("A", "s", listOf(msg(1)), true)
        cache.forgetChat("A", "s")
        assertNull(cache.open("A", "s")); assertNull(cache.hubCursor("A", "s")); assertTrue(cache.chats("A").isEmpty())
    }

    @Test fun messageIndicesCoverChatAndTime() {
        val names = db.openHelper.readableDatabase.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").use { c ->
            buildList { while (c.moveToNext()) add(c.getString(1).orEmpty()) }
        }
        assertTrue(names.toString(), names.any { it.contains("`chat_id`, `ts`") })
        assertTrue(names.toString(), names.any { it.contains("UNIQUE") && it.contains("`msg_key`") })
        assertTrue(names.toString(), names.any { it.contains("`ord`") })
    }

    // ---- cache first, then network ----

    @Test fun cacheThenNetworkEmitsCachedThenFreshAndWrites() = runBlocking {
        var written: String? = null
        val out = cacheThenNetwork({ "saved" }, { "fresh" }, { written = it }).toList()
        assertEquals(listOf(Load.Cached("saved"), Load.Fresh("fresh")), out); assertEquals("fresh", written)
    }

    @Test fun cacheThenNetworkFailureKeepsCache() = runBlocking {
        val out = cacheThenNetwork({ "saved" }, { throw java.io.IOException("down") }, {}).toList()
        assertEquals(Load.Cached("saved"), out[0]); assertTrue((out[1] as Load.Failed).hadCache)
        val none = cacheThenNetwork<String>({ null }, { throw java.io.IOException("down") }, {}).toList()
        assertEquals(1, none.size); assertFalse((none[0] as Load.Failed).hadCache)
    }

    @Test(expected = dev.foxfleet.app.data.AuthRequiredException::class)
    fun cacheThenNetworkRethrowsAuth() { runBlocking { cacheThenNetwork({ "saved" }, { throw dev.foxfleet.app.data.AuthRequiredException() }, {}).toList() } }
}
