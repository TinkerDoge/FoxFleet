package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.screens.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

private val common1 = listOf(
    KindField("name", "ID", "id", required = true, help = "Letters, digits, . _ - (used in links; cannot change later)"),
    KindField("label", "Display name", "text"),
)
private val kinds1 = listOf(
    AgentKind("hermes", "Hermes agent", "Chat, files, skills and voice from a machine running Hermes. It dials out to your hub: no open ports.", false, common1 + listOf(
        KindField("connection", "Connection", "enum", default = "connector", options = listOf("connector", "direct"), help = "Connector: the agent dials out to this hub. Direct: the hub dials the agent (advanced)."),
        KindField("profile", "Profile", "id", default = "default"),
        KindField("dashboardPass", "Dashboard password", "secret", writeOnly = true),
        KindField("host", "Host or IP", "host", required = true, writeOnly = true, advanced = true, whenKey = "connection", whenValue = "direct"),
    )),
    AgentKind("openrouter", "OpenRouter", "Hundreds of models through one OpenRouter API key.", false, common1 + listOf(
        KindField("model", "Model", "text", required = true, default = "openai/gpt-4o-mini"), KindField("apiKey", "API key", "secret", required = true, writeOnly = true))),
    AgentKind("zai", "Z.ai (GLM)", "GLM models from Z.ai with your API key.", false, common1 + listOf(
        KindField("endpoint", "Endpoint", "enum", default = "general", options = listOf("general", "coding")),
        KindField("model", "Model", "text", required = true, default = "glm-5.1"), KindField("apiKey", "API key", "secret", required = true, writeOnly = true)),
        auth = listOf("api_key"), warnings = listOf("The Coding Plan endpoint is licensed by Z.ai for officially supported coding tools only. Use the general endpoint unless you accept the risk.")),
    AgentKind("opencode", "OpenCode", "OpenCode Zen models with your OpenCode API key.", false, common1),
    AgentKind("grok", "Grok (xAI)", "Grok models with your xAI API key.", false, common1),
    AgentKind("mcp-inbox", "MCP inbox", "A mailbox an outside agent (e.g. an outside agent) reads and answers over MCP.", false, common1),
)

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class V1ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("$OUT/v1-$name-${if (dark) "dark" else "light"}.png")
    }
    private val noTest: suspend (AgentKind, Map<String, Any>) -> TestResult = { _, _ -> TestResult(true, emptyList()) }
    private val noSave: suspend (AgentKind, Map<String, Any>) -> SaveResult = { _, _ -> SaveResult(SavedAgent("x", "hermes")) }
    private fun editor(name: String, dark: Boolean, kind: String?, token: String? = null, test: TestResult? = null) = shot(name, dark) {
        AgentEditorScreen(kinds1, null, {}, noTest, noSave, {}, {}, initialKind = kind, initialToken = token, initialTest = test)
    }

    @Test fun hubAddressFirstLaunch() = shot("hub-address", false) { HubAddressScreen("", false, null, { _, _ -> }) }
    @Test fun hubAddressDark() = shot("hub-address", true) { HubAddressScreen("", false, null, { _, _ -> }) }
    @Test fun hubAddressHttpError() = shot("hub-address-http", false) { HubAddressScreen("http://hub.example.com", false, null, { _, _ -> }) }
    @Test fun hubAddressFromLink() = shot("hub-address-link", false) { HubAddressScreen("https://hub.example.com", false, null, { _, _ -> }, onCancel = {}) }
    @Test fun loginSignIn() = shot("login", false) { LoginScreen("hub.example.com", HubApi(SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>())), null, {}, {}, previewInfo = AuthInfo(registration = "invite")) }
    @Test fun loginSignInDark() = shot("login", true) { LoginScreen("hub.example.com", HubApi(SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>())), "Wrong username or password", {}, {}, previewInfo = AuthInfo()) }
    @Test fun loginSetup() = shot("setup", false) { LoginScreen("hub.example.com", HubApi(SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>())), null, {}, {}, previewInfo = AuthInfo(setupRequired = true, setupCodeRequired = true)) }
    @Test fun loginJoin() = shot("join", false) { LoginScreen("hub.example.com", HubApi(SettingsStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>())), null, {}, {}, previewInfo = AuthInfo(registration = "invite"), previewJoin = true) }
    @Test fun devices() = shot("devices", false) { DevicesScreen(null, {}, {}, previewDevices = listOf(
        Device("a", "Pixel 8", "app", System.currentTimeMillis() - 30_000, true), Device("b", "Tablet", "app", System.currentTimeMillis() - 3 * 3600_000, false), Device("c", "Web browser", "web", System.currentTimeMillis() - 2 * 86400_000, false))) }
    @Test fun devicesDark() = shot("devices", true) { DevicesScreen(null, {}, {}, previewDevices = listOf(Device("a", "Pixel 8", "app", System.currentTimeMillis() - 30_000, true), Device("c", "Web browser", "web", System.currentTimeMillis() - 2 * 86400_000, false))) }
    @Test fun hubs() = shot("hubs", false) { HubsScreen(listOf(HubEntry("1", "https://hub.example.com", "hub.example.com"), HubEntry("2", "http://nas.local:3080", "nas.local")), "1", {}, {}, {}, {}) }
    @Test fun settings() = shot("settings", false) { SettingsScreen(AppPrefs(), {}, {}, {}, {}, hubName = "hub.example.com", username = "owner1") }
    @Test fun settingsDark() = shot("settings", true) { SettingsScreen(AppPrefs(theme = ThemeMode.Dark), {}, {}, {}, {}, hubName = "hub.example.com", username = "owner1") }
    @Test fun pickType() = editor("add-type", false, null)
    @Test fun addHermesDirect() = editor("add-hermes-direct", false, "hermes")
    @Test fun addHermesDirectDark() = editor("add-hermes-direct", true, "hermes")
    @Test fun addZai() = editor("add-zai", false, "zai")
    @Test fun addOpenRouter() = editor("add-openrouter", false, "openrouter")
}
