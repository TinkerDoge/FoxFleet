package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentKind
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.CheckResult
import dev.foxfleet.app.data.KindField
import dev.foxfleet.app.data.SaveResult
import dev.foxfleet.app.data.SavedAgent
import dev.foxfleet.app.data.TestResult
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.screens.AgentEditorScreen
import dev.foxfleet.app.ui.screens.AgentsScreen
import dev.foxfleet.app.ui.screens.FleetScreen
import dev.foxfleet.app.ui.screens.SettingsScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

private val fleet05 = listOf(
    AgentStatus("Atlas", true, true, true, activeSessions = 2, description = "Studio lead and system architect"),
    AgentStatus("Nova", true, true, true, description = "Keeps repos tidy and ships releases"),
    AgentStatus("Sora", true, true, true, label = "Sora", description = "Fast second opinion"),
    AgentStatus("Echo", false, false, false, description = "Video editor and clip harvester"),
)

private val common = listOf(
    KindField("name", "ID", "id", required = true, help = "Letters, digits, . _ - (used in links; cannot change later)"),
    KindField("label", "Display name", "text"),
    KindField("description", "Description", "multiline"),
)
val kinds05 = listOf(
    AgentKind("hermes", "Hermes agent", "A Hermes Agent install on your network: chat, files, skills, voice and its desktop screen.", false, common + listOf(
        KindField("host", "Host or IP", "host", required = true, writeOnly = true),
        KindField("profile", "Profile", "id", default = "default"),
        KindField("dashboardPort", "Dashboard port", "port", writeOnly = true, default = "9119"),
        KindField("dashboardUser", "Dashboard user", "text", default = "admin"),
        KindField("dashboardPass", "Dashboard password", "secret", writeOnly = true),
        KindField("apiServerPort", "Chat API port", "port", writeOnly = true, default = "8642"),
        KindField("apiServerKey", "Chat API key", "secret", writeOnly = true),
        KindField("dashboardUrl", "Dashboard HTTPS origin", "url", writeOnly = true, advanced = true),
    )),
)
private val saved05 = listOf(
    SavedAgent("Atlas", "hermes", mapOf("description" to "Studio lead and system architect", "profile" to "companion", "dashboardUser" to "admin"), setOf("host", "dashboardPort", "apiServerPort", "dashboardPass", "apiServerKey")),
    SavedAgent("Nova", "hermes", mapOf("description" to "Keeps repos tidy and ships releases", "profile" to "release"), setOf("host")),
    SavedAgent("Sora", "hermes", mapOf("description" to "Fast second opinion", "profile" to "sora"), setOf("host")),
    SavedAgent("Echo", "hermes", mapOf("description" to "Video editor and clip harvester"), setOf("host")),
)

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class V05ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("$OUT/v05-$name-${if (dark) "dark" else "light"}.png")
    }

    private val noTest: suspend (AgentKind, Map<String, Any>) -> TestResult = { _, _ -> TestResult(true, emptyList()) }
    private val noSave: suspend (AgentKind, Map<String, Any>) -> SaveResult = { _, f -> SaveResult(SavedAgent("x", "hermes")) }

    private fun editor(name: String, dark: Boolean, existing: SavedAgent?, kind: String?, test: TestResult? = null) = shot(name, dark) {
        AgentEditorScreen(kinds05, existing, {}, noTest, noSave, {}, {}, initialKind = kind, initialTest = test)
    }

    @Test fun fleetLight() = shot("fleet", false) { FleetScreen(fleet05, loading = false, loadedOnce = true, error = null, unread = { it.name == "Sora" }, onRefresh = {}, onOpen = {}, onSettings = {}) }
    @Test fun fleetDark() = shot("fleet", true) { FleetScreen(fleet05, loading = false, loadedOnce = true, error = null, unread = { false }, onRefresh = {}, onOpen = {}, onSettings = {}) }
    @Test fun settingsLight() = shot("settings", false) { SettingsScreen(AppPrefs(), {}, {}, {}, {}) }
    @Test fun agentsLight() = shot("agents", false) { AgentsScreen(saved05, null, {}, {}, {}, { _, _ -> }) }
    @Test fun agentsDark() = shot("agents", true) { AgentsScreen(saved05, null, {}, {}, {}, { _, _ -> }) }
    @Test fun agentsEmpty() = shot("agents-empty", false) { AgentsScreen(emptyList(), null, {}, {}, {}, { _, _ -> }) }
    @Test fun addPickType() = editor("add-type", false, null, null)
    @Test fun addPickTypeDark() = editor("add-type", true, null, null)
    @Test fun addHermesTested() = editor("add-hermes-tested", false, null, "hermes", TestResult(false, listOf(
        "dashboard" to CheckResult(true, "Dashboard reachable"), "management" to CheckResult(true, "Management authenticated"),
        "api" to CheckResult(false, "Chat API unavailable, invalid or authentication failed"))))
    @Test fun editHermes() = editor("edit-hermes", false, saved05[0], "hermes")
    @Test fun editHermesDark() = editor("edit-hermes", true, saved05[0], "hermes")
}
