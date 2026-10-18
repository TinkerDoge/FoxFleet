package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.ui.AgentList
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.MediaRef
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.LocalMediaHost
import dev.foxfleet.app.ui.components.MediaViewer
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.initials
import dev.foxfleet.app.ui.components.presence
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import okhttp3.OkHttpClient

/**
 * Agent dossier (0.4.3 C3): who the agent is (display name, small hub id, presence), its recent chats
 * (tap opens that session) and a grid of the pictures and videos this device has cached for it. Tapping a
 * tile opens the swipe viewer. Everything here is device-local: the hub is not asked to list media.
 */
@Composable
fun DossierScreen(
    agent: AgentStatus,
    sessions: List<SessionInfo>,
    media: List<MediaRef>,
    onBack: () -> Unit,
    onOpenSession: (String) -> Unit,
    onMediaDeleted: () -> Unit = {},
    onClearMedia: () -> Unit = {},
    httpClient: OkHttpClient? = null,
    now: () -> Long = { System.currentTimeMillis() },
) {
    val c = LocalHubColors.current
    var viewing by remember(media) { mutableStateOf<Int?>(null) }
    val p = agent.presence()
    Column(Modifier.fillMaxSize().background(c.bg)) {
        Box {
            Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                AgentAvatar(agent.name, p, 96.dp)
                Spacer(Modifier.size(12.dp))
                Text(agent.displayName, style = MaterialTheme.typography.titleLarge, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (agent.capabilities.bot) "bot" else agent.name, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.size(16.dp))
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    DossierPill("Message", "chat", Modifier.weight(1f), onClick = { sessions.firstOrNull()?.id?.let(onOpenSession) ?: onBack() })
                }
                Spacer(Modifier.size(8.dp))
            }
            SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text, modifier = Modifier.statusBarsPadding().padding(8.dp))
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 32.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item(key = "chatlabel", span = { GridItemSpan(maxLineSpan) }) {
                SectionLabel("Chats")
            }
            if (sessions.isEmpty()) item(key = "nochats", span = { GridItemSpan(maxLineSpan) }) {
                Text("No chats saved on this device yet.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp))
            } else sessions.take(20).forEach { s ->
                item(key = "chat:${s.id}", span = { GridItemSpan(maxLineSpan) }) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(12.dp)).background(c.surface)
                            .clickable { onOpenSession(s.id) }.padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(34.dp).clip(CircleShape).background(c.surfaceAlt), contentAlignment = Alignment.Center) { FoxIcon("chat", tint = c.textMuted, size = 18.dp) }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(s.title?.takeIf { it.isNotBlank() } ?: "Chat", style = MaterialTheme.typography.bodyLarge, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (s.preview.isNotBlank()) Text(s.preview, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(AgentList.time(s.updated, now()), style = MaterialTheme.typography.labelSmall, color = c.textFaint)
                    }
                }
            }
            item(key = "medialabel", span = { GridItemSpan(maxLineSpan) }) {
                Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { SectionLabel("Media on this device") }
                    if (media.isNotEmpty()) Text("Clear", style = MaterialTheme.typography.labelLarge, color = c.accent,
                        modifier = Modifier.heightIn(min = 44.dp).clickable(onClick = onClearMedia).padding(horizontal = 12.dp, vertical = 12.dp))
                }
            }
            if (media.isEmpty()) item(key = "nomedia", span = { GridItemSpan(maxLineSpan) }) {
                Text("Pictures and videos this agent sent show here once you have opened a chat.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp))
            } else itemsIndexed(media, key = { i, r -> "m:$i:${r.ref ?: r.url}" }) { i, r ->
                DossierMediaTile(r, onOpen = { viewing = i })
            }
        }
    }
    viewing?.let { index ->
        val start = index.coerceIn(0, (media.size - 1).coerceAtLeast(0))
        MediaViewer(media, start, httpClient, onClose = { viewing = null }, onDelete = { onMediaDeleted() })
    }
}

@Composable
private fun DossierMediaTile(ref: MediaRef, onOpen: () -> Unit) {
    val c = LocalHubColors.current
    val host = LocalMediaHost.current
    val cached = ref.ref != null && ref.agent != null && host?.cache != null
    val src by produceState<String?>(if (cached) null else ref.url, ref, host) {
        if (!cached) { value = ref.url; return@produceState }
        value = null
        try {
            val lease = host!!.acquire(ref.agent!!, ref.ref!!, ref.instance)
            try { value = lease.file.toURI().toString(); awaitCancellation() } finally { lease.close() }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { value = null }
    }
    Box(
        Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(c.surfaceAlt).clickable(onClick = onOpen)
            .semantics { contentDescription = if (ref.kind == MediaRef.Kind.Video) "Play ${ref.alt.ifBlank { "video" }}" else "Open ${ref.alt.ifBlank { "picture" }}" },
        contentAlignment = Alignment.Center,
    ) {
        val s = src
        if (s != null) AsyncImage(s, ref.alt.ifBlank { "Media" }, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else FoxIcon(if (ref.kind == MediaRef.Kind.Video) "play" else "image", tint = c.textMuted)
        if (ref.kind == MediaRef.Kind.Video) Box(Modifier.align(Alignment.BottomEnd).padding(4.dp)) { FoxIcon("play", tint = Color.White, size = 18.dp) }
    }
}

@Composable
private fun DossierPill(label: String, icon: String, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Column(
        modifier.clip(RoundedCornerShape(16.dp)).background(c.surfaceAlt).clickable(onClick = onClick).padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        FoxIcon(icon, tint = c.accent, size = 22.dp)
        Spacer(Modifier.size(4.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = c.text)
    }
}
