package dev.foxfleet.app.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.LiveStep
import dev.foxfleet.app.ui.chat.StepLog
import dev.foxfleet.app.ui.chat.toolPresentation

/** What one step says in a line: "Running a command · ls -la", or the commentary / status text itself. */
fun stepLabel(s: LiveStep): String = if (s.isTool) toolPresentation(s.name).second + if (s.preview.isNotBlank()) " · " + s.preview else "" else s.text

/** The panel's one-line summary: what runs now, else the newest line, else the count. */
fun stepsSummary(log: StepLog, live: Boolean): String {
    val n = log.toolCount
    val count = if (n == 1) "1 step" else "$n steps"
    val failed = log.steps.count { it.kind == "tool" && it.state == "failed" }
    if (!live) return if (n > 0) "Used " + (if (n == 1) "1 tool" else "$n tools") + (if (failed > 0) ", $failed failed" else "") else count
    return log.current?.let(::stepLabel) ?: if (n > 0) "$count done" else "Working…"
}

/**
 * The reply's progress, FoxFleet style: a quiet card with one live line (spinner + what runs now) that opens into every step,
 * each with its outcome (spinner, check, cross) and how long it took. Live while the reply streams; afterwards the finished
 * message keeps the same card, closed, as "Used N tools".
 */
@Composable
fun StepsPanel(log: StepLog, live: Boolean, stateKey: String, modifier: Modifier = Modifier, startOpen: Boolean = false) {
    if (log.isEmpty) return
    val c = LocalHubColors.current
    var open by rememberSaveable(stateKey) { mutableStateOf(startOpen) }
    val current = if (live) log.current else null
    Column(modifier.padding(bottom = 8.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).animateContentSize().testTag("steps")) {
        Row(
            Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp).clickable { open = !open }
                .semantics { contentDescription = (if (open) "Hide steps" else "Show steps") + ", " + stepsSummary(log, live) }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StepGlyph(if (live) "running" else if (log.steps.any { it.state == "failed" }) "failed" else if (log.steps.any { it.isTool && it.state != "ok" }) "done" else "ok", 16.dp)
            Spacer(Modifier.width(8.dp))
            Text(stepsSummary(log, live), style = MaterialTheme.typography.labelLarge, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (live && log.toolCount > 0) Text("${log.toolCount}", style = MaterialTheme.typography.labelMedium, color = c.textFaint, modifier = Modifier.padding(start = 8.dp))
            Icon(FoxIcons.get("chevronDown"), null, tint = c.textMuted, modifier = Modifier.padding(start = 4.dp).size(20.dp).rotate(if (open) 180f else 0f))
        }
        if (open) Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            log.steps.forEach { s -> StepRow(s) }
        }
    }
}

@Composable
private fun StepRow(s: LiveStep) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 2.dp)) { StepGlyph(if (s.isTool) s.state else if (s.state == "error") "failed" else if (s.state == "warn") "warn" else "note", 14.dp) }
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            if (s.isTool) {
                Text(toolPresentation(s.name).second, style = MaterialTheme.typography.labelMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (s.preview.isNotBlank()) Text(s.preview, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (s.state == "failed" && s.result.isNotBlank()) Text(s.result, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis)
            } else Text(s.text, style = MaterialTheme.typography.labelMedium, color = if (s.state == "error") MaterialTheme.colorScheme.error else c.textMuted, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        StepLog.duration(s.durationMs)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.padding(start = 8.dp, top = 2.dp)) }
    }
}

/** Our own glyphs (drawn, not icon assets): a turning arc while running, a check on success, a cross when it failed, a ring when it ended without an outcome, a dot for a note. */
@Composable
fun StepGlyph(state: String, size: Dp) {
    val c = LocalHubColors.current
    val err = MaterialTheme.colorScheme.error
    val label = when (state) { "running" -> "Running"; "ok" -> "Succeeded"; "done" -> "Finished"; "failed" -> "Failed"; "warn" -> "Warning"; else -> "Note" }
    if (state == "running") {
        val t = rememberInfiniteTransition(label = "step")
        val turn by t.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "turn")
        Canvas(Modifier.size(size).semantics { contentDescription = label }) {
            val w = this.size.minDimension * 0.14f
            drawArc(c.hairline, 0f, 360f, false, topLeft = Offset(w / 2, w / 2), size = Size(this.size.width - w, this.size.height - w), style = Stroke(w))
            drawArc(c.accent, turn, 100f, false, topLeft = Offset(w / 2, w / 2), size = Size(this.size.width - w, this.size.height - w), style = Stroke(w, cap = StrokeCap.Round))
        }
        return
    }
    val tint: Color = when (state) { "ok" -> c.onlineText; "failed" -> err; "warn" -> c.accent; "done" -> c.textMuted; else -> c.textFaint }
    Canvas(Modifier.size(size).semantics { contentDescription = label }) {
        val s = this.size.minDimension; val w = s * 0.13f
        when (state) {
            "ok" -> { drawLine(tint, Offset(s * 0.2f, s * 0.53f), Offset(s * 0.42f, s * 0.74f), w, StrokeCap.Round); drawLine(tint, Offset(s * 0.42f, s * 0.74f), Offset(s * 0.8f, s * 0.3f), w, StrokeCap.Round) }
            "failed" -> { drawLine(tint, Offset(s * 0.28f, s * 0.28f), Offset(s * 0.72f, s * 0.72f), w, StrokeCap.Round); drawLine(tint, Offset(s * 0.72f, s * 0.28f), Offset(s * 0.28f, s * 0.72f), w, StrokeCap.Round) }
            "warn" -> { drawLine(tint, Offset(s * 0.5f, s * 0.22f), Offset(s * 0.5f, s * 0.58f), w, StrokeCap.Round); drawCircle(tint, w * 0.7f, Offset(s * 0.5f, s * 0.78f)) }
            "done" -> drawCircle(tint, s * 0.3f, Offset(s / 2, s / 2), style = Stroke(w)) // neutral: it ended, outcome unknown
            else -> drawCircle(tint, s * 0.14f, Offset(s / 2, s / 2))
        }
    }
}
