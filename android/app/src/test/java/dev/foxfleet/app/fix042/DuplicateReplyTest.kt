package dev.foxfleet.app.fix042

import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.NativeChatTest
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.ui.chat.ChatState
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Soran QA (pre-existing since 0.4.0/0.4.1): in a reopened chat the second reply showed twice until the chat was reopened again.
 * Seen live on hub main 53c5046 (HubViewModel + ChatScreen): the reply's stream closed and was committed, then the queue sync
 * still found that run as the hub's active run (the hub finishes it a moment later), followed it again from the start and
 * committed the same reply a second time; message.new then gave its hub id to the second copy only.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DuplicateReplyTest {
    private val sse = "event: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n"
    private val stillActive = """{"items":[],"halted":false,"active_run":"run1","modes":[],"open_requests":[],"can_cancel":false}"""

    @Test fun aRunAlreadyFollowedToTheEndIsNotFollowedAgain() = runBlocking {
        val seen = mutableListOf<String>()
        NativeChatTest.Fake(mapOf("GET /events" to Triple(200, "text/event-stream", sse), "GET /queue" to Triple(200, "application/json", stillActive)), seen).use { f ->
            val api = HubApi(SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:${f.port}" })
            val st = ChatState(); st.adopt("sess-1")
            st.resume(api, "a", "run1", null) // the reply streams and is committed
            assertEquals(listOf("hello"), st.messages.filter { it.role == "assistant" }.map { it.content })
            withTimeout(10_000) { st.syncQueue(api, "a") } // the hub still lists run1 as active
            st.resume(api, "a", "run1", null)              // and any other path that would reattach to it
            assertEquals(listOf("hello"), st.messages.filter { it.role == "assistant" }.map { it.content })
            assertEquals(1, seen.count { it.contains("/events") })
            assertTrue(st.finishedRun("run1"))
        }
    }

    @Test fun aRunCutOffMidStreamIsStillResumed() = runBlocking {
        // the guard is only for runs whose stream reached its end: an unknown run (the app was away) reattaches as before
        val seen = mutableListOf<String>()
        NativeChatTest.Fake(mapOf("GET /events" to Triple(200, "text/event-stream", sse)), seen).use { f ->
            val api = HubApi(SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:${f.port}" })
            val st = ChatState(); st.adopt("sess-1")
            st.resume(api, "a", "run2", "hi")
            assertEquals(listOf("hi", "hello"), st.messages.map { it.content })
        }
    }
}
