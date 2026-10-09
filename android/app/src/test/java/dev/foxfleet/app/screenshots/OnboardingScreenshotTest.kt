package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Machine
import dev.foxfleet.app.data.Pairing
import dev.foxfleet.app.data.PairingState
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.screens.MachinesContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"
private val machines = listOf(
    Machine("a".repeat(32), "Workstation", true, null, listOf("default", "coder", "research")),
    Machine("b".repeat(32), "Laptop", false, System.currentTimeMillis() - 3 * 3600_000, listOf("default")),
)
private val url = "https://hub.example.com/c/K7QMX2PD4H"
private val pairing = Pairing("K7QMX2PD4H", "K7QMX-2PD4H", System.currentTimeMillis() + 15 * 60_000, url, "foxfleet://pair?hub=https%3A%2F%2Fhub.example.com&code=K7QMX2PD4H",
    listOf("11111110111010100110001111111",
        "10000010111000000001001000001",
        "10111010101101011111101011101",
        "10111010110100101001001011101",
        "10111010000001101110001011101",
        "10000010100111100101001000001",
        "11111110101010101010101111111",
        "00000000010010110111000000000",
        "11001110000101101101100101111",
        "01111000111010010010001111111",
        "11010111000111111000001110001",
        "11001100101101010111101011011",
        "01011111001011000110110000010",
        "11110100100001101110111011111",
        "01001011001000011010110111101",
        "10111100001010111110111100011",
        "00010110011101101001110000010",
        "11010100111010001110001111011",
        "00100111111111111000011000101",
        "00011100100101001110101000011",
        "11010010011011001110111111001",
        "00000000101001110001100010001",
        "11111110001000011011101011101",
        "10000010110010111111100010011",
        "10111010100101111001111111010",
        "10111010010010001001110100001",
        "10111010011111110100010001111",
        "10000010101101010111100101011",
        "11111110111011010000110001010"), "curl -fsSL $url | sh", "irm $url.ps1 | iex", "node …")

/** Onboarding screens: machines list and the "Connect a machine" flow in each live state. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class OnboardingScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("$OUT/onboarding-$name-${if (dark) "dark" else "light"}.png")
    }
    private fun content(m: List<Machine>?, p: Pairing?, s: PairingState) = @Composable { MachinesContent(m, p, s, null, {}, {}, {}, {}, {}) }
    @Test fun list() = shot("machines", false, content(machines, null, PairingState.Waiting))
    @Test fun listDark() = shot("machines", true, content(machines, null, PairingState.Waiting))
    @Test fun empty() = shot("machines-empty", false, content(emptyList(), null, PairingState.Waiting))
    @Test fun waiting() = shot("connect-waiting", false, content(machines, pairing, PairingState.Waiting))
    @Test fun waitingDark() = shot("connect-waiting", true, content(machines, pairing, PairingState.Waiting))
    @Test fun found() = shot("connect-found", false, content(machines, pairing, PairingState.Paired(machines[0])))
    @Test fun expired() = shot("connect-expired", false, content(machines, pairing, PairingState.Expired))
}
