package dev.foxfleet.app.ui.chat

/** A composer suggestion: [insert] replaces the typed token. [local] commands act in the app. */
data class CommandSuggestion(val insert: String, val label: String, val hint: String, val local: LocalCommand? = null)

enum class LocalCommand { New, Sessions, Stop }

/** Hermes chat commands worth offering on a phone (prompt-style ones are sent as text). Other kinds get only the local ones. */
val HermesCommands = listOf(
    CommandSuggestion("/new", "/new", "Start a new conversation", LocalCommand.New),
    CommandSuggestion("/sessions", "/sessions", "Open recent sessions", LocalCommand.Sessions),
    CommandSuggestion("/stop", "/stop", "Stop the current reply", LocalCommand.Stop),
    CommandSuggestion("/btw ", "/btw", "Side question without interrupting"),
    CommandSuggestion("/bg ", "/bg", "Run a prompt in a background session"),
    CommandSuggestion("/usage", "/usage", "Token usage for this session"),
    CommandSuggestion("/reasoning ", "/reasoning", "Change reasoning effort or show/hide"),
    CommandSuggestion("/title ", "/title", "Name this session"),
    CommandSuggestion("/rollback", "/rollback", "List or restore file checkpoints"),
    CommandSuggestion("/help", "/help", "List the agent's commands"),
)

/**
 * Suggestions for the token being typed. `/` offers commands plus skills as `/<skill>`;
 * `#` offers skills. Only triggers while the token is the first word and has no space yet.
 */
fun commandSuggestions(input: String, skills: List<String>, limit: Int = 8, agentCommands: Boolean = true): List<CommandSuggestion> {
    if (input.isEmpty() || input.contains(' ') || input.contains('\n')) return emptyList()
    val q = input.drop(1).lowercase()
    return when (input[0]) {
        '/' -> (HermesCommands.filter { (agentCommands || it.local != null) && it.label.drop(1).startsWith(q) } +
            skills.filter { it.lowercase().startsWith(q) }.map { CommandSuggestion("/$it ", "/$it", "Skill") })
            .distinctBy { it.label }.take(limit)
        '#' -> skills.filter { it.lowercase().contains(q) }.sortedBy { if (it.lowercase().startsWith(q)) 0 else 1 }
            .map { CommandSuggestion("#$it ", "#$it", "Skill") }.take(limit)
        else -> emptyList()
    }
}

/** Exact local command typed and sent (e.g. "/new"), if any. */
fun localCommandFor(text: String): LocalCommand? =
    HermesCommands.firstOrNull { it.local != null && it.label == text.trim() }?.local
