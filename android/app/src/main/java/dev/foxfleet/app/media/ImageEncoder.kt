package dev.foxfleet.app.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import dev.foxfleet.app.data.ChatPayload
import dev.foxfleet.app.data.ImageAttachment
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/** Pure sizing rules, unit-tested without Android bitmaps. */
object ImageSizing {
    const val MAX_EDGE = 2048

    /** Largest power-of-two sample size that keeps the long edge ≥ [maxEdge]. */
    fun sampleSize(w: Int, h: Int, maxEdge: Int = MAX_EDGE): Int {
        var s = 1
        while (max(w, h) / (s * 2) >= maxEdge) s *= 2
        return s
    }

    /** Final size with the long edge capped at [maxEdge], aspect kept. */
    fun fit(w: Int, h: Int, maxEdge: Int = MAX_EDGE): Pair<Int, Int> {
        val long = max(w, h)
        if (long <= maxEdge || long == 0) return w to h
        val k = maxEdge.toFloat() / long
        return (w * k).roundToInt().coerceAtLeast(1) to (h * k).roundToInt().coerceAtLeast(1)
    }

    /** Length of a base64 data URL for [bytes] of JPEG. */
    fun dataUrlLength(bytes: Int): Int = "data:image/jpeg;base64,".length + 4 * ((bytes + 2) / 3)

    fun fitsBudget(bytes: Int, budget: Int = ChatPayload.IMAGE_BUDGET) = dataUrlLength(bytes) <= budget

    /** Quality ladder tried until the encoded image fits; then the edge shrinks. */
    val QUALITIES = listOf(85, 75, 65, 55)
}

object ImageEncoder {
    /** Decode, orient, downscale and JPEG-encode [uri] so its data URL fits the hub budget. */
    fun encode(context: Context, uri: Uri): ImageAttachment {
        val cr = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth > 0) { "Not an image" }
        val opts = BitmapFactory.Options().apply { inSampleSize = ImageSizing.sampleSize(bounds.outWidth, bounds.outHeight) }
        var bmp = cr.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, opts) } ?: error("Couldn't read image")
        val rotation = runCatching {
            cr.openInputStream(uri).use { ExifInterface(it!!).rotationDegrees }
        }.getOrDefault(0)
        if (rotation != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
        var edge = ImageSizing.MAX_EDGE
        while (true) {
            val (w, h) = ImageSizing.fit(bmp.width, bmp.height, edge)
            val scaled = if (w == bmp.width && h == bmp.height) bmp else Bitmap.createScaledBitmap(bmp, w, h, true)
            for (q in ImageSizing.QUALITIES) {
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, q, out)
                val bytes = out.toByteArray()
                if (ImageSizing.fitsBudget(bytes.size) || edge <= 512) {
                    val dir = File(context.cacheDir, "attachments").apply { mkdirs() }
                    val file = File(dir, "img-${System.currentTimeMillis()}-${bytes.size}.jpg")
                    file.writeBytes(bytes)
                    return ImageAttachment(file.absolutePath, "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP), bytes.size)
                }
            }
            edge = (edge * 0.75f).toInt()
        }
    }
}
