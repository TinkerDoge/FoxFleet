package dev.foxfleet.app.ui.screens

import dev.foxfleet.app.ui.FoxIcons
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.BuildConfig
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.TextSize
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.ui.AccentPresets
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftCard
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.motion.reduceMotion

@Composable
fun SettingsScreen(
    prefs: AppPrefs,
    onChange: (AppPrefs) -> Unit,
    onSignOut: () -> Unit,
    onBack: () -> Unit,
    onAgents: () -> Unit = {},
    hubName: String = "",
    username: String = "",
    onHubs: () -> Unit = {},
    onDevices: () -> Unit = {},
    isOwner: Boolean = false,
    onAdmin: () -> Unit = {},
) {
    val c = LocalHubColors.current
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text, background = c.surfaceAlt)
            Spacer(Modifier.width(4.dp))
            Text("Settings", style = MaterialTheme.typography.titleLarge, color = c.text)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            Spacer(Modifier.size(8.dp))
            SoftCard(Modifier.fillMaxWidth(), onClick = onDevices) {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(48.dp).clip(androidx.compose.foundation.shape.CircleShape).background(c.surfaceAlt), contentAlignment = Alignment.Center) {
                        Text(dev.foxfleet.app.ui.components.initials(username.ifBlank { "?" }), color = c.text, style = MaterialTheme.typography.titleSmall)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(username.ifBlank { "Signed in" }, style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1)
                        Text(hubName.ifBlank { "Connected hub" } + if (isOwner) " · Owner" else "", style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1)
                    }
                    dev.foxfleet.app.ui.components.FoxIcon("chevronRight", tint = c.textFaint)
                }
            }
            SectionLabel("Agents")
            SoftCard(Modifier.fillMaxWidth(), onClick = onAgents) {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Manage agents", style = MaterialTheme.typography.bodyLarge, color = c.text)
                        Text("Add, edit, remove and reorder the agents your hub connects to.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                    }
                    dev.foxfleet.app.ui.components.FoxIcon("chevronRight", tint = c.textFaint)
                }
            }
            SectionLabel("Appearance")
            SoftCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    RowLabel("Theme")
                    Segmented(ThemeMode.entries.map { it.name }, prefs.theme.ordinal) { onChange(prefs.copy(theme = ThemeMode.entries[it])) }
                    Spacer(Modifier.size(16.dp)); Hairline(); Spacer(Modifier.size(16.dp))
                    RowLabel("Accent")
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        AccentPresets.forEachIndexed { i, (name, light, dark) ->
                            Swatch(if (c.dark) dark else light, name, i == prefs.accent) { onChange(prefs.copy(accent = i)) }
                        }
                    }
                    Spacer(Modifier.size(16.dp)); Hairline(); Spacer(Modifier.size(16.dp))
                    RowLabel("Text size")
                    Segmented(listOf("S", "M", "L"), prefs.textSize.ordinal) { onChange(prefs.copy(textSize = TextSize.entries[it])) }
                }
            }
            SectionLabel("Motion & feel")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    ToggleRow("Reduce motion", "Instant transitions, no shimmer. Also follows the system \"Remove animations\" switch.", prefs.reduceMotion) {
                        onChange(prefs.copy(reduceMotion = it))
                    }
                    Hairline(Modifier.padding(start = 16.dp))
                    ToggleRow("Haptics", "A light tap when you send or sign in.", prefs.haptics) { onChange(prefs.copy(haptics = it)) }
                    Hairline(Modifier.padding(start = 16.dp))
                    ToggleRow("Notifications", "Not available yet: the hub has no push API.", false, enabled = false) {}
                }
            }
            SectionLabel("Account")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    NavRow("Hubs", value = hubName.ifBlank { "Connected" }, onClick = onHubs)
                    Hairline(Modifier.padding(start = 16.dp))
                    if (isOwner) { NavRow("Admin", "Pairing, invites, people", onClick = onAdmin); Hairline(Modifier.padding(start = 16.dp)) }
                    NavRow("Devices & security", onClick = onDevices)
                    Hairline(Modifier.padding(start = 16.dp))
                    NavRow("Sign out", danger = true, chevron = false, onClick = onSignOut)
                }
            }
            SectionLabel("About")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    dev.foxfleet.app.ui.components.BrandWordmark(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).fillMaxWidth(0.7f).height(36.dp))
                    InfoRow("Version", BuildConfig.VERSION_NAME)
                    Hairline(Modifier.padding(start = 16.dp))
                    InfoRow("Build", "${BuildConfig.VERSION_CODE} · ${BuildConfig.BUILD_TYPE}")
                    Hairline(Modifier.padding(start = 16.dp))
                    InfoRow("Source", "MIT licence · open source")
                }
            }
            Spacer(Modifier.size(32.dp))
        }
    }
}

@Composable
private fun Color_Danger() = if (LocalHubColors.current.dark) androidx.compose.ui.graphics.Color(0xFFFF7B72) else androidx.compose.ui.graphics.Color(0xFFC4372B)

/** A settings row: title (+ optional second line), optional value on the right, chevron; 56dp tall at least. */
@Composable
private fun NavRow(title: String, subtitle: String? = null, value: String? = null, danger: Boolean = false, chevron: Boolean = true, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (danger) Color_Danger() else c.text)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        }
        if (value != null) { Text(value, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, maxLines = 1, modifier = Modifier.widthIn(max = 160.dp)); Spacer(Modifier.width(8.dp)) }
        if (chevron) dev.foxfleet.app.ui.components.FoxIcon("chevronRight", tint = c.textFaint)
    }
}

@Composable
private fun RowLabel(t: String) {
    Text(t, style = MaterialTheme.typography.titleMedium, color = LocalHubColors.current.text, modifier = Modifier.padding(bottom = 10.dp))
}

@Composable
private fun InfoRow(label: String, value: String) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = Modifier.weight(0.4f))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.weight(0.6f))
    }
}

@Composable
private fun ToggleRow(title: String, body: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val c = LocalHubColors.current
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) }.padding(16.dp)
            .graphicsLayer { alpha = if (enabled) 1f else 0.5f },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = c.text)
            Text(body, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked, onCheckedChange = onChange, enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.onAccent,
                uncheckedTrackColor = c.surfaceAlt, uncheckedBorderColor = c.hairline, uncheckedThumbColor = c.textFaint),
        )
    }
}

/** Pill segmented control; the selected chip springs in. */
@Composable
internal fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(3.dp)) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            val bg by animateColorAsState(if (on) c.surface else c.surfaceAlt, label = "seg")
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(bg).clickable { onSelect(i) }.padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) { Text(label, style = MaterialTheme.typography.labelLarge, color = if (on) c.text else c.textMuted) }
        }
    }
}

@Composable
private fun Swatch(color: androidx.compose.ui.graphics.Color, name: String, selected: Boolean, onClick: () -> Unit) {
    val c = LocalHubColors.current
    val reduce = reduceMotion()
    val s by animateFloatAsState(if (selected && !reduce) 1.12f else 1f, spring(Spring.DampingRatioMediumBouncy), label = "sw")
    Box(
        Modifier.size(36.dp).graphicsLayer { scaleX = s; scaleY = s }.clip(CircleShape).background(color)
            .border(if (selected) 2.dp else 0.dp, if (selected) c.text else color, CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { if (selected) Icon(FoxIcons.get("check"), name, tint = c.onAccent.takeIf { color == c.accent } ?: androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(18.dp)) }
}
