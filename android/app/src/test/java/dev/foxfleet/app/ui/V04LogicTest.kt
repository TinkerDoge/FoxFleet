package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.FileMarker
import dev.foxfleet.app.data.FileRef
import dev.foxfleet.app.ui.screens.ScreenPhase
import dev.foxfleet.app.ui.screens.fleetSubtitle
import dev.foxfleet.app.ui.screens.handBackCountdown
import dev.foxfleet.app.ui.screens.screenPhaseLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V04LogicTest {
    @Test fun fileMarkerRoundTrips() {
        val f = FileRef("Báo cáo (Q3).pdf", "/home/a/foxfleet-uploads/2026-10-09/k1-Báo cáo Q3.pdf", 2_456_000)
        val text = FileMarker.compose("Summarise this", listOf(f))
        assertEquals("Summarise this\n\n[Attached file: /home/a/foxfleet-uploads/2026-10-09/k1-Báo cáo Q3.pdf (2.3 MB)]", text)
        val (body, files) = FileMarker.split(text)
        assertEquals("Summarise this", body)
        assertEquals(listOf("/home/a/foxfleet-uploads/2026-10-09/k1-Báo cáo Q3.pdf" to "2.3 MB"), files)
    }

    @Test fun fileOnlyMessageAndSizes() {
        assertEquals("[Attached file: /x/a.zip (512 B)]", FileMarker.compose("  ", listOf(FileRef("a.zip", "/x/a.zip", 512))).trim())
        assertEquals("plain", FileMarker.compose("plain", emptyList()))
        assertEquals("12 KB", FileMarker.humanSize(12 * 1024 + 5))
        assertEquals(90L * 1024 * 1024, FileMarker.MAX_BYTES)
        // A user typing something marker-like inline is not a file.
        assertTrue(FileMarker.split("see [Attached file: x (1 B)] here").second.isEmpty())
    }

    @Test fun bridgedAgentsGetBadgesAndSubtitles() {
        val muse = AgentStatus("Scribe", true, true, false, kind = "mcp-inbox", label = "Scribe")
        val glm = AgentStatus("GLM", true, true, false, kind = "openai")
        val hermes = AgentStatus("Atlas", true, true, true, activeSessions = 2, description = "Studio lead\nsecond line")
        assertEquals("Inbox", muse.badge); assertEquals("API", glm.badge); assertNull(hermes.badge)
        assertTrue(muse.isInbox && !muse.isHermes); assertTrue(hermes.isHermes)
        assertEquals("OpenAI-compatible", fleetSubtitle(glm))
        assertEquals("Studio lead · 2 active", fleetSubtitle(hermes))
        assertEquals("Hermes agent", fleetSubtitle(AgentStatus("X", true, true, true)))
        assertTrue(fleetSubtitle(muse).startsWith("Mailbox"))
    }

    @Test fun screenLabelsAndCountdown() {
        assertEquals("You're in control", screenPhaseLabel(ScreenPhase.Control))
        assertEquals("Watching", screenPhaseLabel(ScreenPhase.Watching))
        assertEquals("15:00", handBackCountdown(15 * 60_000))
        assertEquals("0:01", handBackCountdown(1))
        assertEquals("0:00", handBackCountdown(-5))
    }
}
