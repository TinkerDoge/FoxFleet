package dev.foxfleet.app.fix042

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performTouchInput
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.ReactionSnapshot
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** 0.4.2 release shots: the app on an older hub (hint, chips where ids exist) and on a 0.4.1 hub (unchanged). Output: build/outputs/roborazzi/fix042. */
@OptIn(ExperimentalRoborazziApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class OldHubReactionsScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val out = "build/outputs/roborazzi/fix042"
    private val now = System.currentTimeMillis()
    private val me = ReactionActor("user:minh", "minh", "human"); private val sumin = ReactionActor("user:sumin", "sumin", "human"); private val bot = ReactionActor("agent:atlas", "Atlas", "agent")
    private fun atlas(reactions: Boolean) = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, kind = "hermes", label = "Atlas",
        capabilities = Capabilities(sessions = true, reactions = reactions, agentReactions = reactions, busy = listOf("queue", "interrupt")))
    /** History (provider ids) plus the turn that just arrived live: on a 0.4.0 hub it has hub ids only; on 0.3.x none. */
    private fun shown(hubIds: Boolean) = listOf(
        UiMessage("user", "Morning! Is the nightly build green?", id = "1", ts = now - 900_000, hubId = "h.1".takeIf { hubIds }, status = "read"),
        UiMessage("assistant", "Yes. All 214 tests passed and the APK is signed.", id = "2", ts = now - 880_000, hubId = "h.2".takeIf { hubIds }),
        UiMessage("user", "Great, draft the release notes please", ts = now - 60_000, hubId = "h.3".takeIf { hubIds }, status = "read"),
        UiMessage("assistant", "Done. The draft is in release-notes.md and links the changelog.", ts = now - 20_000, hubId = "h.4".takeIf { hubIds }),
    )
    private val oldSnap = ReactionSnapshot(me, mapOf("1" to listOf(ReactionGroup("❤️", listOf(bot))), "2" to listOf(ReactionGroup("🎉", listOf(me, sumin, bot)), ReactionGroup("👍", listOf(sumin)))), emptySet())
    private val newSnap = ReactionSnapshot(me, mapOf("1" to listOf(ReactionGroup("❤️", listOf(bot))), "2" to listOf(ReactionGroup("🎉", listOf(me, sumin, bot)))), emptySet(),
        mapOf("h.1" to listOf(ReactionGroup("❤️", listOf(bot))), "h.2" to listOf(ReactionGroup("🎉", listOf(me, sumin, bot))), "h.3" to listOf(ReactionGroup("❤️", listOf(bot))), "h.4" to listOf(ReactionGroup("👍", listOf(me, sumin)), ReactionGroup("🔥", listOf(sumin)))))

    private fun shot(name: String, reactions: Boolean, hubIds: Boolean, newHub: Boolean, snap: ReactionSnapshot?, press: String? = null, extra: List<UiMessage> = emptyList()) {
        val state = ChatState().apply { load(shown(hubIds) + extra, "s1"); snap?.let { simulateReactions(it) }; hubIdReactions = newHub }
        val a = atlas(reactions)
        compose.mainClock.autoAdvance = true
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { ChatScreen(a, listOf(a), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}) } } }
        compose.waitForIdle()
        if (press != null) {
            val m = hasText(press, substring = true); compose.waitUntil(5_000) { compose.onAllNodes(m).fetchSemanticsNodes().isNotEmpty() }
            compose.onAllNodes(m).onFirst().performTouchInput { longClick() }; compose.waitForIdle(); compose.mainClock.advanceTimeBy(800); compose.waitForIdle()
        }
        captureScreenRoboImage("$out/$name.png")
    }

    /** A hub without reactions (before 0.3.7): long-press still opens the menu (Copy, Share, ...) and says to update the hub. */
    @Test fun oldHubMenuHint() = shot("01-oldhub-no-reactions-menu-hint", reactions = false, hubIds = false, newHub = false, snap = null, press = "All 214 tests")
    /** A 0.4.0 hub, the reply that just arrived live (no provider id yet): the menu explains instead of a quick row that fails. */
    @Test fun oldHubLiveMessageHint() = shot("02-oldhub-live-message-menu-hint", reactions = true, hubIds = true, newHub = false, snap = oldSnap, press = "links the changelog")
    /** A 0.4.0 hub: pills on the messages it has ids for (history), with counts; yours highlighted. */
    @Test fun oldHubChips() = shot("03-oldhub-chips-on-saved-messages", reactions = true, hubIds = true, newHub = false, snap = oldSnap)
    /** A 0.4.0 hub, a saved message: the quick row as before. */
    @Test fun oldHubQuickPick() = shot("04-oldhub-quick-pick-on-saved-message", reactions = true, hubIds = true, newHub = false, snap = oldSnap, press = "All 214 tests")
    /** A 0.4.1 hub (reactionEvents): unchanged, the live reply has the quick row. */
    @Test fun newHubQuickPick() = shot("05-newhub-quick-pick-unchanged", reactions = true, hubIds = true, newHub = true, snap = newSnap, press = "links the changelog")
    /** A 0.4.1 hub: chips by hub id on every message, the agent's ❤️ on your message. */
    @Test fun newHubChips() = shot("06-newhub-chips-unchanged", reactions = true, hubIds = true, newHub = true, snap = newSnap)
    /** A 0.4.1 hub, a message you just sent (no ids until its message.new): the menu without a quick row and without any hint, as in 0.4.1 (QA blocker on 008acf6). */
    @Test fun newHubJustSentNoHint() = shot("07-newhub-just-sent-no-hint", reactions = true, hubIds = true, newHub = true, snap = newSnap, press = "Ship it tonight",
        extra = listOf(UiMessage("user", "Ship it tonight?", ts = now - 1_000, status = "sending")))
}
