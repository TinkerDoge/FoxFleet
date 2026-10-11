package dev.foxfleet.app.screenshots

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"
private val TAG = System.getProperty("foxfleet.headertag") ?: "after"

/** The chat header with every action present (Screen, Background, History, New chat) on narrow phones, a long agent name and font scale 1.3. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ChatHeaderScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val agent = AgentStatus("research-assistant", online = true, chatReady = true, managementReady = true, label = "Research assistant for the whole team", capabilities = Capabilities(images = true, files = true, sessions = true, screen = true))

    private fun header(widthDp: Int, scale: Float, dark: Boolean) {
        RuntimeEnvironment.setQualifiers("+w${widthDp}dp-h700dp-xxhdpi")
        compose.mainClock.autoAdvance = false
        val state = ChatState().apply { load(listOf(UiMessage("user", "Hello", ts = System.currentTimeMillis())), "s1") }
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, scale)) {
                FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { ChatScreen(agent, listOf(agent), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, onOpenScreen = {}) } }
            }
        }
        compose.mainClock.advanceTimeBy(1200)
        compose.onRoot().captureRoboImage("$OUT/android-header-$TAG-${widthDp}dp-x${scale}-${if (dark) "dark" else "light"}.png")
    }
    @Test fun w320() = header(320, 1f, true)
    @Test fun w320Large() = header(320, 1.3f, true)
    @Test fun w360() = header(360, 1f, true)
    @Test fun w360Large() = header(360, 1.3f, false)
}
