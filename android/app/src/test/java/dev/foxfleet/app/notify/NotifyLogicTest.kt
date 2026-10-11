package dev.foxfleet.app.notify

import dev.foxfleet.app.data.AuthRequiredException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

private fun e(id: Long, type: NotifyType = NotifyType.ReplyFinished, agent: String? = "nova", chat: String? = "h_1", muted: Boolean = false, at: Long = 1_000_000L, req: String? = null, msg: String? = null) =
    NotifyEvent(id, type, agent, chat, type == NotifyType.Approval || type == NotifyType.Error, at, muted, requestId = req, message = msg)
private val all = NotifyCategory.entries.toSet()
private const val NOW = 1_000_000L

class NotifyPolicyTest {
    private fun d(ev: NotifyEvent, cats: Set<NotifyCategory> = all, mutes: List<MuteRule> = emptyList(), open: Boolean = false) = NotifyPolicy.decide(ev, cats, mutes, NOW, open)
    private val show = NotifyPolicy.Decision.Show
    private fun skip(w: NotifyPolicy.Drop) = NotifyPolicy.Decision.Skip(w)

    @Test fun plainReplyShows() = assertEquals(show, d(e(1)))
    @Test fun hubMutedNeverShows() { assertEquals(skip(NotifyPolicy.Drop.HubMuted), d(e(1, muted = true))); assertEquals(skip(NotifyPolicy.Drop.HubMuted), d(e(2, NotifyType.Test, null, null, muted = true))) }
    @Test fun testEventsShowWhateverTheCategories() = assertEquals(show, d(e(1, NotifyType.Test, null, null), cats = emptySet()))
    @Test fun categoriesAreHonoured() {
        assertEquals(skip(NotifyPolicy.Drop.CategoryOff), d(e(1), cats = all - NotifyCategory.Replies))
        assertEquals(skip(NotifyPolicy.Drop.CategoryOff), d(e(1, NotifyType.Error), cats = all - NotifyCategory.Errors))
        assertEquals(skip(NotifyPolicy.Drop.CategoryOff), d(e(1, NotifyType.Approval, req = "r"), cats = all - NotifyCategory.Approvals))
        assertEquals(show, d(e(1, NotifyType.Approval, req = "r"), cats = setOf(NotifyCategory.Approvals)))
    }
    @Test fun agentMuteHidesEverythingIncludingApprovals() {
        val m = listOf(MuteRule("nova", null, null))
        assertEquals(skip(NotifyPolicy.Drop.AgentMuted), d(e(1), mutes = m)); assertEquals(skip(NotifyPolicy.Drop.AgentMuted), d(e(2, NotifyType.Approval, req = "r"), mutes = m))
        assertEquals(show, d(e(3, agent = "other"), mutes = m))
    }
    @Test fun chatMuteHidesRepliesButApprovalsBreakThrough() {
        val m = listOf(MuteRule("nova", "h_1", NOW + 1000))
        assertEquals(skip(NotifyPolicy.Drop.ChatMuted), d(e(1), mutes = m)); assertEquals(skip(NotifyPolicy.Drop.ChatMuted), d(e(2, NotifyType.Error), mutes = m))
        assertEquals(show, d(e(3, NotifyType.Approval, req = "r"), mutes = m)); assertEquals(show, d(e(4, chat = "h_2"), mutes = m))
    }
    @Test fun expiredMutesDoNotApply() { assertEquals(show, d(e(1), mutes = listOf(MuteRule("nova", null, NOW - 1), MuteRule("nova", "h_1", NOW)))) }
    @Test fun openChatSuppressesEverythingExceptApprovals() {
        assertEquals(skip(NotifyPolicy.Drop.ChatOpen), d(e(1), open = true)); assertEquals(skip(NotifyPolicy.Drop.ChatOpen), d(e(2, NotifyType.Error), open = true))
        assertEquals(show, d(e(3, NotifyType.Approval, req = "r"), open = true))
    }
    @Test fun unknownTypesAreDropped() = assertEquals(skip(NotifyPolicy.Drop.Unknown), d(e(1, NotifyType.Other)))

    @Test fun replayKeepsTheNewestPerChatAndDropsOldOnes() {
        val old = NOW - 7 * 3600_000L
        val out = NotifyPolicy.coalesceReplay(listOf(e(1), e(2), e(3, chat = "h_2"), e(4, at = old), e(5, NotifyType.Test, null, null), e(6, NotifyType.Approval, req = "r1", at = old), e(7, NotifyType.Approval, req = "r2")), NOW)
        assertEquals(listOf(2L, 3L, 6L, 7L), out.map { it.id })
    }
}

class NotifyPermissionStateTest {
    @Test fun grantedWins() { assertEquals(PermissionState.Granted, PermissionState.of(34, true, false, false)); assertTrue(PermissionState.of(30, true, false, false).ok) }
    @Test fun neverAskedNeedsTheRequest() = assertEquals(PermissionState.NeedsRequest, PermissionState.of(34, false, false, false))
    @Test fun deniedOnceShowsTheRationale() = assertEquals(PermissionState.Denied, PermissionState.of(34, false, true, true))
    @Test fun dontAskAgainNeedsTheSystemSettings() = assertEquals(PermissionState.Blocked, PermissionState.of(34, false, true, false))
    @Test fun beforeAndroid13OffMeansSystemSettings() = assertEquals(PermissionState.Blocked, PermissionState.of(32, false, false, false))
}

class NotifyTargetTest {
    @Test fun roundTrips() {
        val t = NotifyTarget("ab12", "nova", "h_abc", "srq-1")
        assertEquals(t, NotifyTarget.parse(t.toUri())); assertEquals(NotifyTarget("ab12", "nova", "h_abc"), NotifyTarget.parse(NotifyTarget("ab12", "nova", "h_abc").toUri()))
    }
    @Test fun rejectsAnythingOddOrIncomplete() {
        listOf(null, "", "foxfleet://connect?hub=x", "foxfleet://chat?agent=a&chat=b", "foxfleet://chat?hub=h&agent=a%20b&chat=c", "https://chat?hub=h&agent=a&chat=c", "foxfleet://chat?hub=h&agent=a&chat=").forEach { assertNull(it, NotifyTarget.parse(it)) }
    }
}

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34])
class NotifyStoreTest {
    private fun store() = NotifyStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.app.Application>().getSharedPreferences("t" + System.nanoTime(), 0))
    @Test fun everythingIsPerAccountAndHub() {
        val s = store(); val a = NotifyBinding("h1", "ann"); val b = NotifyBinding("h1", "bob"); val c = NotifyBinding("h2", "ann")
        s.setEnabled(a, true); s.setLastId(a, 42); s.setCategory(a, NotifyCategory.Errors, false); s.setMutes(a, listOf(MuteRule("nova", null, null), MuteRule("nova", "h_1", 5L)))
        assertTrue(s.enabled(a)); assertFalse(s.enabled(b)); assertFalse(s.enabled(c))
        assertEquals(42L, s.lastId(a)); assertNull(s.lastId(b)); assertNull(s.lastId(c))
        assertEquals(setOf(NotifyCategory.Replies, NotifyCategory.Approvals), s.categories(a)); assertEquals(NotifyCategory.entries.toSet(), s.categories(b))
        assertEquals(2, s.mutes(a).size); assertTrue(s.mutes(b).isEmpty())
    }
    @Test fun clearForgetsOnePairOnly() {
        val s = store(); val a = NotifyBinding("h1", "ann"); val b = NotifyBinding("h1", "bob")
        listOf(a, b).forEach { s.setEnabled(it, true); s.setLastId(it, 9); s.setMutes(it, listOf(MuteRule("x", null, null))) }
        s.clear(a)
        assertFalse(s.enabled(a)); assertNull(s.lastId(a)); assertTrue(s.mutes(a).isEmpty()); assertTrue(s.enabled(b)); assertEquals(9L, s.lastId(b)); assertEquals(1, s.mutes(b).size)
    }
    @Test fun hubTokenIsSharedWithTheAppsSettingsKey() {
        val p = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.app.Application>().getSharedPreferences("tok" + System.nanoTime(), 0)
        val t = HubTokens(p, "h1"); assertNull(t.get()); t.set("a"); assertEquals("a", p.getString("token_h1", null)); t.set("b"); assertEquals("b", t.get()); t.set(""); assertEquals("b", t.get())
    }
}

private class FakeContent : NotifyContent {
    var reply: ReplyText? = ReplyText("All done, the build passed.", 5L); var request: RequestLookup = RequestLookup.Found("Run rm -rf build?"); var unread: List<Pair<String, String>> = emptyList()
    var failReply = false; var authGone = false; val fetched = ArrayList<String>()
    override suspend fun agentLabel(agent: String) = if (agent == "nova") "Nova" else agent
    override suspend fun lastReply(agent: String, chat: String): ReplyText? { fetched.add("reply:$agent:$chat"); if (authGone) throw AuthRequiredException(); if (failReply) throw java.io.IOException("x"); return reply }
    override suspend fun openRequest(agent: String, chat: String, requestId: String): RequestLookup { fetched.add("req:$requestId"); return request }
    override suspend fun unreadChats() = unread
}
private class FakeNotifier : Notifier {
    val posted = ArrayList<ChatNotice>(); var tests = 0
    override fun post(n: ChatNotice) { if (n.chat == "h_bad") throw IllegalStateException("boom"); posted.add(n) }
    override fun postTest() { tests++ }
    override fun clearChat(agent: String, chat: String?) {}
    override fun clearAll() {}
}

class NotifyDispatcherTest {
    private fun d(c: FakeContent, n: FakeNotifier, cats: Set<NotifyCategory> = all, mutes: List<MuteRule> = emptyList(), open: Boolean = false) =
        NotifyDispatcher("h1", c, n, { cats }, { mutes }, { _, _ -> open }, { NOW })

    @Test fun replyIsBuiltFromFetchedContentNotFromTheEvent() = runTest {
        val c = FakeContent(); val n = FakeNotifier(); d(c, n).onEvents(listOf(e(1)), false)
        val p = n.posted.single(); assertEquals("Nova", p.agentLabel); assertEquals("All done, the build passed.", p.text); assertEquals(listOf("reply:nova:h_1"), c.fetched)
    }
    @Test fun aFailedFetchStillNotifiesWithAPlainLine() = runTest {
        val c = FakeContent().apply { failReply = true }; val n = FakeNotifier(); d(c, n).onEvents(listOf(e(1)), false)
        assertNull(n.posted.single().text)
    }
    @Test fun lostLoginPropagatesSoTheServiceCanSignOut() = runTest {
        val c = FakeContent().apply { authGone = true }; val n = FakeNotifier()
        try { d(c, n).onEvents(listOf(e(1)), false); fail() } catch (_: AuthRequiredException) {}
    }
    @Test fun mutedCategoryAndOpenChatDoNotFetchAnything() = runTest {
        val c = FakeContent(); val n = FakeNotifier()
        d(c, n, mutes = listOf(MuteRule("nova", null, null))).onEvents(listOf(e(1)), false)
        d(c, n, open = true).onEvents(listOf(e(2)), false)
        d(c, n, cats = all - NotifyCategory.Replies).onEvents(listOf(e(3)), false)
        assertTrue(n.posted.isEmpty()); assertTrue(c.fetched.isEmpty())
    }
    @Test fun approvalShowsEvenInAnOpenChatAndUsesTheOpenRequest() = runTest {
        val c = FakeContent(); val n = FakeNotifier(); d(c, n, open = true).onEvents(listOf(e(1, NotifyType.Approval, req = "srq-1")), false)
        val p = n.posted.single(); assertEquals("Run rm -rf build?", p.text); assertEquals("srq-1", p.requestId)
    }
    @Test fun anApprovalThatIsAlreadyAnsweredIsNotShown() = runTest {
        val c = FakeContent().apply { request = RequestLookup.Gone }; val n = FakeNotifier(); d(c, n).onEvents(listOf(e(1, NotifyType.Approval, req = "srq-1")), true)
        assertTrue(n.posted.isEmpty())
    }
    @Test fun anApprovalWhenTheHubIsUnreachableStillShowsAPlainLine() = runTest {
        val c = FakeContent().apply { request = RequestLookup.Unknown }; val n = FakeNotifier(); d(c, n).onEvents(listOf(e(1, NotifyType.Approval, req = "srq-1")), false)
        assertNull(n.posted.single().text)
    }
    @Test fun errorUsesTheFixedSentence() = runTest {
        val n = FakeNotifier(); d(FakeContent(), n).onEvents(listOf(e(1, NotifyType.Error, msg = "The agent turn failed")), false)
        assertEquals("The agent turn failed", n.posted.single().text)
    }
    @Test fun testEventPostsTheTestNotificationUnlessMuted() = runTest {
        val n = FakeNotifier(); val x = d(FakeContent(), n)
        x.onEvents(listOf(e(1, NotifyType.Test, null, null), e(2, NotifyType.Test, null, null, muted = true)), false); assertEquals(1, n.tests)
    }
    @Test fun replayCollapsesToOneNotificationPerChat() = runTest {
        val c = FakeContent(); val n = FakeNotifier(); d(c, n).onEvents(listOf(e(1), e(2), e(3), e(4, chat = "h_2")), true)
        assertEquals(listOf("h_1", "h_2"), n.posted.map { it.chat }); assertEquals(2, c.fetched.size)
    }
    @Test fun aGapResyncsFromTheHubInsteadOfTrustingTheStream() = runTest {
        val c = FakeContent().apply { unread = listOf("nova" to "h_9", "echo" to "h_3") }; val n = FakeNotifier()
        d(c, n, mutes = listOf(MuteRule("echo", null, null))).onGap(NotifyFrame.Gap(400, 503))
        assertEquals(listOf("h_9"), n.posted.map { it.chat }) // echo is muted, nova is shown
    }
}

class NotifyPoisonEventTest {
    private fun d(n: FakeNotifier, skipped: MutableList<Long>) = NotifyDispatcher("h1", FakeContent(), n, { all }, { emptyList() }, { _, _ -> false }, { NOW }, { id, _ -> skipped.add(id) })

    @Test fun anEventThatCannotBePostedIsSkippedAndTheRestStillArrive() = runTest {
        val n = FakeNotifier(); val skipped = ArrayList<Long>()
        d(n, skipped).onEvents(listOf(e(1, chat = "h_bad"), e(2, chat = "h_1")), false)
        assertEquals(listOf("h_1"), n.posted.map { it.chat }); assertEquals(listOf(1L), skipped)
    }

    @Test fun cancellationAndALostLoginStillPropagate() = runTest {
        val c = FakeContent().apply { authGone = true }
        try { NotifyDispatcher("h1", c, FakeNotifier(), { all }, { emptyList() }, { _, _ -> false }, { NOW }).onEvents(listOf(e(1)), false); fail() } catch (_: AuthRequiredException) {}
    }

    @Test fun theCursorMovesPastThePoisonEventSoItIsNotReplayedForever() = runTest {
        val n = FakeNotifier(); val skipped = ArrayList<Long>(); var last: Long? = 0L; var opens = 0
        val frames = "id: 1\nevent: notify\ndata: {\"id\":1,\"v\":1,\"type\":\"reply_finished\",\"agent\":\"nova\",\"chat\":\"h_bad\",\"priority\":\"normal\",\"at\":1,\"muted\":false}\n\n" +
            "event: foxfleet.ready\ndata: {\"contract\":\"foxfleet.notify/1\",\"cursor\":1}\n\n"
        val store = object : NotifyCursorStore { override var lastId: Long? get() = last; set(v) { last = v }; override fun saveToken(token: String) {} }
        val transport = NotifyTransport { if (opens++ > 0) throw kotlinx.coroutines.CancellationException("done"); NotifyOpen(200, "text/event-stream", null, null, java.io.StringReader(frames)) }
        try { NotifyStreamRunner(transport, store, d(n, skipped), sleep = {}).run() } catch (_: kotlinx.coroutines.CancellationException) {}
        assertEquals(1L, last); assertEquals(listOf(1L), skipped); assertTrue(n.posted.isEmpty()); assertEquals(2, opens) // reconnected once, with id 1, no loop on it
    }
}

class NotifyGuardsTest {
    @Test fun revokedPermissionStopsPostingAndConsumesNothing() = runTest {
        val n = FakeNotifier(); var ok = true
        val g = PermissionGuardSink(NotifyDispatcher("h1", FakeContent(), n, { all }, { emptyList() }, { _, _ -> false }, { NOW })) { ok }
        g.onEvents(listOf(e(1)), false); assertEquals(1, n.posted.size)
        ok = false
        try { g.onEvents(listOf(e(2)), false); fail() } catch (_: NotifyPermissionLost) {}
        try { g.onGap(NotifyFrame.Gap(1, 5)); fail() } catch (_: NotifyPermissionLost) {}
        assertEquals(1, n.posted.size)
    }

    @Test fun muteActionReportsEveryFailureInsteadOfSwallowingIt() = runTest {
        val ok = MuteOutcome.run { HubNotifyPrefs() }; assertEquals(MuteOutcome.Done, ok.first); assertNotNull(ok.second)
        suspend fun failed(ex: Exception) = (MuteOutcome.run { throw ex }.also { assertNull(it.second) }.first as MuteOutcome.Failed).message
        assertTrue(failed(NotifyHttpException(0, "x", network = true)).startsWith("Can't reach your hub"))
        assertTrue(failed(NotifyHttpException(401, "no")).contains("Log in again"))
        assertTrue(failed(NotifyHttpException(500, "boom")).contains("boom"))
        assertTrue(failed(AuthRequiredException()).contains("Log in again"))
        assertTrue(failed(IllegalStateException("x")).startsWith("Couldn't mute"))
    }
}

class AgentChatsTest {
    @Test fun twoThreadsCreatingAndReadingNeverCorruptOrCreateTwice() {
        val chats = AgentChats<Any>(); val created = java.util.concurrent.atomic.AtomicInteger(); val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val start = java.util.concurrent.CountDownLatch(1)
        val ui = Thread { start.await(); try { repeat(20_000) { i -> chats.getOrPut("a${i % 50}") { created.incrementAndGet(); Any() }; if (i % 997 == 0) chats.clear() } } catch (t: Throwable) { errors.add(t) } }
        val service = Thread { start.await(); try { repeat(20_000) { i -> chats.peek("a${i % 50}") } } catch (t: Throwable) { errors.add(t) } }
        ui.start(); service.start(); start.countDown(); ui.join(); service.join()
        assertTrue(errors.toString(), errors.isEmpty())
    }
    @Test fun peekNeverCreatesStateForTheService() { val c = AgentChats<Any>(); assertNull(c.peek("nova")); assertEquals(0, c.size); val a = c.getOrPut("nova") { Any() }; assertSame(a, c.getOrPut("nova") { Any() }); assertSame(a, c.peek("nova")) }
}
