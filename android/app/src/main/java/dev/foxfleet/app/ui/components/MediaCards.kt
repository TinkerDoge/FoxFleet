package dev.foxfleet.app.ui.components

import android.content.Intent
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import coil3.compose.AsyncImage
import dev.foxfleet.app.data.HubApiException
import dev.foxfleet.app.data.MediaLink
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.MediaRef
import dev.foxfleet.app.ui.chat.MediaTags
import dev.foxfleet.app.ui.chat.TagMedia
import dev.foxfleet.app.ui.chat.TagMediaData
import androidx.compose.foundation.layout.defaultMinSize
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** Account-scoped cache and transport. Resolve signed links only on a cache miss. */
class MediaHost(
    val client: OkHttpClient,
    val cache: dev.foxfleet.app.media.MediaRepository.Session? = null,
    val resolve: suspend (agent: String, ref: String) -> MediaLink,
) {
    var diagnose: (suspend (url: String) -> HubFailure?)? = null
    suspend fun acquire(agent: String, ref: String, instance: String, progress: (dev.foxfleet.app.media.MediaRepository.Progress) -> Unit = {}): dev.foxfleet.app.media.MediaRepository.Lease {
        val session = cache ?: error("Media cache is unavailable")
        return session.acquire(dev.foxfleet.app.media.MediaRepository.identity(agent, instance, ref), progress) { file, limit, report ->
            val link = resolveWithRetry(this, agent, ref)
            try { dev.foxfleet.app.media.downloadMedia(client, link.url, file, limit, report) }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) {
                val failure = diagnose?.invoke(link.url)
                if (failure != null) throw HubApiException(failure.status, failure.message ?: "Media unavailable", network = failure.network, code = failure.code)
                throw e
            }
        }
    }
    /** Local-only delete of one cached file — the primitive the viewer's delete-for-everyone runs after the hub revoke. A viewer holding the file keeps it until it closes. */
    suspend fun delete(agent: String, ref: String, instance: String) = withContext(Dispatchers.IO) {
        cache?.delete(dev.foxfleet.app.media.MediaRepository.identity(agent, instance, ref))
    }

    /** Device-only delete of every cached media file of [agent] (dossier / settings). */
    suspend fun deleteAgent(agent: String) = withContext(Dispatchers.IO) { cache?.deleteAgent(agent) }
}
val LocalMediaHost = compositionLocalOf<MediaHost?> { null }

private sealed interface Card { object Loading : Card; data class Failed(val why: MediaProblem) : Card; data class Ready(val link: MediaLink) : Card }

/** The hub learns a ref when the reply is stored; a card shown a moment earlier asks again briefly instead of failing. */
internal suspend fun resolveWithRetry(host: MediaHost, agent: String, ref: String): MediaLink {
    var n = 0
    while (true) {
        try { return host.resolve(agent, ref) } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            val status = (e as? HubApiException)?.status ?: 0
            if (n >= 3 || (status in 400..499 && status != 404 && status != 408)) throw e
            delay(500L * (++n))
        }
    }
}

/** Pictures, video, voice/audio and files an agent sent with MEDIA: tags, drawn under the reply. */
@Composable
fun AgentMediaCards(agent: String, media: List<TagMedia>, onOpen: (MediaRef) -> Unit, instance: String = "") {
    if (media.isEmpty()) return
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { media.forEach { MediaCardFor(agent, it, onOpen, instance) } }
}

@Composable
private fun MediaCardFor(agent: String, m: TagMedia, onOpen: (MediaRef) -> Unit, instance: String) {
    val host = LocalMediaHost.current
    val c = LocalHubColors.current
    var tick by remember { mutableIntStateOf(0) }
    val state by produceState<Card>(Card.Loading, listOf(agent, m.ref, instance, tick, host)) {
        value = Card.Loading
        if (host == null) { value = Card.Failed(MediaProblem.Generic); return@produceState }
        if (TagMediaData.isData(m.ref)) { value = Card.Ready(MediaLink(m.ref, "image", m.name)); return@produceState } // a data: picture carries its own bytes
        value = try {
            if (host.cache != null && m.kind == TagMedia.Kind.Image) {
                val lease = host.acquire(agent, m.ref, instance)
                try {
                    value = Card.Ready(MediaLink(lease.file.toURI().toString(), "image", m.name))
                    kotlinx.coroutines.awaitCancellation()
                } finally { lease.close() }
            } else if (host.cache != null) Card.Ready(MediaLink("", m.kind.name.lowercase(), m.name))
            else Card.Ready(resolveWithRetry(host, agent, m.ref))
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            val h = e as? HubApiException
            Card.Failed(mediaProblem(HubFailure(h?.status ?: 0, h?.code, h?.message, network = h?.network == true || h == null)))
        }
    }
    val shape = RoundedCornerShape(14.dp)
    when (val s = state) {
        Card.Loading -> Row(Modifier.clip(shape).background(c.surfaceAlt).padding(horizontal = 14.dp, vertical = 12.dp).semantics { contentDescription = "Loading ${m.name}" }, verticalAlignment = Alignment.CenterVertically) {
            Icon(FoxIcons.get(if (m.kind == TagMedia.Kind.Image) "image" else "file"), null, tint = c.textFaint, modifier = Modifier.size(22.dp)); Spacer(Modifier.width(8.dp))
            Text(m.name, style = MaterialTheme.typography.bodyMedium, color = c.textFaint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        is Card.Failed -> {
            val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
            val cmd = if (s.why == MediaProblem.Outside) allowMediaCommand(m.ref) else ""
            var copied by remember { mutableStateOf(false) }
            Column(Modifier.clip(shape).background(c.surfaceAlt).padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(FoxIcons.get("attach"), null, tint = c.textMuted, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(8.dp))
                    Column { Text(m.name, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(s.why.text, style = MaterialTheme.typography.labelSmall, color = c.textMuted) }
                }
                if (cmd.isNotEmpty()) Text("Share its folder with: $cmd", style = MaterialTheme.typography.labelSmall, color = c.textFaint)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (cmd.isNotEmpty()) Text(if (copied) "Copied" else "Copy fix", style = MaterialTheme.typography.labelLarge, color = c.accent, modifier = Modifier.defaultMinSize(minHeight = 44.dp).clickable { clipboard.setText(androidx.compose.ui.text.AnnotatedString(cmd)); copied = true }.padding(vertical = 12.dp))
                    if (s.why != MediaProblem.HubTooOld) Text("Try again", style = MaterialTheme.typography.labelLarge, color = c.accent, modifier = Modifier.defaultMinSize(minHeight = 44.dp).clickable { tick++ }.padding(vertical = 12.dp))
                }
            }
        }
        is Card.Ready -> when (s.link.kind) {
            "image" -> AsyncImage(s.link.url, m.name, contentScale = ContentScale.Fit, modifier = Modifier.clip(shape).background(c.surfaceAlt).heightIn(min = 80.dp, max = 280.dp).clickable { onOpen(MediaRef(s.link.url, MediaRef.Kind.Image, m.name, agent, m.ref, instance)) })
            "video" -> Box(Modifier.fillMaxWidth().heightIn(min = 120.dp).clip(shape).background(c.surfaceAlt).clickable { onOpen(MediaRef(s.link.url, MediaRef.Kind.Video, m.name, agent, m.ref, instance)) }.semantics { contentDescription = "Play video ${m.name}" }, contentAlignment = Alignment.Center) {
                Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) { Icon(FoxIcons.get("play"), null, tint = c.accent, modifier = Modifier.size(32.dp)); Spacer(Modifier.width(8.dp)); Text(m.name, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            "audio" -> CachedAudioCard(agent, instance, s.link, m, host)
            else -> FileCard(agent, instance, s.link, m, host)
        }
    }
}

@Composable
private fun AudioCard(link: MediaLink, m: TagMedia, host: MediaHost?) {
    val c = LocalHubColors.current; val ctx = LocalContext.current
    var playing by remember { mutableStateOf(false) }; val inspect = LocalInspectionMode.current
    val player = remember(link.url) {
        if (inspect || host == null) null else ExoPlayer.Builder(ctx).setMediaSourceFactory(DefaultMediaSourceFactory(ctx).setDataSourceFactory(androidx.media3.datasource.DefaultDataSource.Factory(ctx, OkHttpDataSource.Factory(host.client)))).build().apply {
            setMediaItem(MediaItem.fromUri(link.url)); prepare()
            addListener(object : androidx.media3.common.Player.Listener { override fun onIsPlayingChanged(p: Boolean) { playing = p }; override fun onPlaybackStateChanged(st: Int) { if (st == androidx.media3.common.Player.STATE_ENDED) { playing = false; seekTo(0); pause() } } })
        }
    }
    DisposableEffect(player) { onDispose { player?.release() } }
    Row(Modifier.clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt).clickable { player?.let { if (it.isPlaying) it.pause() else it.play() } }.padding(horizontal = 14.dp, vertical = 10.dp).semantics { contentDescription = (if (playing) "Pause " else "Play ") + (if (m.voice) "voice message" else m.name) }, verticalAlignment = Alignment.CenterVertically) {
        Icon(FoxIcons.get(if (playing) "close" else "play"), null, tint = c.accent, modifier = Modifier.size(28.dp)); Spacer(Modifier.width(10.dp))
        Text(if (m.voice) "Voice message" else m.name, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun FileCard(agent: String, instance: String, link: MediaLink, m: TagMedia, host: MediaHost?) {
    val c = LocalHubColors.current; val ctx = LocalContext.current; val scope = androidx.compose.runtime.rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }; var err by remember { mutableStateOf(false) }
    Row(Modifier.clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt).clickable(enabled = !busy && host != null) {
        busy = true; err = false
        scope.launch {
            val ok = try {
                host!!.acquire(agent, m.ref, instance).use { lease -> openCachedFile(ctx, lease.file, m.name) }; true
            } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { false }
            busy = false; err = !ok
        }
    }.padding(horizontal = 14.dp, vertical = 12.dp).semantics { contentDescription = "Download ${m.name}" }, verticalAlignment = Alignment.CenterVertically) {
        Icon(FoxIcons.get("file"), null, tint = c.accent, modifier = Modifier.size(24.dp)); Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f, fill = false)) { Text(m.name, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(if (err) "Could not download. Tap to try again" else if (busy) "Downloading…" else "Tap to open", style = MaterialTheme.typography.labelSmall, color = c.textMuted) }
        Spacer(Modifier.width(10.dp)); Icon(FoxIcons.get("download"), null, tint = c.textMuted, modifier = Modifier.size(20.dp))
    }
}

/** Grants read access only after the user explicitly taps a file. */
private fun openCachedFile(ctx: android.content.Context, file: java.io.File, name: String) {
    val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(80).ifBlank { "file" }
    val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
    val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(safe.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(Intent.createChooser(view, safe).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

@Composable
private fun CachedAudioCard(agent: String, instance: String, link: MediaLink, m: TagMedia, host: MediaHost?) {
    if (host?.cache == null) { AudioCard(link, m, host); return }
    val c = LocalHubColors.current
    var opened by remember(host, m.ref, instance) { mutableStateOf(false) }
    val source by produceState<String?>(null, host, m.ref, instance, opened) {
        if (!opened) return@produceState
        try {
            val lease = host.acquire(agent, m.ref, instance)
            try { value = lease.file.toURI().toString(); kotlinx.coroutines.awaitCancellation() } finally { lease.close() }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { opened = false }
    }
    if (source != null) AudioCard(link.copy(url = source!!), m, host)
    else Text(if (opened) "Loading audio…" else "Play ${if (m.voice) "voice message" else m.name}", color = c.accent,
        modifier = Modifier.defaultMinSize(minHeight = 48.dp).clickable { opened = !opened }.padding(14.dp))
}

/** Reply text with MEDIA: tags removed and the media drawn as cards below. */
@Composable
fun AssistantBody(agent: String, text: String, streaming: Boolean = false, instance: String = "", onOpen: (MediaRef) -> Unit, drawText: @Composable (String) -> Unit) {
    val parsed = remember(text, streaming) { if (streaming) MediaTags.parseStreaming(text) else MediaTags.parse(text) }
    if (parsed.text.isNotBlank()) drawText(parsed.text)
    AgentMediaCards(agent, parsed.media, onOpen, instance)
}
