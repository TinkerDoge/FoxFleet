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

/** The "Mute 1 h" action on a chat notification and the boot-completed restart. */
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
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> NotifyController.onBoot(app)
        }
    }
    companion object { const val ACTION_MUTE = "dev.foxfleet.app.notify.MUTE" }
}
