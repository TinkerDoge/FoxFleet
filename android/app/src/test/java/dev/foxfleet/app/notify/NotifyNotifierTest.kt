package dev.foxfleet.app.notify

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotifyNotifierTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val nm get() = ctx.getSystemService(NotificationManager::class.java)
    private lateinit var notifier: AndroidNotifier
    private fun notice(chat: String = "h_1", text: String? = "Build passed", at: Long = 10, type: NotifyType = NotifyType.ReplyFinished, req: String? = null, agent: String = "nova", label: String = "Nova") =
        ChatNotice("hub1", agent, label, chat, type, text, at, requestId = req)
    private fun chats() = nm.activeNotifications.filter { it.id == AndroidNotifier.CHAT_ID }

    @Before fun setUp() { NotifyChannels.create(ctx); notifier = AndroidNotifier(ctx) }

    @Test fun channelsExistWithTheRightImportance() {
        assertEquals(NotificationManager.IMPORTANCE_LOW, nm.getNotificationChannel("foxfleet_service").importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, nm.getNotificationChannel("foxfleet_replies").importance)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, nm.getNotificationChannel("foxfleet_approvals").importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, nm.getNotificationChannel("foxfleet_errors").importance)
        NotifyChannel.entries.forEach { assertTrue(it.label.isNotBlank() && it.description.isNotBlank()) }
        assertTrue(NotifyChannels.status(ctx).all { it.exists && !it.blocked })
    }

    @Test fun creatingChannelsTwiceKeepsWhatTheUserChanged() {
        nm.getNotificationChannel("foxfleet_replies").let { assertNotNull(it) }
        NotifyChannels.create(ctx); assertEquals(4, NotifyChannel.entries.count { nm.getNotificationChannel(it.id) != null })
    }

    @Test fun serviceNotificationIsQuietOngoingAndReplaceableText() {
        val connected = notifier.serviceNotification(NotifyLink.Connected)
        assertEquals("foxfleet_service", connected.channelId)
        assertTrue(connected.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals("Connected", connected.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertNotNull(connected.contentIntent)
        listOf(NotifyLink.Connecting to "Connecting…", NotifyLink.Reconnecting(1) to "Reconnecting…", NotifyLink.Offline to "Offline, retrying").forEach { (l, t) ->
            assertEquals(t, notifier.serviceNotification(l).extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        }
    }

    @Test fun replyBecomesAMessagingStyleNotificationInTheRepliesChannelAndGroup() {
        notifier.post(notice())
        val n = chats().single().notification
        assertEquals("foxfleet_replies", n.channelId); assertEquals(AndroidNotifier.GROUP, n.group)
        assertTrue(n.extras.getCharSequence(Notification.EXTRA_TITLE).toString().startsWith("Nova"))
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)!!
        assertEquals("Build passed", style.messages.single().text.toString())
        assertNotNull(n.contentIntent); assertNotNull(n.publicVersion) // lock screen shows no message text
        assertFalse(n.publicVersion.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("Build"))
        assertEquals(2, n.actions.size)
    }

    @Test fun approvalGoesToTheHighChannelAndDeepLinksToTheApproval() {
        notifier.post(notice(type = NotifyType.Approval, req = "srq-1", text = "Run rm -rf build?"))
        val n = chats().single().notification
        assertEquals("foxfleet_approvals", n.channelId)
        val i = shadowIntent(n.contentIntent)
        assertEquals(NotifyTarget("hub1", "nova", "h_1", "srq-1"), NotifyTarget.parse(i.dataString))
    }

    @Test fun secondReplyInTheSameChatStacksInsteadOfDuplicating() {
        notifier.post(notice(text = "First", at = 1)); notifier.post(notice(text = "Second", at = 2)); notifier.post(notice(text = "Second", at = 2))
        val n = chats().single().notification
        assertEquals(listOf("First", "Second"), NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)!!.messages.map { it.text.toString() })
    }

    @Test fun eachChatGetsItsOwnNotificationAndOneGroupSummary() {
        notifier.post(notice("h_1")); notifier.post(notice("h_2", agent = "echo", label = "Echo"))
        assertEquals(2, chats().size)
        val summary = nm.activeNotifications.single { it.id == AndroidNotifier.SUMMARY_ID }.notification
        assertTrue(summary.flags and Notification.FLAG_GROUP_SUMMARY != 0); assertEquals(AndroidNotifier.GROUP, summary.group)
        assertEquals("2 chats with news", summary.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }

    @Test fun openingAChatClearsOnlyItsNotificationsAndTheSummaryWhenNoneLeft() {
        notifier.post(notice("h_1")); notifier.post(notice("h_2")); notifier.post(notice("h_3", agent = "echo", label = "Echo"))
        notifier.clearChat("nova", "h_1"); assertEquals(2, chats().size)
        notifier.clearChat("nova", null); assertEquals(listOf("echo"), chats().map { it.tag.split(AndroidNotifier.SEP)[2] })
        notifier.clearChat("echo", "h_3"); assertTrue(nm.activeNotifications.isEmpty())
    }

    @Test fun clearAllRemovesEverythingIncludingTheSummary() {
        notifier.post(notice()); notifier.postTest(); notifier.clearAll(); assertTrue(nm.activeNotifications.isEmpty())
    }

    @Test fun nothingIsPostedWhenTheSystemBlocksNotifications() {
        org.robolectric.Shadows.shadowOf(nm).setNotificationsEnabled(false)
        notifier.post(notice()); assertTrue(nm.activeNotifications.isEmpty())
    }

    private fun shadowIntent(pi: android.app.PendingIntent): android.content.Intent = org.robolectric.Shadows.shadowOf(pi).savedIntent

    @Test fun aReplyOrErrorNeverReplacesAPendingApproval() {
        notifier.post(notice(text = "Run rm -rf build?", type = NotifyType.Approval, req = "srq-1"))
        notifier.post(notice(text = "All done", at = 20))
        notifier.post(notice(text = "The reply failed", at = 30, type = NotifyType.Error))
        val list = chats()
        assertEquals(2, list.size) // one approval, one chat line (reply + error share it)
        val approval = list.single { it.tag!!.startsWith("approval" + AndroidNotifier.SEP) }.notification
        assertEquals("foxfleet_approvals", approval.channelId)
        assertTrue(approval.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("rm -rf"))
        assertTrue(shadowIntent(approval.contentIntent).dataString.orEmpty().contains("srq-1"))
        assertTrue(list.single { it.tag!!.startsWith("chat" + AndroidNotifier.SEP) }.notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("The reply failed"))
    }

    @Test fun openingTheChatClearsItsApprovalToo_evenWithColonsInIds() {
        notifier.post(notice(chat = "h:1", agent = "no:va", text = "ok"))
        notifier.post(notice(chat = "h:1", agent = "no:va", text = "ask", type = NotifyType.Approval, req = "r1"))
        notifier.post(notice(chat = "h_2", text = "other"))
        assertEquals(3, chats().size)
        notifier.clearChat("no:va", "h:1")
        assertEquals(listOf("h_2"), chats().map { it.tag!!.split(AndroidNotifier.SEP).last() })
    }

}
