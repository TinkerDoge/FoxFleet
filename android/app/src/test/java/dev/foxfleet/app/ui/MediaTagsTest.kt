package dev.foxfleet.app.ui

import dev.foxfleet.app.ui.chat.MediaTags
import dev.foxfleet.app.ui.chat.TagMedia
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same vectors the hub and the web client pass (contract/media-tags.vectors.json). */
class MediaTagsTest {
    private fun vectors(): List<JsonObject> {
        var dir = java.io.File(System.getProperty("user.dir")).absoluteFile
        while (!java.io.File(dir, "contract/media-tags.vectors.json").exists()) dir = dir.parentFile ?: error("contract/media-tags.vectors.json not found")
        return Json.parseToJsonElement(java.io.File(dir, "contract/media-tags.vectors.json").readText()).jsonObject["vectors"]!!.jsonArray.map { it.jsonObject }
    }
    private fun kind(s: String) = when (s) { "image" -> TagMedia.Kind.Image; "video" -> TagMedia.Kind.Video; "audio" -> TagMedia.Kind.Audio; else -> TagMedia.Kind.File }

    @Test fun conformsToTheSharedVectors() {
        val failures = ArrayList<String>()
        for (v in vectors()) {
            val r = MediaTags.parse(v["input"]!!.jsonPrimitive.content)
            val want = v["media"]!!.jsonArray.map { it.jsonObject }.map { Triple(it["ref"]!!.jsonPrimitive.content, kind(it["kind"]!!.jsonPrimitive.content), it["voice"]?.jsonPrimitive?.boolean ?: false) }
            val got = r.media.map { Triple(it.ref, it.kind, it.voice) }
            if (r.text != v["text"]!!.jsonPrimitive.content || got != want) failures += "${v["name"]!!.jsonPrimitive.content}: text='${r.text}' media=$got"
        }
        assertTrue("vectors failed:\n" + failures.joinToString("\n"), failures.isEmpty())
    }
    @Test fun streamingHidesAnUnfinishedTag() {
        assertEquals("Here it is", MediaTags.parseStreaming("Here it is MEDIA:/tmp/ch").text)
        assertTrue(MediaTags.parseStreaming("Here it is MEDIA:/tmp/ch").media.isEmpty())
        assertEquals("Here", MediaTags.parseStreaming("Here [[audio_as").text)
        assertEquals(1, MediaTags.parseStreaming("Done MEDIA:/tmp/a.png\nmore").media.size)
    }
    @Test fun aHugeReplyIsBounded() { assertTrue(MediaTags.parse((0 until 5000).joinToString("\n") { "MEDIA:/tmp/f$it.png" }).media.size <= 24) }
}
