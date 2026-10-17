package dev.foxfleet.app.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubApiException
import dev.foxfleet.app.data.SavedChat
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.UiMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

const val PAGE = 80
private val PENDING_STATES = setOf("queued", "awaiting_stop", "sending", "failed")

/** Per-agent conversation state: message history, streaming overlays, session id. */
class ChatState {
    var messages by mutableStateOf<List<UiMessage>>(emptyList())
        private set
    var streaming by mutableStateOf(false)
        private set
    var streamText by mutableStateOf("")
        private set
    var streamReasoning by mutableStateOf("")
        private set
    var toolLabel by mutableStateOf<String?>(null)
        private set
    /** When the first reasoning chunk of this reply arrived, and how long the thinking lasted (until the first reply text or the end). */
    var reasoningStart by mutableLongStateOf(0L)
        private set
    var reasoningMs by mutableLongStateOf(0L)
        private set
    private fun reasoningDuration(): Long = if (reasoningMs > 0) reasoningMs else if (reasoningStart > 0) System.currentTimeMillis() - reasoningStart else 0L
    var error by mutableStateOf<String?>(null)
        private set
    var sessionId by mutableStateOf<String?>(null)
        private set
    /** Small bot-style lines (a confirmation such as the model change). Local to this screen: never sent to the agent. */
    var notices by mutableStateOf<List<String>>(emptyList())
        private set
    fun addNotice(text: String) { notices = (notices + text).takeLast(5) }

    /** The hub run behind the reply being streamed, and where to remember it (set by the ViewModel). */
    var runId: String? = null
        private set
    var persist: (SavedChat) -> Unit = {}

    var loading by mutableStateOf(false)
        private set
    /** Older pages exist on the hub; [olderOffset] is where the next page starts (counted back from the newest message). */
    var hasOlder by mutableStateOf(false)
        private set
    var loadingOlder by mutableStateOf(false)
        private set
    var olderOffset = 0
        private set
    /** Stable list keys: prepending older messages must not shift the keys of the ones already on screen. */
    var keyBase = 0
        private set
    var unread by mutableStateOf(false)
        private set
    /** What the hub holds for this conversation (queued, waiting for a stop, guidance accepted) and whether draining is paused. */
    var queue by mutableStateOf<List<HubApi.QueuedMessage>>(emptyList())
        private set
    var halted by mutableStateOf(false)
        private set
    /** Messages are waiting (queued, waiting for a stop, sending, failed): same set as web's PENDING. A failed one stays until dismissed, so Retry and Edit wait for it. */
    val queuePending: Boolean get() = queue.any { it.state in PENDING_STATES }
    /** Questions and approvals the agent waits on (native sessions): one card each, answered once by id. */
    var requests by mutableStateOf<List<HubApi.OpenRequest>>(emptyList())
        private set
    /** Tools used in the current reply, newest last. */
    var toolLog by mutableStateOf<List<String>>(emptyList())
        private set
    /** Calls running right now (hubs that send per-call events); each disappears when its end arrives, all clear when the reply ends. */
    var tools by mutableStateOf(ToolActivity())
        private set
    /** 0.4.1: the reply's live step list (tool calls with preview, outcome and time; commentary and status lines). */
    private val stepsLock = Any()
    var steps by mutableStateOf(StepLog())
        private set
    /** The agent's message.new for the reply still streaming (hub id, number, the hub's reasoning/tools): merged into the bubble when it commits. */
    private var pendingReply: UiMessage? = null
    /** The run reported failure (`foxfleet.run` / `run.finished` state): calls without an end are settled as failed, not done. */
    private var runFailed = false
    /** A run that started in this chat while it was loading (0.4.0 dropped it): the ViewModel follows it once the page is in. */
    var missedRun: String? = null
    /** Reactions for this conversation once loaded (null: not loaded, or the hub has none for this agent). */
    var reactions by mutableStateOf<dev.foxfleet.app.data.ReactionSnapshot?>(null)
        private set
    var reactionError by mutableStateOf<String?>(null)
    /** The message just hidden, while its Undo row shows (5 s). */
    var hiddenUndo by mutableStateOf<String?>(null)
        private set
    /** The Undo row's 5 s are up: it goes, unless a newer hide already took its place. */
    fun expireUndo(messageId: String) { if (hiddenUndo == messageId) hiddenUndo = null }
    private var reacting = 0
    /** False when the agent keeps the queue itself (Hermes): a queued message cannot be taken back from here. */
    var canCancel by mutableStateOf(true)
        private set
    /** Bumped whenever the screen moves to another chat or stream: callbacks of an older stream are ignored. */
    private var gen = 0
    private var submitting = 0

    /** Previews/screenshot tests: show reactions without a hub. */
    internal fun simulateReactions(snapshot: dev.foxfleet.app.data.ReactionSnapshot) { reactions = snapshot }

    /** Previews/screenshot tests: put the live overlays into a mid-stream state. */
    internal fun simulateStream(text: String, reasoning: String = "", tool: String? = null, steps: StepLog = StepLog(), run: String? = null) {
        streaming = true; streamText = text; streamReasoning = reasoning; toolLabel = tool; this.steps = steps; runId = run
    }

    /** Previews/screenshot tests: what a native session shows (cards, the queue as Hermes holds it, tools used). */
    internal fun simulateNative(requests: List<HubApi.OpenRequest> = emptyList(), queue: List<HubApi.QueuedMessage> = emptyList(), canCancel: Boolean = true, tools: List<String> = emptyList()) {
        this.requests = requests; this.queue = queue; this.canCancel = canCancel; this.toolLog = tools
    }

    fun markRead() { unread = false }
    fun markUnread() { unread = true }
    fun beginLoad() { loading = true; error = null }
    fun loadFailed(msg: String) { loading = false; error = msg }
    /** A reload that ends without changing the chat (Edit's reload failed or was skipped). */
    fun endLoad() { loading = false }

    /** How many user messages carry [target]'s text: Edit's check for a message without a hub id. */
    fun userCopies(target: UiMessage) = messages.count { it.role == "user" && it.content == target.content }

    /**
     * Edit's reload after /undo. The page is applied only while nothing new started (a reply streaming, messages waiting):
     * loading it then would wipe that turn. Returns true when [target] is gone, false when it is still there, null when skipped.
     */
    fun applyUndo(sid: String, page: List<UiMessage>, hasMore: Boolean, target: UiMessage, copiesBefore: Int): Boolean? {
        if (sessionId != sid) return null // another chat opened: its own load owns the flag
        // deliberately not queuePending: a leftover rejected/failed item must not block the reload after /undo for good
        if (streaming || queue.any { it.state != "rejected" && it.state != "failed" }) { loading = false; return null }
        load(page, sid, hasMore)
        return target.id?.let { id -> messages.none { it.id == id } } ?: (userCopies(target) < copiesBefore)
    }

    /** Append a fully-formed message (history load or user send). */
    fun push(m: UiMessage) { messages = messages + m }
    /** Live catch-up (0.3.14): messages that arrived after the newest one shown. They shift the history window, so the next older page starts later. */
    fun appendLive(fresh: List<UiMessage>) { if (fresh.isEmpty()) return; messages = messages + fresh; olderOffset += fresh.size }

    private fun resetStream() {
        streaming = false; streamText = ""; streamReasoning = ""; reasoningStart = 0L; reasoningMs = 0L; toolLabel = null; toolLog = emptyList(); tools = ToolActivity(); editSteps { StepLog() }; requests = emptyList(); pendingReply = null
    }

    fun adopt(sessionId: String?) {
        if (sessionId != null && sessionId.isNotBlank()) this.sessionId = sessionId
    }

    fun load(messages: List<UiMessage>, sessionId: String?, hasMore: Boolean = false) {
        if (sessionId != this.sessionId) { reactions = null; reactionError = null; hiddenUndo = null }
        val carried = if (sessionId == this.sessionId) MessageMerge.carry(this.messages, messages) else messages
        gen++; queue = emptyList(); halted = false; requests = emptyList(); notices = emptyList()
        this.messages = carried; keyBase = 0; hasOlder = hasMore; olderOffset = PAGE; loadingOlder = false
        this.sessionId = sessionId
        if (!sessionId.isNullOrBlank()) persist(SavedChat(sessionId, null, null))
        loading = false; fromCache = false
        resetStream(); error = null
    }

    /** Retry: forget everything from the last user message on; it is sent again. */
    fun dropAfterLastUser() { val i = messages.indexOfLast { it.role == "user" }; if (i >= 0) messages = messages.take(i) }

    fun beginOlder() { loadingOlder = true }
    fun prepend(older: List<UiMessage>, hasMore: Boolean) {
        keyBase -= older.size; messages = older + messages; hasOlder = hasMore; olderOffset += PAGE; loadingOlder = false
    }
    fun olderFailed() { loadingOlder = false }

    // ---- phase 1 live v2: events for this chat edit the list in place (by hub_id) ----

    /**
     * `message.new` / `message.edited` for this chat. Matches by `hub_id`; a new user message replaces the optimistic copy you
     * just sent (same text, no hub id yet); an agent message while its reply is still streaming is left to the run's stream
     * (its commit and reconcile give it the ids). Returns true when the list changed.
     */
    fun applyLive(m: UiMessage, edited: Boolean): Boolean {
        val hub = m.hubId ?: return false
        val i = messages.indexOfFirst { it.hubId == hub }
        if (i >= 0) { messages = messages.toMutableList().also { it[i] = mergeLive(it[i], m) }; return true }
        if (edited || loading) return false // an edit of a message not shown, or a page about to land that includes it
        // The reply that is streaming right now: keep its ids for the commit (0.4.0 dropped them, and the bubble then lost its thinking on the next swap).
        if (m.role == "assistant" && streaming && (m.runId == null || runId == null || m.runId == runId)) { pendingReply = m; editSteps { it.settle(runFailed) }; return false } // the final reply: no call is still running
        val j = if (m.role == "user") messages.indexOfLast { it.role == "user" && it.hubId == null && it.content.trim() == m.content.trim() }.takeIf { it >= messages.size - 3 }
        else { if (streaming) return false; MessageMerge.replyIndex(messages, m) }
        if (j != null && j >= 0) { messages = messages.toMutableList().also { it[j] = mergeLive(it[j], m) }; return true }
        appendLive(listOf(m)); return true
    }

    private fun mergeLive(old: UiMessage, new: UiMessage) = MessageMerge.merge(old, new)

    /** `message.status`: ticks on your messages only move forward. */
    fun applyStatus(ids: Collection<String>, status: String) {
        if (ids.isEmpty() || messages.none { it.hubId in ids }) return
        messages = messages.map { if (it.hubId in ids) it.copy(status = dev.foxfleet.app.data.live.MessageStatus.advance(it.status, status)) else it }
    }

    /** `message.deleted` (delete for me, on any device). */
    fun applyDeleted(ids: Collection<String>) {
        if (ids.isEmpty() || messages.none { it.hubId in ids }) return
        messages = messages.filterNot { it.hubId in ids }
    }

    /** The rows on screen came from the device cache and the hub has not confirmed them yet. */
    var fromCache by mutableStateOf(false)
        private set

    /**
     * Cache first (0.4.0): show what this device saved for [sessionId] while the hub page loads. Only into an empty,
     * idle chat, and [loading] stays on, so a send cannot start before the hub's page replaces these rows.
     */
    fun showCached(cached: List<UiMessage>, sessionId: String, hasOlder: Boolean): Boolean {
        if (cached.isEmpty() || streaming || (messages.isNotEmpty() && sessionId == this.sessionId)) return false
        if (sessionId != this.sessionId) { reactions = null; reactionError = null; hiddenUndo = null }
        this.messages = cached; this.sessionId = sessionId; keyBase = 0; this.hasOlder = hasOlder; olderOffset = PAGE
        loading = true; error = null; fromCache = true
        return true
    }

    /** The hub could not be reached: keep the saved rows, end the load, and say so once. */
    fun keepCached(notice: String) {
        loading = false; fromCache = true
        if (notice !in notices) notices = notices + notice
    }

    /**
     * Older rows from the device cache (keyset, no network). [hubOffset] is where the hub's own paging continues
     * once the device runs out; [hasMore] covers both.
     */
    fun prependCached(older: List<UiMessage>, hasMore: Boolean, hubOffset: Int) {
        keyBase -= older.size; messages = older + messages; hasOlder = hasMore; olderOffset = hubOffset; loadingOlder = false
    }

    fun newConversation() {
        gen++; queue = emptyList(); halted = false; requests = emptyList(); notices = emptyList()
        messages = emptyList(); keyBase = 0; hasOlder = false; sessionId = null; runId = null; reactions = null; reactionError = null; hiddenUndo = null; persist(SavedChat())
        resetStream(); error = null; loading = false // a new chat loads nothing (an Edit reload it cut short must not leave the composer waiting)
    }

    /** True while the hub or the tunnel is briefly unreachable and we are resuming quietly (shown as a small status, never an error). */
    var reconnecting by mutableStateOf(false)

    private fun callbacks(g: Int) = HubApi.StreamCallbacks(
        onReconnecting = { if (g == gen) reconnecting = true },
        onContent = { if (g == gen) { reconnecting = false; if (reasoningStart > 0 && reasoningMs == 0L) reasoningMs = System.currentTimeMillis() - reasoningStart; streamText += it } }, onReasoning = { if (g == gen) { if (streamReasoning.isEmpty()) reasoningStart = System.currentTimeMillis(); streamReasoning += it } }, onTool = { if (g == gen) { if (tools.active.isEmpty() && tools.ended.isEmpty()) toolLabel = it; if (toolLog.lastOrNull() != it) toolLog = (toolLog + it).takeLast(12); toolTick(it) } },
        onToolEvent = { e -> if (g == gen) { tools = tools.update(e); toolLabel = null; editSteps { it.tool(e) } } }, // per-call events replace the legacy label
        onStep = { k, t, l -> if (g == gen) editSteps { it.note(k, t, l) } },
        onRunState = { st -> if (g == gen && st in FAILED_RUN) runFailed = true },
        onRequest = { r -> if (g == gen && requests.none { it.id == r.id }) requests = requests + r },
        onRequestClosed = { id, _ -> if (g == gen) requests = requests.filter { it.id != id } },
        onAck = { id, ack -> if (g == gen) queue = queue.map { if (it.id == id) it.copy(ack = ack) else it } },
        onSession = { if (g == gen) { adopt(it); persist(SavedChat(sessionId, runId, pendingUser)) } },
        onRun = { if (g == gen) { runId = it; persist(SavedChat(sessionId, it, pendingUser)) } },
        onGap = { if (g == gen) streamText = "" },
        onReplace = { if (g == gen) streamText = it },
    )
    private var pendingUser: String? = null

    /** Streams one assistant turn into the live overlays, then commits it. */
    suspend fun send(api: HubApi, agent: String, userText: String, images: List<dev.foxfleet.app.data.ImageAttachment> = emptyList()) {
        push(UiMessage(role = "user", content = userText, images = images))
        pendingUser = userText; runId = null
        val sentAt = System.currentTimeMillis(); val before = messages
        try { stream { cb -> api.chat(agent, messages, sessionId, cb.onContent, cb.onReasoning, cb.onTool, cb.onSession, cb.onRun, cb.onGap, cb.onRequest, cb.onRequestClosed, cb.onAck, cb.onReconnecting, cb.onToolEvent, onReplace = cb.onReplace, onStep = cb.onStep, onRunState = cb.onRunState) } }
        catch (e: dev.foxfleet.app.data.HubApiException) {
            if (!e.transient || runId != null || !autoResubmit(api, agent, UiMessage(role = "user", content = userText, images = images), sentAt)) throw e
        }
    }

    /**
     * The submit died in a tunnel blip before a run id was seen. The hub may or may not have started the run: look first (a run that
     * began after we sent is ours), and only otherwise send again through the idempotent /messages path (one client_id for every retry).
     */
    private suspend fun autoResubmit(api: HubApi, agent: String, user: UiMessage, sentAt: Long): Boolean {
        val clientId = java.util.UUID.randomUUID().toString(); error = null; reconnecting = true; streaming = true
        try {
            for (n in 0 until 10) {
                delay(dev.foxfleet.app.data.backoffMs(n, 600, 10_000))
                try {
                    val mine = api.runs(agent, sessionId).firstOrNull { it.started >= sentAt - 3000 }
                    val run = mine?.id ?: api.sendMessage(agent, user, sessionId, "queue", clientId).also { r -> r.sessionId?.let { adopt(it) } }.runId
                    reconnecting = false
                    if (run != null) { resume(api, agent, run, null) } else { streaming = false; syncQueue(api, agent) }
                    return true
                } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (e: dev.foxfleet.app.data.HubApiException) { if (!e.transient) return false }
            }
            return false
        } finally { reconnecting = false; if (!messages.isEmpty() && runId == null) streaming = false }
    }

    /** Reattach to a reply that was still being written (or just finished) while the app was away. */
    suspend fun resume(api: HubApi, agent: String, run: String, userText: String?) {
        if (run in finishedRuns) return // its whole reply is shown already (the hub can still list it as active for a moment)
        if (userText != null && messages.lastOrNull()?.content != userText) push(UiMessage(role = "user", content = userText))
        pendingUser = userText; runId = run
        stream { cb -> api.follow(agent, run, 0, cb) }
    }

    private suspend fun stream(block: suspend (HubApi.StreamCallbacks) -> String) {
        val g = ++gen
        streaming = true; error = null; streamText = ""; streamReasoning = ""; reasoningStart = 0L; reasoningMs = 0L; toolLabel = null; tools = ToolActivity(); editSteps { StepLog() }; pendingReply = null; runFailed = false
        try {
            val text = block(callbacks(g))
            if (g != gen) return // another chat is open now: this stream's end changes nothing
            toolLabel = null
            commitReply(text)
            runId?.let(::rememberFinished)
            resetStream(); finishRun()
        } catch (e: CancellationException) {
            // The app left the screen or the process is going away. The hub keeps the run alive, so keep what we have and
            // leave the saved run id in place: the next launch reattaches and fills in the rest.
            val partial = streamText; val thinking = streamReasoning; val took = reasoningDuration()
            if (g != gen) throw e
            resetStream()
            if (partial.isNotBlank() || thinking.isNotBlank()) push(UiMessage(role = "assistant", content = partial, reasoning = thinking, reasoningMs = took, runId = runId))
            throw e
        } catch (e: AuthRequiredException) {
            if (g == gen) resetStream(); error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) }; throw e
        } catch (e: Exception) {
            if (g != gen) throw e
            resetStream(); error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Chat failed"
            throw e
        }
    }

    /**
     * The streamed reply becomes a message: its thinking, timing and steps, plus the hub's ids from its message.new when that
     * already came (it usually does: the hub announces the reply before the run stream closes). Merged by run_id.
     */
    private fun commitReply(text: String) {
        val log = synchronized(stepsLock) { steps.settle(runFailed) }; val pending = pendingReply?.takeIf { p -> p.runId == null || runId == null || p.runId == runId }
        if (text.isEmpty() && streamReasoning.isEmpty() && pending == null) return
        val local = UiMessage(role = "assistant", content = text, reasoning = streamReasoning, reasoningMs = reasoningDuration(), steps = log.toToolSteps(), runId = runId)
        val m = if (pending != null && messages.none { it.hubId == pending.hubId }) MessageMerge.merge(local, pending).copy(content = text.ifEmpty { pending.content }) else local
        push(m)
    }
    /** The reply just committed, when it has a hub id (the ViewModel stores its thinking and steps in the device cache). */
    val lastCommitted: UiMessage? get() = messages.lastOrNull()?.takeIf { it.role == "assistant" && it.hubId != null }

    /** `run.step` from live v2 for the reply streaming here: same rows as the run stream's own events (deduped by tool_id). */
    fun applyRunStep(s: dev.foxfleet.app.data.live.RunStep) {
        if (!streaming || (s.runId != null && runId != null && s.runId != runId)) return
        editSteps { steps -> when (s.kind) {
            // run.step `preview` is the arguments on tool.start and the result on tool.end (LIVE-EVENTS.md, RunStep)
            "tool.start", "tool.progress" -> s.name?.let { steps.tool(s.kind, s.toolId, it, s.preview, s.ok, s.durationMs) } ?: steps
            "tool.end" -> s.name?.let { steps.tool(s.kind, s.toolId, it, null, s.ok, s.durationMs, result = s.preview) } ?: steps
            else -> s.text?.let { steps.note(s.kind, it) } ?: steps
        } }
    }

    /** The run stream's `hermes.tool.progress` (see [StepLog.legacyTool]). */
    internal fun toolTick(name: String) = editSteps { it.legacyTool(name) }

    /**
     * Every change to the step list is one read-modify-write under a lock: the run stream's callbacks run on an IO thread
     * while live v2's run.step and run.finished arrive on the main thread, often for the same call at the same moment.
     */
    private fun editSteps(f: (StepLog) -> StepLog) { synchronized(stepsLock) { steps = f(steps) } }

    /** live v2 `run.finished` for the reply streaming here: its calls are settled even if the run stream is slow to close. */
    fun runEnded(run: String?, state: String?) {
        if (!streaming || (run != null && runId != null && run != runId)) return
        if (state in FAILED_RUN) runFailed = true
        editSteps { it.settle(runFailed) }
    }

    fun finishRun() { runId = null; pendingUser = null; persist(SavedChat(sessionId, null, null)) }

    /**
     * Runs whose stream this chat followed to the end and committed (0.4.2). The hub can still report such a run as the queue's
     * active run for a moment after its stream closed; following it again replayed the whole reply and committed it a second time
     * (the "second reply shows twice until reopen" bug). Bounded: run ids are unique, only the newest few can still be reported.
     */
    private val finishedRuns = LinkedHashSet<String>()
    private fun rememberFinished(run: String) { finishedRuns.remove(run); finishedRuns.add(run); while (finishedRuns.size > 16) finishedRuns.remove(finishedRuns.first()) }
    internal fun finishedRun(run: String) = run in finishedRuns

    // ---- sending while the agent works ----

    /** The hub stores the message first; the mode decides what happens if the agent is busy. A rejected send returns its text so nothing is lost. */
    suspend fun sendBusy(api: HubApi, agent: String, userText: String, images: List<dev.foxfleet.app.data.ImageAttachment>, mode: String): String? {
        val clientId = java.util.UUID.randomUUID().toString()
        val local = HubApi.QueuedMessage(clientId, if (mode == "interrupt") "awaiting_stop" else if (mode == "queue") "queued" else "sending", mode, userText)
        queue = queue + local; submitting++
        try {
            val r = api.sendMessage(agent, UiMessage(role = "user", content = userText, images = images), sessionId, mode, clientId)
            queue = queue.map { if (it.id == clientId) r.message else it }
        } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { queue = queue.filter { it.id != clientId }; throw e } catch (e: Exception) {
            queue = queue.filter { it.id != clientId }; error = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Not sent"; return userText
        } finally { submitting-- }
        return null
    }

    /**
     * Reads the hub's queue for this conversation: shows what is waiting and follows the next reply when the hub has started one
     * (a queued message, or the replacement after Interrupt & send). Call after a send, a finished reply, a reload or a reconnect.
     */
    suspend fun syncQueue(api: HubApi, agent: String, attempts: Int = 0) {
        val s = sessionId; val q = try { api.queue(agent, s) } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
        if (s != sessionId) return
        val running = q.items.firstOrNull { it.runId != null && it.runId == q.activeRun }
        // the run ended (guidance) or Hermes started the queued turn itself: the text joins the transcript
        val gone = queue.filter { (it.state == "guidance_accepted" || (it.state == "queued" && it.ack == "queued")) && q.items.none { i -> i.id == it.id } }
        if (gone.isNotEmpty()) messages = messages + gone.map { UiMessage(role = "user", content = it.text) }
        if (submitting == 0) { queue = q.items.filter { it.id !in dismissed && it !== running && it.state != "sending" && it.state != "running" }; halted = q.halted; canCancel = q.canCancel; requests = q.openRequests }
        if (q.activeRun != null && !streaming && runId == null && q.activeRun !in finishedRuns) { resume(api, agent, q.activeRun, running?.text); syncQueue(api, agent); return }
        if (q.activeRun == null && !q.halted && attempts < 12 && q.items.any { it.state == "queued" || it.state == "awaiting_stop" }) { delay(300); syncQueue(api, agent, attempts + 1) }
    }
    private val dismissed = mutableSetOf<String>()
    /** Taking a message back, or hiding one Hermes refused (Hermes keeps no copy of that). */
    fun dropQueued(id: String) { dismissed.add(id); queue = queue.filter { it.id != id } }

    /** Answers a card. It disappears once the hub took the answer, or said it was already closed (404). Returns an error text, or null. */
    suspend fun answerRequest(api: HubApi, agent: String, id: String, result: kotlinx.serialization.json.JsonObject): String? {
        val s = sessionId ?: return "No conversation yet"
        return try { api.answerRequest(agent, s, id, result); requests = requests.filter { it.id != id }; null }
        catch (e: CancellationException) { throw e }
        catch (e: HubApiException) { if (e.status == 404) { requests = requests.filter { it.id != id }; null } else e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Could not send the answer" }
        catch (e: AuthRequiredException) { throw e } catch (_: Exception) { "Could not send the answer" }
    }

    // ---- stable ids and reactions ----

    /**
     * The hub takes a message's hub id as a reaction target and keys its snapshot by hub id too (`reactionEvents`, 0.4.1).
     * Off (older hubs): reactions address the provider id, which a message that arrived live only gets later.
     */
    var hubIdReactions by mutableStateOf(false)
    /** Called with each snapshot the hub confirmed (the ViewModel keeps it in the device cache). */
    var onReactionsSaved: ((sessionId: String, snapshot: dev.foxfleet.app.data.ReactionSnapshot) -> Unit)? = null
    private fun confirmed(s: String, snap: dev.foxfleet.app.data.ReactionSnapshot) { reactions = snap; onReactionsSaved?.invoke(s, snap) }

    /**
     * A live turn has no provider ids yet. Once it ended, read the newest page and give shown messages the ids the hub knows for their
     * hub ids (whatever their text). Without hub ids (older hubs), swap the newest page for the stored one, but only when the stored
     * copy already ends with the same message: a provider may persist after the stream closes.
     */
    suspend fun reconcile(api: HubApi, agent: String) {
        val s = sessionId ?: return; val start = messages
        if (streaming || loading || start.isEmpty() || !MessageMerge.needsIds(start)) return
        val page = try { api.messages(agent, s, limit = PAGE) } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
        if (s != sessionId || streaming || page.messages.isEmpty()) return
        // 1) by hub id: safe even if the list changed meanwhile (0.4.0 needed the exact text, and a reply whose stored copy joins its
        //    steps with a blank line never got its id, so it could not be reacted to)
        val now = messages; val bound = MessageMerge.bindIds(now, page.messages)
        if (bound !== now) { messages = bound; return }
        // 2) no hub ids: the stored page must end with the same exchange (last two messages), not merely a repeated answer.
        if (now !== start) return
        fun same(a: UiMessage?, b: UiMessage?) = a == null || (b != null && a.role == b.role && a.content.trim() == b.content.trim())
        if (!same(start.last(), page.messages.last()) || !same(start.getOrNull(start.size - 2), page.messages.getOrNull(page.messages.size - 2))) return
        val first = page.messages.first().id; val boundary = if (first != null) start.indexOfFirst { it.id == first } else -1
        messages = MessageMerge.carry(start, (if (boundary >= 0) start.take(boundary) else emptyList()) + page.messages)
        if (boundary < 0) { hasOlder = page.hasMore; olderOffset = PAGE } // the stored page replaced everything we had
    }

    suspend fun refreshReactions(api: HubApi, agent: String) {
        val s = sessionId ?: return
        if (reacting > 0) return
        val snap = try { api.reactions(agent, s) } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (_: Exception) { return }
        if (s == sessionId && reacting == 0) confirmed(s, snap)
    }

    /** The device cache's snapshot while the hub's is not in yet (cache-first open, offline). Never over a fresher one. */
    fun showCachedReactions(sessionId: String, snap: dev.foxfleet.app.data.ReactionSnapshot) {
        if (sessionId == this.sessionId && reactions == null) reactions = snap
    }

    /** `message.reaction` (live v2, replayed after a reconnect): the full set on one message replaces what was shown. */
    fun applyReactionEvent(hubId: String, upstreamId: String?, groups: List<dev.foxfleet.app.data.ReactionGroup>) {
        val snap = reactions ?: return
        val id = upstreamId ?: messages.firstOrNull { it.hubId == hubId }?.id
        reactions = snap.replace(hubId, id, groups)
    }

    /** Where a reaction on [m] goes: its hub id on 0.4.1 hubs, else its provider id (null: not known yet). */
    fun reactionTarget(m: UiMessage): String? = if (hubIdReactions && m.hubId != null) m.hubId else m.id

    /** Quick row, picker and double tap: add [emoji], or take yours back when you already gave it. */
    suspend fun toggleReaction(api: HubApi, agent: String, m: UiMessage, emoji: String) {
        val snap = reactions ?: run { refreshReactions(api, agent); reactions } ?: run { reactionError = "Couldn't load reactions. Try again."; return }
        react(api, agent, m, emoji, MessageActions.nextReaction(snap.groupsFor(current(m)), snap.actor.id, emoji))
    }

    /** The shown copy of [m] (its ids may have arrived since the menu opened). */
    private fun current(m: UiMessage): UiMessage = m.hubId?.let { h -> messages.firstOrNull { it.hubId == h } } ?: m.id?.let { id -> messages.firstOrNull { it.id == id } } ?: m

    /** Optimistic: shows at once, rolls back (with a short reason) and re-reads the hub when the change fails. */
    suspend fun react(api: HubApi, agent: String, message: UiMessage, emoji: String, present: Boolean) {
        val s = sessionId ?: return; val before = reactions ?: return
        var m = current(message)
        reactions = before.apply(m, emoji, present); reactionError = null; reacting++
        var failed = false
        try {
            var target = reactionTarget(m)
            if (target == null) { // an older hub and a message that only arrived live: learn its provider id first
                reconcile(api, agent); m = current(m); target = m.id
                if (target == null) throw HubApiException(404, "Message not found", code = "message_not_found")
            }
            val snap = api.react(agent, s, target, emoji, present)
            if (s == sessionId && reacting == 1) confirmed(s, snap)
        } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { if (s == sessionId) reactions = before; throw e } catch (e: Exception) {
            failed = true; if (s == sessionId) { reactions = before; reactionError = HubApi.reactionErrorText(e) }
        } finally { reacting-- }
        if (failed) refreshReactions(api, agent)
    }

    /** Pills and older callers that only know a provider id. */
    suspend fun react(api: HubApi, agent: String, messageId: String, emoji: String, present: Boolean) {
        val m = messages.firstOrNull { it.id == messageId } ?: UiMessage("user", "", id = messageId)
        react(api, agent, m, emoji, present)
    }

    /** Optimistic delete-for-me: hides at once, rolls back and re-reads the hub when the change fails. */
    suspend fun hide(api: HubApi, agent: String, messageId: String, present: Boolean) {
        val s = sessionId ?: return; val before = reactions ?: return
        reactions = before.copy(hidden = (before.hidden ?: emptySet()).let { if (present) it + messageId else it - messageId }); reactionError = null; reacting++
        // a new hide takes the Undo row over; Undo (present = false) closes only its own row
        if (present) hiddenUndo = messageId else if (hiddenUndo == messageId) hiddenUndo = null
        var failed = false
        try {
            val snap = api.hide(agent, s, messageId, present)
            if (s == sessionId && reacting == 1) reactions = snap
        } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { if (s == sessionId) reactions = before; throw e } catch (_: Exception) {
            failed = true; if (s == sessionId) { reactions = before; if (hiddenUndo == messageId) hiddenUndo = null; reactionError = "Couldn't hide the message. Try again." }
        } finally { reacting-- }
        if (failed) refreshReactions(api, agent)
    }
}

/** Run states that mean the run failed (calls without an end are then shown as failed). */
private val FAILED_RUN = setOf("failed", "error")
