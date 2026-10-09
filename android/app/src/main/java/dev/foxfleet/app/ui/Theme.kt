package dev.foxfleet.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.ThemeMode

/** Accent presets: name to (light, dark) tone. Index is what SettingsStore persists. */
val AccentPresets: List<Triple<String, Color, Color>> = Tokens.accents // generated from design/tokens.json

/** Extra tones Material's scheme doesn't name. */
@Immutable
data class HubColors(
    val bg: Color,
    val surface: Color,
    val surfaceAlt: Color,
    val hairline: Color,
    val text: Color,
    val textMuted: Color,
    val textFaint: Color,
    val userBubble: Color,
    val accent: Color,
    val onAccent: Color,
    val online: Color,
    val idle: Color,
    val offline: Color,
    val dark: Boolean,
)

fun hubColors(dark: Boolean, accentIndex: Int): HubColors {
    val preset = AccentPresets[accentIndex.coerceIn(0, AccentPresets.lastIndex)]
    val accent = if (dark) preset.third else preset.second
    val onAccent = if (accent.luminanceApprox() > 0.55f) Color(0xFF111111) else Color.White
    return if (dark) HubColors(
        bg = Tokens.Dark.bg, surface = Tokens.Dark.surface, surfaceAlt = Tokens.Dark.surfaceAlt,
        hairline = Tokens.Dark.hairline, text = Tokens.Dark.text, textMuted = Tokens.Dark.textMuted,
        textFaint = Tokens.Dark.textFaint, userBubble = accent.copy(alpha = Tokens.Dark.userBubbleAlpha), accent = accent,
        onAccent = onAccent, online = Tokens.Dark.online, idle = Tokens.Dark.idle, offline = Tokens.Dark.offline, dark = true,
    ) else HubColors(
        bg = Tokens.Light.bg, surface = Tokens.Light.surface, surfaceAlt = Tokens.Light.surfaceAlt,
        hairline = Tokens.Light.hairline, text = Tokens.Light.text, textMuted = Tokens.Light.textMuted,
        textFaint = Tokens.Light.textFaint, userBubble = accent.copy(alpha = Tokens.Light.userBubbleAlpha), accent = accent,
        onAccent = onAccent, online = Tokens.Light.online, idle = Tokens.Light.idle, offline = Tokens.Light.offline, dark = false,
    )
}

private fun Color.luminanceApprox(): Float = 0.2126f * red + 0.7152f * green + 0.0722f * blue

val LocalHubColors = staticCompositionLocalOf { hubColors(dark = true, accentIndex = 0) }
val LocalAppPrefs = staticCompositionLocalOf { AppPrefs() }

private val Sans = FontFamily.SansSerif

fun appTypography(c: HubColors) = Typography(
    headlineSmall = TextStyle(fontFamily = Sans, fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.2).sp),
    titleLarge = TextStyle(fontFamily = Sans, fontSize = 19.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontFamily = Sans, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontFamily = Sans, fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = Sans, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontFamily = Sans, fontSize = 12.sp, lineHeight = 16.sp, color = c.textMuted),
    labelLarge = TextStyle(fontFamily = Sans, fontSize = 14.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontFamily = Sans, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = c.textMuted),
    labelSmall = TextStyle(fontFamily = Sans, fontSize = 11.sp, color = c.textFaint),
)

fun isDark(mode: ThemeMode, system: Boolean) = when (mode) {
    ThemeMode.System -> system
    ThemeMode.Light -> false
    ThemeMode.Dark -> true
}

@Composable
fun FoxfleetTheme(prefs: AppPrefs = AppPrefs(), content: @Composable () -> Unit) {
    val dark = isDark(prefs.theme, isSystemInDarkTheme())
    val c = hubColors(dark, prefs.accent)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = c.accent, onPrimary = c.onAccent,
        background = c.bg, onBackground = c.text,
        surface = c.bg, onSurface = c.text,
        surfaceVariant = c.surfaceAlt, onSurfaceVariant = c.textMuted,
        surfaceContainer = c.surface, surfaceContainerLow = c.surface, surfaceContainerHigh = c.surfaceAlt,
        surfaceContainerHighest = c.surfaceAlt, surfaceContainerLowest = c.bg,
        outline = c.hairline, outlineVariant = c.hairline,
        secondaryContainer = c.surfaceAlt, onSecondaryContainer = c.text,
    )
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalHubColors provides c,
        LocalAppPrefs provides prefs,
        LocalDensity provides Density(density.density, density.fontScale * prefs.textSize.scale),
    ) {
        MaterialTheme(colorScheme = scheme, typography = appTypography(c), content = content)
    }
}
