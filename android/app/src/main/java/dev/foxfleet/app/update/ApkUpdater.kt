package dev.foxfleet.app.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** Download, verify and hand an APK to the system installer. Never runs the APK; never installs on a hash mismatch. */
object ApkUpdater {
    const val EXTRA_SESSION_ID = "dev.foxfleet.app.update.session"

    /** Download [manifest]'s APK to [dest] over HTTPS, reporting (bytes, total|null). */
    suspend fun download(client: OkHttpClient, manifest: UpdateManifest, dest: File, onProgress: (Long, Long?) -> Unit = { _, _ -> }): File = withContext(Dispatchers.IO) {
        require(UpdatePolicy.isHttps(manifest.apkUrl)) { "The update link is not HTTPS." }
        dest.parentFile?.mkdirs()
        client.newCall(Request.Builder().url(manifest.apkUrl).build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Update download failed (${response.code})")
            val body = response.body ?: throw IOException("Update download was empty")
            val total = body.contentLength().takeIf { it > 0 }
            body.byteStream().use { input ->
                dest.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n); done += n; onProgress(done, total)
                    }
                }
            }
        }
        dest
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Start an install session for a verified [apk]. The system shows its own "install unknown app" prompt
     * ([REQUEST_INSTALL_PACKAGES] is declared; the user may need to allow this source once). Returns false if the
     * session could not be opened; the caller keeps [apk] for a retry.
     */
    fun install(context: Context, apk: File): Boolean = try {
        val installer = context.packageManager.packageInstaller
        val sessionId = installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL))
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, UpdateInstallReceiver::class.java).putExtra(EXTRA_SESSION_ID, sessionId)
            var flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or android.app.PendingIntent.FLAG_MUTABLE
            val pending = android.app.PendingIntent.getBroadcast(context, sessionId, intent, flags)
            session.commit(pending.intentSender)
        }
        true
    } catch (_: Exception) { false }
}

/** Receives the installer's reply and launches the system's confirmation screen when it asks for one. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) return
        val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { context.startActivity(it) }
    }
}
