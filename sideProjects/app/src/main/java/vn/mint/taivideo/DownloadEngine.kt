package vn.mint.taivideo

import android.content.Context
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.ffmpeg.FFmpeg
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

data class VideoMeta(
    val title: String,
    val thumbnail: String?,
    val durationSec: Long,
    val uploader: String?,
)

enum class Quality(val format: String, val audioOnly: Boolean) {
    BEST("bv*+ba/b", false),
    P720("bv*[height<=720]+ba/b[height<=720]/b[height<=720]", false),
    P480("bv*[height<=480]+ba/b[height<=480]/b[height<=480]", false),
    AUDIO("bestaudio/best", true),
}

object DownloadEngine {
    @Volatile
    private var initialized = false

    /** Extract native binaries on first run. Must be called off the main thread. */
    suspend fun init(context: Context) = withContext(Dispatchers.IO) {
        if (!initialized) {
            YoutubeDL.getInstance().init(context.applicationContext)
            FFmpeg.getInstance().init(context.applicationContext)
            initialized = true
        }
    }

    /** Pull the latest yt-dlp so extractors keep up with site changes. */
    suspend fun update(context: Context): String = withContext(Dispatchers.IO) {
        init(context)
        val status = YoutubeDL.getInstance()
            .updateYoutubeDL(context.applicationContext, YoutubeDL.UpdateChannel.STABLE)
        status.toString()
    }

    fun version(context: Context): String =
        try {
            YoutubeDL.getInstance().version(context.applicationContext) ?: "?"
        } catch (_: Exception) {
            "?"
        }

    suspend fun fetchInfo(url: String): VideoMeta = withContext(Dispatchers.IO) {
        val req = YoutubeDLRequest(url.trim())
        req.addOption("--no-playlist")
        req.addOption("--socket-timeout", "30")
        req.addOption("--retries", "1")
        val info = YoutubeDL.getInstance().getInfo(req)
        VideoMeta(
            title = info.title?.takeIf { it.isNotBlank() } ?: url.trim(),
            thumbnail = info.thumbnail,
            durationSec = info.duration.toLong(),
            uploader = info.uploader,
        )
    }

    /**
     * Downloads [url] into [outputDir]. Returns the downloaded file
     * (newest file in the dir after yt-dlp finishes).
     */
    fun download(
        url: String,
        quality: Quality,
        outputDir: File,
        onProgress: (Float) -> Unit,
    ): Result<File> {
        return try {
            val req = YoutubeDLRequest(url.trim())
            req.addOption("--no-playlist")
            req.addOption("--socket-timeout", "30")
            req.addOption("--retries", "3")
            req.addOption("-f", quality.format)
            if (quality.audioOnly) {
                req.addOption("-x")
                req.addOption("--audio-format", "mp3")
            } else {
                req.addOption("--merge-output-format", "mp4")
            }
            req.addOption("-o", outputDir.absolutePath + "/%(title).80s [%(id)s].%(ext)s")
            YoutubeDL.getInstance().execute(req, null) { progress, _, _ ->
                onProgress((progress / 100f).coerceIn(0f, 1f))
            }
            val newest = outputDir.listFiles()
                ?.filter { it.isFile }
                ?.maxByOrNull { it.lastModified() }
            if (newest != null) Result.success(newest)
            else Result.failure(IllegalStateException("no file produced"))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
