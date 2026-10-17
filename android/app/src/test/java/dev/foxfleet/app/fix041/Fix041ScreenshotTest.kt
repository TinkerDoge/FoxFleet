package dev.foxfleet.app.fix041

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureRoboImage
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.ToolStep
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.chat.StepLog
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.LocalStepsOpen
import dev.foxfleet.app.ui.screens.NativeControls
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** 0.4.1 renders of the three reported states (the "after" set of the release's before/after screenshots). Output: build/outputs/roborazzi/fix041. */
@OptIn(ExperimentalRoborazziApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class Fix041ScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val out = "build/outputs/roborazzi/fix041"
    private val now = System.currentTimeMillis()
    private val hermes = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, kind = "hermes", label = "Atlas",
        capabilities = Capabilities(sessions = true, skills = true, busy = listOf("queue", "interrupt"), models = "request"))
    private val controls = NativeControls(
        models = { listOf(HubApi.ModelProvider("openrouter", "OpenRouter", listOf("anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro"), true), HubApi.ModelProvider("local", "Local (Ollama)", listOf("qwen3:32b", "llama3.3:70b"), false)) },
        setModel = { m, _ -> m }, busy = { "" }, setBusy = {})
    private fun history() = listOf(
        UiMessage("user", "Can you check why the staging deploy failed?", ts = now - 600_000, hubId = "h.1", n = 1, status = "read"),
        UiMessage("assistant", "The build step ran out of disk. I cleared the cache and re-ran it: green now.", ts = now - 560_000, hubId = "h.2", n = 2),
        UiMessage("user", "Thanks. Now check the deploy log for warnings.", ts = now - 30_000, hubId = "h.3", n = 3, status = "read"),
    )
    private val t0 = now - 9_000
    private fun liveSteps() = StepLog()
        .tool("tool.start", "c1", "terminal", "tail -n 200 /var/log/deploy/staging.log", now = t0).tool("tool.end", "c1", "terminal", ok = true, durationMs = 1240, now = t0 + 1240)
        .note("commentary", "Two warnings in the log. Checking the health-check timings next.", now = t0 + 1500)
        .tool("tool.start", "c2", "read_file", "deploy/healthcheck.yaml", now = t0 + 1700).tool("tool.end", "c2", "read_file", ok = false, durationMs = 310, result = "No such file: deploy/healthcheck.yaml", now = t0 + 2010)
        .tool("tool.start", "c3", "search_files", "healthcheck in deploy/", now = now - 2_000)

    private fun shot(name: String, state: ChatState, input: String = "", send: Boolean = false, screen: Boolean = false, stepsOpen: Boolean = false, open: List<String> = emptyList()) {
        compose.mainClock.autoAdvance = send // the model sheet animates in
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { CompositionLocalProvider(LocalStepsOpen provides stepsOpen) { Box(Modifier.fillMaxSize()) {
            ChatScreen(hermes, listOf(hermes), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, nativeControls = controls, initialInput = input)
        } } } }
        compose.mainClock.advanceTimeBy(1200)
        for (d in open) { compose.onNodeWithContentDescription(d, substring = true).performClick(); compose.mainClock.advanceTimeBy(600) }
        if (send) { compose.onNodeWithContentDescription("Send").performClick(); compose.waitForIdle(); compose.mainClock.advanceTimeBy(1500); compose.waitForIdle(); compose.onNodeWithText("Choose a provider").assertExists() }
        if (screen) captureScreenRoboImage("$out/$name.png") else compose.onRoot().captureRoboImage("$out/$name.png")
    }

    /** Thinking streams into the collapsible Reasoning block; the finished first tool already shows as a step. */
    @Test fun streamingThinking() = shot("01-thinking-streaming", ChatState().apply { load(history(), "s1")
        simulateStream("", "The log is long, so I'll tail the last 200 lines first and look for WARN and ERROR entries. Then I'll compare the health-check timings with the last green deploy.",
            steps = StepLog().tool("tool.start", "c1", "terminal", "tail -n 200 /var/log/deploy/staging.log", now = t0).tool("tool.end", "c1", "terminal", ok = true, durationMs = 1240, now = t0 + 1240)) }, open = listOf("Show reasoning"))
    /** Finished: the reply keeps its Reasoning block and the tools it used; no tick on the agent's bubble (the read tick stays on your own message). */
    @Test fun finished() = shot("02-thinking-finished", ChatState().apply { load(history() + UiMessage("assistant", "Two warnings: a deprecated Node flag and one slow health check (2.4 s). Nothing blocking.", ts = now, hubId = "h.4", n = 4,
        reasoning = "The log is long, so I'll tail the last 200 lines first and look for WARN and ERROR entries. Then I'll compare the health-check timings with the last green deploy.", reasoningMs = 4200,
        steps = listOf(ToolStep("terminal", "tail -n 200 /var/log/deploy/staging.log", "2 warnings", true), ToolStep("read_file", "deploy/healthcheck.yaml", "No such file", false), ToolStep("search_files", "healthcheck in deploy/", "deploy/checks/health.yaml", true)), runId = "r1"), "s1") }, open = listOf("Show reasoning", "Show steps"))
    /** /model on a Hermes agent without the native gateway (capabilities.models = request): the picker opens. */
    @Test fun model() = shot("03-model-picker", ChatState().apply { load(history(), "s1") }, input = "/model", send = true, screen = true)
    /** Live progress: every step of the running reply (tool, preview, spinner → check / cross, duration, commentary). */
    @Test fun progress() = shot("04-live-progress", ChatState().apply { load(history(), "s1"); simulateStream("", "", steps = liveSteps()) }, stepsOpen = true)
}
