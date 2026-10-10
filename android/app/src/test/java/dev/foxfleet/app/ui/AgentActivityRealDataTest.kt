package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.HubApi
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.ZoneId
import java.util.Locale

/** The agent list is checked against a REAL /api/agents answer (written by the hub's own test), not hand-made vectors. */
class AgentActivityRealDataTest {
    private fun sample(): String { var d = File("").absoluteFile; while (!File(d, "contract/agents-activity.sample.json").exists()) d = d.parentFile ?: error("sample not found"); return File(d, "contract/agents-activity.sample.json").readText() }
    private val agent: AgentStatus get() = HubApi.parseAgents(sample()).single()

    @Test fun theRealAnswerGivesATimeAndAPreview() {
        val a = agent
        assertEquals(1791407520500L, a.lastActivityAt)
        assertEquals("Here is the plan we agreed on", AgentList.preview(a).text)
        assertEquals("Wed", AgentList.time(a.lastActivityAt, now = a.lastActivityAt!! + 3 * 86_400_000L, locale = Locale.US, zone = ZoneId.of("UTC")))
        assertEquals("Oct 7", AgentList.time(a.lastActivityAt, now = a.lastActivityAt!! + 9 * 86_400_000L, locale = Locale.US, zone = ZoneId.of("UTC")))
    }

    @Test fun timeFollowsTheDevicesZoneAndLocale() {
        val at = 1791407520500L // 2026-10-07T21:12Z
        fun t(zone: String, loc: Locale) = AgentList.time(at, now = at + 1000, locale = loc, zone = ZoneId.of(zone)).replace("\u202f", " ")
        assertEquals("9:12 PM", t("UTC", Locale.US)); assertEquals("4:12 AM", t("Asia/Bangkok", Locale.US)); assertEquals("04:12", t("Asia/Bangkok", Locale.GERMANY))
    }

    @Test fun anOldHubRowStaysUsableAndTheLocalLastMessageFillsIt() {
        val old = agent.copy(lastActivityAt = null, lastMessagePreview = null, lastRole = null, lastSessionTitle = null)
        assertEquals(AgentList.Kind.Empty, AgentList.preview(old).kind)
        val merged = LocalLast.merge(old, LocalLast.Entry(5000, "user", "hi there"))
        assertEquals(5000L, merged.lastActivityAt); assertEquals("hi there", AgentList.preview(merged).text); assertTrue(AgentList.preview(merged).you)
        assertSame(old, LocalLast.merge(old, null))
        assertEquals(agent.lastMessagePreview, LocalLast.merge(agent, LocalLast.Entry(1, "user", "older local")).lastMessagePreview)
    }

    @Test fun localEntriesRoundTripAndPreviewsAreClean() {
        val e = LocalLast.Entry(42, "assistant", LocalLast.preview("**Done**\nMEDIA:/tmp/a.png\n![x](http://a/b.png) ok | pipe"))
        assertEquals("Done [image] ok | pipe", e.text); assertEquals(e, LocalLast.decode(LocalLast.encode(e)))
        assertNull(LocalLast.decode("garbage")); assertNull(LocalLast.decode("1|robot|x"))
    }

    @Test fun hubCompat() {
        assertTrue(HubCompat.isOld(null, emptyList()))
        assertFalse(HubCompat.isOld("0.3.5-alpha", HubCompat.needs.keys.toList()))
        assertEquals(listOf("agentActivity"), HubCompat.missing("0.3.5-alpha", HubCompat.needs.keys.filter { it != "agentActivity" }))
    }
}
