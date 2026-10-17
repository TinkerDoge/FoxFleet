package dev.foxfleet.app.ui

import dev.foxfleet.app.data.ImageAttachment
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.chat.MessageAction
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.QUICK_REACTIONS
import dev.foxfleet.app.ui.chat.Quoted
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
        // a reply with only pictures: the send trims the blank line away
        assertEquals(Quoted("Ship it?", ""), MessageActions.splitQuote("> Ship it?"))
        assertEquals("", MessageActions.displayText(UiMessage("user", "> Ship it?")))
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
        assertFalse(MessageActions.emptyReply(UiMessage("assistant", "", steps = listOf(dev.foxfleet.app.data.ToolStep("terminal")))))
        assertEquals(listOf("u"), MessageActions.visible(msgs, setOf("b")).map { it.value.id })
        assertEquals(listOf(0), MessageActions.visible(msgs, setOf("b")).map { it.index }) // original index kept for stable list keys
    }

    @Test fun menuActionsFollowRoleRecencyKindAndIds() {
        val a = UiMessage("assistant", "Hello", id = "a"); val u = UiMessage("user", "Hi", id = "u")
        assertEquals(listOf(MessageAction.Reply, MessageAction.Copy, MessageAction.Select, MessageAction.Share, MessageAction.Retry, MessageAction.Delete),
            MessageActions.actions(a, newestAssistant = true, newestUser = false, busy = false, hermes = true, canHide = true))
        assertFalse(MessageAction.Retry in MessageActions.actions(a, newestAssistant = true, newestUser = false, busy = true, hermes = true, canHide = true))
        assertTrue(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, busy = false, hermes = true, canHide = true))
        assertFalse(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, busy = false, hermes = false, canHide = true))
        assertEquals(listOf(MessageAction.Reply, MessageAction.Copy, MessageAction.Select, MessageAction.Share),
            MessageActions.actions(UiMessage("user", "Hi"), newestAssistant = false, newestUser = false, busy = false, hermes = true, canHide = true))
    }

    @Test fun retryOnlyOnTheLastReplyEditOnlyOnAnsweredNewestUser() {
        val u1 = UiMessage("user", "one", id = "u1"); val a1 = UiMessage("assistant", "A", id = "a1"); val u2 = UiMessage("user", "two", id = "u2"); val a2 = UiMessage("assistant", "B", id = "a2")
        MessageActions.newestTargets(listOf(u1, a1, u2, a2)).let { assertTrue(it.assistant === a2); assertTrue(it.user === u2) }
        // the newest user message has no reply yet: no Retry (the last message is not a reply) and no Edit (nothing to undo)
        MessageActions.newestTargets(listOf(u1, a1, u2)).let { assertNull(it.assistant); assertNull(it.user) }
        // notices do not count
        val sys = UiMessage("system", "note")
        MessageActions.newestTargets(listOf(u1, a1, sys)).let { assertTrue(it.assistant === a1); assertTrue(it.user === u1) }
        // several replies after one user message: the last one retries, the user message edits
        val a3 = UiMessage("assistant", "C")
        MessageActions.newestTargets(listOf(u1, a1, a3)).let { assertTrue(it.assistant === a3); assertTrue(it.user === u1) }
        MessageActions.newestTargets(emptyList()).let { assertNull(it.assistant); assertNull(it.user) }
    }

    @Test fun busyHidesRetryAndEdit() {
        val a = UiMessage("assistant", "Hello", id = "a"); val u = UiMessage("user", "Hi", id = "u")
        assertFalse(MessageAction.Retry in MessageActions.actions(a, newestAssistant = true, newestUser = false, busy = true, hermes = true, canHide = true))
        assertFalse(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, busy = true, hermes = true, canHide = true))
    }

    @Test fun pickingAnEmojiYouGaveTakesItBack() {
        val me = ReactionActor("user:u", "Me", "human"); val them = ReactionActor("agent:a", "A", "agent")
        assertTrue(MessageActions.nextReaction(emptyList(), me.id, "👍"))
        assertFalse(MessageActions.nextReaction(listOf(ReactionGroup("👍", listOf(them, me))), me.id, "👍"))
        assertTrue(MessageActions.nextReaction(listOf(ReactionGroup("👍", listOf(them))), me.id, "👍"))
        assertTrue(MessageActions.nextReaction(listOf(ReactionGroup("❤️", listOf(me))), me.id, "👍"))
    }

    @Test fun doubleTapTogglesYourHeart() {
        val me = ReactionActor("user:u", "Me", "human")
        assertTrue(MessageActions.nextHeart(emptyList(), me.id))
        assertFalse(MessageActions.nextHeart(listOf(ReactionGroup("❤️", listOf(me))), me.id))
        assertTrue(MessageActions.nextHeart(listOf(ReactionGroup("❤️", listOf(ReactionActor("agent:a", "A", "agent")))), me.id))
    }

    @Test fun editReloadAppliesOnlyWhenNothingNewStarted() {
        val u = UiMessage("user", "Hi", id = "u"); val a = UiMessage("assistant", "Hello", id = "a")
        fun chat() = dev.foxfleet.app.ui.chat.ChatState().apply { load(listOf(u, a), "s1"); beginLoad() }
        // gone after /undo: Edit puts the text back; the reload ends the load
        chat().let { s -> assertEquals(true, s.applyUndo("s1", emptyList(), false, u, 1)); assertFalse(s.loading) }
        // still there: refused
        chat().let { s -> assertEquals(false, s.applyUndo("s1", listOf(u, a), false, u, 1)) }
        // no hub id: fewer copies of the same text means it went
        val bare = UiMessage("user", "Hi")
        chat().let { s -> assertEquals(true, s.applyUndo("s1", listOf(UiMessage("user", "Hi")), false, bare, 2)); assertEquals(false, s.applyUndo("s1", listOf(UiMessage("user", "Hi")), false, bare, 1)) }
        // a reply started meanwhile: the page is not applied (it would wipe that turn), the composer is free again
        chat().let { s -> s.simulateStream("new"); assertNull(s.applyUndo("s1", emptyList(), false, u, 1)); assertEquals(2, s.messages.size); assertFalse(s.loading) }
        chat().let { s -> s.simulateNative(queue = listOf(dev.foxfleet.app.data.HubApi.QueuedMessage("q", "sending", "queue", "next"))); assertNull(s.applyUndo("s1", emptyList(), false, u, 1)); assertEquals(2, s.messages.size) }
        // another chat opened: untouched, its own load owns the flag
        chat().let { s -> assertNull(s.applyUndo("other", emptyList(), false, u, 1)); assertTrue(s.loading) }
        // a new chat never waits on a reload it cut short
        chat().let { s -> s.newConversation(); assertFalse(s.loading) }
    }

    @Test fun swipeRules() {
        assertFalse(MessageActions.swipeAllowed(startXInWindow = 20f, edgePx = 24f))
        assertTrue(MessageActions.swipeAllowed(startXInWindow = 30f, edgePx = 24f))
        assertFalse(MessageActions.swipeFires(dragPx = 63f, thresholdPx = 64f))
        assertTrue(MessageActions.swipeFires(dragPx = 64f, thresholdPx = 64f))
    }
}
