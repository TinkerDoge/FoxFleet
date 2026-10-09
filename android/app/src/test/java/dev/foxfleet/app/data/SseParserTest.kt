package dev.foxfleet.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SseParserTest {

    private data class Ev(val event: String, val data: String)

    private fun collect(chunks: List<String>): MutableList<Ev> {
        val out = mutableListOf<Ev>()
        val parser = SseParser(onEvent = { e -> out.add(Ev(e.event, e.data)); true })
        for (c in chunks) parser.feed(c)
        parser.end()
        return out
    }

    @Test
    fun `basic data line dispatches on blank line`() {
        val out = collect(listOf("data: hello\n\n"))
        assertEquals(listOf(Ev("message", "hello")), out)
    }

    @Test
    fun `multi data lines join with newline`() {
        val out = collect(listOf("data: a\ndata: b\n\n"))
        assertEquals(listOf(Ev("message", "a\nb")), out)
    }

    @Test
    fun `event field sets event name`() {
        val out = collect(listOf("event: hermes.tool.progress\ndata: {\"tool\":\"x\"}\n\n"))
        assertEquals(listOf(Ev("hermes.tool.progress", "{\"tool\":\"x\"}")), out)
    }

    @Test
    fun `colon without space is valid`() {
        val out = collect(listOf("data:{\"a\":1}\n\n"))
        assertEquals(listOf(Ev("message", "{\"a\":1}")), out)
    }

    @Test
    fun `comment lines are ignored`() {
        val out = collect(listOf(": keep-alive\ndata: x\n\n"))
        assertEquals(listOf(Ev("message", "x")), out)
    }

    @Test
    fun `crlf boundaries`() {
        val out = collect(listOf("data: x\r\n\r\n"))
        assertEquals(listOf(Ev("message", "x")), out)
    }

    @Test
    fun `chunk boundary splits a line`() {
        val out = collect(listOf("data: hel", "lo\n\n"))
        assertEquals(listOf(Ev("message", "hello")), out)
    }

    @Test
    fun `chunk boundary splits a CRLF pair`() {
        // "\r" arrives alone at end of chunk — must be deferred, not treated as a full line end
        val out = collect(listOf("data: x\r", "\n\ndata: y\n\n"))
        assertEquals(listOf(Ev("message", "x"), Ev("message", "y")), out)
    }

    @Test
    fun `chunk boundary inside CRLF before dispatch`() {
        val out = collect(listOf("data: x\n\r", "\n"))
        assertEquals(listOf(Ev("message", "x")), out)
    }

    @Test
    fun `field without colon is field only`() {
        val out = collect(listOf("event\n\n")) // dispatch with no data → nothing
        assertTrue(out.isEmpty())
    }

    @Test
    fun `returning false stops the parser`() {
        val out = mutableListOf<Ev>()
        var first = true
        val parser = SseParser(onEvent = { e ->
            out.add(Ev(e.event, e.data))
            if (e.data == "[DONE]") false else true
        })
        parser.feed("data: one\n\ndata: [DONE]\n\ndata: two\n\n")
        assertEquals(listOf(Ev("message", "one"), Ev("message", "[DONE]")), out)
        assertTrue(parser.isStopped)
    }

    @Test
    fun `stream ends without trailing blank line still dispatches`() {
        val out = collect(listOf("data: tail"))
        assertEquals(listOf(Ev("message", "tail")), out)
    }

    @Test(expected = IllegalStateException::class)
    fun `oversized event throws`() {
        val parser = SseParser({ true }, limit = 16)
        parser.feed("data: 0123456789abcdefghij\n\n")
    }

    @Test
    fun `chat delta sample parses as two events`() {
        val wire = listOf(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Yo\"}}]}\n\n",
            "event: hermes.tool.progress\ndata: {\"tool\":\"terminal\"}\n\n",
            "data: [DONE]\n\n",
        )
        val out = mutableListOf<Ev>()
        val parser = SseParser(onEvent = { e -> out.add(Ev(e.event, e.data)); e.data != "[DONE]" })
        for (w in wire) parser.feed(w)
        parser.end()
        assertEquals(3, out.size)
        assertEquals("hermes.tool.progress", out[1].event)
    }
}
