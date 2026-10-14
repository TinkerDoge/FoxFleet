package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.FileMarker
import dev.foxfleet.app.data.FileRef
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.FleetScreen
import dev.foxfleet.app.ui.screens.LoginScreen
import dev.foxfleet.app.ui.screens.ScreenPhase
import dev.foxfleet.app.ui.screens.ScreenScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

private val fleet04 = listOf(
    AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, activeSessions = 2),
    AgentStatus("Nova", online = true, chatReady = true, managementReady = true),
    AgentStatus("Sora", online = true, chatReady = true, managementReady = true, label = "Sora"),
    AgentStatus("Echo", online = false, chatReady = false, managementReady = false),
)

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class V04ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("$OUT/$name-${if (dark) "dark" else "light"}.png")
    }

    private fun fleet(dark: Boolean) = shot("fleet-v04", dark) {
        FleetScreen(fleet04, loading = false, loadedOnce = true, error = null, unread = { it.name == "Sora" }, onRefresh = {}, onOpen = {}, onSettings = {})
    }

    private fun files(dark: Boolean) {
        val report = FileRef("Q3 report.pdf", "/home/atlas/foxfleet-uploads/2026-10-09/mv0ie57c-Q3 report.pdf", 2_456_000)
        val state = ChatState().apply {
            load(listOf(
                UiMessage("user", FileMarker.compose("Summarise this and flag anything odd in the cash flow.", listOf(report))),
                UiMessage("assistant", "Read **Q3 report.pdf** (14 pages). Revenue is up 12%, but operating cash flow dropped because receivables doubled in September."),
            ), "a1b2c3d4e5")
        }
        shot("chat-files", dark) {
            ChatScreen(fleet04[0], fleet04, state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {},
                onUploadFile = { _, _ -> report }, onOpenScreen = {},
                initialFiles = listOf(FileRef("site-plan.zip", "/x/site-plan.zip", 18_874_368)))
        }
    }

    private fun screen(phase: ScreenPhase) = shot("screen-${phase.name.lowercase()}", true) {
        ScreenScreen("Atlas", api = null, onBack = {}, onLeaveInControl = {}, preview = true, initialPhase = phase,
            initialHandBackAt = if (phase == ScreenPhase.Control) System.currentTimeMillis() + 14 * 60_000 + 30_000 else 0)
    }

    private fun login(dark: Boolean) {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = SettingsStore(ctx)
        shot("login-brand", dark) { LoginScreen("hub.example.com", HubApi(store), null, {}, {}, previewInfo = dev.foxfleet.app.data.AuthInfo()) }
    }

    @Test fun fleetLight() = fleet(false)
    @Test fun fleetDark() = fleet(true)
    @Test fun filesLight() = files(false)
    @Test fun filesDark() = files(true)
    @Test fun screenWatching() = screen(ScreenPhase.Watching)
    @Test fun screenControl() = screen(ScreenPhase.Control)
    @Test fun screenStopped() = screen(ScreenPhase.Stopped)
    @Test fun loginLight() = login(false)
    @Test fun loginDark() = login(true)
}
