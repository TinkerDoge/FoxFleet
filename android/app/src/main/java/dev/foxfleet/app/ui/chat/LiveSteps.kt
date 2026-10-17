package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.ToolEvent
import dev.foxfleet.app.data.ToolStep

/**
 * One line of a reply's live progress (0.4.1): a tool call (running, done or failed, with a short preview and how long it took),
 * or a short commentary / status / sub-agent line the agent wrote while it worked.
 */
data class LiveStep(
    val key: String,
    /** "tool", "commentary", "status" or "subagent". */
    val kind: String,
    val name: String = "",
    val preview: String = "",
    val text: String = "",
    /** "running", "ok" or "failed" for tools; "info", "warn" or "error" for status lines. */
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
data class StepLog(val steps: List<LiveStep> = emptyList()) {
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
        if (old != null && old.state != "running" && !ended) return this // a start or progress replayed after its end
        val base = old ?: LiveStep(key, "tool", name = name.take(NAME_MAX), startedAt = now)
        val next = base.copy(
            name = base.name.ifBlank { name.take(NAME_MAX) },
            preview = preview?.takeIf { it.isNotBlank() }?.let(::oneLine)?.take(PREVIEW_MAX) ?: base.preview,
            state = if (ended) (if (ok == false) "failed" else if (old?.state == "failed") "failed" else "ok") else "running",
            durationMs = if (ended) (durationMs ?: base.durationMs ?: (if (base.startedAt >= 0) (now - base.startedAt).coerceAtLeast(0) else null)) else base.durationMs,
            result = result?.takeIf { it.isNotBlank() }?.let(::oneLine)?.take(RESULT_MAX) ?: base.result,
        )
        if (old == next && steps.getOrNull(i)?.key == key) return this
        val list = if (i >= 0) steps.toMutableList().also { it[i] = next } else steps + next
        return StepLog(list.takeLast(MAX))
    }

    fun tool(e: ToolEvent, now: Long = System.currentTimeMillis()) = tool(e.type, e.toolId, e.name, e.preview, e.ok, e.durationMs, e.resultPreview, now)

    /** Older hubs: only `hermes.tool.progress {tool}`. A new name means the one before it finished. */
    fun legacyTool(name: String, now: Long = System.currentTimeMillis()): StepLog {
        if (name.isBlank()) return this
        val last = steps.lastOrNull()
        if (last != null && last.running && last.key.startsWith("legacy:") && last.name.equals(name, ignoreCase = true)) return this
        if (steps.any { it.running && !it.key.startsWith("legacy:") }) return this // per-call events already cover it
        val settled = steps.map { if (it.running && it.key.startsWith("legacy:")) it.copy(state = "ok", durationMs = (now - it.startedAt).takeIf { d -> it.startedAt >= 0 && d >= 0 }) else it }
        val key = "legacy:${name.lowercase()}#${steps.size}"
        return StepLog((settled + LiveStep(key, "tool", name = name.take(NAME_MAX), startedAt = now)).takeLast(MAX))
    }

    /** `foxfleet.step` / `run.step` commentary, status or sub-agent line. Repeats of the newest line of that kind are dropped. */
    fun note(kind: String, text: String, level: String? = null, now: Long = System.currentTimeMillis()): StepLog {
        val k = kind.takeIf { it in NOTE_KINDS } ?: return this
        val t = oneLine(text).take(TEXT_MAX); if (t.isEmpty()) return this
        if (steps.lastOrNull { it.kind == k }?.text == t) return this
        val st = when (level) { "warn", "error" -> level; else -> "info" }
        return StepLog((steps + LiveStep("n:${steps.size}:$k", k, text = t, state = st, startedAt = now)).takeLast(MAX))
    }

    /** The reply ended: anything still running is settled (its end was lost or never sent). */
    fun settle(now: Long = System.currentTimeMillis()): StepLog =
        if (running.isEmpty()) this else StepLog(steps.map { if (it.running) it.copy(state = "ok", durationMs = it.durationMs ?: (now - it.startedAt).takeIf { d -> it.startedAt >= 0 && d >= 0 }) else it })

    /** What a committed message keeps (the same shape as history and message.new `tools`). */
    fun toToolSteps(): List<ToolStep> = steps.filter { it.isTool }.map { ToolStep(it.name, it.preview, it.result, it.state != "failed") }

    companion object {
        const val MAX = 40; const val NAME_MAX = 80; const val PREVIEW_MAX = 200; const val RESULT_MAX = 500; const val TEXT_MAX = 300
        val NOTE_KINDS = setOf("commentary", "status", "subagent")
        private fun oneLine(s: String) = s.replace(Regex("\\s+"), " ").trim()
        /** A finished message's tools as rows (no timing: history does not keep it). */
        fun of(tools: List<ToolStep>): StepLog = StepLog(tools.mapIndexed { i, t -> LiveStep("h:$i", "tool", name = t.name, preview = oneLine(t.args).take(PREVIEW_MAX), state = if (t.ok) "ok" else "failed", result = oneLine(t.result).take(RESULT_MAX)) })
        /** "1.2 s", "850 ms", "2 min 5 s". */
        fun duration(ms: Long?): String? = when {
            ms == null || ms < 0 -> null
            ms < 1000 -> "$ms ms"
            ms < 60_000 -> String.format(java.util.Locale.US, "%.1f s", ms / 1000.0)
            else -> "${ms / 60_000} min ${(ms % 60_000) / 1000} s"
        }
    }
}
