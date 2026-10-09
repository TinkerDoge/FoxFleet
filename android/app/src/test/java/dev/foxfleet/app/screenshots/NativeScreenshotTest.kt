package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** Native Hermes sessions: question/approval cards, Hermes's acknowledgements, chat controls. Run with -Proborazzi.test.record=true. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class NativeScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val atlas = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, description = "Research and code on the workstation",
        capabilities = Capabilities(images = true, files = true, sessions = true, skills = true, busy = listOf("queue", "steer", "interrupt"), nativeUi = true))
    private val now = System.currentTimeMillis()
    private val history = listOf(UiMessage("user", "Deploy the new build", ts = now - 120_000))
    private val clarify = HubApi.OpenRequest("srq-000000000001", "clarify", listOf(HubApi.RequestQuestion("q0", "Which environment should I deploy to?", listOf("staging", "production"), false)))
    private val approval = HubApi.OpenRequest("srq-000000000002", "approval", command = "rm -rf build/ && npm run build", description = "Remove the old build folder before rebuilding")
    private val controls = NativeControls(
        models = { listOf(HubApi.ModelProvider("openrouter", "OpenRouter", listOf("anthropic/claude-sonnet", "openai/gpt-5"), true), HubApi.ModelProvider("custom", "Local", listOf("qwen3-coder"), false)) },
        setModel = { m, _ -> "Model for this chat: $m" }, busy = { "queue" }, setBusy = {},
    )

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(900)
        compose.onRoot().captureRoboImage("$OUT/$name-${if (dark) "dark" else "light"}.png")
    }
    private fun chat(dark: Boolean, name: String, setup: ChatState.() -> Unit) {
        val state = ChatState().apply { load(history, "s9"); setup() }
        shot(name, dark) { ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, nativeControls = controls, onAnswerRequest = { _, _ -> null }) }
    }
    private val cards: ChatState.() -> Unit = { simulateStream("Before I change anything, ", tool = "terminal"); simulateNative(requests = listOf(clarify, approval), tools = listOf("fleet_status", "read_file", "terminal")) }
    private val acks: ChatState.() -> Unit = {
        simulateStream("Deploying the build…", tool = "terminal")
        simulateNative(queue = listOf(
            HubApi.QueuedMessage("a", "queued", "queue", "also run the tests after", ack = "queued"),
            HubApi.QueuedMessage("b", "guidance_accepted", "steer", "keep the logs short", ack = "steered"),
            HubApi.QueuedMessage("c", "guidance_accepted", "interrupt", "actually only deploy the docs", ack = "redirected"),
            HubApi.QueuedMessage("d", "rejected", "interrupt", "stop everything", ack = "rejected", error = "Hermes did not accept it"),
        ), canCancel = false)
    }

    @Test fun cardsLight() = chat(false, "01-cards", cards)
    @Test fun cardsDark() = chat(true, "01-cards", cards)
    @Test fun acknowledgementsLight() = chat(false, "02-acknowledgements", acks)
    @Test fun acknowledgementsDark() = chat(true, "02-acknowledgements", acks)
    @Test fun controlsLight() = shot("03-controls", false) { NativeControlsDialog(controls, hasSession = true, streaming = false) {} }
    @Test fun controlsNoChatDark() = shot("03-controls-no-chat", true) { NativeControlsDialog(controls, hasSession = false, streaming = false) {} }
}
