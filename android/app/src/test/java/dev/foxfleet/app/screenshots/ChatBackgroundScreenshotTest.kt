package dev.foxfleet.app.screenshots

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AColor
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.BgMode
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.ChatBackgroundStore
import dev.foxfleet.app.data.ChatBg
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.ChatBackgroundContent
import dev.foxfleet.app.ui.chat.ChatBackgroundState
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** Chat backgrounds (0.3.10): the chat over each kind of background, the picker body, and the attachment menu with icons. Run with -Proborazzi.test.record=true. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ChatBackgroundScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val atlas = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, capabilities = Capabilities(images = true, files = true, sessions = true))
    private val now = System.currentTimeMillis()
    private val convo = listOf(
        UiMessage("user", "Summarise last week's usage per agent.", ts = now - 120_000),
        UiMessage("assistant", "Here is the **weekly summary**:\n\n| Agent | Tokens |\n| --- | --- |\n| Atlas | 912k |\n| Nova | 604k |\n\nFriday was the busiest day.", ts = now - 90_000),
        UiMessage("user", "Thanks. Can you rotate Echo's key too?", ts = now - 60_000),
    )
    private lateinit var store: ChatBackgroundStore
    private val key get() = store.key("Atlas", "s1")

    @Before fun clean() { store = ChatBackgroundStore(RuntimeEnvironment.getApplication()); store.clearAll() }

    private fun photo() { // a mountain-ish gradient picture, stored the way a picked one is
        val b = Bitmap.createBitmap(900, 1400, Bitmap.Config.ARGB_8888); val c = Canvas(b)
        c.drawRect(0f, 0f, 900f, 1400f, Paint().apply { shader = LinearGradient(0f, 0f, 0f, 1400f, intArrayOf(AColor.rgb(250, 190, 120), AColor.rgb(120, 90, 160), AColor.rgb(30, 40, 90)), null, Shader.TileMode.CLAMP) })
        val p = Paint().apply { color = AColor.rgb(60, 50, 110); isAntiAlias = true }
        for (i in 0 until 6) c.drawCircle(150f * i + 40f, 1150f + (i % 2) * 90f, 330f, p)
        store.writeImage(key, b)
    }
    private fun seed(bg: ChatBg) { if (bg.image) photo(); store.save(key, bg) }

    private fun chat(name: String, dark: Boolean, bg: ChatBg, act: () -> Unit = {}) {
        seed(bg)
        compose.mainClock.autoAdvance = false
        val state = ChatState().apply { load(convo, "s1") }
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { Box(Modifier.fillMaxSize()) { ChatScreen(atlas, listOf(atlas), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}) } } }
        Thread.sleep(400); compose.mainClock.advanceTimeBy(1500); compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(800)
        act()
        compose.onRoot().captureRoboImage("$OUT/android-$name-${if (dark) "dark" else "light"}.png")
    }
    private fun settle() { Thread.sleep(400); compose.mainClock.autoAdvance = true; compose.waitForIdle(); compose.mainClock.autoAdvance = false; compose.mainClock.advanceTimeBy(900) }

    @Test fun defaultDark() = chat("chat-default", true, ChatBg())
    @Test fun solidDark() = chat("chat-solid-sage", true, ChatBg(BgMode.Solid, solid = "sage"))
    @Test fun solidLight() = chat("chat-solid-sage", false, ChatBg(BgMode.Solid, solid = "sage"))
    @Test fun pawsDark() = chat("chat-pattern-paws", true, ChatBg(BgMode.Pattern, solid = "sand", pattern = "paws"))
    @Test fun pawsLight() = chat("chat-pattern-paws", false, ChatBg(BgMode.Pattern, solid = "sand", pattern = "paws"))
    @Test fun foxesDark() = chat("chat-pattern-foxes", true, ChatBg(BgMode.Pattern, solid = "sky", pattern = "foxes"))
    @Test fun topoLight() = chat("chat-pattern-topography", false, ChatBg(BgMode.Pattern, solid = "teal", pattern = "topography"))
    @Test fun starsDark() = chat("chat-pattern-stars", true, ChatBg(BgMode.Pattern, solid = "midnight", pattern = "stars"))
    @Test fun imageDark() = chat("chat-image-blur0-dim25", true, ChatBg(BgMode.Image, blur = 0, dim = 0.25f, image = true))
    @Test fun imageBlurDark() = chat("chat-image-blur12-dim45", true, ChatBg(BgMode.Image, blur = 12, dim = 0.45f, image = true))
    @Test fun imageLight() = chat("chat-image-blur0-dim0", false, ChatBg(BgMode.Image, blur = 0, dim = 0f, image = true))
    @Test fun imageBlurLight() = chat("chat-image-blur20-dim30", false, ChatBg(BgMode.Image, blur = 20, dim = 0.3f, image = true))

    @Test fun attachMenuDark() = chat("attach-menu", true, ChatBg()) {
        compose.onNodeWithContentDescription("Attach").performClick(); settle()
        compose.onNodeWithText("Photo library").assertIsDisplayed(); compose.onNodeWithText("Take photo").assertIsDisplayed()
    }
    @Test fun attachMenuLight() = chat("attach-menu", false, ChatBg()) { compose.onNodeWithContentDescription("Attach").performClick(); settle() }

    private fun panel(name: String, dark: Boolean, bg: ChatBg) {
        seed(bg); compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) {
            val c = LocalHubColors.current
            Box(Modifier.fillMaxSize().background(c.surface).padding(16.dp)) { ChatBackgroundContent(ChatBackgroundState(store, RuntimeEnvironment.getApplication() as Context, key, kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main))) {} }
        } }
        compose.mainClock.advanceTimeBy(900)
        compose.onRoot().captureRoboImage("$OUT/android-picker-$name-${if (dark) "dark" else "light"}.png")
    }
    @Test fun pickerDefaultDark() = panel("default", true, ChatBg())
    @Test fun pickerSolidLight() = panel("solid", false, ChatBg(BgMode.Solid, solid = "sage"))
    @Test fun pickerPatternDark() = panel("pattern", true, ChatBg(BgMode.Pattern, solid = "sand", pattern = "paws"))
    @Test fun pickerImageLight() = panel("image", false, ChatBg(BgMode.Image, blur = 12, dim = 0.45f, image = true))
}
