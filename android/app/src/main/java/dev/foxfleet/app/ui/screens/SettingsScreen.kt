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
            SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text)
            Spacer(Modifier.width(4.dp))
            Text("Settings", style = MaterialTheme.typography.titleLarge, color = c.text)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            SectionLabel("Agents")
            SoftCard(Modifier.fillMaxWidth(), onClick = onAgents) {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Manage agents", style = MaterialTheme.typography.bodyLarge, color = c.text)
                        Text("Add, edit, remove and reorder the agents your hub connects to.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                    }
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = c.textFaint)
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
                    InfoRow("Hub", hubName.ifBlank { "Connected" })
                    Hairline(Modifier.padding(start = 16.dp))
                    if (username.isNotBlank()) { InfoRow("Signed in as", username); Hairline(Modifier.padding(start = 16.dp)) }
                    Text("Hubs", color = c.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().clickable(onClick = onHubs).padding(16.dp))
                    Hairline(Modifier.padding(start = 16.dp))
                    if (isOwner) { Text("Admin: pairing, invites, people", color = c.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().clickable(onClick = onAdmin).padding(16.dp)); Hairline(Modifier.padding(start = 16.dp)) }
                    Text("Devices & security", color = c.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().clickable(onClick = onDevices).padding(16.dp))
                    Hairline(Modifier.padding(start = 16.dp))
                    Text("Sign out", color = Color_Danger(), style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.fillMaxWidth().clickable(onClick = onSignOut).padding(16.dp))
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
