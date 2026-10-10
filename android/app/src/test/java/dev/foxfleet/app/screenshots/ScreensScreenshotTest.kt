package dev.foxfleet.app.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.FleetScreen
import dev.foxfleet.app.ui.screens.SettingsScreen
import dev.foxfleet.app.ui.screens.AvatarCropScreen
import dev.foxfleet.app.ui.chat.MediaRef
import dev.foxfleet.app.data.ImageAttachment
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

private val agents = listOf(
    AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, activeSessions = 2),
    AgentStatus("Nova", online = true, chatReady = true, managementReady = true),
    AgentStatus("Orion", online = true, chatReady = false, managementReady = true),
    AgentStatus("Pixel", online = true, chatReady = true, managementReady = false),
    AgentStatus("Echo", online = false, chatReady = false, managementReady = false),
)

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreensScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() }
        }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("$OUT/$name-${if (dark) "dark" else "light"}.png")
    }

    private fun fleet(dark: Boolean) = shot("fleet", dark) {
        FleetScreen(agents, loading = false, loadedOnce = true, error = null, unread = { it.name == "Nova" }, onRefresh = {}, onOpen = {}, onSettings = {})
    }

    private fun chat(dark: Boolean) {
        val state = ChatState().apply {
            load(listOf(
                UiMessage("user", "Can you check why the Companion build failed last night?"),
                UiMessage("assistant", "Sure. The release job ran out of disk on box-01 during assembleRelease; I cleared the Gradle cache and re-queued it."),
                UiMessage("user", "Nice. Is 0.12.8 merged?"),
            ), "a1b2c3d4e5")
            simulateStream("Yes, 0.12.8 is on main at c312b31 and origin only has main left. I'm now checking the", tool = null)
        }
        shot("chat-streaming-keyboard", dark) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f)) {
                    ChatScreen(agents[0], agents, state, listOf(SessionInfo("a1b2c3d4e5", "Build triage")), { false },
                        { _, _ -> }, {}, {}, {}, {}, {}, {}, initialInput = "Also bump the")
                }
                // Simulated soft keyboard occupying the bottom of the window.
                Box(Modifier.fillMaxWidth().height(290.dp).background(if (dark) Color(0xFF2A2A2D) else Color(0xFFD9D6D1)), contentAlignment = Alignment.Center) {
                    Text("keyboard", color = Color.Gray)
                }
            }
        }
    }

    private fun thinking(dark: Boolean) {
        val state = ChatState().apply {
            load(listOf(UiMessage("user", "Summarise today's gaming news")), null)
            simulateStream("", reasoning = "")
        }
        shot("chat-thinking", dark) {
            ChatScreen(agents[0], agents, state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {})
        }
    }

    private fun sampleImage(): ImageAttachment {
        val bmp = android.graphics.Bitmap.createBitmap(480, 320, android.graphics.Bitmap.Config.ARGB_8888)
        val cv = android.graphics.Canvas(bmp)
        cv.drawColor(android.graphics.Color.rgb(222, 140, 92))
        val p = android.graphics.Paint().apply { color = android.graphics.Color.rgb(250, 230, 200) }
        cv.drawCircle(340f, 110f, 60f, p)
        p.color = android.graphics.Color.rgb(60, 70, 90); cv.drawRect(0f, 230f, 480f, 320f, p)
        val f = java.io.File.createTempFile("shot", ".jpg")
        f.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, it) }
        return ImageAttachment(f.absolutePath, "data:image/jpeg;base64,AA", 10)
    }

    private val richReply = """
        |## Build status
        |The **release job** failed on `box-01`. Fix applied:
        |
        || Step | Result |
        ||---|---|
        || assembleRelease | ✅ |
        || tests | 1,333 passed |
        |
        |```bash
        |./gradlew --max-workers=2 assembleDebug
        |```
        |Clip of the run: https://hub.example.com/demo/run.mp4
        """.trimMargin()

    private fun rich(dark: Boolean) {
        val pic = sampleImage()
        val state = ChatState().apply {
            load(listOf(
                UiMessage("user", "Why did it fail? Screenshot attached", images = listOf(pic)),
                UiMessage("assistant", richReply),
            ), "a1b2c3d4e5")
        }
        shot("chat-rich", dark) {
            ChatScreen(agents[0], agents, state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {})
        }
    }

    private fun composerTools(dark: Boolean) {
        val pic = sampleImage()
        val state = ChatState().apply { load(listOf(UiMessage("user", "hi"), UiMessage("assistant", "Hey! What should we look at?")), null) }
        shot("composer-attach-commands", dark) {
            ChatScreen(agents[0], agents, state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {},
                initialInput = "/g", skills = listOf("gaming-news", "github-pr-workflow"), initialAttachments = listOf(pic, pic))
        }
    }

    private fun viewer() {
        val pic = sampleImage()
        val state = ChatState()
        shot("viewer", true) {
            ChatScreen(agents[0], agents, state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {},
                initialViewing = MediaRef(java.io.File(pic.localPath).toURI().toString(), MediaRef.Kind.Image))
        }
    }

    private fun crop(dark: Boolean) {
        val bmp = android.graphics.Bitmap.createBitmap(900, 600, android.graphics.Bitmap.Config.ARGB_8888).apply {
            android.graphics.Canvas(this).apply {
                drawColor(android.graphics.Color.rgb(90, 120, 200))
                drawCircle(450f, 300f, 200f, android.graphics.Paint().apply { color = android.graphics.Color.rgb(240, 200, 170) })
            }
        }
        shot("avatar-crop", dark) { AvatarCropScreen("Atlas", bmp, { _, _, _ -> }, {}) }
    }

    @Test fun richLight() = rich(false)
    @Test fun richDark() = rich(true)
    @Test fun composerLight() = composerTools(false)
    @Test fun composerDark() = composerTools(true)
    @Test fun viewerDark() = viewer()
    @Test fun cropDark() = crop(true)

    private fun settings(dark: Boolean) = shot("settings", dark) {
        SettingsScreen(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light, accent = 0), {}, {}, {})
    }

    @Test fun fleetLight() = fleet(false)
    @Test fun fleetDark() = fleet(true)
    @Test fun chatLight() = chat(false)
    @Test fun chatDark() = chat(true)
    @Test fun thinkingLight() = thinking(false)
    @Test fun settingsLight() = settings(false)
    @Test fun settingsDark() = settings(true)
}
