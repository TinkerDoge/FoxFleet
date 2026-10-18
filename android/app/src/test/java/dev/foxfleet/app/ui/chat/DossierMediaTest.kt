package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.local.AgentMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DossierMediaTest {
    private fun msgs(content: String, images: List<String> = emptyList()) =
        listOf(AgentMessage("s1", UiMessage("assistant", content, id = "1", imageUrls = images)))

    @Test fun aPictureGoesToMediaNotFiles() {
        val m = msgs("See this\nMEDIA:/tmp/pic.png")
        val refs = DossierMedia.refs("sumi", m)
        assertEquals(1, refs.size)
        assertEquals(MediaRef.Kind.Image, refs[0].kind)
        assertTrue(DossierMedia.files("sumi", m).isEmpty())
        assertTrue(DossierMedia.links(m).isEmpty())
    }

    @Test fun aPdfGoesToFiles() {
        val m = msgs("Here\nMEDIA:/tmp/report.pdf")
        assertEquals("report.pdf", DossierMedia.files("sumi", m).single().name)
        assertTrue(DossierMedia.refs("sumi", m).isEmpty())
    }

    @Test fun aBareHttpLinkGoesToLinks() {
        val m = msgs("Read https://indc.io.vn/notes")
        assertEquals("https://indc.io.vn/notes", DossierMedia.links(m).single().url)
        assertTrue(DossierMedia.refs("sumi", m).isEmpty())
        assertTrue(DossierMedia.files("sumi", m).isEmpty())
    }

    @Test fun anImageUrlDoesNotCountAsALink() {
        val m = msgs("https://example.com/a.png")
        assertTrue(DossierMedia.links(m).isEmpty())
        assertEquals(1, DossierMedia.refs("sumi", m).size)
    }
}
