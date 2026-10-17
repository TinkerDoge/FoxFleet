package dev.foxfleet.app.screenshots

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.HubChat
import dev.foxfleet.app.data.live.LastMessage
import dev.foxfleet.app.data.live.LinkState
import dev.foxfleet.app.notify.AndroidNotifier
import dev.foxfleet.app.notify.ChatNotice
import dev.foxfleet.app.notify.NotifyChannels
import dev.foxfleet.app.notify.NotifyType
import dev.foxfleet.app.notify.ReplyGrant
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatRowActions
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.FleetScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private val OUT = System.getProperty("foxfleet.shots") ?: "build/outputs/roborazzi"

/** Phase 1 renders: chat list (badges, muted, archived), a chat with ticks/typing/pill, link states, the reply notification. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class Phase1ScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val now = 1_790_000_000_000L
    private fun agent(n: String, label: String, online: Boolean = true) = AgentStatus(n, online = online, chatReady = true, managementReady = true, label = label, capabilities = Capabilities(sessions = true))
    private val agents = listOf(agent("nova", "Nova"), agent("atlas", "Atlas"), agent("quill", "Quill", online = false), agent("pixel", "Pixel"), agent("echo", "Echo"), agent("orbit", "Orbit"))
    private fun row(a: String, label: String, preview: String, sender: String?, role: String, unread: Int = 0, archived: Boolean = false, muted: Boolean = false, pinned: Boolean = false, manual: Boolean = false, status: String? = null, ago: Long = 60_000) =
        HubChat(a, label, "hermes", "c_$a", LastMessage("m_$a", role, sender, preview, now - ago, status), unread, 0, archived, muted, null, pinned, if (pinned) 0 else null, false, false, manual, now - ago)
    private val rows = listOf(
        row("nova", "Nova", "Build passed on main, 3 warnings left", "Nova", "assistant", unread = 3, pinned = true, ago = 120_000),
        row("atlas", "Atlas", "Can you check the deploy log?", "You", "user", status = "read", ago = 600_000),
        row("quill", "Quill", "Draft of the release notes is ready", "Quill", "assistant", unread = 12, muted = true, ago = 3_600_000),
        row("pixel", "Pixel", "Here are the three icon options", "Pixel", "assistant", manual = true, ago = 7_200_000),
        row("echo", "Echo", "Old thread about the migration", "Echo", "assistant", unread = 2, archived = true, ago = 86_400_000),
        row("orbit", "Orbit", "Weekly report sent", "You", "user", archived = true, status = "delivered", ago = 172_800_000),
    ).associateBy { it.agent }
    private val actions = ChatRowActions({ _, _ -> }, {}, { _, _ -> })

    private fun fleet(name: String, archived: Boolean, link: LinkState? = null, dark: Boolean = false, typing: String? = null) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) {
                Box(Modifier.fillMaxSize()) {
                    FleetScreen(agents, false, true, null, { rows[it.name]?.badge?.let { b -> b > 0 } == true }, {}, {}, {}, now = { now }, rows = rows, archivedView = archived, rowActions = actions, link = link, typingLabel = { if (it == "atlas") typing else null })
                }
            }
        }
        compose.mainClock.advanceTimeBy(1500)
        compose.onRoot().captureRoboImage("$OUT/$name.png")
    }

    @Test fun chatList() = fleet("chat-list-badges-muted-archived", archived = false, typing = "typing…")
    @Test fun chatListDark() = fleet("chat-list-dark", archived = false, dark = true)
    @Test fun archivedView() = fleet("chat-list-archived-view", archived = true)
    @Test fun linkConnecting() = fleet("link-connecting", archived = false, link = LinkState.Connecting)
    @Test fun linkUpdating() = fleet("link-updating", archived = false, link = LinkState.Updating)
    @Test fun linkOffline() = fleet("link-offline", archived = false, link = LinkState.Offline)

    private val chatNow = System.currentTimeMillis()
    private fun msgs(): List<UiMessage> = (1..14).flatMap { i ->
        listOf(UiMessage("user", "Question $i: can you check step $i of the rollout?", ts = chatNow - (30 - i) * 60_000L, hubId = "u$i", n = i * 2 - 1, status = if (i < 13) "read" else if (i == 13) "delivered" else "sent"),
            UiMessage("assistant", "Step $i looks fine. Logs are clean and the health check is green.", ts = chatNow - (30 - i) * 60_000L + 20_000, hubId = "a$i", n = i * 2))
    }

    private fun chat(name: String, typing: String?, link: LinkState?, pill: Boolean) {
        compose.mainClock.autoAdvance = false
        val a = agents[0]
        val state = ChatState().apply { load(msgs(), "c_nova") }
        compose.setContent {
            FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) {
                Box(Modifier.fillMaxSize()) { ChatScreen(a, agents, state, emptyList(), { false }, { _, _ -> }, {}, {}, {}, {}, {}, {}, typingLabel = typing, link = link) }
            }
        }
        compose.mainClock.advanceTimeBy(1500)
        if (pill) {
            compose.onRoot().performTouchInput { swipeDown(startY = centerY - 400f, endY = centerY + 600f) }
            compose.mainClock.advanceTimeBy(800)
            compose.runOnIdle { state.appendLive(listOf(UiMessage("assistant", "Rollout finished.", ts = chatNow, hubId = "a99", n = 99), UiMessage("assistant", "All 6 regions are green.", ts = chatNow + 1000, hubId = "a100", n = 100))) }
            compose.mainClock.advanceTimeBy(1500)
        }
        compose.onRoot().captureRoboImage("$OUT/$name.png")
    }

    @Test fun chatTicksTypingPill() = chat("chat-ticks-typing-pill", "typing…", null, pill = true)
    @Test fun chatTicksBottom() = chat("chat-ticks-typing", "typing…", null, pill = false)
    @Test fun chatLinkConnecting() = chat("chat-link-connecting", null, LinkState.Connecting, pill = false)
    @Test fun chatLinkOffline() = chat("chat-link-offline", null, LinkState.Offline, pill = false)

    /** The real posted notification (built by AndroidNotifier with a reply token), drawn from its own fields: Robolectric has no system UI. */
    @Test fun notificationWithReply() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        NotifyChannels.create(ctx)
        val notifier = AndroidNotifier(ctx)
        notifier.setBadge(5, mapOf("nova" to 2, "quill" to 3))
        notifier.post(ChatNotice("hub1", "nova", "Nova", "c_nova", NotifyType.ReplyFinished, "Build passed. Deploy to staging now?", now, reply = ReplyGrant("t", System.currentTimeMillis() + 3_600_000)))
        val n = ctx.getSystemService(NotificationManager::class.java).activeNotifications.first { it.id == AndroidNotifier.CHAT_ID }.notification
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        val title = style?.conversationTitle?.toString() ?: style?.messages?.firstOrNull()?.person?.name?.toString() ?: n.extras.getCharSequence(Notification.EXTRA_TITLE).toString()
        val lines = style?.messages?.map { it.text.toString() } ?: listOf(n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        val acts = n.actions.map { it.title.toString() to (it.remoteInputs?.firstOrNull()?.label?.toString()) }
        compose.setContent {
            FoxfleetTheme(AppPrefs(theme = ThemeMode.Dark)) {
                Box(Modifier.fillMaxSize().background(Color(0xFF1B1B1F)).padding(12.dp)) {
                    Column(Modifier.fillMaxWidth().background(Color(0xFF2B2930), RoundedCornerShape(24.dp)).padding(16.dp)) {
                        Row { Text("FoxFleet · now · badge ${n.number}", color = Color(0xFFCAC4D0), style = MaterialTheme.typography.labelMedium) }
                        Spacer(Modifier.height(6.dp))
                        Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium)
                        lines.forEach { Text(it, color = Color(0xFFE6E0E9), style = MaterialTheme.typography.bodyMedium) }
                        Spacer(Modifier.height(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) { acts.forEach { (t, _) -> Text(t, color = Color(0xFFD0BCFF), style = MaterialTheme.typography.labelLarge) } }
                        acts.firstOrNull { it.second != null }?.let { (_, hint) ->
                            Spacer(Modifier.height(12.dp))
                            Box(Modifier.fillMaxWidth().border(1.dp, Color(0xFF938F99), RoundedCornerShape(20.dp)).padding(horizontal = 16.dp, vertical = 10.dp)) { Text(hint!!, color = Color(0xFF938F99)) }
                        }
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("$OUT/notification-reply.png")
    }
}
