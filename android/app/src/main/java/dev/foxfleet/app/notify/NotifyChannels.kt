package dev.foxfleet.app.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationManagerCompat

/** The four notification channels. Names and descriptions are what the user sees in the system settings. */
enum class NotifyChannel(val id: String, val label: String, val description: String, val importance: Int) {
    Service("foxfleet_service", "Connection status", "A quiet, permanent line while FoxFleet listens for replies. You can hide it from the system settings; the connection keeps working.", NotificationManager.IMPORTANCE_LOW),
    Replies("foxfleet_replies", "Replies", "An agent finished a reply.", NotificationManager.IMPORTANCE_DEFAULT),
    Approvals("foxfleet_approvals", "Approvals and questions", "An agent is waiting for your OK or an answer. Shown right away.", NotificationManager.IMPORTANCE_HIGH),
    Errors("foxfleet_errors", "Errors", "A reply failed.", NotificationManager.IMPORTANCE_DEFAULT);

    companion object {
        fun forType(t: NotifyType): NotifyChannel = when (t) { NotifyType.Approval -> Approvals; NotifyType.Error -> Errors; else -> Replies }
    }
}

/** What the system says about one channel (the user can switch a channel off or silence it in the Android settings). */
data class ChannelStatus(val channel: NotifyChannel, val exists: Boolean, val blocked: Boolean, val silent: Boolean)

object NotifyChannels {
    /** Creates the channels (safe to call on every start: Android keeps the user's changes to an existing channel). */
    fun create(context: Context) {
        val nm = NotificationManagerCompat.from(context)
        NotifyChannel.entries.forEach { c ->
            val ch = NotificationChannel(c.id, c.label, c.importance).apply {
                description = c.description
                if (c == NotifyChannel.Service) { setShowBadge(false); setSound(null, null); enableVibration(false); enableLights(false) }
                if (c == NotifyChannel.Replies || c == NotifyChannel.Errors || c == NotifyChannel.Approvals) setShowBadge(true)
            }
            nm.createNotificationChannel(ch)
            if (c == NotifyChannel.Service) nm.getNotificationChannel(c.id)?.let { existing ->
                existing.setShowBadge(false)
                nm.createNotificationChannel(existing)
            }
        }
    }

    fun status(context: Context): List<ChannelStatus> {
        val nm = context.getSystemService(NotificationManager::class.java)
        return NotifyChannel.entries.map { c ->
            val ch = nm.getNotificationChannel(c.id)
            ChannelStatus(c, ch != null, ch != null && ch.importance == NotificationManager.IMPORTANCE_NONE, ch != null && ch.importance in 1..NotificationManager.IMPORTANCE_LOW && c != NotifyChannel.Service)
        }
    }
}
