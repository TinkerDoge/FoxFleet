package dev.foxfleet.app.notify

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Feature fallback on the notification: Reply + Mark read only with a valid reply token, otherwise Open as before. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplyNotificationTest {
    private val ctx = ApplicationProvider.getApplicationContext<Context>()
    private val nm = ctx.getSystemService(NotificationManager::class.java)
    private fun notice(reply: ReplyGrant?) = ChatNotice("hub1", "nova", "Nova", "c1", NotifyType.ReplyFinished, "Done. Deploy?", 1_790_000_000_000L, reply = reply)
    private fun posted() = nm.activeNotifications.first { it.id == AndroidNotifier.CHAT_ID }.notification

    @Test fun tokenAddsReplyAndMarkRead() {
        NotifyChannels.create(ctx)
        AndroidNotifier(ctx).post(notice(ReplyGrant("secret", System.currentTimeMillis() + 3_600_000)))
        val n = posted()
        val titles = n.actions.map { it.title.toString() }
        assertTrue(titles.toString(), titles.containsAll(listOf("Reply", "Mark read", "Mute 1 h")))
        val reply = n.actions.first { it.title == "Reply" }
        assertNotNull(reply.remoteInputs); assertEquals(NotifyActionReceiver.KEY_TEXT, reply.remoteInputs.single().resultKey)
    }

    @Test fun noTokenOrExpiredTokenKeepsTheOldActions() {
        NotifyChannels.create(ctx)
        AndroidNotifier(ctx).post(notice(ReplyGrant("secret", 1L)))
        val titles = posted().actions.map { it.title.toString() }
        assertEquals(listOf("Open", "Mute 1 h"), titles)
        assertTrue("token is never printed", !ReplyGrant("secret", 1L).toString().contains("secret"))
    }

    @Test fun replyTokenParsedFromNotifyEvent() {
        val o = kotlinx.serialization.json.Json.parseToJsonElement("""{"id":5,"type":"reply_finished","agent":"nova","chat":"c","at":1,"reply":{"token":"t","expires_at":99}}""") as kotlinx.serialization.json.JsonObject
        assertEquals(ReplyGrant("t", 99), NotifyFrames.parseEvent(o)!!.reply)
    }

    @Test fun badgeNumberOnSummary() {
        NotifyChannels.create(ctx)
        val notifier = AndroidNotifier(ctx)
        notifier.setBadge(7, mapOf("nova" to 4))
        notifier.post(notice(null))
        assertEquals(4, posted().number)
        assertEquals(7, nm.activeNotifications.first { it.tag == AndroidNotifier.SUMMARY_TAG }.notification.number)
    }
}
