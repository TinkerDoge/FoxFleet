package dev.foxfleet.app.ui.motion

import android.provider.Settings
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import dev.foxfleet.app.ui.LocalAppPrefs

/**
 * Reduce motion is on when the user flips it in Settings, or when the system
 * "Remove animations" switch sets the animator duration scale to 0.
 */
fun shouldReduceMotion(userPref: Boolean, animatorDurationScale: Float): Boolean =
    userPref || animatorDurationScale <= 0f

/** Delay for the n-th item of a staggered entrance; capped so long lists don't crawl. */
fun staggerDelayMs(index: Int, stepMs: Int = 40, maxMs: Int = 320): Int =
    if (index < 0) 0 else minOf(index * stepMs, maxMs)

@Composable
fun reduceMotion(): Boolean {
    val ctx = LocalContext.current
    val pref = LocalAppPrefs.current.reduceMotion
    val scale = remember(ctx) {
        runCatching { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f)
    }
    return shouldReduceMotion(pref, scale)
}

/** Spring press feedback: scales to [pressed] while held. Static under reduce motion. */
@Composable
fun Modifier.pressScale(interaction: MutableInteractionSource, pressed: Float = 0.96f): Modifier {
    val isPressed by interaction.collectIsPressedAsState()
    val reduce = reduceMotion()
    val s by animateFloatAsState(
        targetValue = if (isPressed && !reduce) pressed else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMediumLow),
        label = "press",
    )
    return this.graphicsLayer { scaleX = s; scaleY = s }
}

/** Haptic tick that honours the Settings toggle. */
@Composable
fun rememberHaptic(): (HapticFeedbackType) -> Unit {
    val h = LocalHapticFeedback.current
    val on = LocalAppPrefs.current.haptics
    return remember(h, on) { { t -> if (on) h.performHapticFeedback(t) } }
}
