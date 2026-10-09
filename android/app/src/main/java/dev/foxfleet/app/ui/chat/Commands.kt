package dev.foxfleet.app.ui.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
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

/** One catalog entry, kept whole so argument choices, aliases and what the agent can execute survive (flattened [CommandSuggestion]s lose them). */
data class CommandDef(
    val name: String, val aliases: List<String>, val description: String, val category: String, val args: String,
    val subcommands: List<String>, val availability: String, val handler: String = "", val executable: Boolean = true,
    val disabledReason: String = "", val unavailableSubcommands: Map<String, String> = emptyMap(),
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

    fun parse(text: String): List<CommandSuggestion> = fromDefs(parseDefs(text))

    /** Flattened suggestions (one per name and alias). A command the agent cannot execute is listed disabled with its reason. */
    fun fromDefs(defs: List<CommandDef>): List<CommandSuggestion> {
        val out = ArrayList<CommandSuggestion>()
        for (d in defs) {
            val avail = when { !d.executable -> "unavailable"; d.handler in listOf("hub:queue", "hub:steer", "hub:busy") -> "chat"; else -> d.availability }
            val reason = d.disabledReason
            for (n in listOf(d.name) + d.aliases) {
                if (avail == "app" && n !in appCommands) continue
                val hint = if (avail == "unavailable") "${d.description} · ${reason.ifEmpty { "Not available remotely" }}" else d.description
                out += CommandSuggestion("/$n" + if (d.args.isNotEmpty()) " " else "", "/$n", hint, if (avail == "app") appCommands[n] else null, d.category, d.args, avail, reason)
            }
        }
        return out.sortedWith(compareBy<CommandSuggestion>({ categoryOrder.indexOf(it.group).let { i -> if (i < 0) 99 else i } }, { when (it.availability) { "app" -> 0; "chat" -> 1; else -> 2 } }, { it.label }))
    }

    /** Whole definitions from a catalog JSON (the bundled one or the hub's per-agent one). */
    fun parseDefs(text: String): List<CommandDef> {
        val arr = runCatching { Json.parseToJsonElement(text).jsonObject["commands"]!!.jsonArray }.getOrNull() ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = runCatching { e.jsonObject }.getOrNull() ?: return@mapNotNull null
            fun s(k: String) = o[k]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
            fun list(k: String) = runCatching { o[k]!!.jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())
            val name = s("name").ifEmpty { return@mapNotNull null }
            CommandDef(name, list("aliases"), s("description"), s("category"), s("args"), list("subcommands"), s("availability").ifEmpty { "chat" }, s("handler"),
                o["executable"]?.let { runCatching { it.jsonPrimitive.boolean }.getOrNull() } ?: true, s("disabledReason").ifEmpty { s("reason") },
                runCatching { o["unavailableSubcommands"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content } }.getOrDefault(emptyMap()))
        }
    }
    val defs: List<CommandDef> by lazy { parseDefs(HermesCatalog::class.java.getResourceAsStream("/hermes-commands.json")?.bufferedReader()?.readText().orEmpty()) }

    fun unavailableReason(text: String): String? {
        val name = Regex("^/([A-Za-z0-9_-]+)").find(text.trim())?.groupValues?.get(1)?.lowercase() ?: return null
        return suggestions.firstOrNull { it.label == "/$name" && it.availability == "unavailable" }?.reason?.ifEmpty { "Not available remotely" }
    }
}

/**
 * Suggestions for the token being typed. `/` offers the grouped Hermes commands plus skills as `/<skill>`;
 * `#` offers skills. Only while the token is the first word. Agents that are not Hermes get only the local commands.
 */
fun commandSuggestions(input: String, skills: List<String>, limit: Int = 12, agentCommands: Boolean = true, defs: List<CommandDef>? = null): List<CommandSuggestion> {
    if (input.isEmpty()) return emptyList()
    if (input.contains(' ') || input.contains('\n')) return if (input[0] == '/' && (agentCommands || defs != null) && !input.contains('\n')) argSuggestions(input, defs ?: HermesCatalog.defs).take(limit) else emptyList()
    val q = input.drop(1).lowercase()
    return when (input[0]) {
        '/' -> ((if (defs != null) HermesCatalog.fromDefs(defs) else if (agentCommands) HermesCatalog.suggestions else localOnly).filter { it.label.drop(1).startsWith(q) } +
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

/** The command a typed name refers to; aliases resolve ("/q" is /queue). */
fun resolveCommand(name: String, defs: List<CommandDef> = HermesCatalog.defs): CommandDef? = defs.firstOrNull { name.lowercase() == it.name || name.lowercase() in it.aliases }

/**
 * Second-level choices: "/busy " lists queue, steer, interrupt, status; "/busy st" filters to steer and status.
 * Only while the one argument token is being typed; free text after a command is left alone.
 */
fun argSuggestions(input: String, defs: List<CommandDef> = HermesCatalog.defs): List<CommandSuggestion> {
    val m = Regex("^/([A-Za-z0-9_-]+)\\s+(\\S*)$").find(input) ?: return emptyList()
    val c = resolveCommand(m.groupValues[1], defs)?.takeIf { it.executable && it.subcommands.isNotEmpty() } ?: return emptyList()
    val q = m.groupValues[2].lowercase(); val more = Regex("<|\\bN\\b|prompt").containsMatchIn(c.args)
    val hits = c.subcommands.filter { it.lowercase().startsWith(q) }
    if (hits.size == 1 && hits[0].lowercase() == q) return emptyList()
    return hits.map { sub ->
        val off = c.unavailableSubcommands[sub]
        CommandSuggestion("/${m.groupValues[1]} $sub" + if (more && sub in listOf("add", "rm", "edit", "move")) " " else "", sub, off.orEmpty(), group = "Choices for /${c.name}", availability = if (off != null) "unavailable" else "chat", reason = off.orEmpty())
    }
}

/** The hub's own busy controls typed in the composer: "/queue text", "/steer text", "/busy steer" (aliases /q, /s). */
data class HubCommand(val cmd: String, val args: String, val def: CommandDef)
fun parseHub(text: String, defs: List<CommandDef> = HermesCatalog.defs): HubCommand? {
    val m = Regex("^/([A-Za-z0-9_-]+)(?:\\s+([\\s\\S]*))?$").find(text.trim()) ?: return null
    val c = resolveCommand(m.groupValues[1], defs) ?: return null
    val h = c.handler.removePrefix("hub:").ifEmpty { c.name }
    return if (h in listOf("queue", "steer", "busy")) HubCommand(h, m.groupValues[2].trim(), c) else null
}
