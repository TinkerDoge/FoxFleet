package dev.foxfleet.app.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.notify.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.screens.MuteDialog
import dev.foxfleet.app.ui.screens.NotifyActions
import dev.foxfleet.app.ui.screens.NotificationsSectionContent
import dev.foxfleet.app.ui.screens.PermissionDialog
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getenv("FOXFLEET_SHOTS") ?: "build/outputs/roborazzi"

/** Settings > Notifications in every state the user can see. Run with -Proborazzi.test.record=true; files land in $FOXFLEET_SHOTS (notif-*.png). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h1500dp-xxhdpi")
class NotifyScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val channels = NotifyChannel.entries.map { ChannelStatus(it, true, false, false) }
    private val now = System.currentTimeMillis()
    private val agents = listOf(
        AgentRow("nova", "Nova", null, emptyList()),
        AgentRow("atlas", "Atlas", MuteRule("atlas", null, now + 2 * 3600_000L), emptyList()),
        AgentRow("echo", "Echo", null, listOf(MuteRule("echo", "h_2", null)), chats = listOf(SessionInfo("h_1", "Deploy the docs", 0), SessionInfo("h_2", "Weekly summary", 0), SessionInfo("h_3", null, 0)), expanded = true),
    )
    private val on = NotifyUiState(loaded = true, serviceOn = true, link = NotifyLink.Connected, channels = channels, agents = agents)

    private fun shot(name: String, dark: Boolean, ui: NotifyUiState, extra: @Composable () -> Unit = {}) {
        RuntimeEnvironment.setQualifiers("+w411dp-h1500dp-xxhdpi")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) {
                Column(Modifier.fillMaxSize().background(LocalHubColors.current.bg).statusBarsPadding().padding(horizontal = 16.dp).verticalScroll(rememberScrollState())) {
                    Text("Settings", style = MaterialTheme.typography.titleLarge, color = LocalHubColors.current.text, modifier = Modifier.padding(vertical = 12.dp))
                    NotificationsSectionContent(ui, NotifyActions())
                }
                extra()
            }
        }
        compose.mainClock.advanceTimeBy(600)
        compose.onRoot().captureRoboImage("$OUT/notif-$name-${if (dark) "dark" else "light"}.png")
    }

    @Test fun connectedDark() = shot("connected", true, on)
    @Test fun connectedLight() = shot("connected", false, on)
    @Test fun reconnecting() = shot("reconnecting", true, on.copy(link = NotifyLink.Reconnecting(2)))
    @Test fun offline() = shot("offline", true, on.copy(link = NotifyLink.Offline))
    @Test fun offDark() = shot("off", true, NotifyUiState(loaded = true, serviceOn = false, channels = channels))
    @Test fun offLight() = shot("off", false, NotifyUiState(loaded = true, serviceOn = false, channels = channels))
    @Test fun permissionMissingDark() = shot("permission-missing", true, on.copy(permission = PermissionState.NeedsRequest, link = NotifyLink.Off))
    @Test fun permissionMissingLight() = shot("permission-missing", false, on.copy(permission = PermissionState.NeedsRequest, link = NotifyLink.Off))
    @Test fun permissionBlocked() = shot("permission-blocked", true, on.copy(permission = PermissionState.Blocked, link = NotifyLink.Off))
    @Test fun channelOff() = shot("channel-off", true, on.copy(channels = channels.map { if (it.channel == NotifyChannel.Approvals) it.copy(blocked = true) else it }))
    @Test fun testSending() = shot("test-sending", true, on.copy(test = TestOutcome.Sending))
    @Test fun testSentDark() = shot("test-sent", true, on.copy(test = TestOutcome.Sent))
    @Test fun testSentLight() = shot("test-sent", false, on.copy(test = TestOutcome.Sent))
    @Test fun testHubMuted() = shot("test-hub-switch-off", true, on.copy(test = TestOutcome.HubMuted))
    @Test fun testFailedDark() = shot("test-failed", true, on.copy(test = TestOutcome.Failed("Can't reach your hub.")))
    @Test fun testFailedLight() = shot("test-failed", false, on.copy(test = TestOutcome.Failed("Can't reach your hub.")))
    @Test fun testRateLimited() = shot("test-rate-limited", true, on.copy(test = TestOutcome.RateLimited(60)))
    @Test fun oldHub() = shot("old-hub", true, NotifyUiState(loaded = true, hubSupported = false, channels = channels))
    @Test fun rationaleDialog() = shot("rationale-dialog", true, NotifyUiState(loaded = true, channels = channels)) { PermissionDialog(blocked = false, onAllow = {}, onSettings = {}, onDismiss = {}) }
    @Test fun blockedDialog() = shot("blocked-dialog", false, NotifyUiState(loaded = true, channels = channels)) { PermissionDialog(blocked = true, onAllow = {}, onSettings = {}, onDismiss = {}) }
    @Test fun muteDialog() = shot("mute-dialog", true, on) { MuteDialog("Mute Nova", {}, {}) }
}
