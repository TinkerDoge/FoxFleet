package dev.foxfleet.app.media

import java.nio.file.Files
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class MediaSourceTest {
    @Test fun `thumbnail and viewer fall back to sent bytes after eviction`() {
        val missing = Files.createTempDirectory("attachment").resolve("gone.jpg").toFile()
        assertEquals("data:image/jpeg;base64,YQ==", attachmentSource(missing.path, "data:image/jpeg;base64,YQ=="))
        missing.writeText("photo")
        assertEquals(missing.toURI().toString(), attachmentSource(missing.path, "data:fallback"))
    }
    @Test fun `media credentials only follow the exact hub origin`() {
        val hub = "https://hub.example:443".toHttpUrl()
        assertTrue(sameMediaOrigin("https://hub.example/api/media/1".toHttpUrl(), hub))
        assertFalse(sameMediaOrigin("http://hub.example/api/media/1".toHttpUrl(), hub))
        assertFalse(sameMediaOrigin("https://hub.example:444/api/media/1".toHttpUrl(), hub))
        assertFalse(sameMediaOrigin("https://hub.example.evil.test/image.jpg".toHttpUrl(), hub))
    }
}
