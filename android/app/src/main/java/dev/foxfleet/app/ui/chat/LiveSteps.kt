package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.ToolEvent
import dev.foxfleet.app.data.ToolStep

/**
 * One line of a reply's live progress (0.4.1): a tool call (running, done or failed, with a short preview and how long it took),
 * or a short commentary / status / sub-agent line the agent wrote while it worked.
 */
data class LiveStep(
    val key: String,
    /** "tool", "commentary" or "status" (a sub-agent line is a status line: the run stream says `subagent`, live v2 `status`). */
    val kind: String,
    val name: String = "",
    val preview: String = "",
    val text: String = "",
    /**
     * Tools: "running", "ok" (the agent reported success), "failed", or "done" (it ended but nobody said how: chat-completions
     * agents only announce starts, so their calls are settled as done when the run ends; never shown as a success check).
     * Notes: "info", "warn" or "error".
     */
    val state: String = "running",
    /** When it started (ms), or -1 when not known (a row from history). */
    val startedAt: Long = -1L,
    val durationMs: Long? = null,
    val result: String = "",
) {
    val isTool get() = kind == "tool"
    val running get() = isTool && state == "running"
}

/**
 * The reply's step list, merged from every source the hub has: the run stream (`foxfleet.tool`, `foxfleet.step`, legacy
 * `hermes.tool.progress`) and live v2 (`run.step`). A tool call is one row keyed by its tool_id, whichever source says it
 * first; an end that arrives twice, or a start replayed after its end, changes nothing. Immutable: each event returns a new log.
 */
data class StepLog(
    val steps: List<LiveStep> = emptyList(),
    /** A per-call event (foxfleet.tool / run.step with a tool_id) was seen: from then on the legacy `hermes.tool.progress` ticks are ignored. */
    val keyed: Boolean = false,
) {
    val isEmpty get() = steps.isEmpty()
    val running get() = steps.filter { it.running }
    val toolCount get() = steps.count { it.isTool }
    /** The compact live line: the newest running tool, else the newest commentary or status line. */
    val current: LiveStep? get() = steps.lastOrNull { it.running } ?: steps.lastOrNull { !it.isTool }

    private fun keyOf(toolId: String?, name: String): String = toolId?.takeIf { it.isNotBlank() }?.let { "t:$it" } ?: "legacy:${name.lowercase()}"

    fun tool(type: String, toolId: String?, name: String, preview: String? = null, ok: Boolean? = null, durationMs: Long? = null, result: String? = null, now: Long = System.currentTimeMillis()): StepLog {
        if (name.isBlank() && toolId.isNullOrBlank()) return this
        val legacyAt = if (toolId.isNullOrBlank()) steps.indexOfLast { it.key.startsWith("legacy:") && it.name.equals(name, ignoreCase = true) } else -1
        val key = if (legacyAt >= 0) steps[legacyAt].key else keyOf(toolId, name) + if (toolId.isNullOrBlank()) "#${steps.size}" else ""
        var i = steps.indexOfFirst { it.key == key }
        // the hub sends the legacy progress line next to the per-call start: that row becomes this call instead of a second one
        if (i < 0 && !toolId.isNullOrBlank()) i = steps.indexOfFirst { it.running && it.key.startsWith("legacy:") && it.name.equals(name, ignoreCase = true) }
        val old = steps.getOrNull(i)?.let { if (it.key != key) it.copy(key = key) else it }
        val ended = type == "tool.end"
        if (old != null && old.state != "running" && !ended) { // a start or progress replayed after its end: only a missing args preview is taken
            val p = preview?.takeIf { it.isNotBlank() }?.let(::oneLine)?.take(PREVIEW_MAX)
            return if (p != null && old.preview.isEmpty()) StepLog(steps.toMutableList().also { it[i] = old.copy(preview = p) }, keyed || !toolId.isNullOrBlank()) else this
        }
        val base = old ?: LiveStep(key, "tool", name = name.take(NAME_MAX), startedAt = now)
        val next = base.copy(
            name = base.name.ifBlank { name.take(NAME_MAX) },
            // the args preview is set by the start only: an end carries the result (run.step `preview` on tool.end is the result)
            preview = (if (ended) null else preview)?.takeIf { it.isNotBlank() }?.let(::oneLine)?.take(PREVIEW_MAX) ?: base.preview,
            // a real end beats a settled "done"; without `ok` nobody said it worked, so it stays neutral
            state = if (ended) (when (ok) { false -> "failed"; true -> "ok"; else -> if (old?.state == "failed") "failed" else if (old?.state == "ok") "ok" else "done" }) else "running",
            durationMs = if (ended) (durationMs ?: base.durationMs ?: (if (base.startedAt >= 0) (now - base.startedAt).coerceAtLeast(0) else null)) else base.durationMs,
            result = result?.takeIf { it.isNotBlank() }?.let(::oneLine)?.take(RESULT_MAX) ?: base.result,
        )
        val nowKeyed = keyed || !toolId.isNullOrBlank()
        if (old == next && steps.getOrNull(i)?.key == key && nowKeyed == keyed) return this
        var list = if (i >= 0) steps.toMutableList().also { it[i] = next } else {
            // a new call without an id (chat completions: starts only): the one before it has ended, outcome unknown
            val prev = if (toolId.isNullOrBlank() && !ended) steps.map { if (it.running && it.key.startsWith("legacy:")) it.copy(state = "done", durationMs = (now - it.startedAt).takeIf { d -> it.startedAt >= 0 && d >= 0 }) else it } else steps
            prev + next
        }
        // first per-call event: the legacy rows it did not adopt were ticks of the same calls (native gateway), not calls of their own
        if (nowKeyed && !keyed) list = list.filter { !it.key.startsWith("legacy:") }
        return StepLog(list.takeLast(MAX), nowKeyed)
    }

    fun tool(e: ToolEvent, now: Long = System.currentTimeMillis()) = tool(e.type, e.toolId, e.name, e.preview, e.ok, e.durationMs, e.resultPreview, now)

    /**
     * `hermes.tool.progress {tool}`: the only tool signal of chat-completions agents (once per start) and of 0.4.0 `/v1/runs` hubs.
     * Ignored once per-call events were seen (the native gateway repeats it on its own ticks) and for commentary text the hub
     * also sends in this frame (a tool name has no spaces). A new name means the call before it ended (outcome unknown: "done").
     */
    fun legacyTool(name: String, now: Long = System.currentTimeMillis()): StepLog {
        val n = name.trim()
        if (keyed || n.isEmpty() || n.any { it.isWhitespace() }) return this
        val last = steps.lastOrNull { it.isTool }
        if (last != null && last.running && last.key.startsWith("legacy:") && last.name.equals(n, ignoreCase = true)) return this
        val settled = steps.map { if (it.running && it.key.startsWith("legacy:")) it.copy(state = "done", durationMs = (now - it.startedAt).takeIf { d -> it.startedAt >= 0 && d >= 0 }) else it }
        val key = "legacy:${n.lowercase()}#${steps.size}"
        return StepLog((settled + LiveStep(key, "tool", name = n.take(NAME_MAX), startedAt = now)).takeLast(MAX), keyed)
    }

    /**
     * `foxfleet.step` (commentary, status, subagent) / `run.step` (commentary, status) line. A sub-agent line is a status line
     * (the run stream calls it `subagent`, live v2 `status`), so both sources make one row: a line already among the newest few
     * of its kind is not added again. A warn/error level from either copy is kept.
     */
    fun note(kind: String, text: String, level: String? = null, now: Long = System.currentTimeMillis()): StepLog {
        val k = when (kind) { "commentary" -> "commentary"; "status", "subagent" -> "status"; else -> return this }
        val t = oneLine(text).take(TEXT_MAX); if (t.isEmpty()) return this
        val st = when (level) { "warn", "error" -> level; else -> "info" }
        val same = steps.withIndex().filter { it.value.kind == k }.takeLast(DEDUPE_WINDOW).lastOrNull { it.value.text == t }
        if (same != null) return if (st != "info" && same.value.state == "info") StepLog(steps.toMutableList().also { it[same.index] = same.value.copy(state = st) }, keyed) else this
        return StepLog((steps + LiveStep("n:${steps.size}:$k", k, text = t, state = st, startedAt = now)).takeLast(MAX), keyed)
    }

    /**
     * The run ended (stream closed, run.finished, or the reply's message.new): calls still running get no end any more. They
     * become "done" (neutral, not a success check), or "failed" when the run itself failed. A real end arriving later still wins.
     */
    fun settle(failed: Boolean = false, now: Long = System.currentTimeMillis()): StepLog =
        if (running.isEmpty()) this else StepLog(steps.map { if (it.running) it.copy(state = if (failed) "failed" else "done", durationMs = it.durationMs ?: (now - it.startedAt).takeIf { d -> it.startedAt >= 0 && d >= 0 }) else it }, keyed)

    /** What a committed message keeps (the same shape as history and message.new `tools`; `ok` only when known). */
    fun toToolSteps(): List<ToolStep> = steps.filter { it.isTool }.map { ToolStep(it.name, it.preview, it.result, when (it.state) { "ok" -> true; "failed" -> false; else -> null }) }

    companion object {
        const val MAX = 40; const val NAME_MAX = 80; const val PREVIEW_MAX = 200; const val RESULT_MAX = 500; const val TEXT_MAX = 300
        val NOTE_KINDS = setOf("commentary", "status", "subagent")
        /** How many of the newest lines of a kind a repeat is checked against (the two sources can interleave). */
        const val DEDUPE_WINDOW = 4
        private fun oneLine(s: String) = s.replace(Regex("\\s+"), " ").trim()
        /** A finished message's tools as rows (no timing: history does not keep it). */
        fun of(tools: List<ToolStep>): StepLog = StepLog(tools.mapIndexed { i, t -> LiveStep("h:$i", "tool", name = t.name, preview = oneLine(t.args).take(PREVIEW_MAX), state = when (t.ok) { true -> "ok"; false -> "failed"; null -> "done" }, result = oneLine(t.result).take(RESULT_MAX)) })
        /** "1.2 s", "850 ms", "2 min 5 s". */
        fun duration(ms: Long?): String? = when {
            ms == null || ms < 0 -> null
            ms < 1000 -> "$ms ms"
            ms < 60_000 -> String.format(java.util.Locale.US, "%.1f s", ms / 1000.0)
            else -> "${ms / 60_000} min ${(ms % 60_000) / 1000} s"
        }
    }
}
