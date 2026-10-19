package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.Conversation
import dev.foxfleet.app.data.ConversationPreferences
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.SoftButton
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.presence

/** Room details: the owner may rename, add/remove agent members and change notification preferences. */
@Composable
fun ConversationDetailsScreen(
    room: Conversation?,
    agents: List<AgentStatus>,
    meId: String?,
    error: String?,
    onBack: () -> Unit,
    onRename: (String) -> Unit,
    onAddMember: (String) -> Unit,
    onRemoveMember: (String) -> Unit,
    onPreferences: (ConversationPreferences) -> Unit,
    onMarkRead: () -> Unit,
) {
    val c = LocalHubColors.current
    if (room == null) {
        Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text)
                Text("Room details", style = MaterialTheme.typography.titleLarge, color = c.text, modifier = Modifier.padding(start = 8.dp))
            }
            Text("Loading…", color = c.textMuted, modifier = Modifier.padding(24.dp))
        }
        return
    }
    val owner = meId != null && room.owner.id == meId
    var title by remember(room.id, room.title) { mutableStateOf(room.title) }
    var muted by remember(room.id) { mutableStateOf(false) }
    var notify by remember(room.id) { mutableStateOf("all") }
    val candidates = agents.filter { a -> room.members.none { it.name == a.name || it.id == "agent:${a.name}" } }
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            SoftIconButton(FoxIcons.get("back"), "Back to the room", onBack, tint = c.text)
            Text("Room details", style = MaterialTheme.typography.titleLarge, color = c.text, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
        Section("Name") {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.surface).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(title, { title = it }, enabled = owner, singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text), cursorBrush = SolidColor(c.accent), modifier = Modifier.weight(1f))
                if (owner && title.trim().isNotEmpty() && title.trim() != room.title) {
                    SoftButton(onClick = { onRename(title.trim()) }) { Text("Save", color = c.accent) }
                }
            }
        }
        Section("Members") {
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                AgentAvatar(room.owner.name, null, 36.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(room.owner.name, color = c.text, style = MaterialTheme.typography.titleSmall)
                    Text("owner", color = c.textMuted, style = MaterialTheme.typography.bodySmall)
                }
            }
            room.members.forEach { m ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    AgentAvatar(m.name, null, 36.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(m.name, color = c.text, style = MaterialTheme.typography.titleSmall)
                        Text("agent", color = c.textMuted, style = MaterialTheme.typography.bodySmall)
                    }
                    if (owner) SoftButton(onClick = { onRemoveMember(m.name) }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                }
            }
            if (owner && candidates.isNotEmpty()) {
                Text("Add an agent", color = c.textMuted, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
                candidates.forEach { a ->
                    Row(Modifier.fillMaxWidth().clickable { onAddMember(a.name) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        AgentAvatar(a.name, a.presence(), 32.dp)
                        Spacer(Modifier.width(10.dp))
                        Text(a.displayName, color = c.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Text("Add", color = c.accent, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        }
        Section("Notifications") {
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Mute this room", color = c.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                Switch(muted, { on -> muted = on; onPreferences(ConversationPreferences(muted = on, notify = notify)) })
            }
            listOf("all" to "Everything", "mentions" to "Mentions", "none" to "Nothing").forEach { (id, label) ->
                Row(Modifier.fillMaxWidth().clickable { notify = id; onPreferences(ConversationPreferences(muted = muted, notify = id)) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(notify == id, { notify = id; onPreferences(ConversationPreferences(muted = muted, notify = id)) })
                    Text(label, color = c.text, style = MaterialTheme.typography.bodyMedium)
                }
            }
            SoftButton(onClick = onMarkRead, modifier = Modifier.padding(top = 8.dp)) { Text("Mark as read", color = c.accent) }
        }
        Spacer(Modifier.width(1.dp))
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val c = LocalHubColors.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 2.dp, vertical = 6.dp))
        content()
    }
}
