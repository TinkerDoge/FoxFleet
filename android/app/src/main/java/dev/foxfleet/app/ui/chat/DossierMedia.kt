package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.local.AgentMessage

/**
 * Media a chat's messages point to, in conversation order, for the swipe viewer (0.4.3 C3).
 *
 * Cache-backed refs carry [MediaRef.agent] + [MediaRef.ref] + the same [MediaRef.instance] the chat row used
 * (`sessionId + ":" + message identity`), so a warm open hits the on-disk `.media` file instead of downloading.
 * Bare image URLs from `imageUrls` or the reply text get no cache identity and are fetched by their URL.
 *
 * Pure: no disk and no network, so it is covered by an ordinary JVM test.
 */
object DossierMedia {
    /** The instance key the chat rows use for a message's media (`sessionId:msgId`). */
    fun instance(sessionId: String, m: UiMessage): String = sessionId + ":" + (m.id ?: "${m.ts}:${m.content.hashCode()}")

    private fun key(agent: String, ref: String) = "media:$agent\u0000$ref"

    /** Image and video refs of one conversation (chronological). */
    fun refs(agent: String, sessionId: String, messages: List<UiMessage>): List<MediaRef> {
        val out = LinkedHashMap<String, MediaRef>()
        for (m in messages) {
            m.imageUrls.forEach { u -> out.putIfAbsent("url:$u", MediaRef(u, MediaRef.Kind.Image)) }
            val parsed = MediaTags.parse(m.content)
            parsed.media.forEach { t ->
                if (t.kind == TagMedia.Kind.Image || t.kind == TagMedia.Kind.Video) {
                    val kind = if (t.kind == TagMedia.Kind.Video) MediaRef.Kind.Video else MediaRef.Kind.Image
                    out.putIfAbsent(key(agent, t.ref), MediaRef("", kind, t.name, agent, t.ref, instance(sessionId, m)))
                }
            }
            extractMedia(parsed.text).forEach { r -> out.putIfAbsent("url:${r.url}", r) }
        }
        return out.values.toList()
    }

    /** Image and video refs of every cached conversation of one agent (the dossier grid). */
    fun refs(agent: String, messages: List<AgentMessage>): List<MediaRef> {
        val out = LinkedHashMap<String, MediaRef>()
        for (cm in messages) for (r in refs(agent, cm.chatId, listOf(cm.message))) {
            val k = if (r.ref != null) key(agent, r.ref) else "url:${r.url}"
            out.putIfAbsent(k, r)
        }
        return out.values.toList()
    }

    /** Whether two refs point at the same media (cache identity first, then URL). Used to find a tap in the list. */
    fun matches(a: MediaRef, b: MediaRef): Boolean =
        if (a.ref != null && b.ref != null) a.ref == b.ref && a.agent == b.agent else a.url == b.url
}
