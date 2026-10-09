package dev.foxfleet.app.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.ui.LocalHubColors
import org.robolectric.RuntimeEnvironment
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

/** Telegram-style chat: composer is text + Send + Stop only, cards in the stream, the /model two-step; phone widths, font scale and a shrunken viewport for the keyboard. Run with -Proborazzi.test.record=true. */
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
        models = { listOf(HubApi.ModelProvider("openrouter", "OpenRouter", (1..11).map { "vendor/model-$it" } + "anthropic/claude-sonnet", true), HubApi.ModelProvider("zai", "Z.ai", listOf("glm-4.6"), false)) },
        setModel = { m, _ -> "Model for this chat: $m" }, busy = { "queue" }, setBusy = {},
    )

    /** width/height in dp, font scale; keyboard = the viewport that is left above a ~300dp keyboard (Robolectric draws no IME). */
    private fun shot(name: String, dark: Boolean, w: Int = 411, h: Int = 891, fontScale: Float = 1f, viewportH: Int? = null, content: @Composable () -> Unit) {
        RuntimeEnvironment.setQualifiers("+w${w}dp-h${h}dp-xxhdpi")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale)) {
                FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { Box(if (viewportH != null) Modifier.height(viewportH.dp) else Modifier.fillMaxSize()) { content() } }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        compose.onRoot().captureRoboImage("$OUT/$name-${if (dark) "dark" else "light"}.png")
    }
    private fun chat(name: String, dark: Boolean, w: Int = 411, h: Int = 891, fontScale: Float = 1f, viewportH: Int? = null, setup: ChatState.() -> Unit) {
        val state = ChatState().apply { load(history, "s9"); setup() }
        shot(name, dark, w, h, fontScale, viewportH) { ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, nativeControls = controls, onAnswerRequest = { _, _ -> null }, initialInput = "actually only deploy the docs") }
    }
    private val busy: ChatState.() -> Unit = { simulateStream("Deploying the build…", tool = "terminal") }
    private val acks: ChatState.() -> Unit = {
        simulateStream("Deploying the build…", tool = "terminal")
        simulateNative(queue = listOf(
            HubApi.QueuedMessage("a", "queued", "queue", "also run the tests after", ack = "queued"),
            HubApi.QueuedMessage("b", "guidance_accepted", "steer", "keep the logs short", ack = "steered"),
            HubApi.QueuedMessage("c", "guidance_accepted", "interrupt", "actually only deploy the docs", ack = "redirected"),
        ), canCancel = false)
    }
    private val cards: ChatState.() -> Unit = { simulateStream("Before I change anything, ", tool = "terminal"); simulateNative(requests = listOf(clarify, approval), tools = listOf("fleet_status", "read_file", "terminal")) }

    // 1. the composer while the agent works: text, Send, Stop. Nothing else above it. Phones: 360dp and 411dp, light and dark.
    @Test fun busy360Light() = chat("01-busy-360dp", false, w = 360, h = 740, setup = busy)
    @Test fun busy411Dark() = chat("01-busy-411dp", true, setup = busy)
    // 2. keyboard open (viewport shrunk to what remains above a ~300dp keyboard), also at 360dp with 1.3x text
    @Test fun keyboard411Light() = chat("02-keyboard-411dp", false, viewportH = 560, setup = busy)
    @Test fun keyboard360LargeFontDark() = chat("02-keyboard-360dp-font1.3", true, w = 360, h = 740, fontScale = 1.3f, viewportH = 430, setup = busy)
    @Test fun smallestPhoneLight() = chat("02-keyboard-320dp-font1.3", false, w = 320, h = 640, fontScale = 1.3f, viewportH = 380, setup = busy)
    // 3. in-stream cards and honest acknowledgements stay as they were
    @Test fun cards360Light() = chat("03-cards-360dp", false, w = 360, h = 740, setup = cards)
    @Test fun acknowledgementsDark() = chat("04-acknowledgements", true, setup = acks)
    // 4. /model: step 1 providers, step 2 that provider's models (paged, searchable), then the confirmation line in the chat
    @Test fun modelStep1Light() = shot("05-model-step1-providers", false) { Box(Modifier.fillMaxSize().background(LocalHubColors.current.surface)) { ModelPickerContent(controls, true, {}, {}) } }
    @Test fun modelStep2Dark() = shot("06-model-step2-models", true, w = 360, h = 740) { Box(Modifier.fillMaxSize().background(LocalHubColors.current.surface)) { ModelPickerContent(controls, true, {}, {}, startProvider = "openrouter") } }
    @Test fun modelConfirmedLight() = chat("07-model-confirmed", false, w = 360, h = 740) { addNotice(modelSetMessage("vendor/model-3")) }
    @Test fun profileBusyInSettingsLight() = shot("08-agent-settings-busy", false, w = 360, h = 740) { Box(Modifier.fillMaxSize().background(LocalHubColors.current.bg).padding(16.dp)) { ProfileBusyCard(controls) } }
}
