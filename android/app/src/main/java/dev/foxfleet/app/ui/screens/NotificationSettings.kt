package dev.foxfleet.app.ui.screens

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import dev.foxfleet.app.notify.AgentRow
import dev.foxfleet.app.notify.MuteDuration
import dev.foxfleet.app.notify.NotifyCategory
import dev.foxfleet.app.notify.NotifyController
import dev.foxfleet.app.notify.NotifySettingsModel
import dev.foxfleet.app.notify.NotifyStatus
import dev.foxfleet.app.notify.NotifyText
import dev.foxfleet.app.notify.NotifyUiState
import dev.foxfleet.app.notify.PermissionState
import dev.foxfleet.app.notify.TestOutcome
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.Tokens
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftButton
import dev.foxfleet.app.ui.components.SoftButtonKind
import dev.foxfleet.app.ui.components.SoftCard

/** Everything the section can do. The stateless content below takes this, so screenshots and tests need no Android. */
class NotifyActions(
    val onMaster: (Boolean) -> Unit = {},
    val onCategory: (NotifyCategory, Boolean) -> Unit = { _, _ -> },
    val onAllowClick: () -> Unit = {},
    val onOpenSystemSettings: () -> Unit = {},
    val onOpenChannel: (dev.foxfleet.app.notify.NotifyChannel) -> Unit = {},
    val onMute: (AgentRow) -> Unit = {},
    val onUnmute: (String, String?) -> Unit = { _, _ -> },
    val onToggleChats: (String) -> Unit = {},
    val onMuteChat: (AgentRow, String) -> Unit = { _, _ -> },
    val onTest: () -> Unit = {},
    val onOpenBattery: () -> Unit = {},
)

private tailrec fun Context.activity(): Activity? = when (this) { is Activity -> this; is ContextWrapper -> baseContext.activity(); else -> null }

/** The "Notifications" section of Settings: wires [NotifySettingsModel] to the permission dialog and the system settings. */
@Composable
fun NotificationsSection(model: NotifySettingsModel) {
    val ctx = LocalContext.current
    val ui = model.ui
    val link by NotifyController.link.collectAsState()
    LaunchedEffect(Unit) { model.refresh() }
    LaunchedEffect(link) { model.setLink(link); model.refreshLocal() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val o = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) model.refreshLocal() }
        lifecycle.addObserver(o); onDispose { lifecycle.removeObserver(o) }
    }
    val store = remember { NotifyController.store(ctx) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        store.permissionAsked = true
        model.onPermissionResult(granted)
    }
    val actions = remember(model) {
        NotifyActions(
            onMaster = model::toggleMaster, onCategory = model::setCategory,
            onAllowClick = { model.toggleMaster(true) },
            onOpenSystemSettings = { ctx.startActivity(NotifyController.systemSettingsIntent(ctx)) },
            onOpenChannel = { ctx.startActivity(NotifyController.channelSettingsIntent(ctx, it)) },
            onMute = model::askMute, onUnmute = model::unmute, onToggleChats = model::toggleChats, onMuteChat = model::askMuteChat, onTest = model::sendTest,
            onOpenBattery = { ctx.startActivity(NotifyController.batterySettingsIntent(ctx)) },
        )
    }
    NotificationsSectionContent(ui, actions)
    if (ui.askPermission) PermissionDialog(
        blocked = ui.permission == PermissionState.Blocked,
        onAllow = { if (android.os.Build.VERSION.SDK_INT >= 33) launcher.launch(Manifest.permission.POST_NOTIFICATIONS) else { model.dismissPermissionAsk(); ctx.startActivity(NotifyController.systemSettingsIntent(ctx)) } },
        onSettings = { model.dismissPermissionAsk(); ctx.startActivity(NotifyController.systemSettingsIntent(ctx)) },
        onDismiss = model::dismissPermissionAsk,
    )
    ui.muteFor?.let { a -> MuteDialog("Mute ${a.label}", model::muteChosen, model::dismissMute) }
    ui.muteChat?.let { (a, _) -> MuteDialog("Mute this chat with ${a.label}", model::muteChosen, model::dismissMute) }
}

@Composable
fun PermissionDialog(blocked: Boolean, onAllow: () -> Unit, onSettings: () -> Unit, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = c.surface,
        title = { Text(if (blocked) "Notifications are blocked" else "Allow notifications?", color = c.text) },
        text = {
            Text(
                if (blocked) "Android is not letting FoxFleet show notifications. Open the system settings, turn Notifications on, then come back."
                else "FoxFleet shows a notification when an agent finishes a reply, needs your approval or fails. Replies stay on your hub: the notification text is fetched from it. Android will ask next.",
                color = c.textMuted,
            )
        },
        confirmButton = { SoftButton(onClick = if (blocked) onSettings else onAllow, kind = SoftButtonKind.Filled) { Text(if (blocked) "Open settings" else "Continue", color = c.onAccent) } },
        dismissButton = { SoftButton(onClick = onDismiss, kind = SoftButtonKind.Outlined) { Text("Not now", color = c.textMuted) } },
    )
}

@Composable
fun MuteDialog(title: String, onChoose: (MuteDuration) -> Unit, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = c.surface, title = { Text(title, color = c.text) },
        text = {
            Column {
                MuteDuration.all.forEach { d ->
                    Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp)).clickable { onChoose(d) }.padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) {
                        Text(d.label, color = c.text, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = {}, dismissButton = { SoftButton(onClick = onDismiss, kind = SoftButtonKind.Outlined) { Text("Cancel", color = c.textMuted) } },
    )
}

@Composable
fun NotificationsSectionContent(ui: NotifyUiState, a: NotifyActions) {
    val c = LocalHubColors.current
    SectionLabel("Notifications")
    SoftCard(Modifier.fillMaxWidth()) {
        Column {
            NotifyToggle("Notifications", "Keep a quiet connection to your hub so replies and approvals reach you. A small \"Connected\" line stays in the status bar.", ui.serviceOn && ui.hubSupported, enabled = ui.hubSupported && ui.signedIn, onChange = a.onMaster)
            Hairline(Modifier.padding(start = 16.dp))
            StatusRow(ui, a)
            if (ui.serviceOn && ui.hubSupported) { Hairline(Modifier.padding(start = 16.dp)); LinkRow(NotifyText.BATTERY_HINT, NotifyText.BATTERY_ACTION, a.onOpenBattery) }
            ui.message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = danger(), modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) }
            ui.hubError?.takeIf { ui.hubSupported }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) }
            if (!ui.hub.storageOk) Text("Your hub could not save its notification log. Mutes work now but may be lost if the hub restarts.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp))
        }
    }
    if (ui.hubSupported && ui.serviceOn) {
        SectionLabel("Notify me about")
        SoftCard(Modifier.fillMaxWidth()) {
            Column {
                NotifyCategory.entries.forEachIndexed { i, cat ->
                    if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                    NotifyToggle(cat.label, cat.description, cat in ui.categories, onChange = { a.onCategory(cat, it) })
                }
                ui.channels.filter { it.blocked }.forEach { ch ->
                    Hairline(Modifier.padding(start = 16.dp))
                    LinkRow("\"${ch.channel.label}\" is switched off in Android", "Open channel settings") { a.onOpenChannel(ch.channel) }
                }
            }
        }
        if (ui.agents.isNotEmpty()) {
            SectionLabel("Mute")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    ui.agents.forEachIndexed { i, row ->
                        if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                        AgentMuteRow(row, ui, a)
                    }
                }
            }
        }
    }
    if (ui.hubSupported) {
        SectionLabel("Test")
        SoftCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                SoftButton(onClick = a.onTest, enabled = ui.test != TestOutcome.Sending && ui.signedIn, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Send test notification" }) {
                    FoxIcon("bolt", tint = c.text)
                    Text(if (ui.test == TestOutcome.Sending) "Sending…" else "Send test notification", color = c.text)
                }
                testLine(ui.test)?.let { (text, bad) -> Text(text, style = MaterialTheme.typography.bodySmall, color = if (bad) danger() else c.textMuted, modifier = Modifier.padding(top = 10.dp).semantics { liveRegionPolite() }) }
            }
        }
    }
}

private fun androidx.compose.ui.semantics.SemanticsPropertyReceiver.liveRegionPolite() { liveRegion = LiveRegionMode.Polite }

private fun testLine(t: TestOutcome): Pair<String, Boolean>? = when (t) {
    TestOutcome.Idle, TestOutcome.Sending -> null
    TestOutcome.Sent -> "Sent. It should show up in a moment." to false
    TestOutcome.SentWhileOff -> "The hub sent it, but notifications are off on this phone. Turn them on above to see it." to false
    TestOutcome.HubMuted -> "Your hub's notification switch is off, so nothing was sent. Turn Notifications on above." to true
    is TestOutcome.RateLimited -> "Too many tests. Try again in ${t.retryAfterSec} seconds." to true
    is TestOutcome.Failed -> "Test failed: ${t.message}" to true
}

@Composable private fun danger() = if (LocalHubColors.current.dark) Tokens.Dark.danger else Tokens.Light.danger

@Composable
private fun StatusRow(ui: NotifyUiState, a: NotifyActions) {
    val c = LocalHubColors.current
    val tone = NotifyStatus.tone(ui)
    val dot = when (tone) { NotifyStatus.Tone.Good -> c.online; NotifyStatus.Tone.Warn -> c.idle; NotifyStatus.Tone.Bad -> danger(); NotifyStatus.Tone.Neutral -> c.offline }
    val line = NotifyStatus.line(ui)
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Row(Modifier.heightIn(min = 24.dp).semantics(mergeDescendants = true) { contentDescription = "Notification status: $line" }, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.width(10.dp))
            Text("Status", style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = Modifier.weight(0.3f))
            Text(line, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.weight(0.7f))
        }
        if (ui.serviceOn && !ui.permission.ok) {
            Spacer(Modifier.size(12.dp))
            Text(if (ui.permission == PermissionState.Blocked) "Android is blocking notifications for FoxFleet." else "Android needs your OK before FoxFleet can show notifications.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            Spacer(Modifier.size(8.dp))
            SoftButton(onClick = if (ui.permission == PermissionState.Blocked) a.onOpenSystemSettings else a.onAllowClick, kind = SoftButtonKind.Filled) {
                Text(if (ui.permission == PermissionState.Blocked) "Open system settings" else "Allow notifications", color = c.onAccent)
            }
        }
    }
}

@Composable
private fun AgentMuteRow(row: AgentRow, ui: NotifyUiState, a: NotifyActions) {
    val c = LocalHubColors.current
    val now = remember(ui) { System.currentTimeMillis() }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(row.label, style = MaterialTheme.typography.bodyLarge, color = c.text, maxLines = 1)
                Text(if (row.mute != null) NotifyStatus.until(row.mute.until, now) else if (row.chatMutes.isNotEmpty()) "${row.chatMutes.size} muted chat${if (row.chatMutes.size == 1) "" else "s"}" else "Notifications on", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            }
            if (row.mute != null) SoftButton(onClick = { a.onUnmute(row.name, null) }, kind = SoftButtonKind.Tonal, modifier = Modifier.semantics { contentDescription = "Unmute ${row.label}" }) { Text("Unmute", color = c.text) }
            else SoftButton(onClick = { a.onMute(row) }, kind = SoftButtonKind.Outlined, modifier = Modifier.semantics { contentDescription = "Mute ${row.label}" }) { Text("Mute", color = c.text) }
            Box(Modifier.size(48.dp).clip(CircleShape).clickable(role = Role.Button, onClickLabel = if (row.expanded) "Hide chats of ${row.label}" else "Show chats of ${row.label}") { a.onToggleChats(row.name) }, contentAlignment = Alignment.Center) {
                FoxIcon(if (row.expanded) "chevronUp" else "chevronDown", contentDescription = null, tint = c.textFaint)
            }
        }
        if (row.expanded) {
            val chats = row.chats
            if (chats == null) Text("Loading chats…", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(start = 32.dp, bottom = 12.dp))
            else if (chats.isEmpty() && row.chatMutes.isEmpty()) Text("No chats yet.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(start = 32.dp, bottom = 12.dp))
            else {
                val ids = chats.map { it.id }.toSet()
                (chats.map { it.id to (it.title?.takeIf { t -> t.isNotBlank() } ?: "Untitled chat") } + row.chatMutes.filter { it.chat !in ids }.map { it.chat!! to "Earlier chat" }).forEach { (id, title) ->
                    val m = row.chatMutes.firstOrNull { it.chat == id }
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 32.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(title, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1)
                            if (m != null) Text(NotifyStatus.until(m.until, now), style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                        }
                        if (m != null) SoftButton(onClick = { a.onUnmute(row.name, id) }, kind = SoftButtonKind.Tonal) { Text("Unmute", color = c.text) }
                        else SoftButton(onClick = { a.onMuteChat(row, id) }, kind = SoftButtonKind.Outlined, modifier = Modifier.semantics { contentDescription = "Mute chat $title" }) { Text("Mute", color = c.text) }
                    }
                }
                Spacer(Modifier.size(8.dp))
            }
        }
    }
}

@Composable
private fun LinkRow(title: String, action: String, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, color = c.text)
            Text(action, style = MaterialTheme.typography.bodySmall, color = c.accent)
        }
        FoxIcon("chevronRight", tint = c.textFaint)
    }
}

@Composable
private fun NotifyToggle(title: String, body: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val c = LocalHubColors.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .semantics(mergeDescendants = true) { role = Role.Switch; stateDescription = if (checked) "On" else "Off" }
            .clickable(enabled = enabled) { onChange(!checked) }.padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).then(if (enabled) Modifier else Modifier.background(androidx.compose.ui.graphics.Color.Transparent))) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (enabled) c.text else c.textFaint)
            Text(body, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.onAccent, uncheckedTrackColor = c.surfaceAlt, uncheckedBorderColor = c.hairline, uncheckedThumbColor = c.textFaint))
    }
}
