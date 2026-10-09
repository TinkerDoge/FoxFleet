package dev.foxfleet.app.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.staticCompositionLocalOf
import java.io.File
import kotlin.math.max
import kotlin.math.min

/** Crop maths for the circle cropper; pure so it can be unit-tested. */
object CropMath {
    /** Scale that makes the image cover a [viewport]-sized square. */
    fun coverScale(imgW: Int, imgH: Int, viewport: Float): Float = viewport / min(imgW, imgH).toFloat()

    /** Clamp a pan offset so the image always covers the viewport. */
    fun clampOffset(offset: Float, imgLen: Float, scale: Float, viewport: Float): Float {
        val slack = max(0f, (imgLen * scale - viewport) / 2f)
        return offset.coerceIn(-slack, slack)
    }

    /**
     * Source-pixel square under the viewport for an image centred then panned by (dx, dy)
     * at [scale] (viewport px per image px). Returns left, top, size in image pixels.
     */
    fun sourceSquare(imgW: Int, imgH: Int, viewport: Float, scale: Float, dx: Float, dy: Float): Triple<Int, Int, Int> {
        val size = (viewport / scale).coerceAtMost(min(imgW, imgH).toFloat())
        val cx = imgW / 2f - dx / scale
        val cy = imgH / 2f - dy / scale
        val left = (cx - size / 2f).coerceIn(0f, imgW - size)
        val top = (cy - size / 2f).coerceIn(0f, imgH - size)
        return Triple(left.toInt(), top.toInt(), size.toInt())
    }
}

/** Locally stored custom avatars: filesDir/avatars/<key>.webp, 512 px square. */
class AvatarStore(private val dir: File) {
    constructor(context: Context) : this(File(context.filesDir, "avatars"))

    /** name → version; bumping the version busts Coil's cache. */
    val versions = mutableStateMapOf<String, Long>()

    init {
        dir.listFiles()?.forEach { f -> if (f.extension == "webp") versions[f.nameWithoutExtension] = f.lastModified() }
    }

    fun key(agent: String) = agent.lowercase().replace(Regex("[^a-z0-9._-]"), "_").take(64)

    fun fileFor(agent: String): File? = File(dir, key(agent) + ".webp").takeIf { versions.containsKey(key(agent)) && it.exists() }

    fun save(agent: String, square: Bitmap) {
        dir.mkdirs()
        val out = Bitmap.createScaledBitmap(square, 512, 512, true)
        val f = File(dir, key(agent) + ".webp")
        f.outputStream().use { out.compress(Bitmap.CompressFormat.WEBP_LOSSY, 90, it) }
        versions[key(agent)] = System.currentTimeMillis()
    }

    fun reset(agent: String) {
        File(dir, key(agent) + ".webp").delete()
        versions.remove(key(agent))
    }

    companion object {
        fun loadForCrop(context: Context, uri: Uri, maxEdge: Int = 1600): Bitmap {
            val cr = context.contentResolver
            val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            cr.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, b) }
            val opts = BitmapFactory.Options().apply { inSampleSize = ImageSizing.sampleSize(b.outWidth, b.outHeight, maxEdge) }
            return cr.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, opts) } ?: error("Couldn't read image")
        }

        fun cropSquare(src: Bitmap, left: Int, top: Int, size: Int): Bitmap {
            val out = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888)
            Canvas(out).drawBitmap(src, Rect(left, top, left + size, top + size), RectF(0f, 0f, 512f, 512f), Paint(Paint.FILTER_BITMAP_FLAG))
            return out
        }
    }
}

val LocalAvatarStore = staticCompositionLocalOf<AvatarStore?> { null }
