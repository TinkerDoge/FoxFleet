package dev.foxfleet.app.ui.chat

/**
 * MEDIA: tags as Hermes writes them for Telegram (gateway/platforms/base.py: MEDIA_TAG_CLEANUP_RE, extract_media).
 * Kotlin twin of server/media-tags.js and web/src/lib/mediaTags.ts; contract/media-tags.vectors.json pins all three.
 * Pure text in, text out: nothing here touches the disk or the network.
 */
data class TagMedia(val ref: String, val kind: Kind, val name: String, val voice: Boolean = false) {
    enum class Kind { Image, Video, Audio, File }
}
data class ParsedMedia(val text: String, val media: List<TagMedia>, val react: String? = null)

object MediaTags {
    private val imageExts = listOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "avif")
    private val videoExts = listOf("mp4", "mov", "webm", "mkv", "avi", "3gp", "m4v")
    private val audioExts = listOf("mp3", "m2a", "wav", "ogg", "opus", "m4a", "flac", "aac")
    private val fileExts = listOf("pdf", "docx", "doc", "odt", "rtf", "txt", "md", "epub", "xlsx", "xls", "ods", "csv", "tsv", "pptx", "ppt", "odp", "zip", "tar", "gz", "tgz", "7z", "kml", "kmz", "gpx", "geojson")
    private val known = (imageExts + videoExts + audioExts + fileExts + listOf("svg", "tiff", "html", "htm", "json", "xml", "yaml", "yml", "rar", "bz2", "xz", "apk", "ipa", "key", "log", "py", "sh", "ts")).sortedByDescending { it.length }.joinToString("|")
    private const val TERM = """[\s`"'*_,;:)\]}\[（）〈〉《》：，。；！？、\u201c\u201d\u2018\u2019【】]"""
    private const val ANCHOR = """(?:~/|/|[A-Za-z]:[/\\]|https?://)"""
    private val knownTag = Regex("""[`"'*_]{0,3}MEDIA:\s*(`[^`\n]+?`|"[^"\n]+?"|'[^'\n]+?'|$ANCHOR\S+?(?:[^\S\n]+\S+?)*?\.(?:$known))(?=$TERM|MEDIA:|\.(?:\s|$)|$)[`"'*_]{0,3}\.?""", RegexOption.IGNORE_CASE)
    private val bareTag = Regex("""[`"'*_]{0,3}MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|$ANCHOR[^\s`"']+?)(?=[`"'\s,;:)\]}]|MEDIA:|$)[`"'*_]{0,3}""", RegexOption.IGNORE_CASE)
    private val mdDataImg = Regex("""!\[[^\]\n]*]\(\s*(data:image/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]{16,4000000})\s*\)""")
    private val mdLocalImg = Regex("""!\[[^\]\n]*]\(\s*((?:~/|/|[A-Za-z]:[/\\])[^)\s]+)\s*\)""")
    private val mdLinkMedia = Regex("""\[[^\]\n]*]\(\s*(https?://[^)\s]+)\s*\)|(?<![(\w/"'=])(https?://[^\s<>)"'\]]+)""")
    private val fence = Regex("""(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)""")
    private val quote = Regex("""(^|\n)([ \t]*>[^\n]*)""")
    private val inlineCode = Regex("""(?<!MEDIA:\s{0,3})(`+)(?!`)([^\n]*?[^`\n])\1(?!`)""")
    private const val MAX_TAGS = 24

    private fun blank(s: String) = s.replace(Regex("[^\\n]"), " ")
    private fun mask(text: String): String {
        var m = fence.replace(text) { blank(it.value) }
        m = quote.replace(m) { it.groupValues[1] + blank(it.groupValues[2]) }
        return inlineCode.replace(m) { blank(it.value) }
    }

    // REACT: <one emoji> on its own line is the agent's reaction to the user's message. The hub applies it; the apps never show the line.
    private val reactLine = Regex("^[ \\t]*REACT:[ \\t]*([^ \\t\\r\\n]{1,32})[ \\t]*$", RegexOption.MULTILINE)
    private val partialReact = Regex("(?:^|\\n)[ \\t]*R(?:E(?:A(?:C(?:T(?::[^\\n]*)?)?)?)?)?$")
    /** Emoji-shaped: no ASCII letters and at least one code point from U+2000 up (same rule as the hub). */
    fun emojiShaped(s: String) = s.none { it in 'A'..'Z' || it in 'a'..'z' } && s.codePoints().anyMatch { it >= 0x2000 }
    /** The text with REACT: lines removed, and the first one's token. Lines in code or quotes stay. */
    fun takeReact(input: String): Pair<String, String?> {
        if (!input.contains("REACT:")) return input to null
        val scan = mask(input); val spans = ArrayList<IntArray>(); var react: String? = null
        for (m in reactLine.findAll(scan)) {
            val tok = m.groupValues[1]; if (!emojiShaped(tok)) continue
            if (react == null) react = tok
            val end = m.range.last + 1 // `$` stops before \r in CRLF text
            val nl = if (input.startsWith("\r\n", end)) 2 else if (end < input.length && input[end] == '\n') 1 else 0
            spans += intArrayOf(m.range.first, end + nl)
        }
        if (spans.isEmpty()) return input to null
        var out = input; for (s in spans.asReversed()) out = out.substring(0, s[0]) + out.substring(s[1])
        return out.replace(Regex("[ \\t]+\\n"), "\n").replace(Regex("\\n{3,}"), "\n\n").trim() to react
    }
    private fun normalize(raw: String?): String {
        var p = (raw ?: "").trim()
        if (p.length >= 2 && p[0] == p.last() && p[0] in "`\"'") p = p.substring(1, p.length - 1).trim()
        return p.trimStart('`', '"', '\'').trimEnd('`', '"', '\'', ',', '.', ';', ':', ')', '}', ']')
    }
    fun isUrl(ref: String) = Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(ref)
    private fun pathOf(ref: String): String = if (isUrl(ref)) runCatching { java.net.URLDecoder.decode(java.net.URI(ref).rawPath ?: "", "UTF-8") }.getOrElse { ref.split('?', '#')[0] } else ref.split('?', '#')[0]
    fun isData(ref: String) = ref.startsWith("data:image/", ignoreCase = true)
    fun kindOf(ref: String): TagMedia.Kind {
        if (isData(ref)) return TagMedia.Kind.Image
        val e = Regex("""\.([A-Za-z0-9]{1,8})$""").find(pathOf(ref))?.groupValues?.get(1)?.lowercase() ?: ""
        return when (e) { in imageExts -> TagMedia.Kind.Image; in videoExts -> TagMedia.Kind.Video; in audioExts -> TagMedia.Kind.Audio; else -> TagMedia.Kind.File }
    }
    fun nameOf(ref: String): String = if (isData(ref)) "image" else pathOf(ref).split('/', '\\').lastOrNull { it.isNotEmpty() }?.replace(Regex("[\\u0000-\\u001f\\u007f]"), "")?.take(120)?.ifEmpty { null } ?: "file"

    fun parse(input: String): ParsedMedia {
        val (text, react) = takeReact(input)
        if (!text.contains("MEDIA:") && !text.contains("[[") && !text.contains("](") && !text.contains("http") && !text.contains("data:image")) return ParsedMedia(text, emptyList(), react)
        val voice = text.contains("[[audio_as_voice]]"); val asDoc = text.contains("[[as_document]]")
        val scan = mask(text); val spans = ArrayList<IntArray>(); val media = ArrayList<TagMedia>(); val seen = HashSet<String>()
        fun add(raw: String?, span: IntArray?, strip: Boolean = true, onlyAv: Boolean = false): Boolean {
            val ref = if (raw != null && isData(raw)) raw else normalize(raw); if (ref.isEmpty() || (ref.length > 2000 && !isData(ref)) || Regex("[\\u0000-\\u0008\\u000e-\\u001f]").containsMatchIn(ref)) return false
            if (strip && span != null) spans.add(span)
            val kind = kindOf(ref); if (onlyAv && kind != TagMedia.Kind.Video && kind != TagMedia.Kind.Audio) return false
            if (seen.add(ref) && media.size < MAX_TAGS) media.add(TagMedia(ref, if (asDoc && kind == TagMedia.Kind.Image) TagMedia.Kind.File else kind, nameOf(ref), voice && kind == TagMedia.Kind.Audio))
            return true
        }
        fun taken(a: Int, b: Int) = spans.any { a < it[1] && b > it[0] }
        for (m in knownTag.findAll(scan)) add(m.groupValues[1], intArrayOf(m.range.first, m.range.last + 1))
        for (m in bareTag.findAll(scan)) { val a = m.range.first; val b = m.range.last + 1; if (taken(a, b)) continue; add(m.groupValues[1], intArrayOf(a, b)) }
        for (m in mdDataImg.findAll(scan)) { val a = m.range.first; val b = m.range.last + 1; if (!taken(a, b)) add(m.groupValues[1], intArrayOf(a, b)) }
        for (m in mdLocalImg.findAll(scan)) { val a = m.range.first; val b = m.range.last + 1; if (!taken(a, b)) add(m.groupValues[1], intArrayOf(a, b)) }
        for (m in mdLinkMedia.findAll(scan)) { val a = m.range.first; val b = m.range.last + 1; if (!taken(a, b)) add(m.groupValues[1].ifEmpty { m.groupValues[2] }, null, strip = false, onlyAv = true) }
        var out = text
        for (s in spans.sortedByDescending { it[0] }) out = out.substring(0, s[0]) + out.substring(s[1])
        out = out.replace("[[audio_as_voice]]", "").replace("[[as_document]]", "")
        if (spans.isNotEmpty() || voice || asDoc) out = out.replace(Regex("[ \\t]+\\n"), "\n").replace(Regex("\\n{3,}"), "\n\n").trim()
        return ParsedMedia(out, media, react)
    }

    /** While a reply streams, a tag (or a line that may become REACT:) is held back until its line is finished (a spaced path may still grow). */
    fun parseStreaming(input: String): ParsedMedia {
        val cut = listOfNotNull(Regex("""[`"'*_]{0,3}MEDIA:[^\n]*$""", RegexOption.IGNORE_CASE).find(input)?.range?.first, partialReact.find(input)?.range?.first).minOrNull() ?: -1
        val r = parse(if (cut >= 0) input.substring(0, cut) else input)
        return r.copy(text = r.text.replace(Regex("""\[\[[a-z_]*]?$"""), "").trimEnd())
    }
}

/** Helpers the cards use without depending on the parser's internals. */
object TagMediaData { fun isData(ref: String) = MediaTags.isData(ref) }
