package dev.foxfleet.app.ui.components

import android.annotation.SuppressLint
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.foxfleet.app.ui.motion.reduceMotion

/**
 * Loading/brand mark. Plays `res/raw/foxfleet_loader.riv` through the Rive runtime when
 * that asset exists; otherwise (the default — no .riv ships yet) a breathing Compose
 * avatar stands in. Drop a licensed .riv at that path to switch over, no code change.
 */
@SuppressLint("DiscouragedApi")
@Composable
fun RiveAvatar(name: String, size: Dp = 64.dp, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val inspection = LocalInspectionMode.current
    val resId = remember(ctx) { ctx.resources.getIdentifier(RIVE_ASSET, "raw", ctx.packageName) }
    if (resId != 0 && !inspection) {
        AndroidView(
            modifier = modifier.size(size),
            factory = { c ->
                runCatching { app.rive.runtime.kotlin.core.Rive.init(c) }
                app.rive.runtime.kotlin.RiveAnimationView(c).apply { setRiveResource(resId) }
            },
        )
        return
    }
    BreathingAvatar(name, size, modifier)
}

const val RIVE_ASSET = "foxfleet_loader"

@Composable
private fun BreathingAvatar(name: String, size: Dp, modifier: Modifier) {
    val reduce = reduceMotion()
    val t = rememberInfiniteTransition(label = "breath")
    val s by t.animateFloat(0.94f, 1.04f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "s")
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        AgentAvatar(
            name, presence = null, size = size * 0.8f,
            modifier = Modifier.graphicsLayer { val k = if (reduce) 1f else s; scaleX = k; scaleY = k },
        )
    }
}
