package dev.foxfleet.app.fix042

import androidx.compose.ui.test.assertCountEquals
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
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.ReactState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

/**
 * 0.4.2: the 0.4.1 app on an older hub (Doge: hub 0.4.0 or older). Before, every reaction affordance hung on three silent gates
 * (capabilities.reactions, a loaded snapshot, an addressable message): when one was missing the quick row, the pills and the double
 * tap were simply not there. Now a message that can take a reaction gets them, and one that cannot says "Update your hub for reactions".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class OldHubReactionsTest {
    @get:Rule val compose = createComposeRule()
    private val me = ReactionActor("user:minh", "minh", "human"); private val atlas = ReactionActor("agent:atlas", "Atlas", "agent")
    private val toggles = mutableListOf<String>(); private val chips = mutableListOf<String>(); private var syncs = 0
    private fun agent(reactions: Boolean, bot: Boolean = false) = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, label = "Atlas", kind = "hermes",
        capabilities = Capabilities(reactions = reactions, agentReactions = reactions, bot = bot))

    /** [hubIds]: the hub takes hub ids as targets (0.4.1 `reactionEvents`); false = 0.4.0 and older. [snap] null = not loaded (or the hub could not read it). */
    private fun show(messages: List<UiMessage>, reactions: Boolean = true, hubIds: Boolean = false, snap: ReactionSnapshot? = ReactionSnapshot(me, emptyMap(), emptySet())): ChatState {
        val a = agent(reactions)
        val state = ChatState().apply { load(messages, "s1"); snap?.let { simulateReactions(it) }; hubIdReactions = hubIds }
        compose.setContent { FoxfleetTheme(AppPrefs()) { ChatScreen(a, listOf(a), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {},
            onSyncReactions = { syncs++ }, onReact = { m, e, on -> chips += "${m.id ?: m.hubId} $e $on" }, onToggleReaction = { m, e -> toggles += "${m.id ?: m.hubId} $e" }) } }
        compose.waitForIdle(); return state
    }
    private fun text(t: String) = hasText(t, substring = true).also { m -> compose.waitUntil(5_000) { compose.onAllNodes(m).fetchSemanticsNodes().isNotEmpty() } }
    private fun quickRows() = compose.onAllNodesWithContentDescription("React 👍").fetchSemanticsNodes().size
    private fun longPress(t: String) { compose.onAllNodes(text(t)).onFirst().performTouchInput { longClick() }; compose.waitForIdle() }
    private fun doubleTap(t: String) { compose.onAllNodes(text(t)).onFirst().performTouchInput { doubleClick() }; compose.mainClock.advanceTimeBy(600); compose.waitForIdle() }

    @Test fun reactStateCoversEveryHub() {
        val saved = UiMessage("assistant", "x", id = "2", hubId = "h.2"); val live = UiMessage("assistant", "y", hubId = "h.3"); val bare = UiMessage("assistant", "z")
        val on = Capabilities(reactions = true); val old = Capabilities(reactions = false);        val bot = Capabilities(reactions = true, bot = true)
        assertEquals(ReactState.Ready, MessageActions.reactState(bot, hubIds = false, m = saved))
        assertEquals(ReactState.Off, MessageActions.reactState(Capabilities(reactions = false, bot = true), hubIds = false, m = saved))
        assertEquals(ReactState.Ready, MessageActions.reactState(on, hubIds = true, m = live))   // 0.4.1 hub: hub id is enough
        assertEquals(ReactState.Pending, MessageActions.reactState(on, hubIds = false, m = live)) // 0.4.0: needs the provider id
        assertEquals(ReactState.Pending, MessageActions.reactState(on, hubIds = false, m = bare)) // 0.3.x: no ids at all yet
        assertEquals(ReactState.Off, MessageActions.reactState(on, hubIds = true, m = bare))     // current hub, streaming / just sent: silent (QA blocker)
        assertEquals(ReactState.Ready, MessageActions.reactState(on, hubIds = false, m = saved))
        assertEquals(ReactState.HubTooOld, MessageActions.reactState(old, hubIds = false, m = saved)) // hub before reactions (< 0.3.7)
        assertNull(MessageActions.reactHint(ReactState.Ready)); assertNull(MessageActions.reactHint(ReactState.Off))
    }

    // A hub without reactions (capabilities.reactions false, not a bot): the menu still opens (Copy etc.) and says why there is no quick row.
    @Test fun hubWithoutReactionsShowsTheUpdateHintInTheMenuAndOnDoubleTap() {
        show(listOf(UiMessage("assistant", "Build is green", id = "2")), reactions = false)
        longPress("Build is green")
        assertEquals(0, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT).assertCountEquals(1)
        compose.onAllNodesWithText(MessageActions.HUB_HINT_OLD).assertCountEquals(1)
        compose.onAllNodesWithText("Copy").assertCountEquals(1)
        androidx.test.espresso.Espresso.pressBack(); compose.waitForIdle()
        doubleTap("Build is green")
        assertEquals(emptyList<String>(), toggles)
        assertEquals(MessageActions.HUB_HINT, ShadowToast.getTextOfLatestToast())
    }

    // 0.4.0 hub, a message with a provider id (history): reactions work there: pills with counts, quick row, double tap.
    @Test fun oldHubStillReactsOnMessagesWithIds() {
        show(listOf(UiMessage("assistant", "Tests passed", id = "2", hubId = "h.2")), snap = ReactionSnapshot(me, mapOf("2" to listOf(ReactionGroup("👍", listOf(me, atlas))))))
        compose.onNodeWithContentDescription("👍 2", substring = true).performClick(); compose.waitForIdle()
        assertEquals(listOf("2 👍 false"), chips)
        longPress("Tests passed"); assertEquals(1, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT).assertCountEquals(0)
        compose.onNodeWithContentDescription("React 🎉").performClick(); compose.waitForIdle()
        doubleTap("Tests passed")
        assertEquals(listOf("2 🎉", "2 ❤️"), toggles)
    }

    // 0.4.0 hub, a reply that only arrived live (hub id, no provider id yet): the quick row used to show and every tap failed;
    // now the menu says so, asks for the id, and the quick row comes as soon as the id is known (the menu stays open on it).
    @Test fun liveMessageOnAnOldHubShowsTheHintAndGetsTheQuickRowOnceItHasAnId() {
        val state = show(listOf(UiMessage("assistant", "Draft ready", hubId = "h.4", n = 4)))
        longPress("Draft ready")
        assertEquals(0, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT_PENDING).assertCountEquals(1)
        compose.onAllNodesWithText("Copy").assertCountEquals(1)
        assert(syncs > 0) { "opening the menu asks for the message's id" }
        state.load(listOf(UiMessage("assistant", "Draft ready", id = "101", hubId = "h.4", n = 4)), "s1"); compose.waitForIdle()
        assertEquals(1, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT).assertCountEquals(0)
    }

    // The press detector outlives recompositions: after the id arrived (same row, same hub id), a double tap must use the message as it is now.
    @Test fun doubleTapUsesTheCurrentMessageAfterItsIdArrived() {
        val state = show(listOf(UiMessage("assistant", "Draft ready", hubId = "h.4", n = 4)))
        doubleTap("Draft ready")
        assertEquals(emptyList<String>(), toggles) // no id yet on a 0.4.0 hub: the hint, not a failing call
        assertEquals(MessageActions.HUB_HINT, ShadowToast.getTextOfLatestToast())
        state.load(listOf(UiMessage("assistant", "Draft ready", id = "101", hubId = "h.4", n = 4)), "s1"); compose.waitForIdle()
        compose.mainClock.advanceTimeBy(1_000)
        doubleTap("Draft ready")
        assertEquals(listOf("101 ❤️"), toggles)
    }

    // Reactions not loaded (the hub could not read the transcript, or not yet): the double tap and the quick row stay (they used to vanish).
    @Test fun doubleTapWorksBeforeTheSnapshotIsLoaded() {
        show(listOf(UiMessage("assistant", "Tests passed", id = "2")), snap = null)
        doubleTap("Tests passed")
        assertEquals(listOf("2 ❤️"), toggles)
        longPress("Tests passed"); assertEquals(1, quickRows())
    }

    // 0.4.1 hub: unchanged, a live message is reactable by its hub id.
    @Test fun newHubUnchanged() {
        show(listOf(UiMessage("assistant", "Draft ready", hubId = "h.4", n = 4)), hubIds = true)
        longPress("Draft ready"); assertEquals(1, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT).assertCountEquals(0)
        compose.onNodeWithContentDescription("React 👍").performClick(); compose.waitForIdle()
        assertEquals(listOf("h.4 👍"), toggles)
    }

    // Soran QA blocker (008acf6, probes/QaNewHubIdlessTest.kt): on a current hub (reactionEvents) a message with no ids yet (streaming,
    // just sent) said "Update your hub for reactions", toasted it on double tap and asked the hub for ids each time. Now: nothing, as in 0.4.1.
    @Test fun currentHubIdlessMessageShowsNoHintNoToastAndRequestsNothing() {
        show(listOf(UiMessage("assistant", "Streaming answer")), hubIds = true)
        val opened = syncs // the screen's usual sync on open
        longPress("Streaming answer")
        assertEquals(0, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT).assertCountEquals(0)
        compose.onAllNodesWithText(MessageActions.HUB_HINT_PENDING).assertCountEquals(0)
        compose.onAllNodesWithText("Copy").assertCountEquals(1) // the menu itself still opens
        androidx.test.espresso.Espresso.pressBack(); compose.waitForIdle()
        doubleTap("Streaming answer")
        assertEquals(emptyList<String>(), toggles)
        assertNull(ShadowToast.getTextOfLatestToast())
        assertEquals(opened, syncs) // neither the menu nor the double tap asked the hub for ids
    }
    // ...and the same message once its message.new brought the hub id: the quick row, as in 0.4.1.
    @Test fun currentHubMessageGetsTheQuickRowOnceItsHubIdArrives() {
        val state = show(listOf(UiMessage("assistant", "Streaming answer")), hubIds = true)
        state.load(listOf(UiMessage("assistant", "Streaming answer", hubId = "h.9", n = 9)), "s1"); compose.waitForIdle()
        longPress("Streaming answer"); assertEquals(1, quickRows())
        compose.onAllNodesWithText(MessageActions.HUB_HINT).assertCountEquals(0)
    }
}
