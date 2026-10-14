package vn.mint.taivideo.ui

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import vn.mint.taivideo.R
import kotlin.math.min
import kotlin.math.roundToInt

internal enum class ShibaPose(val frame: Int) {
    Idle(0), Downloading(3), Success(4), Error(5),
}

private data class SpriteBounds(val x: Int, val y: Int, val width: Int, val height: Int)

// Alpha bounds from the generated atlas. Bottom-center alignment keeps blink frames steady.
private val SpriteFrames = listOf(
    SpriteBounds(109, 43, 381, 460),
    SpriteBounds(576, 44, 389, 459),
    SpriteBounds(1070, 44, 384, 459),
    SpriteBounds(100, 520, 394, 457),
    SpriteBounds(574, 521, 392, 456),
    SpriteBounds(1063, 559, 397, 423),
)

@Composable
internal fun PixelShiba(pose: ShibaPose = ShibaPose.Idle, modifier: Modifier = Modifier) {
    val image = ImageBitmap.imageResource(R.drawable.doge_sprites)
    val lifecycleOwner = LocalLifecycleOwner.current
    var frame by remember(pose) { mutableIntStateOf(pose.frame) }
    LaunchedEffect(lifecycleOwner, pose) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (pose == ShibaPose.Idle) {
                while (isActive) {
                    frame = 0
                    delay(3000)
                    frame = 1
                    delay(100)
                    frame = 2
                    delay(100)
                    frame = 1
                    delay(100)
                }
            }
        }
    }
    val bob = if (pose == ShibaPose.Downloading) {
        val transition = rememberInfiniteTransition(label = "shiba-download")
        val value by transition.animateFloat(
            initialValue = -8f, targetValue = 8f,
            animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "shiba-bob",
        )
        value
    } else 0f
    Canvas(modifier) {
        val bounds = SpriteFrames[frame]
        val scale = min(size.width, size.height) / 512f
        val width = (bounds.width * scale).roundToInt()
        val height = (bounds.height * scale).roundToInt()
        val x = ((size.width - width) / 2).roundToInt()
        val y = ((size.height - 460 * scale) / 2 + (460 - bounds.height + bob) * scale).roundToInt()
        drawImage(
            image, srcOffset = IntOffset(bounds.x, bounds.y), srcSize = IntSize(bounds.width, bounds.height),
            dstOffset = IntOffset(x, y), dstSize = IntSize(width, height), filterQuality = FilterQuality.None,
        )
    }
}

@Composable
internal fun AnimatedRefreshIcon(modifier: Modifier = Modifier, contentDescription: String? = null, tint: Color = LocalContentColor.current) {
    val transition = rememberInfiniteTransition(label = "pixel-refresh")
    val rotation by transition.animateFloat(
        initialValue = 0f, targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "refresh-rotation",
    )
    Icon(painterResource(R.drawable.ic_pixel_refresh), contentDescription, modifier.graphicsLayer { rotationZ = rotation }, tint)
}

@Composable
internal fun AnimatedDownloadIcon(modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) {
    val transition = rememberInfiniteTransition(label = "pixel-download")
    val offset by transition.animateFloat(
        initialValue = -3f, targetValue = 3f,
        animationSpec = infiniteRepeatable(tween(700, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "download-offset",
    )
    Icon(painterResource(R.drawable.ic_pixel_download), null, modifier.graphicsLayer { translationY = offset }, tint)
}
