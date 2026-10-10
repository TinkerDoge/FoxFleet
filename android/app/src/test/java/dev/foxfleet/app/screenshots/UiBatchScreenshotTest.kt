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

/** UI batch 1 (no burger, no / button, icons, tonal buttons, paged /model): composer is text + Send + Stop only, cards in the stream, the /model two-step; phone widths, font scale and a shrunken viewport for the keyboard. Run with -Proborazzi.test.record=true. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class UiBatchScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val atlas = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, description = "Research and code on the workstation",
        capabilities = Capabilities(images = true, files = true, sessions = true, skills = true, busy = listOf("queue", "steer", "interrupt"), nativeUi = true))
    private val fleetAgents = listOf(AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, activeSessions = 2), AgentStatus("Nova", online = true, chatReady = true, managementReady = true), AgentStatus("Echo", online = false, chatReady = false, managementReady = false))
    private val now = System.currentTimeMillis()
    private val history = listOf(UiMessage("user", "Deploy the new build", ts = now - 120_000))
    private val clarify = HubApi.OpenRequest("srq-000000000001", "clarify", listOf(HubApi.RequestQuestion("q0", "Which environment should I deploy to?", listOf("staging", "production"), false)))
    private val approval = HubApi.OpenRequest("srq-000000000002", "approval", command = "rm -rf build/ && npm run build", description = "Remove the old build folder before rebuilding")
    private val controls = NativeControls(
        models = { (listOf(HubApi.ModelProvider("openrouter", "OpenRouter", (1..11).map { "vendor/model-$it" } + "anthropic/claude-sonnet", true), HubApi.ModelProvider("zai", "Z.ai", listOf("glm-4.6"), false)) + (1..9).map { HubApi.ModelProvider("p$it", "Provider $it", listOf("m"), false) }) },
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

    @Test fun chat360Light() = chat("01-chat-360dp", false, w = 360, h = 740, setup = busy)
    @Test fun chat411Dark() = chat("01-chat-411dp", true, setup = busy)
    @Test fun keyboard360Dark() = chat("02-chat-keyboard-360dp", true, w = 360, h = 740, viewportH = 430, setup = busy)
    @Test fun providersPaged360Light() = shot("03-model-providers-paged-360dp", false, w = 360, h = 740) { Box(Modifier.fillMaxSize().background(LocalHubColors.current.surface)) { ModelPickerContent(controls, true, {}, {}) } }
    @Test fun providersPaged411Dark() = shot("03-model-providers-paged-411dp", true) { Box(Modifier.fillMaxSize().background(LocalHubColors.current.surface)) { ModelPickerContent(controls, true, {}, {}) } }
    @Test fun models360Light() = shot("04-model-models-360dp", false, w = 360, h = 740) { Box(Modifier.fillMaxSize().background(LocalHubColors.current.surface)) { ModelPickerContent(controls, true, {}, {}, startProvider = "openrouter") } }
    @Test fun fleet360Light() = shot("05-agents-360dp", false, w = 360, h = 740) { FleetScreen(fleetAgents, loading = false, loadedOnce = true, error = null, unread = { it.name == "Nova" }, onRefresh = {}, onOpen = {}, onSettings = {}) }
    @Test fun fleet411Dark() = shot("05-agents-411dp", true) { FleetScreen(fleetAgents, loading = false, loadedOnce = true, error = null, unread = { it.name == "Nova" }, onRefresh = {}, onOpen = {}, onSettings = {}) }
    @Test fun settings360Light() = shot("06-settings-360dp", false, w = 360, h = 740) { SettingsScreen(AppPrefs(theme = ThemeMode.Light, accent = 0), {}, {}, {}) }
    @Test fun settings411Dark() = shot("06-settings-411dp", true) { SettingsScreen(AppPrefs(theme = ThemeMode.Dark, accent = 0), {}, {}, {}) }
}
