package dev.foxfleet.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shared icon set (same drawings as the web app) is complete and every drawing parses. */
class FoxIconsTest {
    @Test fun everyIconParsesToAPath() {
        assertTrue(FoxIcons.names.size >= 45)
        for (n in FoxIcons.names) { val v = FoxIcons.get(n); assertEquals(n, v.name); assertTrue("$n has no drawing", v.root.size > 0) }
    }
    @Test fun theAppNeedsTheseIcons() {
        for (n in listOf("back", "add", "settings", "attach", "mic", "send", "stop", "history", "retry", "screen", "close", "chevronUp", "chevronDown", "logout", "machine", "agents")) assertTrue("missing $n", n in FoxIcons.names)
    }
    @Test fun unknownNamesFallBackInsteadOfCrashing() { assertTrue(FoxIcons.get("nope-nope").root.size > 0) }
}
