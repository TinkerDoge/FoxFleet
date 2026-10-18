package dev.foxfleet.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.ui.AgentList
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.DossierFile
import dev.foxfleet.app.ui.chat.DossierLink
import dev.foxfleet.app.ui.chat.MediaRef
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.components.LocalMediaHost
import dev.foxfleet.app.ui.components.MediaViewer
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.presence
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import okhttp3.OkHttpClient

private enum class DossierTab { Media, Files, Links, Chats }

/**
 * Telegram-style agent dossier: large centred avatar, four equal action pills, username card,
 * then Media / Files / Links / Chats. Media tiles are a flush 3-column grid; tapping one opens the swipe viewer.
 * Everything here is device-local: the hub is not asked to list media.
 */
@Composable
fun DossierScreen(
    agent: AgentStatus,
    sessions: List<SessionInfo>,
    media: List<MediaRef>,
    files: List<DossierFile> = emptyList(),
    links: List<DossierLink> = emptyList(),
    muted: Boolean = false,
    onBack: () -> Unit,
    onMessage: () -> Unit,
    onMute: () -> Unit = {},
    onStop: () -> Unit = {},
    onOpenSession: (String) -> Unit,
    onMediaDeleted: () -> Unit = {},
    onClearMedia: () -> Unit = {},
    httpClient: OkHttpClient? = null,
    now: () -> Long = { System.currentTimeMillis() },
) {
    val c = LocalHubColors.current
    val ctx = LocalContext.current
    var viewing by remember(media) { mutableStateOf<Int?>(null) }
    var tab by remember { mutableStateOf(DossierTab.Media) }
    val p = agent.presence()
    val handle = if (agent.name.startsWith("@")) agent.name else "@${agent.name}"
    Column(Modifier.fillMaxSize().background(c.bg)) {
        Box {
            LazyVerticalGrid(
                columns = GridCells.Fixed(3),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 32.dp),
                horizontalArrangement = Arrangement.spacedBy(if (tab == DossierTab.Media) 1.dp else 0.dp),
                verticalArrangement = Arrangement.spacedBy(if (tab == DossierTab.Media) 1.dp else 0.dp),
            ) {
                item(key = "who", span = { GridItemSpan(maxLineSpan) }) {
                    Column(
                        Modifier.fillMaxWidth().statusBarsPadding().padding(top = 40.dp, start = 16.dp, end = 16.dp, bottom = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        AgentAvatar(agent.name, p, 120.dp)
                        Spacer(Modifier.size(14.dp))
                        Text(
                            agent.displayName,
                            style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                            color = c.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            if (agent.capabilities.bot) "bot" else agent.name,
                            style = MaterialTheme.typography.bodyMedium,
                            color = c.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.size(18.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            DossierPill("Message", "chat", Modifier.weight(1f), onClick = onMessage)
                            DossierPill(if (muted) "Unmute" else "Mute", "moon", Modifier.weight(1f), onClick = onMute)
                            DossierPill("Share", "share", Modifier.weight(1f), onClick = {
                                val send = Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, "${agent.displayName} · $handle")
                                }
                                ctx.startActivity(Intent.createChooser(send, null))
                            })
                            DossierPill("Stop", "stop", Modifier.weight(1f), onClick = onStop)
                        }
                        Spacer(Modifier.size(12.dp))
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.surface).padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(handle, style = MaterialTheme.typography.bodyLarge, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("Username", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                            }
                            SoftIconButton(FoxIcons.get("copy"), "Copy username", onClick = {
                                ctx.getSystemService(ClipboardManager::class.java)
                                    ?.setPrimaryClip(ClipData.newPlainText("username", handle))
                            }, tint = c.textMuted)
                        }
                    }
                }
                item(key = "tabs", span = { GridItemSpan(maxLineSpan) }) {
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        DossierTab.entries.forEach { t ->
                            val on = tab == t
                            Column(
                                Modifier.weight(1f).clickable { tab = t }.padding(top = 10.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Text(
                                    t.name,
                                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal),
                                    color = if (on) c.accent else c.textMuted,
                                )
                                Spacer(Modifier.size(8.dp))
                                Box(Modifier.fillMaxWidth().height(2.dp).background(if (on) c.accent else Color.Transparent))
                            }
                        }
                    }
                }
                when (tab) {
                    DossierTab.Media -> {
                        if (media.isEmpty()) item(key = "nomedia", span = { GridItemSpan(maxLineSpan) }) {
                            EmptyHint("Pictures and videos this agent sent show here once you have opened a chat.")
                        } else itemsIndexed(media, key = { i, r -> "m:$i:${r.ref ?: r.url}" }) { i, r ->
                            DossierMediaTile(r, onOpen = { viewing = i })
                        }
                    }
                    DossierTab.Files -> {
                        if (files.isEmpty()) item(key = "nofiles", span = { GridItemSpan(maxLineSpan) }) {
                            EmptyHint("Documents this agent sent show here.")
                        } else files.forEach { f ->
                            item(key = "f:${f.ref ?: f.name}", span = { GridItemSpan(maxLineSpan) }) {
                                ListRow("file", f.name, onClick = {
                                    if (f.url.isNotBlank()) runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(f.url))) }
                                })
                            }
                        }
                    }
                    DossierTab.Links -> {
                        if (links.isEmpty()) item(key = "nolinks", span = { GridItemSpan(maxLineSpan) }) {
                            EmptyHint("Links from this agent's chats show here.")
                        } else links.forEach { l ->
                            item(key = "l:${l.url}", span = { GridItemSpan(maxLineSpan) }) {
                                ListRow("link", l.url, onClick = {
                                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(l.url))) }
                                })
                            }
                        }
                    }
                    DossierTab.Chats -> {
                        if (sessions.isEmpty()) item(key = "nochats", span = { GridItemSpan(maxLineSpan) }) {
                            EmptyHint("No chats saved on this device yet.")
                        } else sessions.take(20).forEach { s ->
                            item(key = "chat:${s.id}", span = { GridItemSpan(maxLineSpan) }) {
                                Row(
                                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable { onOpenSession(s.id) }
                                        .padding(horizontal = 16.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Box(Modifier.size(34.dp).clip(CircleShape).background(c.surfaceAlt), contentAlignment = Alignment.Center) {
                                        FoxIcon("chat", tint = c.textMuted, size = 18.dp)
                                    }
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
                    }
                }
            }
            SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text, modifier = Modifier.statusBarsPadding().padding(4.dp))
            if (tab == DossierTab.Media && media.isNotEmpty()) {
                Text(
                    "Clear",
                    style = MaterialTheme.typography.labelLarge,
                    color = c.accent,
                    modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().heightIn(min = 44.dp)
                        .clickable(onClick = onClearMedia).padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
        }
    }
    viewing?.let { index ->
        val start = index.coerceIn(0, (media.size - 1).coerceAtLeast(0))
        MediaViewer(media, start, httpClient, onClose = { viewing = null }, onDelete = { onMediaDeleted() })
    }
}

@Composable
private fun EmptyHint(text: String) {
    val c = LocalHubColors.current
    Text(text, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 20.dp))
}

@Composable
private fun ListRow(icon: String, title: String, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FoxIcon(icon, tint = c.accent, size = 22.dp)
        Spacer(Modifier.width(12.dp))
        Text(title, style = MaterialTheme.typography.bodyLarge, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
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
        Modifier.aspectRatio(1f).background(c.surfaceAlt).clickable(onClick = onOpen)
            .semantics { contentDescription = if (ref.kind == MediaRef.Kind.Video) "Play ${ref.alt.ifBlank { "video" }}" else "Open ${ref.alt.ifBlank { "picture" }}" },
        contentAlignment = Alignment.Center,
    ) {
        val s = src
        if (s != null) AsyncImage(s, ref.alt.ifBlank { "Media" }, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else FoxIcon(if (ref.kind == MediaRef.Kind.Video) "play" else "image", tint = c.textMuted)
        if (ref.kind == MediaRef.Kind.Video) Box(Modifier.align(Alignment.BottomStart).padding(6.dp)) { FoxIcon("play", tint = Color.White, size = 18.dp) }
    }
}

@Composable
private fun DossierPill(label: String, icon: String, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Column(
        modifier.clip(RoundedCornerShape(14.dp)).background(c.surface).clickable(onClick = onClick).padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        FoxIcon(icon, tint = c.text, size = 22.dp)
        Spacer(Modifier.size(4.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = c.text)
    }
}
