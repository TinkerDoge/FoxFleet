package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.components.SoftButton
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.presence

/** Rooms are created with a title and agent members; the owner is the signed-in account, never a fake agent. */
@Composable
fun CreateConversationScreen(
    agents: List<AgentStatus>,
    saving: Boolean,
    error: String?,
    onBack: () -> Unit,
    onCreate: (title: String, agentNames: List<String>) -> Unit,
) {
    val c = LocalHubColors.current
    var title by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<Set<String>>(emptySet()) }
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            SoftIconButton(FoxIcons.get("back"), "Back to rooms", onBack, tint = c.text)
            Text("New room", style = MaterialTheme.typography.titleLarge, color = c.text, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
            SoftButton(onClick = { if (title.trim().isNotEmpty()) onCreate(title.trim(), picked.toList()) }, enabled = title.trim().isNotEmpty() && !saving) {
                Text(if (saving) "Creating…" else "Create", color = c.accent)
            }
        }
        Text("Title", style = MaterialTheme.typography.labelLarge, color = c.textMuted, modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp))
        Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).clip(RoundedCornerShape(14.dp)).background(c.surface).padding(14.dp)) {
            if (title.isEmpty()) Text("e.g. Launch room", color = c.textMuted, style = MaterialTheme.typography.bodyLarge)
            BasicTextField(title, { title = it }, singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text), cursorBrush = SolidColor(c.accent), modifier = Modifier.fillMaxWidth())
        }
        Text("Members", style = MaterialTheme.typography.labelLarge, color = c.textMuted, modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp))
        Text("Only agents need to be picked. You are the room owner.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 18.dp, vertical = 2.dp))
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 18.dp, vertical = 6.dp)) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
            items(agents, key = { it.name }) { a ->
                val on = a.name in picked
                Row(Modifier.fillMaxWidth().clickable { picked = if (on) picked - a.name else picked + a.name }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    AgentAvatar(a.name, a.presence(), 42.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(a.displayName, style = MaterialTheme.typography.titleSmall, color = c.text, fontWeight = FontWeight.SemiBold)
                        Text(a.name + if (a.online) "" else " · offline", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                    }
                    Checkbox(on, { picked = if (on) picked - a.name else picked + a.name })
                }
            }
        }
    }
}

private fun AgentStatus.presenceOrNull() = presence()
