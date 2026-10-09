package dev.foxfleet.app.data

/** One field of an agent kind's schema (GET /api/agent-kinds). [writeOnly] fields are never sent back by the hub. */
data class KindField(
    val key: String,
    val label: String,
    val type: String,
    val required: Boolean = false,
    val writeOnly: Boolean = false,
    val default: String? = null,
    val advanced: Boolean = false,
    val help: String? = null,
    val options: List<String> = emptyList(),
    val whenKey: String? = null,
    val whenValue: String? = null,
) {
    val isEnum get() = type == "enum" && options.isNotEmpty()
    /** Fields tied to another field's value (e.g. host only for the direct connection) hide otherwise. */
    fun visible(form: Map<String, String>, kind: AgentKind): Boolean {
        if (whenKey == null) return true
        val current = form[whenKey]?.takeIf { it.isNotBlank() } ?: kind.fields.firstOrNull { it.key == whenKey }?.default
        return current == whenValue
    }
    val isSecret get() = type == "secret"
    val isNumber get() = type == "port"
}

data class AgentKind(
    val kind: String,
    val label: String,
    val summary: String,
    val planned: Boolean,
    val fields: List<KindField>,
    val auth: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
)

/** A saved agent as the owner sees it: plain fields plus has* flags for write-only ones. */
data class SavedAgent(
    val name: String,
    val kind: String,
    val values: Map<String, String> = emptyMap(),
    val saved: Set<String> = emptySet(),
) {
    val label get() = values["label"]?.takeIf { it.isNotBlank() } ?: name
    val description get() = values["description"].orEmpty()
    fun hasSaved(key: String) = key in saved
}

data class TestResult(val ok: Boolean, val checks: List<Pair<String, CheckResult>>)
data class CheckResult(val ok: Boolean, val message: String)

/** Result of saving: an inbox agent gets its MCP token exactly once. */
data class SaveResult(val agent: SavedAgent, val inboxToken: String? = null, val bootstrap: String? = null)

object Registry {
    val checkLabels = mapOf("dashboard" to "Dashboard", "management" to "Management", "api" to "Chat API", "inbox" to "Mailbox", "connector" to "Connector")

    /**
     * Builds the JSON fields to send for a form. On edit, blank write-only fields are omitted so the hub keeps
     * the saved value; blank optional plain fields are sent as "" (clears them). Ports are sent as numbers.
     */
    fun payload(kind: AgentKind, form: Map<String, String>, editing: Boolean): Map<String, Any> {
        val out = linkedMapOf<String, Any>()
        if (!editing) out["kind"] = kind.kind
        for (f in kind.fields) {
            if (editing && f.key == "name") continue
            if (!f.visible(form, kind)) continue
            val v = form[f.key]?.trim().orEmpty()
            if (v.isEmpty()) { if (f.isEnum && !editing && f.default != null) out[f.key] = f.default; else if (!f.writeOnly && editing) out[f.key] = ""; continue }
            out[f.key] = if (f.isNumber) (v.toIntOrNull() ?: v) else v
        }
        return out
    }

    /** First problem with a form, or null when it can be sent. */
    fun validate(kind: AgentKind, form: Map<String, String>, editing: Boolean, existing: SavedAgent? = null): String? {
        for (f in kind.fields) {
            if (!f.visible(form, kind)) continue
            val v = form[f.key]?.trim().orEmpty()
            if (f.key == "name" && !editing && !Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$").matches(v)) return "ID: letters, digits, . _ - (up to 64)"
            if (f.required && v.isEmpty() && !(editing && (f.key == "name" || (f.writeOnly && existing?.hasSaved(f.key) == true)))) return "${f.label} is required"
            if (f.isNumber && v.isNotEmpty() && (v.toIntOrNull() ?: 0) !in 1..65535) return "${f.label} must be 1–65535"
        }
        return null
    }

    fun moved(names: List<String>, index: Int, delta: Int): List<String> {
        val to = index + delta
        if (index !in names.indices || to !in names.indices) return names
        return names.toMutableList().apply { add(to, removeAt(index)) }
    }
}
