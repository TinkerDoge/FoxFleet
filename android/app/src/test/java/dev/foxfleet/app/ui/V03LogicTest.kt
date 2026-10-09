package dev.foxfleet.app.ui

import dev.foxfleet.app.data.ChatPayload
import dev.foxfleet.app.data.ImageAttachment
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.media.CropMath
import dev.foxfleet.app.media.ImageSizing
import dev.foxfleet.app.ui.chat.LocalCommand
import dev.foxfleet.app.ui.chat.MediaRef
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.chat.extractMedia
import dev.foxfleet.app.ui.chat.localCommandFor
import dev.foxfleet.app.ui.components.mergeDictation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V03LogicTest {
    private val img = ImageAttachment("/tmp/a.jpg", "data:image/jpeg;base64,AAAA", 3)

    @Test fun onlyNewestUserTurnCarriesImageBytes() {
        val history = listOf(
            UiMessage("user", "old", images = listOf(img)),
            UiMessage("assistant", "seen it"),
            UiMessage("user", "and this?", images = listOf(img, img)),
        )
        val arr = ChatPayload.messages(history)
        assertEquals("[image] old", arr[0].jsonObject["content"]!!.jsonPrimitive.content)
        val parts = arr[2].jsonObject["content"] as JsonArray
        assertEquals(3, parts.size)
        assertEquals("text", parts[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("image_url", parts[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(img.dataUrl, parts[1].jsonObject["image_url"]!!.jsonObject["url"]!!.jsonPrimitive.content)
    }

    @Test fun imageOnlyMessageHasNoEmptyTextPart() {
        val arr = ChatPayload.messages(listOf(UiMessage("user", "", images = listOf(img))))
        val parts = arr[0].jsonObject["content"]!!.jsonArray
        assertEquals(1, parts.size)
    }

    @Test fun textOnlyStaysAString() {
        val arr = ChatPayload.messages(listOf(UiMessage("user", "hi")))
        assertTrue(arr[0].jsonObject["content"] is JsonPrimitive)
    }

    @Test fun imageSizingRules() {
        assertEquals(2048 to 1536, ImageSizing.fit(4000, 3000))
        assertEquals(800 to 600, ImageSizing.fit(800, 600))
        assertEquals(1, ImageSizing.sampleSize(3000, 2000))
        assertEquals(2, ImageSizing.sampleSize(4096, 3072))
        assertEquals(4, ImageSizing.sampleSize(8192, 6000))
        assertTrue(ImageSizing.fitsBudget(1_800_000))
        assertFalse(ImageSizing.fitsBudget(1_900_000))
        assertTrue(ImageSizing.dataUrlLength(600_000) * 4 < ChatPayload.HUB_BODY_LIMIT)
    }

    @Test fun cropMath() {
        assertEquals(0.5f, CropMath.coverScale(600, 400, 200f), 0.0001f)
        assertEquals(50f, CropMath.clampOffset(80f, 600f, 0.5f, 200f), 0.0001f)
        assertEquals(0f, CropMath.clampOffset(30f, 400f, 0.5f, 200f), 0.0001f)
        val (l, t, s) = CropMath.sourceSquare(600, 400, 200f, 0.5f, 0f, 0f)
        assertEquals(Triple(100, 0, 400), Triple(l, t, s))
        val (l2, _, _) = CropMath.sourceSquare(600, 400, 200f, 0.5f, 50f, 0f)
        assertEquals(0, l2)
    }

    @Test fun slashAndHashSuggestions() {
        val skills = listOf("github-pr-workflow", "gaming-news", "render")
        assertTrue(commandSuggestions("/", skills).any { it.label == "/new" })
        assertEquals(listOf("/new"), commandSuggestions("/ne", skills).map { it.label })
        assertTrue(commandSuggestions("/g", skills).map { it.label }.containsAll(listOf("/github-pr-workflow", "/gaming-news")))
        assertEquals("#gaming-news", commandSuggestions("#gam", skills).first().label)
        assertTrue(commandSuggestions("#news", skills).any { it.label == "#gaming-news" })
        assertTrue(commandSuggestions("/new chat", skills).isEmpty())
        assertTrue(commandSuggestions("hello", skills).isEmpty())
        assertEquals(LocalCommand.New, localCommandFor(" /new "))
        assertNull(localCommandFor("/btw hi"))
    }

    @Test fun mediaExtraction() {
        val text = "Here: ![chart](https://x.io/c.png) and https://x.io/clip.mp4, also https://x.io/raw.jpg. Docs https://x.io/page"
        val m = extractMedia(text)
        assertEquals(listOf("https://x.io/clip.mp4" to MediaRef.Kind.Video, "https://x.io/raw.jpg" to MediaRef.Kind.Image), m.map { it.url to it.kind })
        assertEquals(3, extractMedia(text, includeInline = true).size)
    }

    @Test fun dictationMerge() {
        assertEquals("Hello there", mergeDictation("", "hello there"))
        assertEquals("Ask Atlas to check", mergeDictation("Ask Atlas", "to check"))
        assertEquals("Hi ", mergeDictation("Hi ", ""))
    }
}
