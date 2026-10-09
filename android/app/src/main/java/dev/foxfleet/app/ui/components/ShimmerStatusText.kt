package dev.foxfleet.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.motion.reduceMotion

/** Strips trailing "…" / "..." so the animated dots replace them. */
fun statusBase(text: String): String = text.trimEnd().removeSuffix("…").removeSuffix("...").trimEnd()

/**
 * "Atlas is working…" status line: a soft highlight sweeps across muted text,
 * followed by three dots fading in turn. Static text under reduce motion.
 */
@Composable
fun ShimmerStatusText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    color: Color = LocalHubColors.current.textMuted,
) {
    val base = statusBase(text)
    if (reduceMotion()) {
        Text("$base…", modifier = modifier, style = style, color = color)
        return
    }
    val t = rememberInfiniteTransition(label = "shimmer")
    val sweep by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart), label = "sweep")
    val dots by t.animateFloat(0f, 3f, infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart), label = "dots")
    val dim = color.copy(alpha = 0.55f)
    val brush = object : ShaderBrush() {
        override fun createShader(size: Size): Shader {
            val w = size.width.coerceAtLeast(1f)
            val x = -w * 0.5f + sweep * w * 2f
            return LinearGradientShader(
                from = Offset(x - w * 0.35f, 0f), to = Offset(x + w * 0.35f, 0f),
                colors = listOf(dim, color, dim),
            )
        }
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(
            buildAnnotatedString { withStyle(SpanStyle(brush = brush)) { append(base) } },
            style = style,
        )
        Text(
            buildAnnotatedString {
                for (i in 0..2) {
                    val phase = ((dots - i + 3f) % 3f)
                    val a = if (phase < 1f) 0.35f + 0.65f * (1f - phase) else 0.35f
                    withStyle(SpanStyle(color = color.copy(alpha = a))) { append(".") }
                }
            },
            style = style,
        )
    }
}
