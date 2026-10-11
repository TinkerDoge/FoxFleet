package dev.foxfleet.app.screenshots

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.ImageAttachment
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.ReactionSnapshot
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"
private fun demo(name: String): File = listOf("../../design/demo/$name", "design/demo/$name", "../design/demo/$name").map(::File).firstOrNull { it.exists() }
    ?: error("Run design/tools/demo_assets.py first: design/demo/$name is missing")

/** Message frames: each message (with its pictures, time and reactions) reads as one unit, so it is clear what you react to. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MessengerScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private fun frames(dark: Boolean) {
        val photo = File.createTempFile("demo", ".jpg").also { demo("photo.jpg").copyTo(it, overwrite = true) }
        val chart = File.createTempFile("chart", ".png").also { demo("chart.png").copyTo(it, overwrite = true) }
        val agent = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true)
        val me = ReactionActor("user:owner", "owner", "user")
        val ts = 1_790_000_000_000L
        val state = ChatState().apply {
            load(listOf(
                UiMessage("user", "Here is the photo from the offsite.", id = "m1", ts = ts, images = listOf(ImageAttachment(photo.absolutePath, "data:image/jpeg;base64,AA", 10))),
                UiMessage("assistant", "Lovely shot. I added it to the report and charted last week's tokens:", id = "m2", ts = ts + 60_000, imageUrls = listOf(chart.absolutePath)),
                UiMessage("user", "Perfect, thanks!", id = "m3", ts = ts + 120_000),
                UiMessage("assistant", "Any time. Want me to send it to the team?", id = "m4", ts = ts + 180_000),
            ), "a1b2c3d4e5")
            simulateReactions(ReactionSnapshot(me, mapOf(
                "m2" to listOf(ReactionGroup("❤️", listOf(me)), ReactionGroup("🦊", listOf(ReactionActor("agent:atlas", "Atlas", "agent")))),
                "m3" to listOf(ReactionGroup("👍", listOf(ReactionActor("agent:atlas", "Atlas", "agent")))),
            )))
        }
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { ChatScreen(agent, listOf(agent), state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}) } }
        compose.mainClock.advanceTimeBy(900)
        compose.onRoot().captureRoboImage("$OUT/messenger-frames-${if (dark) "dark" else "light"}.png")
    }

    @Test fun framesLight() = frames(false)
    @Test fun framesDark() = frames(true)
}
