package dev.foxfleet.app.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import dev.foxfleet.app.ui.chat.MediaRef
import me.saket.telephoto.zoomable.coil3.ZoomableAsyncImage
import okhttp3.OkHttpClient

/** Fullscreen black viewer: pinch/double-tap zoom for images, Media3 player for video. */
@Composable
fun MediaViewer(item: MediaRef, client: OkHttpClient?, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when (item.kind) {
            MediaRef.Kind.Image -> ZoomableAsyncImage(
                model = item.url, contentDescription = item.alt.ifBlank { "Image" }, modifier = Modifier.fillMaxSize(),
            )
            MediaRef.Kind.Video -> if (!LocalInspectionMode.current) VideoPlayer(item.url, client)
        }
        SoftIconButton(
            Icons.Filled.Close, "Close", onClose,
            modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp),
            tint = Color.White, background = Color(0x66000000),
        )
    }
}

@Composable
private fun VideoPlayer(url: String, client: OkHttpClient?) {
    val ctx = LocalContext.current
    val player = remember(url) {
        val b = ExoPlayer.Builder(ctx)
        if (client != null) b.setMediaSourceFactory(DefaultMediaSourceFactory(ctx).setDataSourceFactory(OkHttpDataSource.Factory(client)))
        b.build().apply { setMediaItem(MediaItem.fromUri(url)); prepare(); playWhenReady = true }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView(factory = { PlayerView(it).apply { this.player = player } }, modifier = Modifier.fillMaxSize())
}
