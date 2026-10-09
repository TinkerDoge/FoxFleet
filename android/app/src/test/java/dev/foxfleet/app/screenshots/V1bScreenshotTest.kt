package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
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
// Real, scannable matrices produced by the hub's encoder (server/qr.js).
private val PAIR_ROWS: List<String> = listOf("11111110010000001011101111111", "10000010110110110110101000001", "10111010011100101010101011101", "10111010110101100110101011101", "10111010001011100101101011101", "10000010101000010000001000001", "11111110101010101010101111111", "00000000000010000000000000000", "11111011111011110101010101010", "00011100110000001111111111111", "10111010110110011010110100100", "00001100011100111011101101000", "00100011010111111101100001100", "10001101001011001001011011011", "10110110111000110000001100000", "00011101000000110010101101001", "00101011001111100100100001100", "11001000101100101001111010011", "10111111101000011000101001100", "10001100111100001011011001000", "10001110111111100100111110110", "00000000101101000000100010111", "11111110111000111011101010000", "10000010011110001011100011001", "10111010101011100100111111101", "10111010110100000001000101011", "10111010101010110111011011010", "10000010101100100000101001010", "11111110100111001111011010100")
private val INVITE_ROWS: List<String> = listOf("111111100100001111110111001111111", "100000101101100111001100101000001", "101110100111001110101100001011101", "101110101101110001000010001011101", "101110100010111010111111001011101", "100000101010000101100000101000001", "111111101010101010101010101111111", "000000000001101000001110000000000", "111110111110011111010000010101010", "111111001101101001111011001001111", "111100101100011111000000111110110", "001101010110100000000100101011101", "011110101100101001001001110111011", "010100010010001011111001001000101", "101100110100101100001010010011010", "110010011000100100001110010011110", "011110100110011011110001010110010", "001111001011011110111001101000001", "100100101110110111001010100010110", "010100000100000110100111111101111", "110011100001101011000010110111010", "100010000100001001111001011001101", "101111110010010110100100010011110", "100100011001000110000100000011110", "101111111000010101011010111110000", "000000001011001011111111100010101", "111111101000001101001111101010010", "100000100001000110101111100010101", "101110101100011111000010111111001", "101110101011110010011100100110000", "101110101100111111000000011100010", "100000101001100100111100011010100", "111111101110101001010001111010010")

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class V1bScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("$OUT/v1b-$name-${if (dark) "dark" else "light"}.png")
    }
    private val soon = System.currentTimeMillis()
    private val users = listOf(AdminUser("1", "owner1", "owner", false), AdminUser("2", "alice", "user", false), AdminUser("3", "bob", "user", true))
    private val invites = listOf(Invite("a", soon + 60 * 3600_000L, false), Invite("b", soon + 5 * 3600_000L, false))

    @Test fun adminLight() = shot("admin", false) { AdminScreen(null, {}, previewMode = "invite", previewPairing = Shareable("foxfleet://connect?hub=https://hub.example.com", PAIR_ROWS), previewInvites = invites, previewUsers = users) }
    @Test fun adminDark() = shot("admin", true) { AdminScreen(null, {}, previewMode = "closed", previewPairing = Shareable("foxfleet://connect?hub=https://hub.example.com", PAIR_ROWS), previewInvites = emptyList(), previewUsers = users) }
    @Test fun adminNewInvite() = shot("admin-invite", false) { AdminScreen(null, {}, previewMode = "invite", previewPairing = null, previewInvites = invites, previewUsers = users, previewNewInvite = Shareable("foxfleet://connect?hub=https://hub.example.com&invite=Xk2mQ9vTzR4nB7wLpA3", INVITE_ROWS)) }
    @Test fun firstLaunchWithScan() = shot("first-launch-scan", false) { HubAddressScreen("", false, null, { _, _ -> }) }
    @Test fun firstLaunchScanned() = shot("first-launch-scanned", true) { HubAddressScreen("https://hub.example.com", false, null, { _, _ -> }) }
    @Test fun joinWithInvite() = shot("join-invite", false) { LoginScreen("hub.example.com", HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>())), null, inviteCode = "Xk2mQ9vTzR4nB7wLpA3", onChangeHub = {}, onLoggedIn = {}, previewInfo = AuthInfo(registration = "invite"), previewJoin = true) }
    @Test fun settingsOwner() = shot("settings-owner", false) { SettingsScreen(AppPrefs(), {}, {}, {}, {}, hubName = "hub.example.com", username = "owner1", isOwner = true) }
}
