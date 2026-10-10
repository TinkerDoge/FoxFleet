package dev.foxfleet.app.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalAppPrefs
import dev.foxfleet.app.ui.LocalHubColors

/** "Thought for 8 s" / "Thought for 1 min 5 s"; "Reasoning" when the length is not known. Pure, unit-tested. */
fun reasoningLabel(live: Boolean, ms: Long): String = when {
    live -> "Thinking…"
    ms <= 0 -> "Reasoning"
    ms < 1000 -> "Thought for <1 s"
    ms < 60_000 -> "Thought for ${ms / 1000} s"
    else -> "Thought for ${ms / 60_000} min ${(ms % 60_000) / 1000} s"
}

/**
 * The agent's thinking above a reply: collapsed by default, header with a lightbulb, duration (or a shimmer while it is still thinking),
 * tap to open with a smooth height change. Muted Markdown, limited height with "Show all", a copy button. The state is remembered per
 * message ([stateKey]) while the chat is open. Hidden entirely by Settings > Show reasoning.
 */
@Composable
fun ReasoningBlock(text: String, live: Boolean, stateKey: String, durationMs: Long = 0L, modifier: Modifier = Modifier, startOpen: Boolean = false, startFull: Boolean = false) {
    if (!LocalAppPrefs.current.showReasoning || (text.isBlank() && !live)) return
    val c = LocalHubColors.current
    var open by rememberSaveable(stateKey) { mutableStateOf(startOpen) }
    var full by rememberSaveable(stateKey + "#full") { mutableStateOf(startFull) }
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    Column(
        modifier.padding(bottom = 8.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).animateContentSize().testTag("reasoning"),
    ) {
        Row(
            Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp).clickable { open = !open }
                .semantics { contentDescription = (if (open) "Hide reasoning" else "Show reasoning") + ", " + reasoningLabel(live, durationMs) }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(FoxIcons.get("reasoning"), null, tint = c.textMuted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            if (live) ShimmerStatusText("Thinking…", style = MaterialTheme.typography.labelLarge)
            else Text(reasoningLabel(false, durationMs), style = MaterialTheme.typography.labelLarge, color = c.textMuted)
            Spacer(Modifier.weight(1f))
            Icon(FoxIcons.get("chevronDown"), null, tint = c.textMuted, modifier = Modifier.size(20.dp).rotate(if (open) 180f else 0f))
        }
        if (open) {
            Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp)) {
                Box(Modifier.fillMaxWidth().then(if (full) Modifier else Modifier.heightIn(max = 180.dp)).verticalScroll(rememberScrollState())) {
                    RichText(text, muted = true)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (text.length > 400) Text(if (full) "Show less" else "Show all", style = MaterialTheme.typography.labelMedium, color = c.accent,
                        modifier = Modifier.defaultMinSize(minHeight = 44.dp).clickable { full = !full }.padding(vertical = 12.dp))
                    Spacer(Modifier.weight(1f))
                    Row(Modifier.defaultMinSize(minHeight = 44.dp).clip(RoundedCornerShape(8.dp)).clickable { clipboard.setText(AnnotatedString(text)); copied = true }.padding(horizontal = 8.dp).semantics { contentDescription = "Copy reasoning" },
                        verticalAlignment = Alignment.CenterVertically) {
                        Icon(FoxIcons.get("copy"), null, tint = c.textMuted, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp))
                        Text(if (copied) "Copied" else "Copy", style = MaterialTheme.typography.labelMedium, color = c.textMuted)
                    }
                }
            }
        }
    }
}
