package dev.foxfleet.app.data

import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.*
import org.junit.Assert.*
import org.junit.Test

class TelegramUxTest {
    @Test fun plainMessageHasNoModePicker() {
        assertEquals("auto", plainMode(true, listOf("queue", "steer", "interrupt"))) // native Hermes: its own busy setting decides, the ack is shown
        assertEquals("interrupt", plainMode(false, listOf("queue", "interrupt")))     // HTTP agents: stop, then send
        assertEquals("queue", plainMode(false, listOf("queue")))                      // inbox: queue only
    }
    @Test fun pickerCardBelongsToItsChatAndExpires() {
        val t0 = 1_000_000L; val c = PickerCard("s1", "model", openedAt = t0)
        assertTrue(c.valid("s1", t0 + 1000)); assertFalse(c.valid("s2", t0 + 1000)); assertFalse(c.valid(null, t0 + 1000))
        assertFalse(c.valid("s1", t0 + PickerCard.PICKER_TTL_MS + 1))
    }
    @Test fun pagingAndSearchForTheModelList() {
        val items = (1..19).toList(); val (rows, pages, shown) = pageOf(items, 2)
        assertEquals(listOf(17, 18, 19), rows); assertEquals(3, pages); assertEquals(2, shown)
        assertEquals(2, pageOf(items, 99).third); assertEquals(0, pageOf(items, -4).third); assertEquals(1, pageOf(emptyList<Int>(), 3).second)
    }
    @Test fun modelCommandOpensPickerSetsOnlyThisChatAndRefusesGlobal() {
        val s = ChatState(); var opened = 0
        modelCommand("", null, s, picker = { opened++ }); assertEquals(1, opened)
        modelCommand("m --global", null, s, picker = { opened++ }); assertEquals(1, opened); assertTrue(s.notices.last().contains("agent settings"))
        modelCommand("m", null, s, picker = { opened++ }); assertTrue(s.notices.last().contains("Send the first message first"))
        assertEquals("Model for this chat is now x. Your Hermes default is unchanged.", modelSetMessage("x"))
    }
    @Test fun noticesAreLocalAndClearedWithTheConversation() {
        val s = ChatState(); s.addNotice("a"); assertEquals(listOf("a"), s.notices); s.newConversation(); assertTrue(s.notices.isEmpty())
    }
}
