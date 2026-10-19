package dev.foxfleet.app.data

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import dev.foxfleet.app.ui.Tokens
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

enum class BgMode { Default, Solid, Pattern, Image }

/** The look of one chat. [solid] is a preset id ("" = the app background); [image] says a picture is stored for this chat. */
data class ChatBg(
    val mode: BgMode = BgMode.Default,
    val solid: String = "",
    val pattern: String = Tokens.ChatBackgrounds.patterns.first().id,
    val blur: Int = 0,
    val dim: Float = Tokens.ChatBackgrounds.dimDefault,
    val image: Boolean = false,
) {
    val isDefault get() = mode == BgMode.Default

    companion object {
        /** Untrusted stored values become a valid setting: unknown ids fall back, numbers are clamped, image mode without a picture is dropped. */
        fun normalize(mode: String?, solid: String?, pattern: String?, blur: Int?, dim: Float?, image: Boolean?): ChatBg {
            val s = Tokens.ChatBackgrounds.solids.firstOrNull { it.id == solid }?.id ?: ""
            val p = Tokens.ChatBackgrounds.patterns.firstOrNull { it.id == pattern }?.id ?: Tokens.ChatBackgrounds.patterns.first().id
            val img = image == true
            var m = BgMode.entries.firstOrNull { it.name.equals(mode, ignoreCase = true) } ?: BgMode.Default
            if (m == BgMode.Solid && s.isEmpty()) m = BgMode.Default
            if (m == BgMode.Image && !img) m = BgMode.Default
            val d = (dim ?: Tokens.ChatBackgrounds.dimDefault).let { if (it.isNaN()) 0f else it }.coerceIn(0f, Tokens.ChatBackgrounds.dimMax)
            return ChatBg(m, s, p, (blur ?: 0).coerceIn(0, Tokens.ChatBackgrounds.blurMax), Math.round(d * 100) / 100f, img)
        }
    }
}

/** True only when some pixel is not fully opaque (an RGBA PNG with no transparent pixel is still stored as a small JPEG). */
fun usesAlpha(bmp: Bitmap): Boolean {
    if (!bmp.hasAlpha()) return false
    val row = IntArray(bmp.width)
    for (y in 0 until bmp.height) { bmp.getPixels(row, 0, bmp.width, 0, y, bmp.width, 1); if (row.any { (it ushr 24) != 255 }) return true }
    return false
}

enum class Claim { Adopted, Kept, Cleared }

/** Owner identity: a stable account id (not the display name) plus the hub address, both normalised, then hashed so no address sits in the preferences. */
object ChatBgOwner {
    fun normalizeHub(hub: String): String {
        var t = hub.trim(); if (t.isEmpty()) return ""
        if (!t.contains("://")) t = "https://$t"
        val u = t.toHttpUrlOrNull() ?: return t.lowercase().trimEnd('/')
        val port = if (u.port == (if (u.scheme == "https") 443 else 80)) "" else ":${u.port}"
        val host = if (u.host.contains(':')) "[${u.host}]" else u.host
        return "${u.scheme}://$host$port${u.encodedPath.trimEnd('/')}".lowercase()
    }
    fun key(accountId: String?, hub: String): String {
        val raw = (accountId?.trim().takeUnless { it.isNullOrEmpty() } ?: "anonymous") + "@" + normalizeHub(hub)
        return MessageDigest.getInstance("SHA-256").digest(raw.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

object ChatBgSizing {
    /** Largest size that fits [max] on the long edge, keeping the aspect (never upscales). */
    fun fit(w: Int, h: Int, max: Int = Tokens.ChatBackgrounds.maxEdge): Pair<Int, Int> {
        val s = minOf(1f, max.toFloat() / maxOf(w, h))
        return maxOf(1, Math.round(w * s)) to maxOf(1, Math.round(h * s))
    }
    /** BitmapFactory sample size so the decoded picture is not much bigger than [max]. */
    fun sampleSize(w: Int, h: Int, max: Int = Tokens.ChatBackgrounds.maxEdge): Int { var s = 1; while (maxOf(w, h) / (s * 2) >= max) s *= 2; return s }
}

/**
 * Per-agent backgrounds, kept on this phone only: settings in app-private SharedPreferences, the (downscaled JPEG) picture in
 * app-private files. Nothing is sent to the hub. One look per agent, shared by every chat of that agent.
 */
class ChatBackgroundStore(private val prefs: SharedPreferences, private val dir: File) {
    constructor(context: Context) : this(context.getSharedPreferences("foxfleet_chat_bg", Context.MODE_PRIVATE), File(context.filesDir, "chat-bg"))

    /** The key is the agent id alone: every session of an agent reads and writes the same look. */
    fun key(agent: String) = agent
    /**
     * A room has its own look, in a namespace agents can never occupy (agent ids are [A-Za-z0-9._-], no colon).
     * Never pass this to [key] or the other way around: a room look must not land on a member agent's DM.
     */
    fun roomKey(conversationId: String) = "room:$conversationId"
    fun isRoomKey(key: String) = key.startsWith("room:")
    private val OWNER = "owner"
    private fun pk(key: String) = "bg." + key
    fun imageFile(key: String) = File(dir, MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }.take(32) + ".jpg")

    private fun read(key: String): ChatBg? {
        val raw = prefs.getString(pk(key), null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            ChatBg.normalize(o.optString("mode"), o.optString("solid"), o.optString("pattern"), o.optInt("blur", 0), o.optDouble("dim", Tokens.ChatBackgrounds.dimDefault.toDouble()).toFloat(), o.optBoolean("image", false))
                .let { if (it.image && !imageFile(key).exists()) it.copy(image = false, mode = if (it.mode == BgMode.Image) BgMode.Default else it.mode) else it }
        }.getOrNull()
    }

    fun load(key: String): ChatBg = read(key) ?: migrateLegacy(key) ?: ChatBg()

    /**
     * One-off move from the old per-chat keys (`agent\u0000session`) to the agent-only key. Copies the agent's most recently used
     * per-chat look (an entry with a picture wins) and leaves the old keys in place rather than wiping the preferences.
     */
    private fun migrateLegacy(agent: String): ChatBg? {
        val prefix = "bg." + agent + "\u0000"
        val legacy = prefs.all.keys.filter { it.startsWith(prefix) }
            .mapNotNull { pkey -> read(pkey.removePrefix("bg."))?.let { bg -> if (bg.isDefault && !bg.image) null else pkey.removePrefix("bg.") to bg } }
        if (legacy.isEmpty()) return null
        val (from, fromBg) = legacy.firstOrNull { it.second.image } ?: legacy.last()
        var out = fromBg
        if (fromBg.image) {
            val src = imageFile(from)
            if (src.exists()) { dir.mkdirs(); src.copyTo(imageFile(agent), overwrite = true) } else out = fromBg.copy(image = false, mode = if (fromBg.mode == BgMode.Image) BgMode.Default else fromBg.mode)
        }
        save(agent, out); return out
    }

    fun save(key: String, bg: ChatBg) {
        if (bg.isDefault && !bg.image) { prefs.edit().remove(pk(key)).apply(); return }
        val o = JSONObject().put("mode", bg.mode.name).put("solid", bg.solid).put("pattern", bg.pattern).put("blur", bg.blur).put("dim", bg.dim.toDouble()).put("image", bg.image)
        prefs.edit().putString(pk(key), o.toString()).apply()
    }

    /** Decode, orient and downscale a picked picture (long edge 1600 px), store it as JPEG. Returns false when it isn't a usable image. */
    fun savePicked(context: Context, key: String, uri: Uri): Boolean = runCatching {
        val cr = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth > 0 && bounds.outHeight > 0)
        val opts = BitmapFactory.Options().apply { inSampleSize = ChatBgSizing.sampleSize(bounds.outWidth, bounds.outHeight) }
        var bmp = cr.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, opts) } ?: error("unreadable")
        val rotation = runCatching { cr.openInputStream(uri).use { ExifInterface(it!!).rotationDegrees } }.getOrDefault(0)
        if (rotation != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
        val (w, h) = ChatBgSizing.fit(bmp.width, bmp.height)
        if (w != bmp.width || h != bmp.height) bmp = Bitmap.createScaledBitmap(bmp, w, h, true)
        writeImage(key, bmp); true
    }.getOrDefault(false)

    /** A picture with real transparency stays PNG (it would turn black as JPEG); everything else is JPEG. The decoder reads either from the same file. */
    fun writeImage(key: String, bmp: Bitmap) {
        dir.mkdirs(); val f = imageFile(key); val tmp = File(dir, f.name + ".tmp")
        val alpha = usesAlpha(bmp)
        tmp.outputStream().use { if (alpha) bmp.compress(Bitmap.CompressFormat.PNG, 100, it) else bmp.compress(Bitmap.CompressFormat.JPEG, Tokens.ChatBackgrounds.quality, it) }
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }

    fun loadBitmap(key: String): Bitmap? = imageFile(key).takeIf { it.exists() }?.let { runCatching { BitmapFactory.decodeFile(it.path) }.getOrNull() }

    /** Reset to default: the setting and the stored picture both go. */
    fun reset(key: String) { prefs.edit().remove(pk(key)).apply(); imageFile(key).delete() }

    /**
     * Called once a session is signed in (never on sign-out). Backgrounds belong to one account on one hub: nothing stored (or older data
     * with no owner) = adopt, same owner = keep, a different account or hub = clear settings and pictures before anything is drawn.
     * Returns what happened.
     */
    fun claimOwner(owner: String): Claim {
        val had = prefs.getString(OWNER, null)
        if (had == owner) return Claim.Kept
        if (had == null) { prefs.edit().putString(OWNER, owner).apply(); return Claim.Adopted }
        clearAll(); prefs.edit().putString(OWNER, owner).apply(); return Claim.Cleared
    }

    /** Wipes every background and picture (a different account or hub took over this phone). */
    fun clearAll() { prefs.edit().apply { prefs.all.keys.filter { it.startsWith("bg.") }.forEach { remove(it) } }.apply(); dir.listFiles()?.forEach { it.delete() } }
}
