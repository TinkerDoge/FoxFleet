package dev.foxfleet.app.ui.components

import dev.foxfleet.app.ui.FoxIcons
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
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
import me.saket.telephoto.zoomable.coil3.ZoomableAsyncImage
import okhttp3.OkHttpClient

/** Fullscreen viewer owns a cache lease, so clearing storage cannot interrupt an open video. */
@Composable
fun MediaViewer(item: MediaRef, client: OkHttpClient?, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
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
    Box(Modifier.fillMaxSize().background(Color.Black)) {
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
                TextButton(onClick = onClose) { Text("Cancel") }
            }
        }
        SoftIconButton(FoxIcons.get("close"), "Close", onClose,
            modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp), tint = Color.White, background = Color(0x66000000))
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
