package dev.foxfleet.app.data.live

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.local.CacheDb
import dev.foxfleet.app.data.local.ChatCache
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

/** The event reducer over the real Room cache (in memory): placement by n, idempotency, gaps, status, rows, totals. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveReducerTest {
    private lateinit var db: CacheDb
    private lateinit var cache: ChatCache
    private lateinit var reducer: LiveReducer

    @Before fun open() { db = CacheDb.build(ApplicationProvider.getApplicationContext(), name = null); cache = ChatCache(db, "o"); reducer = LiveReducer(cache) }
    @After fun close() { db.close() }

    private fun ui(n: Int, role: String = "assistant", status: String? = null) = UiMessage(role, "text $n", id = "u$n", ts = n * 1000L, hubId = "h$n", n = n, status = status)
    private fun hm(n: Int, role: String = "assistant", text: String = "text $n", status: String? = null) =
        HubMessage("h$n", "u$n", n, role, text, false, n * 1000L, "agent", status, null, null, null, emptyList())
    private fun row(agent: String, unread: Int = 0, archived: Boolean = false, muted: Boolean = false) =
        HubChat(agent, agent.uppercase(), "hermes", "c", LastMessage("h1", "assistant", agent, "hi", 1L, null), unread, 0, archived, muted, null, false, null, false, false, false, 1L)
    private suspend fun seedNumbered(upTo: Int) = cache.saveNewest("nova", "c", (1..upTo).map { ui(it) }, hasMore = false)
    private suspend fun texts() = cache.open("nova", "c", 500)!!.messages.map { it.content }

    @Test fun messageNewAppendsNextNumberAndIsIdempotent() = runBlocking {
        seedNumbered(3)
        val e = V2Event.MessageNew(10, "nova", "c", hm(4))
        val fx = reducer.apply(e); reducer.apply(e)
        assertEquals(listOf("text 1", "text 2", "text 3", "text 4"), texts())
        assertTrue(fx.any { it is LiveEffect.Upserted }); assertTrue(fx.none { it is LiveEffect.FetchAfter })
        assertTrue("the agent's message ends its typing", fx.any { it is LiveEffect.StopTyping })
    }

    @Test fun messageBeyondTheNextNumberAsksForAfterN() = runBlocking {
        seedNumbered(3)
        val fx = reducer.apply(V2Event.MessageNew(10, "nova", "c", hm(7)))
        assertEquals(LiveEffect.FetchAfter("nova", "c", 3), fx.filterIsInstance<LiveEffect.FetchAfter>().single())
        assertEquals(3, texts().size)
    }

    @Test fun unnumberedOrUncachedChatsAreLeftToThePageLoad() = runBlocking {
        cache.saveNewest("nova", "c", listOf(UiMessage("user", "old", id = "x")), false) // cached before the hub numbered messages
        val fx = reducer.apply(V2Event.MessageNew(10, "nova", "c", hm(2)))
        assertEquals(listOf("old"), texts()); assertTrue(fx.none { it is LiveEffect.FetchAfter })
        reducer.apply(V2Event.MessageNew(11, "nova", "other", hm(1)))
        assertNull(cache.open("nova", "other"))
    }

    @Test fun editedReplacesByHubId() = runBlocking {
        seedNumbered(2)
        reducer.apply(V2Event.MessageEdited(11, "nova", "c", hm(2, text = "final text")))
        assertEquals(listOf("text 1", "final text"), texts())
    }

    @Test fun statusOnlyMovesForward() = runBlocking {
        cache.saveNewest("nova", "c", listOf(ui(1, "user", "sent")), false)
        reducer.apply(V2Event.MessageStatusChanged(1, "nova", "c", listOf("h1"), "read"))
        reducer.apply(V2Event.MessageStatusChanged(2, "nova", "c", listOf("h1"), "delivered")) // late, older news
        assertEquals("read", cache.open("nova", "c")!!.messages.single().status)
        assertEquals("failed", MessageStatus.advance("sent", "failed")); assertEquals("read", MessageStatus.advance("read", "failed"))
    }

    @Test fun deletedRemovesForMe() = runBlocking {
        seedNumbered(3)
        reducer.apply(V2Event.MessageDeleted(5, "nova", "c", listOf("h2")))
        assertEquals(listOf("text 1", "text 3"), texts())
        // numbers stay: the next message is still n = 4
        reducer.apply(V2Event.MessageNew(6, "nova", "c", hm(4)))
        assertEquals(listOf("text 1", "text 3", "text 4"), texts())
    }

    @Test fun chatUpdatedReplacesTheRowAndReadUpdatesItAndTotals() = runBlocking {
        reducer.apply(V2Event.ChatUpdated(1, row("nova", unread = 4)))
        reducer.apply(V2Event.ChatUpdated(2, row("nova", unread = 5)))
        assertEquals(5, cache.chatRow("nova")!!.unread)
        val fx = reducer.apply(V2Event.Read(3, "nova", "c", ReadState("c", 9, 0, 0, 2)))
        assertEquals(0, cache.chatRow("nova")!!.unread); assertEquals(9, cache.chatRow("nova")!!.readUpTo); assertEquals(2, cache.sync()!!.totalUnread)
        assertTrue(fx.contains(LiveEffect.ListChanged))
        reducer.apply(V2Event.ChatRemoved(4, "nova")); assertNull(cache.chatRow("nova"))
    }

    @Test fun runAndApprovalBecomeNoticesAndUnknownIsIgnored() = runBlocking {
        assertEquals(LiveEffect.Notice("run_started", "nova", "c", "r1", null), reducer.apply(V2Event.RunStarted(1, "nova", "c", "r1")).single())
        assertTrue(reducer.apply(V2Event.RunFinished(2, "nova", "c", "r1", "done")).contains(LiveEffect.StopTyping("nova", "c")))
        assertTrue(reducer.apply(V2Event.Unknown(3, "poll.created", "nova", "c")).isEmpty())
    }

    @Test fun numberedPagesUseNAsOrderSoLiveAndPagesJoin() = runBlocking {
        cache.saveNewest("nova", "c", listOf(ui(5), ui(6)), hasMore = true)
        cache.saveOlder("nova", "c", listOf(ui(3), ui(4)), hasMore = false, offset = 80)
        reducer.apply(V2Event.MessageNew(1, "nova", "c", hm(7)))
        assertEquals((3..7).map { "text $it" }, texts())
        assertTrue(cache.numbered("nova", "c")); assertEquals(7, cache.maxN("nova", "c"))
        assertFalse(cache.numbered("nova", "none"))
    }
}
