package dev.foxfleet.app.media

import dev.foxfleet.app.ui.chat.MediaRef
import org.junit.Assert.assertEquals
import org.junit.Test

class MediaStoreSaverTest {
    private fun plan(kind: MediaRef.Kind?, alt: String?, ref: String?, mime: String? = null) =
        MediaStoreSaver.plan(kind, alt, ref, mime, nowEpoch = 1700000000123)

    @Test fun `image saves to Pictures, video to Movies, files to Downloads`() {
        assertEquals(MediaStoreSaver.Collection.Pictures, plan(MediaRef.Kind.Image, "chart.png", null).collection)
        assertEquals(MediaStoreSaver.Collection.Movies, plan(MediaRef.Kind.Video, "clip.mp4", null).collection)
        assertEquals(MediaStoreSaver.Collection.Downloads, plan(null, "notes.pdf", null).collection)
        assertEquals("Pictures/FoxFleet", plan(MediaRef.Kind.Image, "chart.png", null).relativePath)
        assertEquals("Movies/FoxFleet", plan(MediaRef.Kind.Video, "clip.mp4", null).relativePath)
        assertEquals("Download/FoxFleet", plan(null, "notes.pdf", null).relativePath)
    }

    @Test fun `a filename alt becomes the display name and drives the mime`() {
        val p = plan(MediaRef.Kind.Image, "photo.PNG", null)
        assertEquals("photo.PNG", p.displayName)
        assertEquals("image/png", p.mimeType)
    }

    @Test fun `alt without an extension falls back to a generated name from the ref`() {
        val p = plan(MediaRef.Kind.Image, "A picture", "https://cdn.example/x.jpg")
        assertEquals("foxfleet-1700000000123.jpg", p.displayName)
        assertEquals("image/jpeg", p.mimeType)
    }

    @Test fun `unknown extension and no alt default by kind`() {
        val v = plan(MediaRef.Kind.Video, null, null)
        assertEquals("foxfleet-1700000000123.mp4", v.displayName)
        assertEquals("video/mp4", v.mimeType)
        val f = plan(null, null, null)
        assertEquals("application/octet-stream", f.mimeType)
    }

    @Test fun `an explicit mime wins over the guessed one`() {
        assertEquals("application/pdf", plan(MediaRef.Kind.Image, "scan.png", null, "application/pdf").mimeType)
    }

    @Test fun `a path separator in the alt means it is not a filename`() {
        val p = plan(MediaRef.Kind.Image, "a/b.png", "c/d.png")
        assertEquals("foxfleet-1700000000123.png", p.displayName)
    }
}
