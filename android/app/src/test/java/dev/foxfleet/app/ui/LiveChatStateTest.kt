package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.HubChat
import dev.foxfleet.app.data.live.LastMessage
import dev.foxfleet.app.data.live.LinkState
import dev.foxfleet.app.ui.chat.ChatState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Live v2 edits of the open chat (ChatState) and the chat-list logic (ChatRows). */
class LiveChatStateTest {
    private fun hub(n: Int, role: String = "assistant", text: String = "t$n", status: String? = null) = UiMessage(role, text, id = "u$n", ts = n.toLong(), hubId = "h$n", n = n, status = status)

    @Test fun newAgentMessageAppendsAndRepeatIsIgnored() {
        val s = ChatState().apply { load(listOf(hub(1)), "c") }
        assertTrue(s.applyLive(hub(2), edited = false)); assertTrue(s.applyLive(hub(2), edited = false))
        assertEquals(listOf("h1", "h2"), s.messages.map { it.hubId })
    }

    @Test fun ownSendIsMatchedNotDuplicated() {
        val s = ChatState().apply { load(listOf(hub(1)), "c"); push(UiMessage("user", "Ship it")) }
        s.applyLive(hub(2, "user", "Ship it", "sent"), edited = false)
        assertEquals(2, s.messages.size); assertEquals("h2", s.messages.last().hubId); assertEquals("sent", s.messages.last().status)
        s.applyStatus(listOf("h2"), "read"); assertEquals("read", s.messages.last().status)
        s.applyStatus(listOf("h2"), "delivered"); assertEquals("read", s.messages.last().status)
    }

    @Test fun editReplacesInPlaceAndUnknownEditIsIgnored() {
        val s = ChatState().apply { load(listOf(hub(1), hub(2)), "c") }
        s.applyLive(hub(2, text = "final"), edited = true); assertEquals("final", s.messages[1].content)
        assertFalse(s.applyLive(hub(9), edited = true)); assertEquals(2, s.messages.size)
    }

    @Test fun deleteForMe() {
        val s = ChatState().apply { load(listOf(hub(1), hub(2)), "c") }
        s.applyDeleted(listOf("h1")); assertEquals(listOf("h2"), s.messages.map { it.hubId })
    }

    @Test fun cachedRowsKeepLoadingUntilTheHubPage() {
        val s = ChatState()
        assertTrue(s.showCached(listOf(hub(1)), "c", hasOlder = true))
        assertTrue(s.loading && s.fromCache)
        s.load(listOf(hub(1), hub(2)), "c"); assertFalse(s.loading); assertFalse(s.fromCache)
        assertFalse("never over a chat already shown", s.showCached(listOf(hub(7)), "c", false))
        s.keepCached("Offline"); s.keepCached("Offline"); assertEquals(listOf("Offline"), s.notices)
    }

    private fun row(agent: String, unread: Int, archived: Boolean = false, muted: Boolean = false, until: Long? = null, manual: Boolean = false) =
        HubChat(agent, agent, "hermes", "c", LastMessage("h", "user", "you", "Ship it", 5, "read"), unread, 0, archived, muted, until, false, null, false, false, manual, 1)

    @Test fun badgeTotalSkipsMutedAndArchived() {
        val rows = listOf(row("a", 3), row("b", 2, muted = true), row("c", 4, archived = true), row("d", 1, muted = true, until = 100))
        assertEquals(3, ChatRows.badgeTotal(rows, now = 50)); assertEquals(4, ChatRows.badgeTotal(rows, now = 200)) // d's mute ran out
        assertEquals(1, row("e", 0, manual = true).badge)
    }

    @Test fun listsSplitByArchivedAndFallBackWithoutRows() {
        val agents = listOf("a", "b", "c").map { AgentStatus(it, true, true, true) }
        val rows = mapOf("b" to row("b", 0, archived = true))
        assertEquals(listOf("a", "c"), ChatRows.visible(agents, rows, archived = false).map { it.name })
        assertEquals(listOf("b"), ChatRows.visible(agents, rows, archived = true).map { it.name })
        assertEquals(agents, ChatRows.visible(agents, emptyMap(), archived = false))
    }

    @Test fun previewNamesTheSenderAndLinkLabels() {
        assertEquals(ChatRows.Preview("You", "Ship it"), ChatRows.preview(row("a", 0)))
        val agentRow = row("a", 0).copy(last = LastMessage("h", "assistant", "Atlas", "Done", 5, null))
        assertEquals("Atlas", ChatRows.preview(agentRow)!!.sender)
        assertNull(ChatRows.preview(row("a", 0).copy(last = null)))
        assertEquals("999+", ChatRows.badgeText(1200))
        assertNull(ChatRows.linkLabel(LinkState.Live)); assertEquals("Connecting…", ChatRows.linkLabel(LinkState.Connecting)); assertEquals("Offline", ChatRows.linkLabel(LinkState.Offline))
    }
}
