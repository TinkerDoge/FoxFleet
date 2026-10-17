package dev.foxfleet.app.data.live

import dev.foxfleet.app.data.LiveCancel
import dev.foxfleet.app.data.LiveOpen
import dev.foxfleet.app.data.LiveStreamRunner
import dev.foxfleet.app.data.SseParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Reader

/** What the connection indicator says. Same words in the chat list title and the chat header. */
enum class LinkState {
    /** Live: events arrive as they happen (no indicator). */
    Live,
    /** Opening the stream (first connect or after a drop). */
    Connecting,
    /** The stream is open and the hub is replaying what was missed, or the app is resyncing after a gap. */
    Updating,
    /** Several attempts failed in a row: showing saved data, retrying in the background. */
    Offline,
}

/** `<store>:<seq>`. Seq compares only within one store. */
data class LiveCursor(val store: String, val seq: Long) {
    override fun toString() = "$store:$seq"
    companion object {
        fun parse(s: String?): LiveCursor? {
            val i = s?.lastIndexOf(':') ?: return null; if (i <= 0) return null
            val seq = s.substring(i + 1).toLongOrNull()?.takeIf { it >= 0 } ?: return null
            return LiveCursor(s.substring(0, i), seq)
        }
    }
}

sealed interface V2Frame {
    data class Event(val id: String, val event: V2Event) : V2Frame
    data class TypingFrame(val typing: Typing) : V2Frame
    data class Gap(val reason: String, val cursor: String?) : V2Frame
    data class Ready(val cursor: String?, val contract: String?) : V2Frame
    data object Auth : V2Frame
}

object V2Frames {
    fun decode(event: String, data: String, id: String?): V2Frame? {
        val o = Contract.obj(data) ?: return null
        fun s(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        return when (event) {
            "foxfleet.gap" -> V2Frame.Gap(s("reason") ?: "invalid", s("cursor"))
            "foxfleet.ready" -> V2Frame.Ready(s("cursor"), s("contract"))
            "foxfleet.auth" -> V2Frame.Auth
            "typing" -> Contract.typing(o)?.let { V2Frame.TypingFrame(it) }
            else -> {
                val e = Contract.event(o, event) ?: return null
                // the SSE id is the cursor; an event without one (should not happen) is still applied, the cursor just stays
                V2Frame.Event(id?.takeIf { LiveCursor.parse(it)?.seq == e.seq } ?: "", e)
            }
        }
    }
}

/** Where the resume cursor lives (the Room sync row of the cache owner). */
interface CursorStore {
    suspend fun load(): String?
    suspend fun save(cursor: String)
}

interface V2Sink {
    suspend fun onLink(state: LinkState)
    /** A persisted event, in seq order (replayed or live). Must be idempotent: after a crash between apply and save it comes again. */
    suspend fun onEvent(e: V2Event)
    fun onTyping(t: Typing)
    /**
     * The stream is live but the cache may have missed something: a gap ([reason] expired/reset/invalid), or the first connect
     * without a cursor. The sink resyncs (chat list, then `after_n` per cached chat) before the indicator turns Live.
     */
    suspend fun onResync(reason: String)
    /** Skipped event (could not be applied). Log the seq only. */
    fun onSkipped(seq: Long, e: Exception) {}
}

enum class V2End { SignedOut, Unsupported }

/**
 * Connection loop for `GET /api/live/stream?v=2` (feature `live2`). Resumes from the stored cursor (`since` + `Last-Event-ID`),
 * saves the cursor after each applied event, drops a repeat (seq at or below the cursor of the same store), and on
 * `foxfleet.gap` stores the gap's cursor and asks the sink to resync. 404/400 = the hub has no v2 (the caller falls back to v1),
 * 401 or `foxfleet.auth` = signed out (do not reconnect). Backoff as the v1 runner; a 429 waits at least 10 s.
 */
class LiveV2Runner(
    private val transport: (cursor: String?, cancel: LiveCancel) -> LiveOpen,
    private val cursors: CursorStore,
    private val sink: V2Sink,
    private val sleep: (suspend (Long) -> Unit)? = null,
    private val random: () -> Double = { Math.random() },
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private val wake = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var nudged = false
    @Volatile private var current: LiveOpen? = null
    @Volatile private var connecting: LiveCancel? = null
    @Volatile var cursor: String? = null; private set
    /** A resync owed from an earlier connection (a 410 `cursor_expired`): done at the next `ready`. */
    private var owedResync: String? = null

    fun nudge() { nudged = true; wake.trySend(Unit) }
    fun close() { connecting?.cancel(); current?.close() }
    private suspend fun pause(ms: Long) { val s = sleep; if (s != null) s(ms) else withTimeoutOrNull(ms) { wake.receive() } }

    suspend fun run(): V2End {
        cursor = cursors.load()
        var attempt = 0; var failures = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            wake.tryReceive(); nudged = false
            sink.onLink(if (failures >= OFFLINE_AFTER) LinkState.Offline else LinkState.Connecting)
            var upSince: Long? = null; var minWait = 0L
            try {
                val cancel = LiveCancel(); connecting = cancel
                val open = try { transport(cursor, cancel) } finally { connecting = null }
                current = open
                if (cancel.cancelled) { open.close(); currentCoroutineContext().ensureActive() }
                open.use { o ->
                    when {
                        o.status == 401 -> return V2End.SignedOut
                        o.status == 404 || o.status == 400 -> return V2End.Unsupported
                        o.status == 429 -> { minWait = 10_000L; failures++ }
                        // 410 cursor_expired: restart from the body's cursor (or from now) and resync with after_n once live.
                        o.status == 410 -> expired(o.body)
                        o.status != 200 || o.body == null || o.contentType?.contains("text/event-stream") != true -> failures++
                        else -> {
                            sink.onLink(LinkState.Updating)
                            val end = read(o.body) { upSince = clock(); failures = 0 }
                            if (end) return V2End.SignedOut
                        }
                    }
                }
            } catch (e: CancellationException) { throw e } catch (_: Exception) { failures++ }
            current = null
            if (upSince?.let { clock() - it >= LiveStreamRunner.STABLE_MS } == true) attempt = 0
            sink.onLink(if (failures >= OFFLINE_AFTER) LinkState.Offline else LinkState.Connecting)
            pause(maxOf(minWait, LiveStreamRunner.delayMs(attempt++, random())))
            if (nudged) { attempt = 0; nudged = false }
        }
    }

    /** True when the hub said the session ended. */
    private suspend fun read(reader: Reader, onLive: () -> Unit): Boolean {
        val pending = ArrayList<V2Frame>()
        val parser = SseParser({ e -> V2Frames.decode(e.event, e.data, e.id)?.let { pending.add(it) }; true })
        var gap: String? = null; val firstEver = cursor == null; var live = false
        val buf = CharArray(4096)
        while (true) {
            currentCoroutineContext().ensureActive()
            val n = reader.read(buf)
            if (n < 0) parser.end() else parser.feed(String(buf, 0, n))
            val batch = pending.toList(); pending.clear()
            for (f in batch) when (f) {
                V2Frame.Auth -> return true
                is V2Frame.Gap -> {
                    f.cursor?.takeIf { LiveCursor.parse(it) != null }?.let { setCursor(it) }
                    // Before ready: resync at ready. After ready (the hub skipped us forward mid-stream): resync now.
                    if (live) { sink.onLink(LinkState.Updating); sink.onResync(f.reason); sink.onLink(LinkState.Live) } else gap = f.reason
                }
                is V2Frame.TypingFrame -> sink.onTyping(f.typing)
                is V2Frame.Event -> apply(f)
                is V2Frame.Ready -> {
                    // The ready cursor is where the stream stands after the replay: store it as the resume point.
                    f.cursor?.takeIf { LiveCursor.parse(it) != null && it != cursor }?.let { setCursor(it) }
                    val why = gap ?: owedResync ?: if (firstEver) "start" else null
                    if (why != null) { sink.onLink(LinkState.Updating); sink.onResync(why) }
                    gap = null; owedResync = null; live = true; onLive(); sink.onLink(LinkState.Live)
                }
            }
            if (n < 0) return false
        }
    }

    private suspend fun apply(f: V2Frame.Event) {
        val at = LiveCursor.parse(cursor); val id = LiveCursor.parse(f.id)
        if (at != null && id != null && at.store == id.store && id.seq <= at.seq) return // a repeat after a reconnect
        try { sink.onEvent(f.event) } catch (e: CancellationException) { throw e } catch (e: dev.foxfleet.app.data.AuthRequiredException) { throw e } catch (e: Exception) { sink.onSkipped(f.event.seq, e) }
        if (id != null) setCursor(f.id)
    }

    private suspend fun setCursor(c: String) { cursor = c; cursors.save(c) }

    private suspend fun expired(body: Reader?) {
        val text = runCatching { body?.let { b -> val buf = CharArray(8192); val n = b.read(buf); if (n > 0) String(buf, 0, n) else null } }.getOrNull()
        val next = text?.let { Contract.obj(it) }?.let { (it["cursor"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }?.takeIf { LiveCursor.parse(it) != null }
        if (next != null) setCursor(next) else cursor = null // no cursor: start at now; ready stores the new one
        owedResync = "expired"
    }

    companion object {
        /** Consecutive failed attempts before the indicator says Offline instead of Connecting. */
        const val OFFLINE_AFTER = 2
    }
}
