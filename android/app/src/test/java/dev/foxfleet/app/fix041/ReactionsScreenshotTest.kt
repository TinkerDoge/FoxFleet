package dev.foxfleet.app.fix041

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.HistoryTest
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Reactions after a live turn (0.4.1): the turn arrived over live v2 (hub ids, no provider ids yet), then the app syncs with the
 * hub exactly as after every run (reconcile + reactions). The hub's stored reply joins the agent's two steps with a blank line,
 * the streamed copy does not. Shots 05-08 of the release's before/after set. Output: build/outputs/roborazzi/fix041.
 */
@OptIn(ExperimentalRoborazziApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ReactionsScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val out = "build/outputs/roborazzi/fix041"
    private val now = System.currentTimeMillis()
    private val atlas = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, kind = "hermes", label = "Atlas",
        capabilities = Capabilities(sessions = true, reactions = true, agentReactions = true, busy = listOf("queue", "interrupt")))
    private val reply = "Let me write it up.Done. The draft is in [release-notes.md](https://example.invalid/notes) and links the changelog."
    /** What the screen holds right after the turn: the older pair from history, the new pair from live v2. */
    private fun shown() = listOf(
        UiMessage("user", "Morning! Is the nightly build green?", id = "1", ts = now - 900_000, hubId = "h.1", n = 1, status = "read"),
        UiMessage("assistant", "Yes. All 214 tests passed and the APK is signed.", id = "2", ts = now - 880_000, hubId = "h.2", n = 2),
        UiMessage("user", "Great, draft the release notes please", ts = now - 60_000, hubId = "h.3", n = 3, status = "read"),
        UiMessage("assistant", "$reply\nREACT: ❤️", ts = now - 20_000, hubId = "h.4", n = 4),
    )
    private val page = """{"messages":[
      {"role":"user","content":"Morning! Is the nightly build green?","id":"1","hub_id":"h.1","n":1,"ts":${now - 900_000},"status":"read"},
      {"role":"assistant","content":"Yes. All 214 tests passed and the APK is signed.","id":"2","hub_id":"h.2","n":2,"ts":${now - 880_000}},
      {"role":"user","content":"Great, draft the release notes please","id":"100","hub_id":"h.3","n":3,"ts":${now - 60_000},"status":"read"},
      {"role":"assistant","content":"Let me write it up.\n\nDone. The draft is in [release-notes.md](https://example.invalid/notes) and links the changelog.\nREACT: ❤️","id":"101","hub_id":"h.4","n":4,"ts":${now - 20_000}}
    ],"has_more":false}"""
    private val me = """{"id":"user:minh","name":"minh","kind":"human"}"""
    private val agent = """{"id":"agent:atlas","name":"Atlas","kind":"agent"}"""
    private val sumin = """{"id":"user:sumin","name":"sumin","kind":"human"}"""
    private val snapshot = """{"actor":$me,"messages":{
      "2":[{"emoji":"🎉","actors":[$me,$sumin,$agent]}],
      "100":[{"emoji":"❤️","actors":[$agent]}],
      "101":[{"emoji":"👍","actors":[$me,$sumin]},{"emoji":"🔥","actors":[$sumin]}]
    },"hidden":[]}"""

    private fun synced(): ChatState {
        val state = ChatState().apply { load(shown(), "s1") }
        HistoryTest.Json({ line -> if (line.contains("/reactions")) snapshot else page }).use { hub ->
            val store = SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()); store.allowHttp = true; store.baseUrl = "http://127.0.0.1:${hub.port}"
            val api = HubApi(store)
            runBlocking { state.reconcile(api, "atlas"); state.refreshReactions(api, "atlas") }
        }
        return state
    }

    private fun shot(name: String, longPress: Boolean = false, more: Boolean = false) {
        val state = synced()
        compose.mainClock.autoAdvance = true // the sheets animate in
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { Box(Modifier.fillMaxSize()) {
            ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {})
        } } }
        compose.waitForIdle()
        if (longPress) { compose.onAllNodes(hasText("links the changelog", substring = true)).onFirst().performTouchInput { longClick() }; compose.waitForIdle(); compose.mainClock.advanceTimeBy(800); compose.waitForIdle() }
        if (more) compose.onAllNodesWithContentDescription("More reactions").fetchSemanticsNodes().takeIf { it.isNotEmpty() }?.let {
            compose.onAllNodesWithContentDescription("More reactions").onFirst().performClick(); compose.waitForIdle(); compose.mainClock.advanceTimeBy(800); compose.waitForIdle()
        }
        captureScreenRoboImage("$out/$name.png")
    }

    /** Long-press the reply that just arrived (it has a link): the quick-pick row on top of the menu. */
    @Test fun quickPick() = shot("05-reactions-quick-pick", longPress = true)
    /** "More reactions" from that menu: the full emoji picker. */
    @Test fun fullPicker() = shot("06-reactions-full-picker", longPress = true, more = true)
    /** Chips under the bubbles with counts; yours highlighted. */
    @Test fun chips() = shot("07-reactions-chips-counts")
    /** The agent's REACT: on your message (the ❤️ under "Great, draft the release notes please"). */
    @Test fun agentReaction() = shot("08-reactions-agent-on-user")
}
