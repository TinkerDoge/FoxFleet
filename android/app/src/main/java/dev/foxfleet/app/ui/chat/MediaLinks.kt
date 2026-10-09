package dev.foxfleet.app.ui.chat

/** Media an agent reply points to, shown as tappable cards under the message. */
data class MediaRef(val url: String, val kind: Kind, val alt: String = "") {
    enum class Kind { Image, Video }
}

private val mdImage = Regex("""!\[([^\]]*)]\((\S+?)(?:\s+"[^"]*")?\)""")
private val bareUrl = Regex("""(?<![(\[])\bhttps?://[^\s)<>"']+""")
private val imageExt = Regex("""\.(png|jpe?g|gif|webp|avif|bmp)(\?\S*)?$""", RegexOption.IGNORE_CASE)
private val videoExt = Regex("""\.(mp4|webm|mov|m4v|mkv)(\?\S*)?$""", RegexOption.IGNORE_CASE)

fun mediaKind(url: String): MediaRef.Kind? = when {
    videoExt.containsMatchIn(url) -> MediaRef.Kind.Video
    imageExt.containsMatchIn(url) || url.startsWith("data:image/") -> MediaRef.Kind.Image
    else -> null
}

/**
 * Videos (markdown links or bare URLs) and bare image URLs. Markdown `![]()` images are drawn
 * inline by the markdown renderer, so they're only returned when [includeInline] is set.
 */
fun extractMedia(text: String, includeInline: Boolean = false, limit: Int = 6): List<MediaRef> {
    val out = LinkedHashMap<String, MediaRef>()
    mdImage.findAll(text).forEach { m ->
        val url = m.groupValues[2]
        val kind = mediaKind(url) ?: MediaRef.Kind.Image
        if (includeInline || kind == MediaRef.Kind.Video) out.putIfAbsent(url, MediaRef(url, kind, m.groupValues[1]))
    }
    val inlineUrls = mdImage.findAll(text).map { it.groupValues[2] }.toSet()
    bareUrl.findAll(text).forEach { m ->
        val url = m.value.trimEnd('.', ',', ';', ':', '!', '?')
        if (url in inlineUrls) return@forEach
        mediaKind(url)?.let { out.putIfAbsent(url, MediaRef(url, it)) }
    }
    return out.values.take(limit)
}
