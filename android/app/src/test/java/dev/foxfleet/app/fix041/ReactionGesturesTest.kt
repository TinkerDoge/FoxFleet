package dev.foxfleet.app.fix041

import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.ReactionSnapshot
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Long press and double tap anywhere on a message (links included), the quick row for live messages, chips, and no reactions for bots. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ReactionGesturesTest {
    @get:Rule val compose = createComposeRule()
    private val me = ReactionActor("user:minh", "minh", "human"); private val atlas = ReactionActor("agent:atlas", "Atlas", "agent")
    private fun agent(reactions: Boolean) = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, label = "Atlas", capabilities = Capabilities(reactions = reactions, agentReactions = reactions))
    private val toggles = mutableListOf<String>(); private val chips = mutableListOf<String>()

    private fun show(messages: List<UiMessage>, reactions: Boolean = true, snap: ReactionSnapshot = ReactionSnapshot(me, emptyMap(), emptySet(), emptyMap())) {
        val a = agent(reactions)
        val state = ChatState().apply { load(messages, "s1"); simulateReactions(snap) }
        compose.setContent { FoxfleetTheme(AppPrefs()) { ChatScreen(a, listOf(a), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {},
            onReact = { m, e, on -> chips += "${m.hubId ?: m.id} $e $on" }, onToggleReaction = { m, e -> toggles += "${m.hubId ?: m.id} $e" }) } }
        compose.waitForIdle()
    }
    /** Markdown lays a reply out off the frame clock: wait for its text before touching it. */
    private fun text(t: String) = hasText(t, substring = true).also { m -> compose.waitUntil(5_000) { compose.onAllNodes(m).fetchSemanticsNodes().isNotEmpty() } }
    private fun quickRows() = compose.onAllNodesWithContentDescription("React 👍").fetchSemanticsNodes().size

    // Root cause 5 (ChatScreen MessageRow): a link inside a reply took the long press and the double tap for itself.
    @Test fun longPressOnALinkInsideAReplyOpensTheMenuWithTheQuickRow() {
        show(listOf(UiMessage("assistant", "Raw https://example.invalid/z link", id = "2", hubId = "h.2")))
        compose.onAllNodes(text("Raw")).onFirst().performTouchInput { longClick() }; compose.waitForIdle()
        assertEquals(1, quickRows())
        compose.onNodeWithContentDescription("React 🎉").performClick(); compose.waitForIdle()
        assertEquals(listOf("h.2 🎉"), toggles)
    }

    @Test fun doubleTapOnALinkHeartsTheMessage() {
        show(listOf(UiMessage("assistant", "See https://example.invalid/z now", id = "2", hubId = "h.2")))
        compose.onAllNodes(text("now")).onFirst().performTouchInput { doubleClick() }; compose.mainClock.advanceTimeBy(600); compose.waitForIdle()
        assertEquals(listOf("h.2 ❤️"), toggles)
    }

    // Root cause 2 (ChatScreen canReact): a message that only arrived live (hub id, no provider id yet) had no quick row.
    @Test fun liveMessageWithOnlyAHubIdHasTheQuickRowAndThePicker() {
        show(listOf(UiMessage("user", "draft it", hubId = "h.3", n = 3)))
        compose.onAllNodesWithText("draft it").onFirst().performTouchInput { longClick() }; compose.waitForIdle()
        assertEquals(1, quickRows())
        compose.onNodeWithContentDescription("More reactions").performClick(); compose.waitForIdle()
        compose.onNodeWithContentDescription("Search emoji").assertExists()
    }

    @Test fun chipsShowCountsByHubIdAndToggle() {
        show(listOf(UiMessage("user", "draft it", hubId = "h.3", n = 3)), snap = ReactionSnapshot(me, emptyMap(), emptySet(), mapOf("h.3" to listOf(ReactionGroup("👍", listOf(me, atlas)), ReactionGroup("❤️", listOf(atlas))))))
        compose.onNodeWithContentDescription("👍 2", substring = true).performClick(); compose.waitForIdle()
        compose.onNodeWithContentDescription("❤️ 1", substring = true).performClick(); compose.waitForIdle()
        assertEquals(listOf("h.3 👍 false", "h.3 ❤️ true"), chips) // yours is taken back, the agent's one is joined
    }

    // Bot agents: capabilities.reactions is false, so there is no reaction UI at all.
    @Test fun botAgentsShowNoReactionUi() {
        show(listOf(UiMessage("assistant", "Hello from the bot", id = "2", hubId = "h.2")), reactions = false, snap = ReactionSnapshot(me, mapOf("2" to listOf(ReactionGroup("👍", listOf(me))))))
        compose.onNodeWithContentDescription("👍 1", substring = true).assertDoesNotExist()
        compose.onAllNodesWithText("Hello from the bot").onFirst().performTouchInput { longClick() }; compose.waitForIdle()
        assertEquals(0, quickRows())
        compose.onAllNodesWithText("Hello from the bot").onFirst().performTouchInput { doubleClick() }; compose.mainClock.advanceTimeBy(600); compose.waitForIdle()
        assertEquals(emptyList<String>(), toggles)
    }
}
