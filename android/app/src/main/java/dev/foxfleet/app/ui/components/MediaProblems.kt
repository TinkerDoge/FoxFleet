package dev.foxfleet.app.ui.components

/** Why a media card could not load. Mirrors web/src/chat/mediaProblems.ts; both are checked against contract/media-problems.vectors.json. */
enum class MediaProblem(val key: String, val text: String) {
    Outside("outside", "Not available: outside shared folders"),
    Denied("denied", "Not available: that location is never shared"),
    Missing("missing", "The file is gone from the agent's machine"),
    TooBig("too_big", "Too large to send (over the size limit)"),
    Type("type", "This file type isn't delivered"),
    Rate("rate", "Too many files at once. Try again in a minute"),
    MachineOffline("machine_offline", "The agent's machine is offline"),
    HubTooOld("hub_too_old", "Your hub needs an update to show agent media"),
    NotOffered("not_offered", "The hub doesn't know this file yet. Reopen the chat"),
    NoConnector("no_connector", "This agent can't send local files (no connector)"),
    AuthExpired("auth_expired", "Sign in again to see this file"),
    HubUnreachable("hub_unreachable", "Can't reach your hub"),
    Expired("expired", "This link expired. Reopen the chat"),
    Generic("generic", "Not available");

    companion object { fun byKey(k: String) = entries.firstOrNull { it.key == k } }
}

/** What the hub answered (or that it could not be reached). */
data class HubFailure(val status: Int = 0, val code: String? = null, val message: String? = null, val network: Boolean = false)

fun mediaProblem(f: HubFailure): MediaProblem {
    if (f.network) return MediaProblem.HubUnreachable
    val s = f.status; val c = f.code ?: ""; val m = (f.message ?: "").lowercase()
    return when {
        s == 401 -> MediaProblem.AuthExpired
        c == "outside" -> MediaProblem.Outside
        c == "denied" -> MediaProblem.Denied
        c == "missing" -> MediaProblem.Missing
        c == "too_big" || s == 413 -> MediaProblem.TooBig
        c == "type" || c == "sniff" || s == 415 -> MediaProblem.Type
        c == "rate" || s == 429 -> MediaProblem.Rate
        s == 410 -> MediaProblem.Expired
        s == 503 || s == 504 -> MediaProblem.MachineOffline
        s == 404 -> when { m.contains("not offered") -> MediaProblem.NotOffered; m.contains("cannot deliver local") -> MediaProblem.NoConnector; m == "not found" || m.isEmpty() -> MediaProblem.HubTooOld; else -> MediaProblem.NotOffered }
        else -> MediaProblem.Generic
    }
}

/** The folder a one-tap fix should share: the file's own directory ("" for URLs). */
fun allowMediaCommand(ref: String): String {
    if (ref.startsWith("http", ignoreCase = true) || ref.startsWith("data:")) return ""
    val i = maxOf(ref.lastIndexOf('/'), ref.lastIndexOf('\\')); if (i <= 0) return ""
    return "foxfleet connector allow-media \"${ref.substring(0, i)}\""
}
