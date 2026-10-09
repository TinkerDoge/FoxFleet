package dev.foxfleet.app.data

/**
 * Wire-exact port of Foxfleet web/sse.js createSSEParser.
 * A chunk boundary may split a line or a CRLF pair — the parser defers a
 * trailing '\r' until the next chunk arrives.
 *
 * The consumer returns false to stop parsing (web parity: [DONE] stops the read).
 */
class SseParser(private val onEvent: (SseEvent) -> Boolean, private val limit: Int = 1024 * 1024) {

    class SseEvent(val event: String, val data: String, val id: String? = null)

    private var buffer = ""
    private var event = "message"
    private var data = mutableListOf<String>()
    private var size = 0
    private var id: String? = null
    private var stopped = false

    val isStopped: Boolean get() = stopped

    private fun dispatch(): Boolean {
        if (data.isNotEmpty()) {
            val e = SseEvent(event, data.joinToString("\n"), id)
            if (!onEvent(e)) stopped = true
        }
        event = "message"
        data = mutableListOf()
        size = 0
        id = null
        return !stopped
    }

    private fun line(value: String) {
        if (value.isEmpty()) { dispatch(); return }
        if (value.startsWith(":")) return
        val colon = value.indexOf(':')
        val field = if (colon < 0) value else value.substring(0, colon)
        var content = if (colon < 0) "" else value.substring(colon + 1)
        if (content.startsWith(" ")) content = content.substring(1)
        if (field == "id") id = content
        if (field == "event") event = content.ifEmpty { "message" }
        if (field == "data") {
            size += content.length
            if (size > limit) throw IllegalStateException("Stream event too large")
            data.add(content)
        }
    }

    fun feed(chunk: String) {
        buffer += chunk
        if (buffer.length + size > limit) throw IllegalStateException("Stream event too large")
        var start = 0
        var i = 0
        while (i < buffer.length && !stopped) {
            val c = buffer[i]
            if (c != '\r' && c != '\n') { i++; continue }
            if (c == '\r' && i == buffer.length - 1) break // may be half of a split CRLF
            line(buffer.substring(start, i))
            if (stopped) break
            if (c == '\r' && i + 1 < buffer.length && buffer[i + 1] == '\n') i++
            start = i + 1
            i++
        }
        buffer = buffer.substring(start)
    }

    fun end() {
        if (stopped) return
        if (buffer.isNotEmpty()) line(buffer.trimEnd('\r'))
        buffer = ""
        dispatch()
    }
}
