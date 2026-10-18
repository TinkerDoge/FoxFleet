package dev.foxfleet.app.ui.components

import dev.foxfleet.app.ui.FoxIcons
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import dev.foxfleet.app.media.MediaRepository
import dev.foxfleet.app.ui.chat.MediaRef
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import me.saket.telephoto.zoomable.coil3.ZoomableAsyncImage
import okhttp3.OkHttpClient

/** Fullscreen viewer for one item (kept for the single-item callers and tests). */
@Composable
fun MediaViewer(item: MediaRef, client: OkHttpClient?, onClose: () -> Unit) =
    MediaViewer(listOf(item), 0, client, onClose)

/**
 * Fullscreen viewer for a list of media (0.4.3 C3): horizontal swipe moves between the chat's pictures and
 * videos, or a dossier's grid. Each page owns a cache lease, so clearing storage or deleting another file
 * cannot interrupt the one on screen. [onDelete] (when given) shows a trash action that removes the file from
 * this device only; the hub copy is untouched and the next open downloads it again.
 */
@Composable
fun MediaViewer(items: List<MediaRef>, startIndex: Int, client: OkHttpClient?, onClose: () -> Unit, onDelete: ((MediaRef) -> Unit)? = null) {
    BackHandler(onBack = onClose)
    if (items.isEmpty()) { LaunchedEffect(Unit) { onClose() }; return }
    val host = LocalMediaHost.current
    val scope = rememberCoroutineScope()
    val pager = rememberPagerState(initialPage = startIndex.coerceIn(0, items.size - 1)) { items.size }
    val current = items.getOrNull(pager.currentPage)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page -> MediaPage(items[page], client) }
        Row(Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val deletable = current != null && host?.cache != null && current.agent != null && current.ref != null
            if (onDelete != null && deletable) SoftIconButton(FoxIcons.get("delete"), "Delete from this device", onClick = {
                scope.launch {
                    host!!.delete(current.agent!!, current.ref!!, current.instance)
                    onDelete(current)
                    onClose()
                }
            }, tint = Color.White, background = Color(0x66000000))
            SoftIconButton(FoxIcons.get("close"), "Close", onClose, tint = Color.White, background = Color(0x66000000))
        }
        if (items.size > 1) Text(
            "${pager.currentPage + 1} / ${items.size}",
            color = Color.White,
            modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp),
        )
    }
}

@Composable
private fun MediaPage(item: MediaRef, client: OkHttpClient?) {
    val host = LocalMediaHost.current
    var progress by remember(item, host) { mutableStateOf(MediaRepository.Progress()) }
    var attempt by remember(item, host) { mutableIntStateOf(0) }
    var error by remember(item, host) { mutableStateOf(false) }
    val cached = host?.cache != null && item.agent != null && item.ref != null
    val source by produceState<String?>(if (cached) null else item.url, item, host, attempt) {
        if (!cached) { value = item.url; return@produceState }
        value = null; error = false
        try {
            val lease = host!!.acquire(item.agent!!, item.ref!!, item.instance) { progress = it }
            try { value = lease.file.toURI().toString(); awaitCancellation() } finally { lease.close() }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { error = true }
    }
    Box(Modifier.fillMaxSize()) {
        if (source != null) when (item.kind) {
            MediaRef.Kind.Image -> ZoomableAsyncImage(model = source, contentDescription = item.alt.ifBlank { "Image" }, modifier = Modifier.fillMaxSize())
            MediaRef.Kind.Video -> if (!LocalInspectionMode.current) VideoPlayer(source!!, host?.client ?: client)
        } else Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (error) {
                Text("Couldn't load this media", color = Color.White)
                TextButton(onClick = { attempt++ }) { Text("Try again") }
            } else {
                CircularProgressIndicator(color = Color.White)
                Spacer(Modifier.height(16.dp))
                val total = progress.total
                Text(if (total != null && total > 0) "Downloading ${(progress.bytes * 100 / total).coerceAtMost(100)}%" else "Downloading… ${progress.bytes / 1024} KB", color = Color.White)
            }
        }
    }
}

@Composable
private fun VideoPlayer(url: String, client: OkHttpClient?) {
    val ctx = LocalContext.current
    var failed by remember(url) { mutableStateOf(false) }
    val player = remember(url, client) {
        val b = ExoPlayer.Builder(ctx)
        if (client != null) b.setMediaSourceFactory(DefaultMediaSourceFactory(ctx).setDataSourceFactory(DefaultDataSource.Factory(ctx, OkHttpDataSource.Factory(client))))
        b.build().apply {
            addListener(object : androidx.media3.common.Player.Listener {
                override fun onPlayerError(error: androidx.media3.common.PlaybackException) { failed = true }
            })
            setMediaItem(MediaItem.fromUri(url)); prepare(); playWhenReady = true
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView(factory = { PlayerView(it).apply { this.player = player } }, modifier = Modifier.fillMaxSize())
    if (failed) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("This video couldn't be played on this device", color = Color.White, modifier = Modifier.background(Color.Black).padding(24.dp))
    }
}
