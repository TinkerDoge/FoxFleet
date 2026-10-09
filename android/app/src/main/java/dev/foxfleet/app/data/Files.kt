package dev.foxfleet.app.data

/** A file uploaded to the agent's disk through the hub; [path] is where the agent can open it. */
data class FileRef(val name: String, val path: String, val size: Long)

/** Chat-text marker for an uploaded file: the agent opens the path with its file tools. */
object FileMarker {
    private val line = Regex("^\\[Attached file: (.+) \\(([^()]+)\\)]$")
    const val MAX_BYTES = 90L * 1024 * 1024 // hub LIMITS.file

    fun of(f: FileRef) = "[Attached file: ${f.path} (${humanSize(f.size)})]"

    fun compose(text: String, files: List<FileRef>): String =
        if (files.isEmpty()) text else (listOf(text).filter { it.isNotBlank() } + files.map(::of)).joinToString("\n\n")

    /** Splits a user message into its text and the (path, size) of each file it carried. */
    fun split(text: String): Pair<String, List<Pair<String, String>>> {
        val files = mutableListOf<Pair<String, String>>(); val rest = mutableListOf<String>()
        for (l in text.lines()) { val m = line.find(l.trim()); if (m != null) files += m.groupValues[1] to m.groupValues[2] else rest += l }
        return rest.joinToString("\n").trim() to files
    }

    fun humanSize(bytes: Long): String = when {
        bytes >= 1024L * 1024 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0)
        bytes >= 1024 -> "${bytes / 1024} KB"
        else -> "$bytes B"
    }
}

/** Screen relay state from the hub (GET/POST /api/agents/{name}/screen/...). */
data class ScreenStatus(val running: Boolean, val supported: Boolean, val holder: String?, val blocker: String?)
