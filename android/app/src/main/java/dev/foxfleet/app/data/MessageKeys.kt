package dev.foxfleet.app.data

/**
 * Stable identity for message rows, independent of their position: the LazyColumn key and the cache key.
 * The hub id when there is one; otherwise role + time + a content hash, made unique by counting repeats from the
 * NEWEST end (so prepending older pages never changes the key of a message already on screen).
 */
object MessageKeys {
    fun base(m: UiMessage): String = m.id?.let { "id:$it" } ?: "c:${m.role}:${m.ts}:${hash(m.content + "\u0000" + m.reasoning)}"

    /** Keys for a chronological list, in the same order. */
    fun keys(messages: List<UiMessage>): List<String> {
        val out = ArrayList<String>(messages.size); val seen = HashMap<String, Int>()
        for (i in messages.indices.reversed()) {
            val b = base(messages[i]); val n = seen.getOrDefault(b, 0); seen[b] = n + 1
            out.add(if (n == 0) b else "$b#$n")
        }
        out.reverse(); return out
    }

    private fun hash(s: String): String {
        var h = -0x340d631b7bdddcdbL // FNV-1a 64
        for (ch in s) { h = h xor ch.code.toLong(); h *= 0x100000001b3L }
        return java.lang.Long.toHexString(h)
    }
}

/** What a message row draws: the LazyColumn contentType (rows of one kind reuse each other's layout) and the cached kind. */
object MessageKinds {
    const val USER = "user"
    const val USER_MEDIA = "user_media"
    const val ASSISTANT = "assistant"
    /** An assistant turn with a reasoning block or tool steps (taller, different layout). */
    const val ASSISTANT_RICH = "assistant_rich"
    const val ASSISTANT_MEDIA = "assistant_media"

    fun of(m: UiMessage): String {
        val media = m.imageUrls.isNotEmpty() || m.images.isNotEmpty() || m.content.contains("MEDIA:")
        return when {
            m.role == "user" -> if (media) USER_MEDIA else USER
            media -> ASSISTANT_MEDIA
            m.reasoning.isNotBlank() || m.steps.isNotEmpty() || m.tools.isNotEmpty() -> ASSISTANT_RICH
            else -> ASSISTANT
        }
    }
}
