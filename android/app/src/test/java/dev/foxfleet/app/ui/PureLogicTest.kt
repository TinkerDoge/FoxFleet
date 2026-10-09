package dev.foxfleet.app.ui

import dev.foxfleet.app.Route
import dev.foxfleet.app.depth
import dev.foxfleet.app.ui.components.initials
import dev.foxfleet.app.ui.components.statusBase
import dev.foxfleet.app.ui.motion.shouldReduceMotion
import dev.foxfleet.app.ui.motion.staggerDelayMs
import dev.foxfleet.app.ui.screens.STREAM_FADE_CHARS
import dev.foxfleet.app.ui.screens.statusLine
import dev.foxfleet.app.ui.screens.streamAlpha
import dev.foxfleet.app.data.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PureLogicTest {
    @Test fun reduceMotionFollowsUserOrSystem() {
        assertFalse(shouldReduceMotion(false, 1f))
        assertTrue(shouldReduceMotion(true, 1f))
        assertTrue(shouldReduceMotion(false, 0f))
        assertFalse(shouldReduceMotion(false, 0.5f))
    }

    @Test fun staggerIsCapped() {
        assertEquals(0, staggerDelayMs(0))
        assertEquals(80, staggerDelayMs(2))
        assertEquals(320, staggerDelayMs(50))
        assertEquals(0, staggerDelayMs(-3))
    }

    @Test fun streamTailFadesHeadIsOpaque() {
        val len = 100
        assertEquals(1f, streamAlpha(0, len), 0f)
        assertEquals(1f, streamAlpha(len - STREAM_FADE_CHARS - 1, len), 0f)
        assertTrue(streamAlpha(len - 1, len) < streamAlpha(len - 10, len))
        assertTrue(streamAlpha(len - 1, len) >= 0.25f)
    }

    @Test fun statusLinePriority() {
        assertEquals("Using web_search…", statusLine("Atlas", "web_search", true, true))
        assertNull(statusLine("Atlas", null, true, true))
        assertEquals("Atlas is thinking…", statusLine("Atlas", null, true, false))
        assertEquals("Atlas is working…", statusLine("Atlas", null, false, false))
    }

    @Test fun statusBaseStripsEllipsis() {
        assertEquals("Atlas is working", statusBase("Atlas is working…"))
        assertEquals("thinking", statusBase("thinking..."))
        assertEquals("idle", statusBase("idle"))
    }

    @Test fun initialsAndThemes() {
        assertEquals("At", initials("atlas"))
        assertEquals("CD", initials("code-doctor"))
        assertEquals("?", initials("  "))
        assertTrue(isDark(ThemeMode.System, true)); assertFalse(isDark(ThemeMode.Light, true)); assertTrue(isDark(ThemeMode.Dark, false))
        assertTrue(Route.Chat("a").depth() > Route.Fleet.depth())
    }

    @Test fun accentPaletteContrast() {
        AccentPresets.indices.forEach { i ->
            val c = hubColors(dark = false, accentIndex = i)
            assertTrue(c.accent != c.onAccent)
        }
        assertEquals(hubColors(true, AccentPresets.lastIndex).accent, hubColors(true, 99).accent)
    }
}
