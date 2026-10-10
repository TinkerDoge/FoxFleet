package dev.foxfleet.app.screenshots

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.components.LocalMediaHost
import dev.foxfleet.app.ui.components.MediaHost
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.FleetScreen
import okhttp3.OkHttpClient
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** fix-batch-5: chat scroll controls, the "outside shared folders" media card, and the agent list from a REAL /api/agents answer. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class FixBatch5ScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val atlas = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, capabilities = Capabilities(images = true, files = true, sessions = true))
    private val now = System.currentTimeMillis()

    private fun chat(dark: Boolean, host: MediaHost? = null, content: ChatState.() -> Unit = {}, block: (ChatState) -> Unit) {
        RuntimeEnvironment.setQualifiers("+w411dp-h891dp-xxhdpi")
        compose.mainClock.autoAdvance = false
        val msgs = (0 until 40).map { UiMessage(if (it % 2 == 0) "assistant" else "user", if (it % 2 == 0) "Answer $it. The build is green and the notes are updated." else "Question $it: how is step $it going?", ts = now - (40 - it) * 60_000L) }
        val state = ChatState().apply { load(msgs, "s1"); content() }
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, 1f), LocalMediaHost provides host) {
                FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}) } }
            }
        }
        compose.mainClock.advanceTimeBy(1500); compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(800)
        block(state)
    }
    private fun list() = compose.onNode(hasScrollAction())
    private fun settle() { compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(900) }

    private fun scrollFlow(dark: Boolean) = chat(dark) { state ->
        val tag = if (dark) "dark" else "light"
        compose.onNodeWithContentDescription("Go to the latest message").assertDoesNotExist() // opened at the bottom: no control
        compose.onRoot().captureRoboImage("$OUT/scroll-1-opened-$tag.png")
        repeat(4) { list().performTouchInput { swipeDown() }; settle() }
        compose.onNodeWithContentDescription("Go to the latest message").assertIsDisplayed()
        compose.onRoot().captureRoboImage("$OUT/scroll-2-arrow-$tag.png")
        state.push(UiMessage("assistant", "Done. The release notes are updated and CI is green.", ts = now)); settle()
        compose.onNodeWithContentDescription("New message").assertIsDisplayed() // no yank: still scrolled up
        compose.onRoot().captureRoboImage("$OUT/scroll-3-pill-$tag.png")
        state.push(UiMessage("assistant", "One more thing.", ts = now)); settle()
        compose.onNodeWithContentDescription("2 new messages").assertIsDisplayed()
        compose.onNodeWithContentDescription("2 new messages").performClick(); settle(); settle()
        compose.onNodeWithContentDescription("2 new messages").assertDoesNotExist(); compose.onNodeWithContentDescription("Go to the latest message").assertDoesNotExist()
        compose.onRoot().captureRoboImage("$OUT/scroll-4-bottom-$tag.png")
    }
    @Test fun scrollFlowLight() = scrollFlow(false)
    @Test fun scrollFlowDark() = scrollFlow(true)

    @Test fun mediaOutsideSharedFolders() {
        val host = MediaHost(OkHttpClient()) { _, _ -> throw HubApiException(403, "That file is outside the folders this machine shares", code = "outside") }
        RuntimeEnvironment.setQualifiers("+w411dp-h891dp-xxhdpi"); compose.mainClock.autoAdvance = false
        val state = ChatState().apply { load(listOf(UiMessage("user", "Send me the chart", ts = now - 60_000), UiMessage("assistant", "Here it is.\nMEDIA:/home/me/projects/out/chart.png", ts = now - 30_000)), "s2") }
        compose.setContent { CompositionLocalProvider(LocalMediaHost provides host) { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}) } } } }
        compose.mainClock.advanceTimeBy(1500); settle()
        compose.onNodeWithText("Not available: outside shared folders").assertIsDisplayed()
        compose.onNodeWithText("Copy fix").assertIsDisplayed()
        compose.onRoot().captureRoboImage("$OUT/media-outside-shared-folders.png")
    }

    @Test fun agentListFromARealHubAnswer() {
        var d = File("").absoluteFile; while (!File(d, "contract/agents-activity.sample.json").exists()) d = d.parentFile!!
        val real = HubApi.parseAgents(File(d, "contract/agents-activity.sample.json").readText()).map { it.copy(lastActivityAt = now - 3 * 60_000L) }
        val old = real.first().copy(name = "Old hub agent", lastActivityAt = null, lastMessagePreview = null, lastRole = null, lastSessionTitle = null)
        RuntimeEnvironment.setQualifiers("+w411dp-h891dp-xxhdpi"); compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { FleetScreen(real + old, loading = false, loadedOnce = true, error = null, unread = { false }, onRefresh = {}, onOpen = {}, onSettings = {}) } } }
        compose.mainClock.advanceTimeBy(1500); settle()
        compose.onNodeWithText("Here is the plan we agreed on", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText("Fixture").assertCountEquals(2) // an old hub: the row still renders (no time, no preview), never an empty hole
        compose.onRoot().captureRoboImage("$OUT/fleet-real-answer.png")
    }
}
