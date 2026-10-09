package dev.foxfleet.app.ui.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * A composer suggestion: [insert] replaces the typed token. [local] commands act in the app.
 * [availability]: "app" (Foxfleet runs it), "chat" (sent as a message) or "unavailable" (terminal/platform only, with a [reason]).
 */
data class CommandSuggestion(
    val insert: String, val label: String, val hint: String, val local: LocalCommand? = null,
    val group: String = "", val args: String = "", val availability: String = "chat", val reason: String = "",
)

enum class LocalCommand { New, Sessions, Stop, Retry, Title }

private val appCommands = mapOf("new" to LocalCommand.New, "reset" to LocalCommand.New, "history" to LocalCommand.Sessions, "resume" to LocalCommand.Sessions,
    "sessions" to LocalCommand.Sessions, "stop" to LocalCommand.Stop, "retry" to LocalCommand.Retry, "title" to LocalCommand.Title)
private val categoryOrder = listOf("Session", "Configuration", "Info", "Tools & Skills", "Context", "Background & Automation", "Plugins", "Exit")

/** Always available for every agent kind: they act on the conversation in the app. */
private val localOnly = listOf(
    CommandSuggestion("/new", "/new", "Start a new conversation", LocalCommand.New, "Chat", availability = "app"),
    CommandSuggestion("/sessions", "/sessions", "Open history", LocalCommand.Sessions, "Chat", availability = "app"),
    CommandSuggestion("/stop", "/stop", "Stop the current reply", LocalCommand.Stop, "Chat", availability = "app"),
)

/**
 * The Hermes slash-command list, bundled as a resource (generated from hermes-agent's COMMAND_REGISTRY by
 * design/tools/gen-hermes-commands.py). The hub serves the same list at /api/agents/{name}/commands.
 */
object HermesCatalog {
    val suggestions: List<CommandSuggestion> by lazy { parse(HermesCatalog::class.java.getResourceAsStream("/hermes-commands.json")?.bufferedReader()?.readText().orEmpty()) }

    fun parse(text: String): List<CommandSuggestion> {
        val arr = runCatching { Json.parseToJsonElement(text).jsonObject["commands"]!!.jsonArray }.getOrNull() ?: return emptyList()
        val out = ArrayList<CommandSuggestion>()
        for (e in arr) {
            val o = runCatching { e.jsonObject }.getOrNull() ?: continue
            fun s(k: String) = o[k]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
            val name = s("name").ifEmpty { continue }
            val aliases = runCatching { o["aliases"]!!.jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())
            val avail = s("availability").ifEmpty { "chat" }; val args = s("args"); val reason = s("reason")
            for (n in listOf(name) + aliases) {
                if (avail == "app" && n !in appCommands) continue
                val hint = if (avail == "unavailable") "${s("description")} · ${reason.ifEmpty { "Not available remotely" }}" else s("description")
                out += CommandSuggestion("/$n" + if (args.isNotEmpty()) " " else "", "/$n", hint, if (avail == "app") appCommands[n] else null, s("category"), args, avail, reason)
            }
        }
        return out.sortedWith(compareBy<CommandSuggestion>({ categoryOrder.indexOf(it.group).let { i -> if (i < 0) 99 else i } }, { when (it.availability) { "app" -> 0; "chat" -> 1; else -> 2 } }, { it.label }))
    }

    fun unavailableReason(text: String): String? {
        val name = Regex("^/([A-Za-z0-9_-]+)").find(text.trim())?.groupValues?.get(1)?.lowercase() ?: return null
        return suggestions.firstOrNull { it.label == "/$name" && it.availability == "unavailable" }?.reason?.ifEmpty { "Not available remotely" }
    }
}

/**
 * Suggestions for the token being typed. `/` offers the grouped Hermes commands plus skills as `/<skill>`;
 * `#` offers skills. Only while the token is the first word. Agents that are not Hermes get only the local commands.
 */
fun commandSuggestions(input: String, skills: List<String>, limit: Int = 12, agentCommands: Boolean = true): List<CommandSuggestion> {
    if (input.isEmpty() || input.contains(' ') || input.contains('\n')) return emptyList()
    val q = input.drop(1).lowercase()
    return when (input[0]) {
        '/' -> ((if (agentCommands) HermesCatalog.suggestions else localOnly).filter { it.label.drop(1).startsWith(q) } +
            (if (agentCommands) skills.filter { it.lowercase().startsWith(q) }.map { CommandSuggestion("/$it ", "/$it", "Skill", group = "Skills") } else emptyList()))
            .distinctBy { it.label }.take(limit)
        '#' -> if (!agentCommands) emptyList() else skills.filter { it.lowercase().contains(q) }.sortedBy { if (it.lowercase().startsWith(q)) 0 else 1 }
            .map { CommandSuggestion("#$it ", "#$it", "Skill", group = "Skills") }.take(limit)
        else -> emptyList()
    }
}

/** "/new", "/title My plan": a command Foxfleet runs itself, with its argument text. */
fun parseLocal(text: String, agentCommands: Boolean = true): Pair<LocalCommand, String>? {
    val m = Regex("^/([A-Za-z0-9_-]+)(?:\\s+([\\s\\S]*))?$").find(text.trim()) ?: return null
    val name = m.groupValues[1].lowercase(); val args = m.groupValues[2].trim()
    localOnly.firstOrNull { it.label == "/$name" }?.let { return if (args.isEmpty()) it.local!! to "" else null }
    if (!agentCommands) return null
    val cmd = appCommands[name] ?: return null
    return if (cmd == LocalCommand.Title) (if (args.isNotEmpty()) cmd to args else null) else if (args.isEmpty()) cmd to "" else null
}

/** Exact local command typed and sent (e.g. "/new"), if any. */
fun localCommandFor(text: String): LocalCommand? = parseLocal(text)?.first
