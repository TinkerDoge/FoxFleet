package dev.foxfleet.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertTrue
import org.junit.Test

/** QA A3: quiet badges (muted chat, archived entry) and the static Offline label meet WCAG AA 4.5:1 in both themes. */
class BadgeContrastTest {
    private fun ratio(a: Color, b: Color): Double { val x = a.luminance() + 0.05; val y = b.luminance() + 0.05; return maxOf(x, y).toDouble() / minOf(x, y) }

    @Test fun mutedBadgeTextOnItsBackgroundIsAtLeast4_5InBothThemes() {
        for (dark in listOf(false, true)) for (i in AccentPresets.indices) {
            val c = hubColors(dark, i)
            val r = ratio(c.onBadgeMuted, c.badgeMuted)
            assertTrue("dark=$dark ratio=$r", r >= 4.5)
        }
    }

    @Test fun offlineLabelOnTheHeaderIsAtLeast4_5() {
        for (dark in listOf(false, true)) { val c = hubColors(dark, 0); assertTrue("dark=$dark", ratio(c.textMuted, c.bg) >= 4.5 && ratio(c.textMuted, c.surface) >= 4.5) }
    }
}
