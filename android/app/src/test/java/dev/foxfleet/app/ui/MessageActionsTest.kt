package dev.foxfleet.app.ui

import dev.foxfleet.app.data.ImageAttachment
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.chat.MessageAction
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.QUICK_REACTIONS
import dev.foxfleet.app.ui.chat.ReplyTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same rules as web/tests/message-actions.test.tsx. */
class MessageActionsTest {
    @Test fun quickRowIsLikeDislikeHeartConfettiSurprise() = assertEquals(listOf("👍", "👎", "❤️", "🎉", "😮"), QUICK_REACTIONS)

    @Test fun quoteRoundTrips() {
        val sent = MessageActions.withQuote(ReplyTarget("Atlas", "Ship it?"), "Yes")
        assertEquals("> Ship it?\n\nYes", sent)
        assertEquals("Ship it?", MessageActions.splitQuote(sent)!!.quote)
        assertEquals("Yes", MessageActions.splitQuote(sent)!!.body)
        assertNull(MessageActions.splitQuote("> no blank line\nYes"))
        assertEquals("Yes", MessageActions.withQuote(null, "Yes"))
    }

    @Test fun displayTextDropsTagsReactFilesAndQuote() {
        assertEquals("Done", MessageActions.displayText(UiMessage("assistant", "Done\nREACT: ❤️\nMEDIA:/tmp/a.png")))
        assertEquals("Hello", MessageActions.displayText(UiMessage("user", "> q\n\nHello\n\n[Attached file: uploads/a.txt (1 KB)]")))
    }

    @Test fun excerptIsOneLineCappedWithFallbacks() {
        assertEquals("a b c", MessageActions.excerpt(UiMessage("user", "a\n\n b   c")))
        val long = MessageActions.excerpt(UiMessage("user", "x".repeat(200)))
        assertEquals(140, long.codePointCount(0, long.length)); assertTrue(long.endsWith("…"))
        assertEquals("[image]", MessageActions.excerpt(UiMessage("user", "", images = listOf(ImageAttachment("/p", "data:image/jpeg;base64,AA", 1)))))
        assertEquals("[voice]", MessageActions.excerpt(UiMessage("assistant", "MEDIA:/tmp/v.ogg")))
        assertEquals("[file]", MessageActions.excerpt(UiMessage("assistant", "MEDIA:/tmp/r.pdf")))
    }

    @Test fun reactOnlyRepliesAndHiddenIdsAreNotShown() {
        val msgs = listOf(UiMessage("user", "hi", id = "u"), UiMessage("assistant", "REACT: ❤️", id = "a"), UiMessage("assistant", "Hello", id = "b"))
        assertTrue(MessageActions.emptyReply(msgs[1])); assertFalse(MessageActions.emptyReply(msgs[2]))
        assertEquals(listOf("u"), MessageActions.visible(msgs, setOf("b")).map { it.value.id })
        assertEquals(listOf(0), MessageActions.visible(msgs, setOf("b")).map { it.index }) // original index kept for stable list keys
    }

    @Test fun menuActionsFollowRoleRecencyKindAndIds() {
        val a = UiMessage("assistant", "Hello", id = "a"); val u = UiMessage("user", "Hi", id = "u")
        assertEquals(listOf(MessageAction.Reply, MessageAction.Copy, MessageAction.Select, MessageAction.Share, MessageAction.Retry, MessageAction.Delete),
            MessageActions.actions(a, newestAssistant = true, newestUser = false, streaming = false, hermes = true, canHide = true))
        assertFalse(MessageAction.Retry in MessageActions.actions(a, newestAssistant = true, newestUser = false, streaming = true, hermes = true, canHide = true))
        assertTrue(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, streaming = false, hermes = true, canHide = true))
        assertFalse(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, streaming = false, hermes = false, canHide = true))
        assertEquals(listOf(MessageAction.Reply, MessageAction.Copy, MessageAction.Select, MessageAction.Share),
            MessageActions.actions(UiMessage("user", "Hi"), newestAssistant = false, newestUser = false, streaming = false, hermes = true, canHide = true))
    }

    @Test fun doubleTapTogglesYourHeart() {
        val me = ReactionActor("user:u", "Me", "human")
        assertTrue(MessageActions.nextHeart(emptyList(), me.id))
        assertFalse(MessageActions.nextHeart(listOf(ReactionGroup("❤️", listOf(me))), me.id))
        assertTrue(MessageActions.nextHeart(listOf(ReactionGroup("❤️", listOf(ReactionActor("agent:a", "A", "agent")))), me.id))
    }

    @Test fun swipeRules() {
        assertFalse(MessageActions.swipeAllowed(startXInWindow = 20f, edgePx = 24f))
        assertTrue(MessageActions.swipeAllowed(startXInWindow = 30f, edgePx = 24f))
        assertFalse(MessageActions.swipeFires(dragPx = 63f, thresholdPx = 64f))
        assertTrue(MessageActions.swipeFires(dragPx = 64f, thresholdPx = 64f))
    }
}
