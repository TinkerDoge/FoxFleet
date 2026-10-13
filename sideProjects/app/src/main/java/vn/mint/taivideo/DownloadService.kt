package vn.mint.taivideo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.provider.MediaStore
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

sealed interface DlState {
    data object Idle : DlState
    data class Running(val title: String, val progress: Float) : DlState
    data class Done(val title: String) : DlState
    data class Failed(val message: String) : DlState
}

/** Same-process bus so the UI can mirror the service's progress. */
object DownloadBus {
    val state = MutableStateFlow<DlState>(DlState.Idle)
}

class DownloadService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var nm: NotificationManager

    override fun onCreate() {
        super.onCreate()
        nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (DownloadBus.state.value is DlState.Running) return START_NOT_STICKY
        val url = intent?.getStringExtra(EXTRA_URL) ?: return START_NOT_STICKY
        val quality = try {
            Quality.valueOf(intent.getStringExtra(EXTRA_QUALITY) ?: "BEST")
        } catch (_: Exception) {
            Quality.BEST
        }
        val title = intent.getStringExtra(EXTRA_TITLE) ?: url

        val notif = progressNotification(title, 0f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, notif)
        }
        DownloadBus.state.value = DlState.Running(title, 0f)

        scope.launch {
            val tmpDir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "taivideo").apply { mkdirs() }
            val result = withContext(Dispatchers.IO) {
                DownloadEngine.download(url, quality, tmpDir) { p ->
                    DownloadBus.state.value = DlState.Running(title, p)
                    nm.notify(NOTIF_ID, progressNotification(title, p))
                }
            }
            result.onSuccess { file ->
                withContext(Dispatchers.IO) { copyToPublicDownloads(file, quality) }
                HistoryStore.add(
                    this@DownloadService,
                    HistoryItem(
                        title = title,
                        url = url,
                        fileName = file.name,
                        timestamp = System.currentTimeMillis(),
                        size = file.length(),
                    ),
                )
                DownloadBus.state.value = DlState.Done(title)
                stopForeground(STOP_FOREGROUND_REMOVE)
                nm.notify(NOTIF_ID, doneNotification(title, file))
            }.onFailure { e ->
                Log.e("DogeDownloader", "Download failed", e)
                val msg = getString(R.string.download_failed)
                DownloadBus.state.value = DlState.Failed(msg)
                stopForeground(STOP_FOREGROUND_REMOVE)
                nm.notify(NOTIF_ID, failedNotification(msg))
            }
            stopSelf()
        }
        return START_NOT_STICKY
    }

    /** Best-effort copy so the file also shows up in the phone's Download folder. */
    private fun copyToPublicDownloads(src: File, quality: Quality) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        try {
            val ext = src.extension.ifBlank { if (quality.audioOnly) "mp3" else "mp4" }
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, src.nameWithoutExtension + "." + ext)
                put(MediaStore.Downloads.MIME_TYPE, if (quality.audioOnly) "audio/mpeg" else "video/mp4")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DogeDownloader")
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return
            contentResolver.openOutputStream(uri)?.use { out ->
                src.inputStream().use { it.copyTo(out) }
            }
        } catch (_: Exception) {
        }
    }

    private fun contentIntent(): PendingIntent {
        val i = Intent(this, MainActivity::class.java)
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun progressNotification(title: String, progress: Float): Notification {
        val pct = (progress * 100).toInt()
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_download_notification)
            .setContentTitle(getString(R.string.notif_downloading, title))
            .setContentText("$pct%")
            .setProgress(100, pct, progress <= 0f)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent())
            .build()
    }

    private fun doneNotification(title: String, file: File): Notification {
        val view = Intent(Intent.ACTION_VIEW).apply {
            val uri = androidx.core.content.FileProvider.getUriForFile(
                this@DownloadService, "${packageName}.provider", file,
            )
            setDataAndType(uri, if (file.extension == "mp3") "audio/mpeg" else "video/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val pi = PendingIntent.getActivity(this, 1, view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_download_notification)
            .setContentTitle(getString(R.string.notif_done, title))
            .setContentText(getString(R.string.tap_to_open))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
    }

    private fun failedNotification(msg: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_download_notification)
            .setContentTitle(getString(R.string.notif_failed))
            .setContentText(msg)
            .setContentIntent(contentIntent())
            .setAutoCancel(true)
            .build()

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
        // Leave the bus alone; the UI resets it when it consumes the terminal state.
    }

    companion object {
        const val CHANNEL_ID = "downloads"
        const val NOTIF_ID = 1001
        const val EXTRA_URL = "extra_url"
        const val EXTRA_QUALITY = "extra_quality"
        const val EXTRA_TITLE = "extra_title"
    }
}
