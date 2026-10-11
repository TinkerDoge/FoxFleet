package dev.foxfleet.app.screenshots

import android.graphics.Bitmap
import android.graphics.Color as AColor
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.ScreenPhase
import dev.foxfleet.app.ui.screens.ScreenScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** 0.3.6: reasoning block, pictures the user sends (and the failure tile), and the bot-screen diagnostics. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class Batch6ScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val atlas = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, capabilities = Capabilities(images = true, files = true, sessions = true))
    private val now = System.currentTimeMillis()
    private val thinking = "The user asks why the sky is blue.\n\n- Sunlight scatters off air molecules (**Rayleigh scattering**)\n- Shorter wavelengths scatter more, so blue wins\n- At sunset the path is longer, so red is left\n\nI should keep the answer short."

    private fun chat(dark: Boolean, prefs: AppPrefs = AppPrefs(), msgs: List<UiMessage>, content: ChatState.() -> Unit = {}, block: (ChatState) -> Unit) {
        RuntimeEnvironment.setQualifiers("+w411dp-h891dp-xxhdpi")
        compose.mainClock.autoAdvance = false
        val state = ChatState().apply { load(msgs, "s1"); content() }
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, 1f)) {
                FoxfleetTheme(prefs.copy(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}) } }
            }
        }
        compose.mainClock.advanceTimeBy(1500); compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(800)
        block(state)
    }
    private fun settle() { compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(900) }
    private val convo get() = listOf(
        UiMessage("user", "Why is the sky blue?", ts = now - 60_000),
        UiMessage("assistant", "Because air scatters short wavelengths of sunlight more than long ones, so the sky looks blue.", reasoning = thinking, reasoningMs = 8_200, ts = now - 30_000),
    )

    private fun reasoning(dark: Boolean) = chat(dark, msgs = convo) {
        val tag = if (dark) "dark" else "light"
        compose.onNodeWithTag("reasoning", useUnmergedTree = true).assertIsDisplayed() // the message frame (long press, double tap) merges its children
        compose.onNodeWithContentDescription("Show reasoning, Thought for 8 s").assertIsDisplayed()
        compose.onNodeWithText("Rayleigh scattering", substring = true).assertDoesNotExist() // collapsed by default
        compose.onRoot().captureRoboImage("$OUT/reasoning-1-collapsed-$tag.png")
        compose.onNodeWithContentDescription("Show reasoning, Thought for 8 s").performClick(); settle()
        compose.onNodeWithContentDescription("Hide reasoning, Thought for 8 s").assertIsDisplayed()
        compose.onNodeWithText("Rayleigh scattering", substring = true).assertExists()
        compose.onNodeWithContentDescription("Copy reasoning").assertIsDisplayed()
        compose.onRoot().captureRoboImage("$OUT/reasoning-2-expanded-$tag.png")
        compose.onNodeWithContentDescription("Hide reasoning, Thought for 8 s").performClick(); settle()
        compose.onNodeWithText("Rayleigh scattering", substring = true).assertDoesNotExist()
    }
    @Test fun reasoningLight() = reasoning(false)
    @Test fun reasoningDark() = reasoning(true)

    @Test fun reasoningStreaming() = chat(false, msgs = listOf(UiMessage("user", "Why is the sky blue?", ts = now - 60_000)), content = { simulateStream("", reasoning = "The user asks why the sky is blue. Rayleigh scattering…") }) {
        compose.onNodeWithContentDescription("Show reasoning, Thinking…").assertIsDisplayed()
        compose.onRoot().captureRoboImage("$OUT/reasoning-3-streaming-light.png")
    }

    @Test fun reasoningOffInSettings() = chat(false, prefs = AppPrefs(showReasoning = false), msgs = convo) {
        compose.onNodeWithTag("reasoning", useUnmergedTree = true).assertDoesNotExist(); compose.onNodeWithText("Because air scatters", substring = true).assertExists()
        compose.onRoot().captureRoboImage("$OUT/reasoning-4-setting-off-light.png")
    }

    private fun jpeg(w: Int = 320, h: Int = 240): ByteArray = ByteArrayOutputStream().also { o ->
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888); b.eraseColor(AColor.rgb(240, 140, 60)); b.compress(Bitmap.CompressFormat.JPEG, 80, o)
    }.toByteArray()

    @Test fun userPicturesShowAndFailuresAreVisible() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val good = File(ctx.cacheDir, "attachments").apply { mkdirs() }.let { File(it, "img-good.jpg").apply { writeBytes(jpeg()) } }
        val dataUrl = "data:image/jpeg;base64," + android.util.Base64.encodeToString(jpeg(200, 200), android.util.Base64.NO_WRAP)
        val msgs = listOf(
            UiMessage("user", "What is this?", images = listOf(ImageAttachment(good.absolutePath, dataUrl, good.length().toInt())), ts = now - 120_000),
            UiMessage("assistant", "An orange square.", ts = now - 100_000),
            UiMessage("user", "And the one from yesterday (reloaded from history)?", imageUrls = listOf(dataUrl), ts = now - 80_000),
            UiMessage("user", "This one is broken:", imageUrls = listOf("data:image/jpeg;base64,AAAA"), ts = now - 60_000),
            UiMessage("user", "The file was deleted from the cache; the data URL we sent is the fallback:", images = listOf(ImageAttachment("/nonexistent/img-gone.jpg", dataUrl, 10)), ts = now - 40_000),
        )
        chat(false, msgs = msgs) {
            settle(); settle()
            check(compose.onAllNodesWithContentDescription("Attached image").fetchSemanticsNodes().isNotEmpty())
            check(compose.onAllNodesWithText("Couldn't load this picture").fetchSemanticsNodes().size == 1) { "the broken picture shows a failure tile" }; check(compose.onAllNodesWithContentDescription("Loading picture").fetchSemanticsNodes().isEmpty()) { "nothing spins forever" }
            compose.onNodeWithContentDescription("Retry loading the picture").assertIsDisplayed().performClick(); settle()
            compose.onRoot().captureRoboImage("$OUT/images-1-user-pictures-light.png")
        }
    }

    private fun screenShot(name: String, empty: Boolean, debug: Boolean) {
        RuntimeEnvironment.setQualifiers("+w411dp-h891dp-xxhdpi"); compose.mainClock.autoAdvance = false
        val black = Bitmap.createBitmap(800, 1280, Bitmap.Config.ARGB_8888).apply { eraseColor(AColor.rgb(11, 11, 12)) }
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Dark)) { ScreenScreen("Atlas", api = null, onBack = {}, onLeaveInControl = {}, preview = true, initialPhase = ScreenPhase.Watching, previewFrame = black, initialEmpty = empty, debug = debug) } }
        compose.mainClock.advanceTimeBy(1500); compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(500)
        if (empty) { compose.onNodeWithText("Connected, but the machine's screen is empty", substring = true).assertIsDisplayed(); compose.onNodeWithText("Restart desktop").assertIsDisplayed(); compose.onNodeWithText("Reconnect").assertIsDisplayed() }
        if (debug) compose.onNodeWithText("Send diagnostics").assertIsDisplayed() else compose.onNodeWithText("Send diagnostics").assertDoesNotExist()
        compose.onRoot().captureRoboImage("$OUT/$name.png")
    }
    @Test fun screenEmptyDesktop() = screenShot("screen-1-empty-desktop-dark", empty = true, debug = false)
    @Test fun screenDebugStrip() = screenShot("screen-2-debug-button-dark", empty = false, debug = true)
}
