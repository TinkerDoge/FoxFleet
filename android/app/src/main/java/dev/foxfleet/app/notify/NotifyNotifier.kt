package dev.foxfleet.app.notify

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.compose.ui.graphics.toArgb
import dev.foxfleet.app.MainActivity
import dev.foxfleet.app.R
import dev.foxfleet.app.ui.Tokens

/** What one chat notification says. Text comes from the hub (fetched after the event); [text] null means it could not be fetched and a plain line is shown. */
data class ChatNotice(
    val hubId: String,
    val agent: String,
    val agentLabel: String,
    val chat: String,
    val type: NotifyType,
    val text: String?,
    val at: Long,
    val requestId: String? = null,
    val detail: String? = null,
)

/** Posts and clears notifications. The builder is separate from the dispatcher so it can be tested with Robolectric. */
interface Notifier {
    fun post(n: ChatNotice)
    fun postTest()
    fun clearChat(agent: String, chat: String?)
    fun clearAll()
}

class AndroidNotifier(private val context: Context) : Notifier {
    private val nm = NotificationManagerCompat.from(context)
    private val accent = Tokens.accents[0].second.toArgb()

    private fun open(target: NotifyTarget?, code: Int): PendingIntent {
        val i = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (target != null) i.data = Uri.parse(target.toUri())
        return PendingIntent.getActivity(context, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun base(channel: NotifyChannel) = NotificationCompat.Builder(context, channel.id)
        .setSmallIcon(R.drawable.ic_stat_foxfleet).setColor(accent).setAutoCancel(true).setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)

    override fun post(n: ChatNotice) {
        if (!nm.areNotificationsEnabled()) return
        val tag = tagOf(n.hubId, n.agent, n.chat, approval = n.type == NotifyType.Approval)
        val channel = NotifyChannel.forType(n.type)
        val target = NotifyTarget(n.hubId, n.agent, n.chat, n.requestId.takeIf { n.type == NotifyType.Approval })
        val code = tag.hashCode()
        val line = when (n.type) {
            NotifyType.Approval -> n.text ?: "Needs your approval"
            NotifyType.Error -> n.text ?: "The reply failed"
            else -> n.text ?: "Replied"
        }
        val who = Person.Builder().setName(n.agentLabel).setKey(n.agent).build()
        val me = Person.Builder().setName("You").build()
        val old = nm.activeNotifications.firstOrNull { it.tag == tag && it.id == CHAT_ID }?.notification
        val earlier = old?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }?.messages.orEmpty()
        val prefix = when (n.type) { NotifyType.Approval -> "Needs approval: "; NotifyType.Error -> "Error: "; else -> "" }
        val style = NotificationCompat.MessagingStyle(me).also { it.conversationTitle = n.agentLabel; it.isGroupConversation = false }
        (earlier.filterNot { it.text == prefix + line && it.timestamp == n.at } + NotificationCompat.MessagingStyle.Message(prefix + line, n.at, who)).takeLast(MAX_LINES).forEach { style.addMessage(it) }
        val public = base(channel).setContentTitle("FoxFleet").setContentText(when (n.type) { NotifyType.Approval -> "Needs your approval"; NotifyType.Error -> "A reply failed"; else -> "New reply" }).build()
        val b = base(channel).setStyle(style).setContentTitle(n.agentLabel).setContentText(prefix + line)
            .setWhen(n.at).setShowWhen(true).setGroup(GROUP).setPublicVersion(public).setContentIntent(open(target, code))
            .setPriority(if (channel == NotifyChannel.Approvals) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        if (n.type == NotifyType.Approval) b.setCategory(NotificationCompat.CATEGORY_MESSAGE).setOnlyAlertOnce(false)
        b.addAction(0, "Open", open(target, code + 1))
        b.addAction(0, "Mute 1 h", PendingIntent.getBroadcast(context, code + 2, Intent(context, NotifyActionReceiver::class.java).setAction(NotifyActionReceiver.ACTION_MUTE).putExtra("agent", n.agent).putExtra("chat", n.chat).putExtra("hub", n.hubId), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        nm.notify(tag, CHAT_ID, b.build())
        summary()
    }

    private fun activeChats() = nm.activeNotifications.filter { it.id == CHAT_ID && it.tag?.let { t -> t.startsWith("chat$SEP") || t.startsWith("approval$SEP") } == true }

    private fun summary() {
        // Guard first, before any other nm call, so lint's MissingPermission flow analysis credits it (as in post()).
        // Disabled notifications cannot show a summary anyway; the next post() with them enabled rebuilds it.
        if (!nm.areNotificationsEnabled()) return
        val chats = activeChats()
        if (chats.isEmpty()) { nm.cancel(SUMMARY_TAG, SUMMARY_ID); return }
        val inbox = NotificationCompat.InboxStyle().setBigContentTitle("FoxFleet")
        chats.take(6).forEach { inbox.addLine(it.notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString()) }
        val s = base(NotifyChannel.Replies).setContentTitle("FoxFleet").setContentText(if (chats.size == 1) "1 chat with news" else "${chats.size} chats with news")
            .setStyle(inbox).setGroup(GROUP).setGroupSummary(true).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setContentIntent(open(null, SUMMARY_ID)).build()
        nm.notify(SUMMARY_TAG, SUMMARY_ID, s)
    }

    override fun postTest() {
        if (!nm.areNotificationsEnabled()) return
        nm.notify("test", TEST_ID, base(NotifyChannel.Replies).setContentTitle("FoxFleet test").setContentText("Notifications work on this phone.").setContentIntent(open(null, TEST_ID)).build())
    }

    override fun clearChat(agent: String, chat: String?) {
        activeChats().filter { sbn ->
            val p = sbn.tag!!.split(SEP, limit = 4)
            p.size == 4 && p[2] == agent && (chat == null || p[3] == chat)
        }.forEach { nm.cancel(it.tag, it.id) }
        summary()
    }

    override fun clearAll() {
        activeChats().forEach { nm.cancel(it.tag, it.id) }
        nm.cancel(SUMMARY_TAG, SUMMARY_ID); nm.cancel("test", TEST_ID)
    }

    /** The always-present service line. Quiet by design: low importance, no sound, no badge, nothing to dismiss. */
    fun serviceNotification(link: NotifyLink): Notification = NotificationCompat.Builder(context, NotifyChannel.Service.id)
        .setSmallIcon(R.drawable.ic_stat_foxfleet).setColor(accent).setOngoing(true).setSilent(true).setOnlyAlertOnce(true).setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE).setPriority(NotificationCompat.PRIORITY_LOW).setVisibility(NotificationCompat.VISIBILITY_SECRET)
        .setContentTitle(serviceText(link)).setContentIntent(open(null, SERVICE_ID)).build()

    companion object {
        const val SERVICE_ID = 1000; const val SUMMARY_ID = 1001; const val TEST_ID = 1002; const val CHAT_ID = 2000
        const val GROUP = "dev.foxfleet.app.CHATS"; const val SUMMARY_TAG = "summary"; const val MAX_LINES = 5
        /** Separator inside a tag: a character an id can't contain, so an id with ':' in it still splits correctly. */
        const val SEP = '\u001f'
        /** Approvals get their own tag, so a later reply or error in the same chat never replaces a pending approval (its channel, text and deep link). */
        fun tagOf(hub: String, agent: String, chat: String, approval: Boolean = false) = "${if (approval) "approval" else "chat"}$SEP$hub$SEP$agent$SEP$chat".replace('\n', ' ')
        fun serviceText(link: NotifyLink) = when (link) {
            NotifyLink.Connected -> "Connected"
            NotifyLink.Connecting, NotifyLink.Off -> "Connecting…"
            is NotifyLink.Reconnecting -> "Reconnecting…"
            NotifyLink.Offline -> "Offline, retrying"
            NotifyLink.SignedOut -> "Signed out"
            NotifyLink.Unsupported -> "Hub too old for notifications"
            NotifyLink.Blocked -> "Paused by Android"
        }
    }
}
