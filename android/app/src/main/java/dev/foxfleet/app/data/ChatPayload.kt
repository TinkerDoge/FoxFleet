package dev.foxfleet.app.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Builds the OpenAI-style `messages` array the hub relays to Hermes.
 * Only the newest user turn carries image bytes; older images collapse to "[image]" so a
 * conversation with photos never re-uploads them and stays under the hub's 4 MB body limit.
 */
object ChatPayload {
    fun messages(history: List<UiMessage>): JsonArray {
        val lastUserWithImages = history.indexOfLast { it.role == "user" && it.images.isNotEmpty() }
        val lastUser = history.indexOfLast { it.role == "user" }
        return buildJsonArray {
            history.forEachIndexed { i, m ->
                add(buildJsonObject {
                    put("role", m.role)
                    if (m.images.isEmpty()) put("content", m.content)
                    else if (i == lastUserWithImages && i == lastUser) put("content", buildJsonArray {
                        if (m.content.isNotBlank()) add(buildJsonObject { put("type", "text"); put("text", m.content) })
                        m.images.forEach { img ->
                            add(buildJsonObject {
                                put("type", "image_url")
                                putJsonObject("image_url") { put("url", img.dataUrl) }
                            })
                        }
                    })
                    else put("content", JsonPrimitive((m.images.joinToString(" ") { "[image]" } + " " + m.content).trim()))
                })
            }
        }
    }

    /** Rough JSON size of the request so the composer can refuse before the hub does. */
    fun estimatedBytes(history: List<UiMessage>): Int = messages(history).toString().length

    const val HUB_BODY_LIMIT = 4 * 1024 * 1024
    /** Per-image budget for the base64 data URL (about 2.5 MB). */
    const val IMAGE_BUDGET = 2_500_000
}
