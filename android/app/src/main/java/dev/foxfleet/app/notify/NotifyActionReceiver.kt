package dev.foxfleet.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Notification actions (Mute 1 h, Reply, Mark read) and the boot-completed restart. */
class NotifyActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        when (intent.action) {
            ACTION_MUTE -> {
                val agent = intent.getStringExtra("agent") ?: return; val chat = intent.getStringExtra("chat") ?: return
                val pending = goAsync()
                CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                    try {
                        val out = NotifyController.muteFromNotification(app, intent.getStringExtra("hub").orEmpty(), agent, chat, 3600_000L)
                        if (out is MuteOutcome.Failed) Handler(Looper.getMainLooper()).post { Toast.makeText(app, out.message, Toast.LENGTH_LONG).show() }
                    } finally { pending.finish() }
                }
            }
            ACTION_REPLY -> {
                val agent = intent.getStringExtra("agent") ?: return; val chat = intent.getStringExtra("chat") ?: return; val hub = intent.getStringExtra("hub").orEmpty()
                val text = androidx.core.app.RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)?.toString().orEmpty()
                val token = intent.getStringExtra("token")?.takeIf { intent.getLongExtra("expires", 0L) > System.currentTimeMillis() }
                val pending = goAsync()
                CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                    try {
                        val notifier = AndroidNotifier(app)
                        val api = NotifyController.actionApi(app, hub)
                        if (api == null) { notifier.replied(hub, agent, chat, text, ok = false, note = "signed out of this hub"); return@launch }
                        val sender = ReplySender(NotifyApiReplyHttp(api), ReplyKeys(app.getSharedPreferences("foxfleet_reply_keys", Context.MODE_PRIVATE)))
                        when (val out = sender.send(hub, agent, chat, text, token)) {
                            is ReplyOutcome.Sent -> notifier.replied(hub, agent, chat, text.trim(), ok = true, note = null)
                            is ReplyOutcome.Failed -> {
                                if (out.directReplyUnavailable) NoReplyAgents(app.getSharedPreferences(NoReplyAgents.PREFS, Context.MODE_PRIVATE)).mark(hub, agent)
                                notifier.replied(hub, agent, chat, text, ok = false, note = out.message)
                            }
                        }
                    } finally { pending.finish() }
                }
            }
            ACTION_READ -> {
                val agent = intent.getStringExtra("agent") ?: return; val chat = intent.getStringExtra("chat") ?: return; val hub = intent.getStringExtra("hub").orEmpty()
                val token = intent.getStringExtra("token")?.takeIf { intent.getLongExtra("expires", 0L) > System.currentTimeMillis() }
                val pending = goAsync()
                CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                    try {
                        val api = NotifyController.actionApi(app, hub)
                        val ok = api != null && ReplySender(NotifyApiReplyHttp(api), ReplyKeys(app.getSharedPreferences("foxfleet_reply_keys", Context.MODE_PRIVATE))).read(agent, chat, token)
                        if (ok) AndroidNotifier(app).clearChat(agent, chat)
                        else Handler(Looper.getMainLooper()).post { Toast.makeText(app, "Couldn't mark as read. Open the chat instead.", Toast.LENGTH_LONG).show() }
                    } finally { pending.finish() }
                }
            }
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> NotifyController.onBoot(app)
        }
    }
    companion object {
        const val ACTION_MUTE = "dev.foxfleet.app.notify.MUTE"
        const val ACTION_REPLY = "dev.foxfleet.app.notify.REPLY"
        const val ACTION_READ = "dev.foxfleet.app.notify.READ"
        const val KEY_TEXT = "reply_text"
    }
}
