package dev.foxfleet.app.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** 0.2.1 screens: history sheet, a formatted old conversation, the slash-command palette. Run with -Proborazzi.test.record=true. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class FixesScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val atlas = AgentStatus("Atlas", online = true, chatReady = true, managementReady = true, description = "Research and code on the workstation")
    private val now = System.currentTimeMillis()
    private val sessions = listOf(
        SessionInfo("s1", "Weekly usage summary", now - 24 * 60_000, "Atlas handled most of the load, and the cheap model took the rest.", 6),
        SessionInfo("s2", "Release notes draft", now - 5 * 3600_000, "Draft is ready: highlights, upgrade notes and the known limits.", 12),
        SessionInfo("s3", "Docs indexing", now - 26 * 3600_000, "Re-indexed 212 pages; 3 broken links were fixed.", 4),
        SessionInfo("s4", "Backup check", now - 3 * 86_400_000, "Last backup was 2 days ago; all files present.", 3),
    )
    private val old = listOf(
        UiMessage("user", "Summarise last week's usage per agent and show the top script.", ts = now - 26 * 3600_000),
        UiMessage("assistant", "Here is the **weekly summary**:\n\n| Agent | Tokens |\n| --- | --- |\n| Atlas | 912k |\n| Nova | 604k |\n| Echo | 288k |\n\n```python\ndef weekly_tokens(rows):\n    totals = {}\n    for agent, tokens in rows:\n        totals[agent] = totals.get(agent, 0) + tokens\n    return totals\n```\n\nNext step: rotate Echo's key.",
            reasoning = "The user wants a per-agent summary; read the usage table, then sum by agent.",
            steps = listOf(ToolStep("read_file", "usage.csv", "212 rows", true), ToolStep("run_python", "", "ok", true)), ts = now - 26 * 3600_000 + 60_000),
    )

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) { content() } }
        compose.mainClock.advanceTimeBy(900)
        compose.onRoot().captureRoboImage("$OUT/$name-${if (dark) "dark" else "light"}.png")
    }
    private fun chat(input: String = "", history: Boolean = false, dark: Boolean, name: String) {
        val state = ChatState().apply { load(old, "s3") }
        shot(name, dark) { ChatScreen(atlas, listOf(atlas), state, sessions, { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, historyOpen = history, initialInput = input) }
    }

    @Test fun historyLight() = chat(history = true, dark = false, name = "01-history")
    @Test fun historyDark() = chat(history = true, dark = true, name = "01-history")
    @Test fun oldConversationLight() = chat(dark = false, name = "02-old-conversation")
    @Test fun oldConversationDark() = chat(dark = true, name = "02-old-conversation")
    @Test fun commandsLight() = chat(input = "/", dark = false, name = "03-commands")
    @Test fun commandsDark() = chat(input = "/mo", dark = true, name = "03-commands-filtered")
}
