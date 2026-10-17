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

/**
 * Where the resume cursor lives (the Room sync row of the cache owner). The owed resync is stored in the same row as the
 * cursor that skipped ahead ([markOwed] is one write), and cleared only after the resync finished ([resynced]): a resync
 * that failed, was cancelled (app to background) or died with the process is redone by the next runner.
 */
interface CursorStore {
    suspend fun load(): String?
    /** An applied event or a `ready` position: advance the cursor (an owed resync stays owed). */
    suspend fun save(cursor: String)
    /** The resync still owed, or null. */
    suspend fun owed(): String?
    /** Skip to [cursor] (null = start at now) and owe a resync for [reason], atomically. */
    suspend fun markOwed(cursor: String?, reason: String)
    suspend fun resynced()
}

interface V2Sink {
    suspend fun onLink(state: LinkState)
    /** A persisted event, in seq order (replayed or live). Must be idempotent: after a crash between apply and save it comes again. */
    suspend fun onEvent(e: V2Event)
    fun onTyping(t: Typing)
    /**
     * The cache may have missed something: a gap ([reason] expired/reset/invalid), a 410, the first connect without a cursor,
     * or the stuck-cursor escape. The sink resyncs (chat list, then `after_n` for every cached chat) and returns only when it
     * finished; it throws when any part failed. Until it returns, the resync stays owed in the [CursorStore].
     */
    suspend fun onResync(reason: String)
    /** Skipped event (could not be applied). Log the seq only. */
    fun onSkipped(seq: Long, e: Exception) {}
}

enum class V2End { SignedOut, Unsupported }

/**
 * Connection loop for `GET /api/live/stream?v=2` (feature `live2`). Resumes from the stored cursor (`since` + `Last-Event-ID`),
 * saves the cursor after each applied event, drops a repeat (seq at or below the cursor of the same store), and on
 * `foxfleet.gap` / 410 stores the new cursor together with an owed resync, done at `ready` (or at once when already live).
 * A failed resync stays owed: the stream is closed and reopened with backoff (the replay up to `ready` still applies events).
 * After [STUCK_AFTER] failed attempts in a row at the same cursor that reached the hub (reset before `ready`, 5xx, garbage),
 * the cursor is dropped (start at now) and a full resync is owed: the escape when the hub cannot deliver that replay.
 * 404/400 = the hub has no v2 (the caller falls back to v1), 401 or `foxfleet.auth` = signed out (do not reconnect).
 * Backoff as the v1 runner; a 429 waits at least 10 s.
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
    /** The resync still owed (mirrors the store). */
    private var owedResync: String? = null
    /** Failed attempts in a row at [stuckAt] that reached the hub. */
    private var stuck = 0; private var stuckAt: String? = null

    fun nudge() { nudged = true; wake.trySend(Unit) }
    fun close() { connecting?.cancel(); current?.close() }
    private suspend fun pause(ms: Long) { val s = sleep; if (s != null) s(ms) else withTimeoutOrNull(ms) { wake.receive() } }

    private class ResyncFailed(cause: Exception) : Exception(cause)

    suspend fun run(): V2End {
        cursor = cursors.load(); owedResync = cursors.owed()
        var attempt = 0; var failures = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            wake.tryReceive(); nudged = false
            sink.onLink(if (failures >= OFFLINE_AFTER) LinkState.Offline else LinkState.Connecting)
            var upSince: Long? = null; var minWait = 0L; var reachedHub = true; var ok = false; val before = cursor
            try {
                val cancel = LiveCancel(); connecting = cancel
                val open = try { transport(cursor, cancel).also { current = it } } finally { connecting = null } // current set before connecting clears: close() always reaches the call
                current = open
                if (cancel.cancelled) { open.close(); currentCoroutineContext().ensureActive() }
                open.use { o ->
                    when {
                        o.status == 401 -> return V2End.SignedOut
                        o.status == 404 || o.status == 400 -> return V2End.Unsupported
                        o.status == 429 -> { minWait = 10_000L; failures++; reachedHub = false }
                        // 410 cursor_expired: restart from the body's cursor (or from now) and resync with after_n once live.
                        o.status == 410 -> { expired(o.body); ok = true }
                        o.status != 200 || o.body == null || o.contentType?.contains("text/event-stream") != true -> failures++
                        else -> {
                            sink.onLink(LinkState.Updating)
                            val end = read(o.body) { upSince = clock(); failures = 0; ok = true }
                            if (end) return V2End.SignedOut
                            if (!ok) failures++ // closed before ready (e.g. reset during the replay)
                        }
                    }
                }
            } catch (e: CancellationException) { throw e
            } catch (e: ResyncFailed) { ok = true // the stream worked; the resync stays owed and is retried after the backoff (attempt keeps growing)
            } catch (e: Exception) { failures++; if (unreachable(e)) reachedHub = false }
            current = null
            if (ok || !reachedHub || cursor != before) { stuck = 0; stuckAt = null } else { // progress (events applied) also resets the count
                if (stuckAt != cursor) { stuckAt = cursor; stuck = 0 }
                if (++stuck >= STUCK_AFTER && cursor != null) { owe(null, "stuck"); stuck = 0; stuckAt = null; attempt = 0 }
            }
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
        val firstEver = cursor == null; var live = false
        val buf = CharArray(4096)
        while (true) {
            currentCoroutineContext().ensureActive()
            val n = reader.read(buf)
            if (n < 0) parser.end() else parser.feed(String(buf, 0, n))
            val batch = pending.toList(); pending.clear()
            for (f in batch) when (f) {
                V2Frame.Auth -> return true
                is V2Frame.Gap -> {
                    // Stored with the new cursor at once (a crash before ready still owes it). Before ready: resync at ready.
                    // After ready (the hub skipped us forward mid-stream): resync now.
                    owe(f.cursor?.takeIf { LiveCursor.parse(it) != null } ?: cursor, f.reason)
                    if (live) { sink.onLink(LinkState.Updating); resync(); sink.onLink(LinkState.Live) }
                }
                is V2Frame.TypingFrame -> sink.onTyping(f.typing)
                is V2Frame.Event -> apply(f)
                is V2Frame.Ready -> {
                    // The ready cursor is where the stream stands after the replay: store it as the resume point.
                    val at = f.cursor?.takeIf { LiveCursor.parse(it) != null && it != cursor }
                    if (firstEver && owedResync == null) owe(at ?: cursor, "start") else at?.let { setCursor(it) }
                    onLive() // the link works: what follows is the resync, not the connection
                    if (owedResync != null) { sink.onLink(LinkState.Updating); resync() }
                    live = true; sink.onLink(LinkState.Live)
                }
            }
            if (n < 0) return false
        }
    }

    private suspend fun resync() {
        val why = owedResync ?: return
        try { sink.onResync(why) } catch (e: CancellationException) { throw e } catch (e: Exception) { throw ResyncFailed(e) }
        owedResync = null; cursors.resynced()
    }

    private suspend fun apply(f: V2Frame.Event) {
        val at = LiveCursor.parse(cursor); val id = LiveCursor.parse(f.id)
        if (at != null && id != null && at.store == id.store && id.seq <= at.seq) return // a repeat after a reconnect
        try { sink.onEvent(f.event) } catch (e: CancellationException) { throw e } catch (e: dev.foxfleet.app.data.AuthRequiredException) { throw e } catch (e: Exception) { sink.onSkipped(f.event.seq, e) }
        if (id != null) setCursor(f.id)
    }

    private suspend fun setCursor(c: String) { cursor = c; cursors.save(c) }
    /** A later reason does not replace an owed one that needs more (any owed resync is a full one, so keep the first). */
    private suspend fun owe(c: String?, reason: String) { cursor = c; val r = owedResync ?: reason; owedResync = r; cursors.markOwed(c, r) }

    private suspend fun expired(body: Reader?) {
        val text = runCatching { body?.let { b -> val buf = CharArray(8192); val n = b.read(buf); if (n > 0) String(buf, 0, n) else null } }.getOrNull()
        val next = text?.let { Contract.obj(it) }?.let { (it["cursor"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }?.takeIf { LiveCursor.parse(it) != null }
        owe(next, "expired") // no cursor: start at now; ready stores the new one
    }

    /** The device could not reach the hub at all (no network, DNS, refused): not evidence of a stuck replay. */
    private fun unreachable(e: Exception): Boolean {
        var t: Throwable? = e
        while (t != null) {
            if (t is java.net.UnknownHostException || t is java.net.ConnectException || t is java.net.NoRouteToHostException || t is java.net.SocketTimeoutException && t.message?.contains("connect", ignoreCase = true) == true) return true
            t = t.cause
        }
        return false
    }

    companion object {
        /** Consecutive failed attempts before the indicator says Offline instead of Connecting. */
        const val OFFLINE_AFTER = 2
        /** Failed attempts in a row at one cursor (that reached the hub) before the runner drops the cursor and resyncs in full. */
        const val STUCK_AFTER = 5
    }
}
