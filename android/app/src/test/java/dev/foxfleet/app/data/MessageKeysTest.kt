package dev.foxfleet.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class MessageKeysTest {
    private val a = UiMessage("assistant", "ok", ts = 5)
    @Test fun hubIdWins() { assertEquals("id:m1", MessageKeys.base(UiMessage("user", "x", id = "m1"))) }

    @Test fun repeatsAreUniqueAndCountedFromTheNewestEnd() {
        val keys = MessageKeys.keys(listOf(a, UiMessage("user", "q"), a))
        assertEquals(3, keys.toSet().size)
        // prepending older rows (even another copy of the same text) leaves the keys already on screen alone
        val more = MessageKeys.keys(listOf(a, UiMessage("user", "older")) + listOf(a, UiMessage("user", "q"), a))
        assertEquals(keys, more.takeLast(3))
    }

    @Test fun keysDoNotDependOnPosition() {
        val list = (0 until 10).map { UiMessage("user", "m$it", ts = it.toLong()) }
        assertEquals(MessageKeys.keys(list).drop(4), MessageKeys.keys(list.drop(4)))
        assertNotEquals(MessageKeys.base(UiMessage("user", "x", ts = 1)), MessageKeys.base(UiMessage("assistant", "x", ts = 1)))
    }

    @Test fun kindsSplitLayouts() {
        assertEquals(MessageKinds.USER, MessageKinds.of(UiMessage("user", "x")))
        assertEquals(MessageKinds.USER_MEDIA, MessageKinds.of(UiMessage("user", "x", imageUrls = listOf("u"))))
        assertEquals(MessageKinds.ASSISTANT, MessageKinds.of(UiMessage("assistant", "x")))
        assertEquals(MessageKinds.ASSISTANT_RICH, MessageKinds.of(UiMessage("assistant", "x", reasoning = "r")))
        assertEquals(MessageKinds.ASSISTANT_MEDIA, MessageKinds.of(UiMessage("assistant", "MEDIA:/x.png")))
    }
}
