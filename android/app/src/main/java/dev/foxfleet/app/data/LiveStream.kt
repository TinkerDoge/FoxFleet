package dev.foxfleet.app.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.IOException
import java.io.Reader

/**
 * Live chat events (hub feature `live`, `GET /api/live/stream`, 0.3.14). The hub pushes "a run started / finished in this chat"
 * and "an approval is waiting" without message text; the app reacts by fetching the newest page of the open chat (catch-up).
 */
data class LiveEvent(val id: String, val type: String, val agent: String, val chat: String?, val runId: String?, val state: String?)

sealed interface LiveFrame {
    data class Event(val event: LiveEvent) : LiveFrame
    data class Ready(val cursor: String) : LiveFrame
    data object Gap : LiveFrame
    data object Auth : LiveFrame
}

object LiveFrames {
    private val json = Json { ignoreUnknownKeys = true }
    fun decode(event: String, data: String, id: String?): LiveFrame? = runCatching {
        when (event) {
            "live" -> {
                val o = json.parseToJsonElement(data).jsonObject
                fun s(k: String) = o[k]?.jsonPrimitive?.contentOrNull
                val agent = s("agent") ?: return null; val type = s("type") ?: return null
                LiveFrame.Event(LiveEvent(id ?: o["id"]?.jsonPrimitive?.longOrNull?.toString() ?: return null, type, agent, s("chat"), s("run_id"), s("state")))
            }
            "foxfleet.ready" -> LiveFrame.Ready(json.parseToJsonElement(data).jsonObject["cursor"]?.jsonPrimitive?.contentOrNull.orEmpty())
            "foxfleet.gap" -> LiveFrame.Gap
            "foxfleet.auth" -> LiveFrame.Auth
            else -> null
        }
    }.getOrNull()
}

/** One answered stream request. */
class LiveOpen(val status: Int, val contentType: String?, val body: Reader?, private val onClose: () -> Unit = {}) : AutoCloseable {
    override fun close() { runCatching { body?.close() }; onClose() }
}

/** Opens the stream with `Last-Event-ID` (null = start at now). Blocking; a silent link must surface as [IOException] (read timeout ≈ 3 missed heartbeats). */
fun interface LiveTransport { fun open(cursor: String?, cancel: LiveCancel): LiveOpen }

/** The in-flight connect of one attempt: the transport registers how to abort it, [LiveStreamRunner.close] fires it (app to background). */
class LiveCancel {
    @Volatile private var action: (() -> Unit)? = null
    @Volatile var cancelled = false; private set
    /** Registers the abort; runs it at once when [cancel] already happened. */
    fun onCancel(a: () -> Unit) { action = a; if (cancelled) a() }
    fun cancel() { cancelled = true; action?.let { runCatching { it() } } }
}

interface LiveSink {
    /** A pushed event (live or replayed after a reconnect). */
    suspend fun onEvent(e: LiveEvent)
    /** The stream is (re)connected. [catchUp] is true after any drop or gap: the client must fetch what it may have missed. */
    suspend fun onConnected(catchUp: Boolean)
}

enum class LiveEnd { SignedOut, Unsupported }

/**
 * Connection loop for the live stream, JVM-testable. Reconnects with backoff (1 s doubling to 30 s, jitter) on any failure, a
 * closed stream or a silent link; [nudge] (app back in the foreground, network back) retries at once. The cursor is kept in memory:
 * after a reconnect the hub replays what was missed, and [LiveSink.onConnected] with catchUp=true covers anything older (gap, hub restart).
 */
class LiveStreamRunner(
    private val transport: LiveTransport,
    private val sink: LiveSink,
    private val sleep: (suspend (Long) -> Unit)? = null,
    private val random: () -> Double = { Math.random() },
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private val wake = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var nudged = false
    @Volatile private var current: LiveOpen? = null
    @Volatile private var connecting: LiveCancel? = null
    @Volatile var cursor: String? = null; private set
    @Volatile var connected = false; private set

    fun nudge() { nudged = true; wake.trySend(Unit) }
    /** Stop: aborts a connect still in progress (so it never holds one of the hub's stream slots) and the open stream. */
    fun close() { connecting?.cancel(); current?.close() }

    private suspend fun pause(ms: Long) { val s = sleep; if (s != null) s(ms) else withTimeoutOrNull(ms) { wake.receive() } }

    suspend fun run(): LiveEnd {
        var attempt = 0; var everConnected = false
        while (true) {
            currentCoroutineContext().ensureActive()
            wake.tryReceive(); nudged = false
            var upSince: Long? = null
            try {
                val cancel = LiveCancel(); connecting = cancel
                val open = try { transport.open(cursor, cancel) } finally { connecting = null }
                current = open
                if (cancel.cancelled) { open.close(); currentCoroutineContext().ensureActive() }
                open.use { o ->
                    when {
                        o.status == 401 -> return LiveEnd.SignedOut
                        o.status == 404 -> return LiveEnd.Unsupported // an older hub: the caller falls back to polling
                        o.status != 200 || o.body == null || o.contentType?.contains("text/event-stream") != true -> Unit
                        else -> {
                            val signedOut = read(o.body) { gap -> upSince = clock(); connected = true; sink.onConnected(catchUp = everConnected || gap); everConnected = true }
                            if (signedOut) return LiveEnd.SignedOut
                        }
                    }
                }
            } catch (e: CancellationException) { throw e } catch (_: Exception) { /* IO, a silent link, an unreachable or unset hub: retry */ }
            current = null; connected = false
            if (upSince?.let { clock() - it >= STABLE_MS } == true) attempt = 0
            pause(delayMs(attempt++, random()))
            if (nudged) { attempt = 0; nudged = false }
        }
    }

    /** True when the hub said the session ended. */
    private suspend fun read(reader: Reader, onReady: suspend (gap: Boolean) -> Unit): Boolean {
        val pending = ArrayList<LiveFrame>()
        val parser = SseParser({ e -> LiveFrames.decode(e.event, e.data, e.id)?.let { pending.add(it) }; true })
        val held = ArrayList<LiveEvent>(); var ready = false; var gap = false
        val buf = CharArray(4096)
        while (true) {
            currentCoroutineContext().ensureActive()
            val n = reader.read(buf)
            if (n < 0) parser.end() else parser.feed(String(buf, 0, n))
            val batch = pending.toList(); pending.clear()
            for (f in batch) when (f) {
                LiveFrame.Auth -> return true
                LiveFrame.Gap -> gap = true
                is LiveFrame.Event -> { cursor = f.event.id; if (ready) sink.onEvent(f.event) else held.add(f.event) }
                is LiveFrame.Ready -> {
                    ready = true; if (f.cursor.isNotBlank() && (gap || cursor == null)) cursor = f.cursor
                    onReady(gap); held.forEach { sink.onEvent(it) }; held.clear()
                }
            }
            if (n < 0) return false
        }
    }

    companion object {
        const val STABLE_MS = 45_000L
        const val CAP_MS = 30_000L
        /** Read timeout for the stream: the hub writes a heartbeat every 15 s, so 45 s of silence means the link is dead. */
        const val READ_TIMEOUT_SEC = 45L
        fun delayMs(attempt: Int, random: Double): Long { val step = minOf(CAP_MS, 1_000L shl minOf(attempt.coerceAtLeast(0), 10)); return (step * (0.5 + random.coerceIn(0.0, 1.0) / 2)).toLong() }
    }
}

/** How the open chat absorbs the newest page fetched after a live event, a reconnect or a fallback poll. */
sealed interface CatchUp {
    data object None : CatchUp
    data class Append(val messages: List<UiMessage>) : CatchUp
    /** The local tail is not in the page (more than a page behind, or edited elsewhere): load the page as the chat. */
    data object Replace : CatchUp
    /** The last local message has no hub id yet (a live turn): let reconcile swap in the stored copy. */
    data object Reconcile : CatchUp
}

object LiveCatchUp {
    fun plan(have: List<UiMessage>, page: List<UiMessage>): CatchUp {
        if (page.isEmpty()) return CatchUp.None
        if (have.isEmpty()) return CatchUp.Replace
        val lastId = have.lastOrNull { it.id != null }?.id
        if (have.last().id == null) return CatchUp.Reconcile
        val at = page.indexOfLast { it.id == lastId }
        if (at < 0) return CatchUp.Replace
        val fresh = page.drop(at + 1).filter { n -> n.id == null || have.none { it.id == n.id } }
        return if (fresh.isEmpty()) CatchUp.None else CatchUp.Append(fresh)
    }

    /** Should a live event refresh the open chat [openSession] of [openAgent]? Events for another agent or session only touch the list. */
    fun touchesChat(e: LiveEvent, openAgent: String?, openSession: String?): Boolean =
        openAgent != null && e.agent == openAgent && (e.chat == null || openSession == null || e.chat == openSession)
}
