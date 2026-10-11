package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.ReactionSnapshot
import dev.foxfleet.app.data.ToolEvent

/** One running tool call, keyed by turn and call id so overlapping calls stay separate. */
data class ActiveTool(val key: String, val name: String)

/** Running calls plus the ones that already ended (a replayed start after its end is ignored). Same rules as the web app. */
data class ToolActivity(val active: List<ActiveTool> = emptyList(), val ended: List<String> = emptyList()) {
    fun update(e: ToolEvent): ToolActivity {
        val key = "${e.turnId.orEmpty()}:${e.toolId?.takeIf { it.isNotEmpty() } ?: "legacy"}"
        if (e.type == "tool.end") return ToolActivity(active.filter { it.key != key }, (ended.filter { it != key } + key).takeLast(1024))
        if (key in ended) return this
        return ToolActivity((active.filter { it.key != key } + ActiveTool(key, e.name)).takeLast(32), ended)
    }
}

/** One safe, short line per tool: an icon name and a description, never raw arguments, paths or results. */
fun toolPresentation(name: String): Pair<String, String> {
    val n = name.lowercase()
    return when {
        Regex("search|browse|web|fetch").containsMatchIn(n) -> "search" to "Searching the web"
        Regex("read|open_file|view").containsMatchIn(n) -> "file" to "Reading a file"
        Regex("write|edit|patch").containsMatchIn(n) -> "file" to "Updating a file"
        Regex("terminal|exec|shell|command|run").containsMatchIn(n) -> "bolt" to "Running a command"
        Regex("image|photo|vision").containsMatchIn(n) -> "image" to "Working with an image"
        Regex("^[a-zA-Z][a-zA-Z0-9_ .-]{0,50}$").matches(name) -> "tool" to "Using ${name.replace('_', ' ')}"
        else -> "tool" to "Using a tool"
    }
}

/** Optimistic local change; the hub's idempotent PUT/DELETE make the same change, so a retry never flips it back. */
fun ReactionSnapshot.apply(message: String, emoji: String, present: Boolean): ReactionSnapshot {
    val groups = (messages[message].orEmpty()).map { g -> g.copy(actors = g.actors.filter { it.id != actor.id || g.emoji != emoji }) }.toMutableList()
    if (present) {
        val at = groups.indexOfFirst { it.emoji == emoji }
        if (at >= 0) groups[at] = groups[at].copy(actors = groups[at].actors + actor) else groups += ReactionGroup(emoji, listOf(actor))
    }
    return copy(messages = messages + (message to groups.filter { it.actors.isNotEmpty() }))
}

/** Quick choices shown first in the picker. */
val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🦊")
