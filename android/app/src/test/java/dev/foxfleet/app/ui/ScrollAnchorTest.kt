package dev.foxfleet.app.ui

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Step 2 (0.4.0): message rows are keyed by message identity, so the row the reader is looking at stays put while
 * older pages load at the far end of the reversed list, or the hub's page replaces the cached one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ScrollAnchorTest {
    @get:Rule val compose = createComposeRule()
    private val agent = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true)
    private fun m(i: Int) = UiMessage(if (i % 2 == 0) "user" else "assistant", "Row number $i", id = "m$i", ts = 1_790_000_000_000L + i * 60_000L)
    private var olderCalls = 0

    private fun show(state: ChatState) {
        compose.setContent { FoxfleetTheme(AppPrefs()) { ChatScreen(agent, listOf(agent), state, emptyList(), { false }, { _, _ -> }, {}, {}, { olderCalls++ }, {}, {}, {}) } }
    }
    private fun top(text: String) = compose.onNodeWithText(text).getBoundsInRoot().top
    private fun scrollTo(text: String) { compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(text)); compose.waitForIdle() }

    @Test fun olderPageKeepsTheVisibleRowInPlace() {
        val state = ChatState().apply { load((100 until 180).map(::m), "s1", hasMore = true) }
        show(state)
        scrollTo("Row number 150")
        val before = top("Row number 150")
        compose.runOnIdle { state.beginOlder(); state.prependCached((20 until 100).map(::m), hasMore = true, hubOffset = 160) }
        compose.waitForIdle()
        assertEquals(before.value, top("Row number 150").value, 0.5f)
        assertEquals(180 - 20, state.messages.size)
    }

    @Test fun hubPageReplacingTheCacheKeepsTheVisibleRowInPlace() {
        val state = ChatState().apply { showCached((100 until 180).map(::m), "s1", hasOlder = true) }
        show(state)
        scrollTo("Row number 140")
        val before = top("Row number 140")
        // the hub's newest page: the same rows plus two new ones at the newest end
        compose.runOnIdle { state.load((102 until 182).map(::m), "s1", hasMore = true) }
        compose.waitForIdle()
        assertEquals(before.value, top("Row number 140").value, 0.5f)
    }

    @Test fun keysAreMessageIdentityNotPosition() {
        val state = ChatState().apply { load((0 until 5).map(::m), "s1") }
        show(state)
        compose.onNode(SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsProperties.CollectionInfo)).assertExists()
        compose.runOnIdle { state.prependCached(listOf(m(-1)), hasMore = false, hubOffset = 80) }
        compose.onNodeWithText("Row number 0").assertExists()
    }
}
