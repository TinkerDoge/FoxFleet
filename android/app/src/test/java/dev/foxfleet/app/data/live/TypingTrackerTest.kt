package dev.foxfleet.app.data.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TypingTrackerTest {
    private var now = 0L
    private val t = TypingTracker { now }
    private fun ty(state: String, tool: String? = null, ttl: Long = 6000) = Typing("nova", "c", state, tool, ttl)

    @Test fun expiresAfterTtlWithoutRepeat() {
        assertTrue(t.on(ty("typing"))); assertEquals("typing…", TypingTracker.label(t.get("nova", "c")))
        now = 5000; assertFalse("a repeat of the same state changes nothing on screen", t.on(ty("typing")))
        now = 10_999; assertTrue(t.get("nova", "c") != null)
        now = 11_000; assertNull(t.get("nova", "c"))
    }

    @Test fun idleRunEndAndAgentMessageClear() {
        t.on(ty("thinking")); assertEquals("thinking…", TypingTracker.label(t.get("nova", "c")))
        assertTrue(t.on(ty("idle"))); assertNull(t.get("nova", "c"))
        t.on(ty("tool", "bash")); assertEquals("running bash…", TypingTracker.label(t.get("nova", null)))
        assertTrue(t.clear("nova", null)); assertNull(t.get("nova", "c"))
        assertEquals("using a tool…", TypingTracker.label(ty("tool")))
    }

    @Test fun nextExpiry() { assertNull(t.nextExpiryIn()); t.on(ty("typing", ttl = 3000)); now = 1000; assertEquals(2000L, t.nextExpiryIn()) }
}
