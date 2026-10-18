package dev.foxfleet.app.media

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import dev.foxfleet.app.ui.chat.MediaRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * Copies a leased cache file into the phone's public gallery (scoped storage, `RELATIVE_PATH`, no
 * permission). Pictures land in `Pictures/FoxFleet`, videos in `Movies/FoxFleet`, everything else in
 * `Download/FoxFleet`, so other apps (gallery, Files, WhatsApp) can open them. The path/mime/name
 * choice is pure ([plan]) and unit-tested; only the actual MediaStore insert touches the device.
 */
object MediaStoreSaver {
    enum class Collection(val relativePath: String, val defaultExt: String, val defaultMime: String) {
        Pictures("Pictures/FoxFleet", "jpg", "image/jpeg"),
        Movies("Movies/FoxFleet", "mp4", "video/mp4"),
        Downloads("Download/FoxFleet", "bin", "application/octet-stream"),
    }

    data class Plan(val collection: Collection, val displayName: String, val mimeType: String) {
        val relativePath get() = collection.relativePath
    }

    data class Saved(val uri: Uri, val relativePath: String)

    private val EXT = Regex("""\.([A-Za-z0-9]{1,8})$""")
    private val PATH_SEP = Regex("""[/\\]""")

    fun plan(kind: MediaRef.Kind?, alt: String?, ref: String?, mime: String?, nowEpoch: Long = System.currentTimeMillis()): Plan {
        val collection = when (kind) {
            MediaRef.Kind.Image -> Collection.Pictures
            MediaRef.Kind.Video -> Collection.Movies
            null -> Collection.Downloads
        }
        val altExt = extension(alt)
        val refExt = extension(ref)
        val ext = altExt ?: refExt ?: collection.defaultExt
        val name = alt?.takeIf { altExt != null && !PATH_SEP.containsMatchIn(it) }?.let(::sanitize)
            ?: "foxfleet-$nowEpoch.$ext"
        val mimeType = mime?.takeIf { it.isNotBlank() } ?: mimeForExtension(ext) ?: collection.defaultMime
        return Plan(collection, name, mimeType)
    }

    private fun extension(s: String?): String? = s?.let { EXT.find(it)?.groupValues?.get(1)?.lowercase() }

    private fun sanitize(name: String): String = name.replace(Regex("""[\x00-\x1f\x7f/\\]"""), "_").take(120).ifBlank { "file" }

    private fun mimeForExtension(ext: String): String? = when (ext) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        "avif" -> "image/avif"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
        "webm" -> "video/webm"
        "mkv" -> "video/x-matroska"
        "m4v" -> "video/x-m4v"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "ogg" -> "audio/ogg"
        "m4a" -> "audio/mp4"
        "flac" -> "audio/flac"
        "pdf" -> "application/pdf"
        "zip" -> "application/zip"
        else -> null
    }

    /** Copies [file] into the right public collection and returns the content Uri plus its folder for the toast. */
    suspend fun save(context: Context, file: File, kind: MediaRef.Kind?, alt: String?, ref: String?, mime: String?): Saved = withContext(Dispatchers.IO) {
        val plan = plan(kind, alt, ref, mime)
        val resolver = context.contentResolver
        val collection = when (plan.collection) {
            Collection.Pictures -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            Collection.Movies -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            Collection.Downloads -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, plan.displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, plan.mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, plan.relativePath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: throw IOException("Could not save to ${plan.relativePath}")
        try {
            val out = resolver.openOutputStream(uri) ?: throw IOException("Could not open ${plan.relativePath}")
            out.use { file.inputStream().use { input -> input.copyTo(it) } }
            val finish = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, finish, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        Saved(uri, plan.relativePath)
    }
}
