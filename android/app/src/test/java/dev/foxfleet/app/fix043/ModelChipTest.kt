package dev.foxfleet.app.fix043

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.MODEL_CHIP_LABEL
import dev.foxfleet.app.ui.screens.NativeControls
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 0.4.3 Lane B: the chip in the chat header for the model of this chat. It is there only where the hub has a model list
 * for the agent (capabilities.models native or request); a bot agent with no list does not get one, because /model there
 * is a message to the agent rather than something the app can do.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ModelChipTest {
    @get:Rule val compose = createComposeRule()
    private fun agent(caps: Capabilities) = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, kind = "hermes", label = "Atlas", capabilities = caps)
    private val controls = NativeControls(models = { listOf(HubApi.ModelProvider("openrouter", "OpenRouter", listOf("m1", "m2"), true)) }, setModel = { m, _ -> m }, busy = { "" }, setBusy = {})

    /** [controls] is passed even where the chip must not appear: the capability is what decides, not the wiring. */
    private fun chat(caps: Capabilities, controls: NativeControls?) {
        val a = agent(caps); val state = ChatState().apply { load(listOf(UiMessage("user", "hi", hubId = "h.1", n = 1)), "s1") }
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { Box(Modifier.fillMaxSize()) {
            ChatScreen(a, listOf(a), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, nativeControls = controls)
        } } }
        compose.waitForIdle()
    }

    private fun chips() = compose.onAllNodesWithContentDescription(MODEL_CHIP_LABEL, substring = true)

    @Test fun nativeAgentHasTheChip() {
        chat(Capabilities(sessions = true, models = "native"), controls)
        chips().assertCountEquals(1)
        // The hub marks the provider it is on; the chip names it until a model is picked here.
        compose.onNodeWithContentDescription("$MODEL_CHIP_LABEL: OpenRouter").assertExists()
    }

    @Test fun requestAgentHasTheChip() {
        chat(Capabilities(sessions = true, models = "request"), controls)
        chips().assertCountEquals(1)
    }

    /** Hubs older than 0.4.1 do not say; the native gateway still has the picker, so the chip is still there. */
    @Test fun anOlderHubThatDoesNotSayStillGetsTheChipForANativeAgent() {
        chat(Capabilities(sessions = true, nativeUi = true), controls)
        chips().assertCountEquals(1)
    }

    @Test fun anAgentWithoutAModelListHasNoChip() {
        chat(Capabilities(sessions = true, models = "none"), controls)
        chips().assertCountEquals(0)
        compose.onAllNodesWithText("Model").assertCountEquals(0)
    }

    /** A bot agent: /model goes to the agent as text, so the app offers nothing to pick from. */
    @Test fun aBotAgentHasNoChip() {
        chat(Capabilities(sessions = true, models = "none", bot = true), controls)
        chips().assertCountEquals(0)
    }

    /** Nothing to open it with: no native controls, so no chip either. */
    @Test fun withoutNativeControlsThereIsNoChip() {
        chat(Capabilities(sessions = true, models = "request"), null)
        chips().assertCountEquals(0)
    }

    /** The chip is the way in: providers, then models, search, paging, Back and Cancel — all inside the chat. */
    @Test fun theChipOpensTheModelCard() {
        chat(Capabilities(sessions = true, models = "native"), controls)
        compose.onNodeWithContentDescription(MODEL_CHIP_LABEL, substring = true).performClick(); compose.waitForIdle()
        compose.onNodeWithContentDescription("Close the model card").assertExists()
        compose.onNodeWithText("Choose a provider").assertExists()
        compose.onNodeWithText("OpenRouter · 2").performClick(); compose.waitForIdle()
        compose.onNodeWithText("Models from OpenRouter").assertExists()
        compose.onNodeWithText("m1").performClick(); compose.waitForIdle()
        // Picked: the chat keeps the card closed and the notice says the profile default is untouched.
        compose.onNodeWithText("Cancel").assertDoesNotExist()
        compose.onNodeWithText("Model for this chat is now m1. Your Hermes default is unchanged.").assertExists()
        // The chip now names what this chat is on.
        compose.onNodeWithContentDescription("$MODEL_CHIP_LABEL: m1").assertExists()
    }
}