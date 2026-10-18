package dev.foxfleet.app.fix042

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubApiException
import dev.foxfleet.app.data.MediaLink
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.components.LocalMediaHost
import dev.foxfleet.app.ui.components.MediaHost
import dev.foxfleet.app.ui.screens.ChatScreen
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * 0.4.2 vc31 blocker (Soran, probe QaDisplayNameTest): ChatScreen passed the agent's label into the transcript, which also
 * uses that string as the agent id. A labelled agent's MEDIA cards asked `/api/agents/<label>/media` (404) and its avatars
 * hashed the label. The id must reach media, avatars and hub calls; the label only the text.
 */
@OptIn(ExperimentalRoborazziApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DisplayNameTest {
    @get:Rule val compose = createComposeRule()
    private val sumi = AgentStatus("sumi", online = true, chatReady = true, managementReady = true, label = "SUMI", capabilities = Capabilities(images = true, files = true, sessions = true))
    private val now = System.currentTimeMillis()

    /** Like the hub: media is looked up by exact agent id, anything else is "Unknown agent". */
    private fun hub(asked: MutableList<String>) = MediaHost(OkHttpClient()) { agent, _ ->
        asked += agent
        if (agent != "sumi") throw HubApiException(404, "Unknown agent")
        MediaLink("http://hub/api/media/f", "file", "report.pdf")
    }

    private fun show(state: ChatState, host: MediaHost, onAnswer: (suspend (String, kotlinx.serialization.json.JsonObject) -> String?)? = null) = compose.setContent {
        CompositionLocalProvider(LocalMediaHost provides host) {
            FoxfleetTheme(AppPrefs()) { Box(Modifier.fillMaxSize()) { ChatScreen(sumi, listOf(sumi), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, onAnswerRequest = onAnswer) } }
        }
    }

    private fun count(text: String, substring: Boolean = false) = compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().size

    @Test fun mediaIsFetchedByIdAndTheStatusLineShowsTheLabel() {
        val asked = java.util.Collections.synchronizedList(mutableListOf<String>())
        val state = ChatState().apply {
            load(listOf(UiMessage("user", "Send me the file", ts = now - 60_000), UiMessage("assistant", "Here it is.\nMEDIA:/tmp/report.pdf", id = "a1", ts = now - 30_000)), "s9")
            simulateStream("")
        }
        show(state, hub(asked))
        compose.waitUntil(10_000) { asked.isNotEmpty() }
        compose.waitForIdle()
        assertEquals("media is resolved by the agent id, never the label", listOf("sumi"), asked.distinct())
        assertEquals("the file card works (no failure card)", 0, count("Try again"))
        assertTrue(count("report.pdf", substring = true) >= 1)
        assertEquals("the live status line speaks the label", 1, count("SUMI is working", substring = true))
        assertEquals(0, count("sumi is working", substring = true))
        // avatars (header, reply row, live row) draw the id's initials "Su"; the label would give "SU"
        assertTrue("avatars use the id", count("Su") >= 3)
        assertEquals("no avatar is drawn from the label", 0, count("SU"))
        captureScreenRoboImage("build/outputs/roborazzi/fix042/labelled-agent-media-status.png")
    }

    @Test fun emptyChatAndRequestCardsUseTheLabel() {
        val state = ChatState().apply { load(emptyList(), "s10") }
        show(state, hub(mutableListOf()), onAnswer = { _, _ -> null })
        compose.waitForIdle()
        assertEquals(1, count("Start a conversation with SUMI"))
        assertTrue("the empty-chat avatar uses the id", count("Su") >= 2)
        compose.runOnIdle { state.load(listOf(UiMessage("user", "Tidy up /tmp/x", ts = now)), "s10"); state.simulateNative(requests = listOf(HubApi.OpenRequest("r1", "approval", command = "rm -rf /tmp/x", description = "Clean up"), HubApi.OpenRequest("r2", "question"))) }
        compose.waitForIdle()
        assertEquals(1, count("SUMI asks permission"))
        assertEquals(1, count("SUMI has a question"))
        assertEquals(0, count("sumi asks", substring = true) + count("sumi has", substring = true) + count("with sumi", substring = true))
    }
}
