package dev.foxfleet.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.runtime.getValue
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.motion.pressScale

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(0.5.dp).background(LocalHubColors.current.hairline))
}

/** Round, flat icon button with spring press feedback. */
@Composable
fun SoftIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = LocalHubColors.current.textMuted,
    background: Color = Color.Transparent,
) {
    val src = remember { MutableInteractionSource() }
    Box(
        modifier.size(40.dp).pressScale(src, 0.9f).clip(CircleShape).background(background)
            .clickable(interactionSource = src, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription, tint = tint, modifier = Modifier.size(22.dp)) }
}

/** 16dp rounded flat card that springs on press. */
@Composable
fun SoftCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    val c = LocalHubColors.current
    val src = remember { MutableInteractionSource() }
    var m = modifier.pressScale(src).clip(RoundedCornerShape(16.dp)).background(c.surface)
    if (onClick != null) m = m.clickable(interactionSource = src, indication = null, onClick = onClick)
    Box(m, content = content)
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
        color = LocalHubColors.current.textFaint,
        modifier = modifier.padding(start = 4.dp, bottom = 8.dp, top = 20.dp),
    )
}

/**
 * The app's button: a soft, rounded surface with a pressed state, never a bare text link.
 * [SoftButtonKind.Tonal] is the default for secondary actions, [Filled] for the one main action, [Outlined] for quiet ones.
 * The label goes in [content] (Text, optionally preceded by a [FoxIcon]).
 */
enum class SoftButtonKind { Tonal, Filled, Outlined }

@Composable
fun SoftButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    kind: SoftButtonKind = SoftButtonKind.Tonal,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    val c = LocalHubColors.current
    val src = remember { MutableInteractionSource() }
    val pressed by src.collectIsPressedAsState()
    val base = when (kind) {
        SoftButtonKind.Filled -> c.accent
        SoftButtonKind.Tonal -> androidx.compose.ui.graphics.lerp(c.surfaceAlt, c.accent, 0.14f)
        SoftButtonKind.Outlined -> Color.Transparent
    }
    val bg = if (pressed && kind != SoftButtonKind.Filled) androidx.compose.ui.graphics.lerp(base, c.accent, 0.12f) else base
    val shape = RoundedCornerShape(14.dp)
    androidx.compose.foundation.layout.Row(
        modifier.alpha(if (enabled) 1f else 0.45f).defaultMinSize(minHeight = 44.dp).pressScale(src, 0.97f).clip(shape).background(bg)
            .then(if (kind == SoftButtonKind.Outlined) Modifier.border(1.dp, c.hairline, shape) else Modifier)
            .clickable(interactionSource = src, indication = null, enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** A rounded icon from the shared set (see [dev.foxfleet.app.ui.FoxIcons]), the same drawings as the web app. */
@Composable
fun FoxIcon(name: String, contentDescription: String? = null, modifier: Modifier = Modifier, tint: Color = LocalHubColors.current.textMuted, size: androidx.compose.ui.unit.Dp = 22.dp) {
    Icon(dev.foxfleet.app.ui.FoxIcons.get(name), contentDescription, modifier.size(size), tint)
}
