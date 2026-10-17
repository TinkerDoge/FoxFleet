package dev.foxfleet.app.notify

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Direct reply from a notification: idempotency key reuse, token fallback, never a sign-out. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplySenderTest {
    private val prefs = ApplicationProvider.getApplicationContext<android.content.Context>().getSharedPreferences("t_keys", 0).also { it.edit().clear().commit() }
    private var n = 0
    private val keys = ReplyKeys(prefs) { "key-${++n}-abcdef" }

    private class Http(val answers: ArrayDeque<() -> JsonObject>, val bearer: Boolean = true) : ReplyHttp {
        val calls = ArrayList<Triple<String, String?, Boolean>>() // key, token, bearer
        override suspend fun reply(agent: String, chat: String, text: String, key: String, token: String?, bearer: Boolean): JsonObject { calls += Triple(key, token, bearer); return answers.removeFirst()() }
        override suspend fun read(agent: String, chat: String, token: String?, bearer: Boolean): JsonObject { calls += Triple("read", token, bearer); return answers.removeFirst()() }
        override fun hasBearer() = bearer
    }
    private fun ok(dup: Boolean = false): () -> JsonObject = { JsonObject(mapOf("duplicate" to JsonPrimitive(dup))) }
    private fun fail(status: Int, code: String? = null, network: Boolean = false): () -> JsonObject = { throw NotifyHttpException(status, "x", network = network, code = code) }

    @Test fun networkRetriesReuseTheSameKey() = runBlocking {
        val http = Http(ArrayDeque(listOf(fail(0, network = true), fail(503), ok())))
        val out = ReplySender(http, keys, sleep = {}).send("hub", "nova", "c", "Yes", "tok")
        assertEquals(ReplyOutcome.Sent(false), out)
        assertEquals(1, http.calls.map { it.first }.toSet().size)
    }

    @Test fun userRetryAfterFailureReusesTheKeyAndHubSaysDuplicate() = runBlocking {
        val first = Http(ArrayDeque(List(4) { fail(0, network = true) }))
        assertTrue(ReplySender(first, keys, sleep = {}).send("hub", "nova", "c", "Yes", "tok") is ReplyOutcome.Failed)
        val second = Http(ArrayDeque(listOf(ok(dup = true))))
        assertEquals(ReplyOutcome.Sent(true), ReplySender(second, keys, sleep = {}).send("hub", "nova", "c", " Yes ", "tok"))
        assertEquals(first.calls[0].first, second.calls[0].first)
        // confirmed: the same text later is a new message with a new key
        val third = Http(ArrayDeque(listOf(ok())))
        ReplySender(third, keys, sleep = {}).send("hub", "nova", "c", "Yes", "tok")
        assertTrue(third.calls[0].first != first.calls[0].first)
    }

    @Test fun invalidTokenFallsBackToTheSignInOnceAndNeverSignsOut() = runBlocking {
        val http = Http(ArrayDeque(listOf(fail(403, "reply_token_invalid"), ok())))
        assertEquals(ReplyOutcome.Sent(false), ReplySender(http, keys, sleep = {}).send("hub", "nova", "c", "Go", "tok"))
        assertEquals(Triple(http.calls[0].first, "tok", true), http.calls[0]); assertEquals(Triple(http.calls[0].first, null, true), http.calls[1])
        val noBearer = Http(ArrayDeque(listOf(fail(403, "reply_token_invalid"))), bearer = false)
        val out = ReplySender(noBearer, keys, sleep = {}).send("hub", "nova", "c", "Go2", "tok")
        assertTrue(out is ReplyOutcome.Failed && out.message.contains("expired"))
    }

    @Test fun conflictTooLongAndRateLimit() = runBlocking {
        assertTrue(ReplySender(Http(ArrayDeque(listOf(fail(409, "idempotency_conflict")))), keys, sleep = {}).send("h", "a", "c", "x", null) is ReplyOutcome.Failed)
        assertTrue(ReplySender(Http(ArrayDeque()), keys, sleep = {}).send("h", "a", "c", "y".repeat(32_001), null) is ReplyOutcome.Failed)
        val waits = ArrayList<Long>()
        val rl = Http(ArrayDeque(listOf({ throw NotifyHttpException(429, "slow", retryAfterSec = 2, code = "rate_limited") }, ok())))
        assertEquals(ReplyOutcome.Sent(false), ReplySender(rl, keys, sleep = { waits += it }).send("h", "a", "c", "z", null)); assertEquals(listOf(2000L), waits)
    }

    @Test fun markReadTriesTokenThenSignIn() = runBlocking {
        val http = Http(ArrayDeque(listOf(fail(403, "reply_token_invalid"), ok())))
        assertTrue(ReplySender(http, keys).read("nova", "c", "tok"))
        assertEquals(listOf("tok", null), http.calls.map { it.second })
    }
}
