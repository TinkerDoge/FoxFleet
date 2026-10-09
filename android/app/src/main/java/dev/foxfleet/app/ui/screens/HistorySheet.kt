package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.ui.LocalHubColors

/** "5 min ago", "yesterday", "3 d ago": short labels for history rows. */
internal fun agoLabel(ms: Long, now: Long = System.currentTimeMillis()): String {
    if (ms <= 0) return ""
    val s = ((now - ms) / 1000).coerceAtLeast(0)
    return when { s < 60 -> "just now"; s < 3600 -> "${s / 60} min ago"; s < 86400 -> "${s / 3600} h ago"; s < 172800 -> "yesterday"; else -> "${s / 86400} d ago" }
}

/**
 * Earlier conversations of this agent: title, time and a preview line. Tap to open, long-press for rename/delete,
 * pull down to refresh, "Load more" for the next page, "New chat" on top.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HistorySheet(
    agentName: String,
    sessions: List<SessionInfo>,
    total: Int,
    currentId: String?,
    loading: Boolean,
    error: String?,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    now: Long = System.currentTimeMillis(),
    onDismiss: () -> Unit,
) {
    val c = LocalHubColors.current
    var menuFor by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<SessionInfo?>(null) }
    var deleting by remember { mutableStateOf<SessionInfo?>(null) }
    LaunchedEffect(Unit) { if (sessions.isEmpty()) onRefresh() }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.bg) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 8.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("History · $agentName", style = MaterialTheme.typography.titleMedium, color = c.text, modifier = Modifier.weight(1f))
                TextButton(onClick = { onNew(); onDismiss() }) { Text("New chat", color = c.accent) }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
            PullToRefreshBox(isRefreshing = loading && sessions.isNotEmpty(), onRefresh = onRefresh, modifier = Modifier.weight(1f, fill = false)) {
                LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (sessions.isEmpty() && !loading) item { Text("No earlier conversations yet.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(20.dp)) }
                    items(sessions, key = { it.id }) { s ->
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 10.dp).clip(RoundedCornerShape(12.dp))
                                .background(if (s.id == currentId) c.surfaceAlt else c.bg)
                                .combinedClickable(onClick = { onOpen(s.id); onDismiss() }, onLongClick = { menuFor = s.id })
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                        ) {
                            Row {
                                Text(s.title?.takeIf { it.isNotBlank() } ?: "Untitled chat", style = MaterialTheme.typography.bodyLarge, color = if (s.id == currentId) c.accent else c.text,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                Text(agoLabel(s.updated, now), style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.padding(start = 8.dp))
                            }
                            if (s.preview.isNotBlank()) Text(s.preview, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            DropdownMenu(expanded = menuFor == s.id, onDismissRequest = { menuFor = null }) {
                                DropdownMenuItem(text = { Text("Rename") }, onClick = { menuFor = null; renaming = s })
                                DropdownMenuItem(text = { Text("Delete") }, onClick = { menuFor = null; deleting = s })
                            }
                        }
                    }
                    if (sessions.size < total) item {
                        TextButton(onClick = onLoadMore, enabled = !loading, modifier = Modifier.fillMaxWidth()) { Text(if (loading) "Loading…" else "Load more", color = c.accent) }
                    }
                    item { Spacer(Modifier.height(8.dp)) }
                }
            }
        }
    }
    renaming?.let { s ->
        var title by remember(s.id) { mutableStateOf(s.title.orEmpty()) }
        AlertDialog(onDismissRequest = { renaming = null }, title = { Text("Rename chat") },
            text = { OutlinedTextField(title, { title = it.take(120) }, singleLine = true) },
            confirmButton = { TextButton(onClick = { if (title.isNotBlank()) onRename(s.id, title.trim()); renaming = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } })
    }
    deleting?.let { s ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Delete this conversation?") },
            text = { Text(s.title ?: "Untitled chat") },
            confirmButton = { TextButton(onClick = { onDelete(s.id); deleting = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } })
    }
}
