package dev.foxfleet.app.ui.screens

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.input.pointer.pointerInput
import dev.foxfleet.app.media.CropMath
import dev.foxfleet.app.ui.LocalHubColors

/** Circle crop: pinch to zoom, drag to frame. Returns the source square in image pixels. */
@Composable
fun AvatarCropScreen(agent: String, bitmap: Bitmap, onDone: (left: Int, top: Int, size: Int) -> Unit, onCancel: () -> Unit) {
    BackHandler(onBack = onCancel)
    val c = LocalHubColors.current
    val viewportDp = 300.dp
    val vp = with(LocalDensity.current) { viewportDp.toPx() }
    val base = remember(bitmap) { CropMath.coverScale(bitmap.width, bitmap.height, vp) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var dx by remember { mutableFloatStateOf(0f) }
    var dy by remember { mutableFloatStateOf(0f) }
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    Column(Modifier.fillMaxSize().background(Color.Black).systemBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Photo for $agent", style = MaterialTheme.typography.titleMedium, color = Color.White, modifier = Modifier.padding(top = 24.dp))
        Text("Pinch to zoom, drag to frame", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAAAAA))
        Spacer(Modifier.weight(1f))
        Box(
            Modifier.size(viewportDp).clipToBounds().pointerInputTransform { pan, z ->
                zoom = (zoom * z).coerceIn(1f, 5f)
                val s = base * zoom
                dx = CropMath.clampOffset(dx + pan.x, bitmap.width.toFloat(), s, vp)
                dy = CropMath.clampOffset(dy + pan.y, bitmap.height.toFloat(), s, vp)
            },
            contentAlignment = Alignment.Center,
        ) {
            val s = base * zoom
            val wDp = with(LocalDensity.current) { (bitmap.width * s).toDp() }
            val hDp = with(LocalDensity.current) { (bitmap.height * s).toDp() }
            Image(image, null, contentScale = ContentScale.FillBounds,
                modifier = Modifier.requiredSize(wDp, hDp).graphicsLayer { translationX = dx; translationY = dy })
            Canvas(Modifier.fillMaxSize().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
                drawRect(Color(0xAA000000))
                drawCircle(Color.Black, radius = size.minDimension / 2f, blendMode = BlendMode.Clear)
                drawCircle(Color.White.copy(alpha = 0.8f), radius = size.minDimension / 2f - 1f, style = Stroke(2f))
            }
        }
        Spacer(Modifier.weight(1f))
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = onCancel) { Text("Cancel", color = Color.White) }
            TextButton(onClick = {
                val (l, t, sz) = CropMath.sourceSquare(bitmap.width, bitmap.height, vp, base * zoom, dx, dy)
                onDone(l, t, sz)
            }) { Text("Use photo", color = c.accent) }
        }
        Spacer(Modifier.height(8.dp))
    }
}

private fun Modifier.pointerInputTransform(onChange: (Offset, Float) -> Unit) =
    this.then(Modifier.pointerInput(Unit) { detectTransformGestures { _, pan, z, _ -> onChange(pan, z) } })
