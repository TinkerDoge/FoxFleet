package dev.foxfleet.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.live.MessageStatus

/*
 * Small glyphs drawn in code for the phase 1 chat list and bubbles (FoxFleet's own strokes, no icon set copied):
 * delivery ticks, muted bell, archive box.
 */

/** sent = one tick, delivered = two, read = two in [readColor], failed = an exclamation mark in [failColor]. */
@Composable
fun StatusTicks(status: String?, color: Color, readColor: Color, failColor: Color, modifier: Modifier = Modifier, height: Dp = 12.dp) {
    if (status == null || status !in MessageStatus.ALL) return
    val label = when (status) { MessageStatus.SENT -> "Sent"; MessageStatus.DELIVERED -> "Delivered"; MessageStatus.READ -> "Read"; else -> "Not delivered" }
    val tint = when (status) { MessageStatus.READ -> readColor; MessageStatus.FAILED -> failColor; else -> color }
    val double = status == MessageStatus.DELIVERED || status == MessageStatus.READ
    Canvas(modifier.size(if (status == MessageStatus.FAILED) height else height * if (double) 1.5f else 1.05f, height).semantics { contentDescription = label }) {
        val w = 1.6.dp.toPx(); val h = size.height; val stroke = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round)
        if (status == MessageStatus.FAILED) {
            drawCircle(tint, radius = h / 2 - w / 2, style = Stroke(w))
            drawLine(tint, Offset(h / 2, h * 0.27f), Offset(h / 2, h * 0.58f), w, StrokeCap.Round)
            drawCircle(tint, radius = w * 0.6f, center = Offset(h / 2, h * 0.76f))
            return@Canvas
        }
        fun tick(dx: Float, short: Boolean) = Path().apply {
            if (!short) { moveTo(dx + h * 0.08f, h * 0.55f); lineTo(dx + h * 0.36f, h * 0.82f) } else moveTo(dx + h * 0.36f, h * 0.82f)
            lineTo(dx + h * 0.92f, h * 0.2f)
        }
        drawPath(tick(0f, false), tint, style = stroke)
        if (double) drawPath(tick(h * 0.42f, true), tint, style = stroke)
    }
}

/** A bell with a slash: notifications for this chat are muted. */
@Composable
fun MutedGlyph(color: Color, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    Canvas(modifier.size(size).semantics { contentDescription = "Muted" }) {
        val s = this.size.width; val w = 1.5.dp.toPx(); val st = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val bell = Path().apply {
            moveTo(s * 0.22f, s * 0.72f); lineTo(s * 0.78f, s * 0.72f)
            quadraticTo(s * 0.68f, s * 0.6f, s * 0.7f, s * 0.42f); quadraticTo(s * 0.68f, s * 0.18f, s * 0.5f, s * 0.16f)
            quadraticTo(s * 0.32f, s * 0.18f, s * 0.3f, s * 0.42f); quadraticTo(s * 0.32f, s * 0.6f, s * 0.22f, s * 0.72f)
        }
        drawPath(bell, color, style = st)
        drawLine(color, Offset(s * 0.42f, s * 0.84f), Offset(s * 0.58f, s * 0.84f), w, StrokeCap.Round)
        drawLine(color, Offset(s * 0.14f, s * 0.12f), Offset(s * 0.86f, s * 0.9f), w, StrokeCap.Round)
    }
}

/** An open-top box: the archive. */
@Composable
fun ArchiveGlyph(color: Color, modifier: Modifier = Modifier, size: Dp = 22.dp) {
    Canvas(modifier.size(size)) {
        val s = this.size.width; val w = 1.8.dp.toPx(); val st = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawRoundRect(color, topLeft = Offset(s * 0.14f, s * 0.2f), size = androidx.compose.ui.geometry.Size(s * 0.72f, s * 0.18f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(w), style = st)
        val body = Path().apply { moveTo(s * 0.2f, s * 0.38f); lineTo(s * 0.2f, s * 0.8f); lineTo(s * 0.8f, s * 0.8f); lineTo(s * 0.8f, s * 0.38f) }
        drawPath(body, color, style = st)
        drawLine(color, Offset(s * 0.4f, s * 0.52f), Offset(s * 0.6f, s * 0.52f), w, StrokeCap.Round)
    }
}
