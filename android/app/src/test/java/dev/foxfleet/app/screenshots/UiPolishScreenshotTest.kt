package dev.foxfleet.app.screenshots

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.screens.FleetScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** The new agent list: pinned on top, newest first, previews with "You: ", Typing…, Needs approval, unread dots, a long name, an offline agent; loading skeleton; empty state. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class UiPolishScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val now = 1_791_633_600_000L // 2026-10-10 12:00 UTC, so labels do not change between runs
    private fun a(name: String, at: Long? = null, role: String? = null, preview: String? = null, pin: Int? = null, working: Boolean = false, needs: Boolean = false, online: Boolean = true, order: Int = 0, label: String? = null, description: String = "") =
        AgentStatus(name, online = online, chatReady = online, managementReady = online, label = label, description = description, order = order, lastActivityAt = at, lastMessagePreview = preview, lastRole = role, pinOrder = pin, working = working, needsInput = needs)
    private val agents = dev.foxfleet.app.ui.AgentList.sort(listOf(
        a("Sumin", now - 3 * 60_000, "assistant", "FoxFleet 0.3.3-alpha is released, merged and cleaned up. CI is green.", pin = 0, order = 0),
        a("Samyn", now - 12 * 60_000, "assistant", "FoxFleet v0.3.3-alpha is published as a pre-release", working = true, order = 1),
        a("Doge Studio Operations Night Shift Agent", now - 2 * 3_600_000, "assistant", "Night shift summary: 3 jobs ran, 1 needs a look in the morning.", order = 2, label = "Doge Studio Operations Night Shift Agent"),
        a("Arzyn", now - 20 * 3_600_000, "user", "The wooden fox icons are ready to review", order = 3),
        a("Rennyn", now - 3L * 86_400_000, "assistant", "Paused. The daily Flow batch stays off until you say so.", needs = true, order = 4),
        a("Soran", now - 6L * 86_400_000, "user", "Soran here. The v0.5 Android build is green", order = 5),
        a("Roseyn", now - 40L * 86_400_000, "assistant", "The SUMI figure brief is done and with Sumin", online = false, order = 6),
        a("Quiet", order = 7, description = "Release engineer"),
    ))
    private val unread = setOf("Samyn", "Soran")

    private fun shot(name: String, dark: Boolean, w: Int, h: Int, fontScale: Float = 1f, content: @Composable () -> Unit) {
        RuntimeEnvironment.setQualifiers("+w${w}dp-h${h}dp-xxhdpi")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale)) { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { content() } } }
        }
        compose.mainClock.advanceTimeBy(1200)
        compose.onRoot().captureRoboImage("$OUT/$name-${if (dark) "dark" else "light"}.png")
    }
    private fun fleet(name: String, dark: Boolean, w: Int, h: Int, list: List<AgentStatus> = agents, loading: Boolean = false, fontScale: Float = 1f) =
        shot(name, dark, w, h, fontScale) { FleetScreen(list, loading = loading, loadedOnce = !loading, error = null, unread = { it.name in unread }, onRefresh = {}, onOpen = {}, onSettings = {}, onAddAgent = {}, userInitials = "MM", now = { now }) }

    @Test fun list360Light() = fleet("10-agent-list-360dp", false, 360, 740)
    @Test fun list360Dark() = fleet("10-agent-list-360dp", true, 360, 740)
    @Test fun list411Light() = fleet("10-agent-list-411dp", false, 411, 891)
    @Test fun list411Dark() = fleet("10-agent-list-411dp", true, 411, 891)
    @Test fun listBigFont360Dark() = fleet("11-agent-list-1.3x-360dp", true, 360, 740, fontScale = 1.3f)
    @Test fun skeleton411Dark() = fleet("12-agent-list-loading-411dp", true, 411, 891, list = emptyList(), loading = true)
    @Test fun empty411Light() = fleet("13-agent-list-empty-411dp", false, 411, 891, list = emptyList())
}
