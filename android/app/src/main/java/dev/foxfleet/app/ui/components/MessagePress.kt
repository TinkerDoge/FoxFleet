package dev.foxfleet.app.ui.components

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown

/**
 * Long press and double tap on a message frame, wherever the finger lands inside it (0.4.1). The frame watches the touch in the
 * Initial pass, before its children: a link or a picture inside a reply used to take the long press (or the second tap) for
 * itself, so the menu and the reaction never came. A plain single tap is left alone, so links and pictures still open.
 * Once a long press or a double tap fired, the rest of that touch is consumed, so the link under the finger does not open too.
 * A drag (touch slop) cancels: the list scroll and swipe-to-reply keep working.
 */
fun Modifier.messagePress(interaction: MutableInteractionSource, onLongPress: (() -> Unit)?, onDoubleTap: (() -> Unit)?): Modifier =
    if (onLongPress == null && onDoubleTap == null) this else pointerInput(onLongPress != null, onDoubleTap != null) {
        var lastUpAt = -1L; var lastUpPos = Offset.Zero
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val press = PressInteraction.Press(down.position); interaction.tryEmit(press)
            val second = onDoubleTap != null && lastUpAt >= 0 && down.uptimeMillis - lastUpAt <= viewConfiguration.doubleTapTimeoutMillis &&
                (down.position - lastUpPos).getDistance() <= viewConfiguration.touchSlop * 4
            if (second) down.consume() // the second tap belongs to the double tap, not to a link under it
            var slop = Offset.Zero
            // 0 = up (a tap), 1 = cancelled (drag, second finger, taken by someone else), 2 = held long enough
            val outcome = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                while (true) {
                    val ev = awaitPointerEvent(PointerEventPass.Initial)
                    val c = ev.changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull 1
                    if (ev.changes.size > 1) return@withTimeoutOrNull 1
                    if (c.changedToUp()) { if (second) c.consume(); return@withTimeoutOrNull 0 }
                    slop += c.positionChange()
                    if (slop.getDistance() > viewConfiguration.touchSlop) return@withTimeoutOrNull 1
                }
                @Suppress("UNREACHABLE_CODE") 1
            } ?: 2
            when (outcome) {
                0 -> {
                    interaction.tryEmit(PressInteraction.Release(press))
                    if (second) { lastUpAt = -1L; onDoubleTap?.invoke() } else { lastUpAt = currentEvent.changes.firstOrNull()?.uptimeMillis ?: down.uptimeMillis; lastUpPos = down.position }
                }
                1 -> { interaction.tryEmit(PressInteraction.Cancel(press)); lastUpAt = -1L }
                else -> {
                    lastUpAt = -1L
                    if (onLongPress == null) { interaction.tryEmit(PressInteraction.Cancel(press)); return@awaitEachGesture }
                    onLongPress()
                    // swallow the rest of this touch: lifting the finger must not also open the link or picture under it
                    while (true) {
                        val ev = awaitPointerEvent(PointerEventPass.Initial)
                        ev.changes.forEach { it.consume() }
                        if (ev.changes.all { !it.pressed }) break
                    }
                    interaction.tryEmit(PressInteraction.Release(press))
                }
            }
        }
    }
