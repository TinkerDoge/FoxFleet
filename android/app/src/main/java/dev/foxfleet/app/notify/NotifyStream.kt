package dev.foxfleet.app.notify

import dev.foxfleet.app.data.SseParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import java.io.IOException
import java.io.Reader

/** Reconnect delay: 1 s doubling to 60 s, with jitter (0.5x to 1x of the step) so a restarted hub is not hit by every phone at once. */
object NotifyBackoff {
    const val BASE_MS = 1_000L
    const val CAP_MS = 60_000L
    fun delayMs(attempt: Int, random: Double = Math.random()): Long {
        val step = minOf(CAP_MS, BASE_MS shl minOf(attempt.coerceAtLeast(0), 10))
        return (step * (0.5 + random.coerceIn(0.0, 1.0) / 2)).toLong()
    }
}

/** One answered stream request. [token] is the hub's `X-Session-Token` header (a rotated bearer token), if any. */
class NotifyOpen(val status: Int, val contentType: String?, val token: String?, val retryAfterSec: Int?, val body: Reader?, private val onClose: () -> Unit = {}) : AutoCloseable {
    override fun close() { runCatching { body?.close() }; onClose() }
}

/** Opens `GET /api/notify/stream` with `Last-Event-ID`. Blocking; throws [IOException] when the hub cannot be reached or the link goes silent (read timeout = the 45 s heartbeat rule). */
fun interface NotifyTransport { fun open(lastId: Long?): NotifyOpen }

/** Where the resume id and a rotated token live. Keyed by account + hub by the implementation. */
interface NotifyCursorStore {
    var lastId: Long?
    fun saveToken(token: String)
}

/** Receives what the stream delivers. */
interface NotifySink {
    /** Live events, in order. Muted events never arrive here (the hub does not push them). */
    suspend fun onEvents(events: List<NotifyEvent>, replay: Boolean)
    /** Ids were lost: refresh unread state from the chat list instead of assuming completeness. */
    suspend fun onGap(gap: NotifyFrame.Gap)
}

enum class RunEnd { SignedOut, Unsupported }

/**
 * The service's connection loop, free of Android so it can be tested on the JVM.
 * - sends the stored `Last-Event-ID`; with none stored, the replay is only a baseline (the cursor is taken, nothing is notified);
 * - stores a rotated `X-Session-Token` before it reads a single frame;
 * - `foxfleet.auth` or `401` ends the loop with [RunEnd.SignedOut] (never reconnect); `404` ends it with [RunEnd.Unsupported];
 * - every other failure, a closed stream or a silent link reconnects with [NotifyBackoff].
 */
class NotifyStreamRunner(
    private val transport: NotifyTransport,
    private val store: NotifyCursorStore,
    private val sink: NotifySink,
    private val onLink: (NotifyLink) -> Unit = {},
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val random: () -> Double = { Math.random() },
    private val chunk: Int = 4096,
) {
    suspend fun run(): RunEnd {
        var attempt = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            onLink(if (attempt == 0) NotifyLink.Connecting else if (attempt >= OFFLINE_AFTER) NotifyLink.Offline else NotifyLink.Reconnecting(attempt))
            var wait: Long? = null
            try {
                val open = transport.open(store.lastId)
                open.use { o ->
                    o.token?.takeIf { it.isNotBlank() }?.let { store.saveToken(it) } // before anything else, or the next reconnect after the 60 s grace gets 401
                    when {
                        o.status == 401 -> return RunEnd.SignedOut
                        o.status == 404 -> return RunEnd.Unsupported
                        o.status == 429 -> wait = maxOf(NotifyBackoff.delayMs(attempt, random()), (o.retryAfterSec ?: 0) * 1000L)
                        o.status != 200 || o.body == null || o.contentType?.contains("text/event-stream") != true -> Unit // a proxy page or a 5xx: retry
                        else -> {
                            val result = read(o.body) { attempt = 0; onLink(NotifyLink.Connected) }
                            if (result == Read.SignedOut) return RunEnd.SignedOut
                        }
                    }
                }
            } catch (e: CancellationException) { throw e } catch (_: IOException) { } catch (_: IllegalStateException) { /* oversize frame */ }
            attempt++
            onLink(if (attempt >= OFFLINE_AFTER) NotifyLink.Offline else NotifyLink.Reconnecting(attempt))
            sleep(wait ?: NotifyBackoff.delayMs(attempt - 1, random()))
        }
    }

    private enum class Read { Closed, SignedOut }

    private suspend fun read(reader: Reader, onReady: () -> Unit): Read {
        val baseline = store.lastId == null
        val pending = ArrayList<NotifyFrame>()
        var auth = false
        val parser = SseParser({ e ->
            NotifyFrames.decode(e.event, e.data, e.id)?.let { pending.add(it); if (it is NotifyFrame.Auth) auth = true }
            !auth
        })
        val replay = ArrayList<NotifyEvent>()
        var ready = false
        val buf = CharArray(chunk)
        while (true) {
            currentCoroutineContext().ensureActive()
            val n = reader.read(buf) // blocks; the transport's read timeout turns a silent link into an IOException
            if (n < 0) { parser.end(); process(pending, replay, baseline, { ready }, { ready = true; onReady() }); return if (auth) Read.SignedOut else Read.Closed }
            parser.feed(String(buf, 0, n))
            if (process(pending, replay, baseline, { ready }, { ready = true; onReady() })) return Read.SignedOut
        }
    }

    /** Handles the decoded frames; true when the hub said `foxfleet.auth`. */
    private suspend fun process(frames: MutableList<NotifyFrame>, replay: MutableList<NotifyEvent>, baseline: Boolean, isReady: () -> Boolean, setReady: () -> Unit): Boolean {
        val batch = frames.toList(); frames.clear()
        for (f in batch) when (f) {
            is NotifyFrame.Auth -> return true
            is NotifyFrame.Gap -> {
                if (store.lastId != null && f.cursor < store.lastId!!) store.lastId = f.cursor // the hub's data was reset: start over from its cursor
                sink.onGap(f)
            }
            is NotifyFrame.Event -> {
                val last = store.lastId
                if (last != null && f.event.id <= last) continue // already handled (ids strictly increase)
                if (!isReady()) replay.add(f.event) else { sink.onEvents(listOf(f.event), replay = false); store.lastId = maxOf(store.lastId ?: 0L, f.event.id) }
            }
            is NotifyFrame.Ready -> {
                setReady()
                val fresh = replay.filter { e -> store.lastId?.let { e.id > it } ?: true }
                val deliver = if (baseline) emptyList() else fresh
                if (deliver.isNotEmpty()) sink.onEvents(deliver, replay = true)
                replay.clear()
                store.lastId = maxOf(store.lastId ?: 0L, f.cursor, fresh.maxOfOrNull { it.id } ?: 0L)
            }
        }
        return false
    }

    companion object { const val OFFLINE_AFTER = 3 }
}
