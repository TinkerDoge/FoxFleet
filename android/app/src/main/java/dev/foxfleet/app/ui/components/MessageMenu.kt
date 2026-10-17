package dev.foxfleet.app.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.HEART
import dev.foxfleet.app.ui.chat.MessageAction
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.QUICK_REACTIONS
import dev.foxfleet.app.ui.motion.reduceMotion
import dev.foxfleet.app.ui.motion.rememberHaptic
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Long-press sheet (Discord style): quick reactions, then the actions this message offers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageMenuSheet(actions: List<MessageAction>, canReact: Boolean, onReact: (String) -> Unit, onMoreReactions: () -> Unit, onAction: (MessageAction) -> Unit, onDismiss: () -> Unit, reactHint: String? = null) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = LocalHubColors.current.surface) {
        MessageMenuContent(actions, canReact, onReact, onMoreReactions, onAction, reactHint)
    }
}

/** The sheet's body, separate so screenshot tests can draw it without a window. */
@Composable
fun MessageMenuContent(actions: List<MessageAction>, canReact: Boolean, onReact: (String) -> Unit, onMoreReactions: () -> Unit, onAction: (MessageAction) -> Unit, reactHint: String? = null) {
    val c = LocalHubColors.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
        // 0.4.2: an older hub that cannot take a reaction on this message says so, where the quick row would be (it used to be silently missing)
        if (!canReact && reactHint != null) Row(Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).semantics(mergeDescendants = true) {}.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(FoxIcons.get("react"), null, tint = c.textMuted, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(12.dp))
            Column {
                Text(dev.foxfleet.app.ui.chat.MessageActions.HUB_HINT, style = MaterialTheme.typography.bodyLarge, color = c.text)
                Text(reactHint, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            }
        }
        if (canReact) Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            QUICK_REACTIONS.forEach { e ->
                Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceAlt).semantics { contentDescription = "React $e" }.clickable(role = Role.Button) { onReact(e) }, contentAlignment = Alignment.Center) {
                    // The glyph may fall back to text; keep it out of the button's label.
                    Box(Modifier.clearAndSetSemantics {}) { EmojiGlyph(e, 28.dp) }
                }
            }
            Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceAlt).semantics { contentDescription = "More reactions" }.clickable(role = Role.Button, onClick = onMoreReactions), contentAlignment = Alignment.Center) {
                Icon(FoxIcons.get("react"), null, tint = c.textMuted, modifier = Modifier.size(24.dp))
            }
        }
        actions.forEach { a ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button) { onAction(a) }.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(FoxIcons.get(a.icon), null, tint = c.text, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(16.dp))
                Text(a.label, style = MaterialTheme.typography.bodyLarge, color = c.text)
            }
        }
    }
}

/** "Select text": the message in a selectable, scrollable dialog. */
@Composable
fun SelectTextDialog(text: String, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).clip(RoundedCornerShape(16.dp)).background(c.surface).padding(16.dp)) {
            Text("Select text", style = MaterialTheme.typography.titleMedium, color = c.text)
            SelectionContainer(Modifier.padding(top = 8.dp).weight(1f, fill = false).verticalScroll(rememberScrollState())) { Text(text, style = MaterialTheme.typography.bodyLarge, color = c.text) }
            Text("Close", color = c.accent, modifier = Modifier.align(Alignment.End).padding(top = 8.dp).clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button, onClick = onDismiss).padding(8.dp))
        }
    }
}

/** The quoted line of a reply, drawn as a bubble with an accent bar (Telegram style). */
@Composable
fun ReplyQuote(text: String, modifier: Modifier = Modifier, label: String? = null) {
    val c = LocalHubColors.current
    Row(modifier.height(IntrinsicSize.Min).clip(RoundedCornerShape(8.dp)).background(c.surfaceAlt.copy(alpha = 0.6f))) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent))
        Column(Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp)) {
            if (label != null) Text(label, style = MaterialTheme.typography.labelMedium, color = c.accent, maxLines = 1)
            Text(text, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * The heart that pops over a message on double tap (bump [trigger] to pop it again). Nothing when reduce-motion is on.
 * It takes no layout space: it measures as 0x0 and draws centred on where it is placed, so it never resizes the frame.
 */
@Composable
fun HeartPop(trigger: Int, modifier: Modifier = Modifier) {
    if (trigger == 0 || reduceMotion()) return
    var done by remember(trigger) { mutableStateOf(false) }
    if (done) return
    val scale = remember(trigger) { Animatable(0.4f) }; val alpha = remember(trigger) { Animatable(1f) }
    LaunchedEffect(trigger) { scale.animateTo(1.15f, tween(220)); alpha.animateTo(0f, tween(200)); done = true }
    Box(
        modifier
            .layout { m, _ -> val p = m.measure(Constraints()); layout(0, 0) { p.place(-p.width / 2, -p.height / 2) } }
            .graphicsLayer { scaleX = scale.value; scaleY = scale.value; this.alpha = alpha.value }
            .clearAndSetSemantics {},
    ) { EmojiGlyph(HEART, 44.dp) }
}

/**
 * Swipe a message right to reply: it follows the finger (max 96 dp), a reply arrow fades in, past 64 dp a tick,
 * release past 64 dp replies. Only horizontal drags are claimed, so the list still scrolls vertically.
 */
@Composable
fun SwipeToReply(onReply: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = LocalHubColors.current; val scope = rememberCoroutineScope()
    val reply by rememberUpdatedState(onReply)
    val haptic by rememberUpdatedState(rememberHaptic())
    val reduce by rememberUpdatedState(reduceMotion())
    // Plain state while dragging (each event writes it synchronously, no coroutine per event); animated back only on release.
    var offset by remember { mutableFloatStateOf(0f) }
    var left by remember { mutableFloatStateOf(0f) }
    Box(modifier.onGloballyPositioned { left = it.positionInWindow().x }.pointerInput(Unit) {
        var active = false; var armed = false; var settle: Job? = null
        fun release() {
            active = false; armed = false
            settle = scope.launch { if (reduce) offset = 0f else animate(offset, 0f, animationSpec = spring()) { v, _ -> offset = v } }
        }
        detectHorizontalDragGestures(
            onDragStart = { o -> settle?.cancel(); active = MessageActions.swipeAllowed(left + o.x, 24.dp.toPx()); armed = false },
            onDragEnd = { if (active && MessageActions.swipeFires(offset, 64.dp.toPx())) reply(); release() },
            onDragCancel = { release() },
        ) { change, dx ->
            if (!active) return@detectHorizontalDragGestures
            change.consume()
            offset = (offset + dx).coerceIn(0f, 96.dp.toPx())
            val fires = MessageActions.swipeFires(offset, 64.dp.toPx())
            if (fires && !armed) haptic(HapticFeedbackType.LongPress)
            armed = fires
        }
    }) {
        Icon(FoxIcons.get("reply"), null, tint = c.textMuted, modifier = Modifier.align(Alignment.CenterStart).padding(start = 4.dp).size(22.dp)
            .graphicsLayer { alpha = (offset / 64.dp.toPx()).coerceIn(0f, 1f) })
        Box(Modifier.graphicsLayer { translationX = offset }) { content() }
    }
}
