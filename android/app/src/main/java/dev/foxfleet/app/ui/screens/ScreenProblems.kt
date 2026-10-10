package dev.foxfleet.app.ui.screens

import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApiException

/** Which message a Bot Screen failure gets. Mirrors web/src/screen/problems.ts; both are checked against contract/screen-problems.vectors.json. */
enum class ScreenProblemKind(val key: String) {
    AuthExpired("auth_expired"), HubUnreachable("hub_unreachable"), MachineOffline("machine_offline"), HermesTooOld("hermes_too_old"),
    NotInstalled("not_installed"), NoVnc("no_vnc"), Blocked("blocked"), DashboardUnreachable("dashboard_unreachable"), Timeout("timeout"),
    Reopen("reopen"), HubTooOld("hub_too_old"), ViewerFailed("viewer_failed"), Generic("generic");

    companion object { fun byKey(k: String) = entries.firstOrNull { it.key == k } }
}

data class ScreenProblem(val kind: ScreenProblemKind, val update: Boolean = false)

fun screenProblem(status: Int? = null, code: String? = null, state: String? = null, network: Boolean = false, hubKnown: Boolean = true): ScreenProblem {
    fun mk(k: ScreenProblemKind, update: Boolean = false) = ScreenProblem(k, update)
    return when {
        network -> mk(ScreenProblemKind.HubUnreachable)
        status == 401 -> mk(ScreenProblemKind.AuthExpired)
        code == "machine_offline" -> mk(ScreenProblemKind.MachineOffline)
        code == "display_unsupported" -> mk(ScreenProblemKind.HermesTooOld)
        state == "not_installed" -> mk(ScreenProblemKind.NotInstalled)
        state == "no_vnc" -> mk(ScreenProblemKind.NoVnc)
        state == "blocked" -> mk(ScreenProblemKind.Blocked)
        code == "gateway_unreachable" || code == "dashboard_auth" -> mk(ScreenProblemKind.DashboardUnreachable)
        code == "timeout" -> mk(ScreenProblemKind.Timeout)
        code == "reopen" -> mk(ScreenProblemKind.Reopen)
        status == 404 -> mk(ScreenProblemKind.HubTooOld, true) // the route itself is missing: a hub that predates Bot Screen
        else -> mk(ScreenProblemKind.Generic, !hubKnown)
    }
}

fun screenProblemOf(e: Throwable, hubKnown: Boolean): ScreenProblem = when (e) {
    is AuthRequiredException -> screenProblem(status = 401)
    is HubApiException -> screenProblem(status = e.status.takeIf { it > 0 }, code = e.code, network = e.network, hubKnown = hubKnown)
    else -> screenProblem(hubKnown = hubKnown)
}

/** The sentence the screen shows (and the fix) for a problem; [detail] is the hub's own text where it adds something. */
fun screenProblemText(p: ScreenProblem, detail: String? = null, missing: List<String> = emptyList()): String {
    val base = when (p.kind) {
        ScreenProblemKind.AuthExpired -> "Your session expired. Sign in again to view the screen."
        ScreenProblemKind.HubUnreachable -> "Can't reach your hub right now. Check your connection and try again."
        ScreenProblemKind.MachineOffline -> "This agent's machine is offline. Start the Foxfleet connector there, then retry."
        ScreenProblemKind.HermesTooOld -> "This agent's Hermes has no Bot Screen. Update Hermes on that machine."
        ScreenProblemKind.NotInstalled -> "Bot Screen isn't installed on that machine yet. In its Hermes dashboard, open the agent's Screen tab and choose Install." + if (missing.isNotEmpty()) " Missing: ${missing.joinToString(", ")}." else ""
        ScreenProblemKind.NoVnc -> "That machine can't host a Bot Screen (no VNC support on this platform)."
        ScreenProblemKind.Blocked -> "The machine can't start a screen right now" + (detail?.let { ": $it" } ?: ".")
        ScreenProblemKind.DashboardUnreachable -> "The hub can't reach that agent's Hermes dashboard. Check that Hermes is running on the machine."
        ScreenProblemKind.Timeout -> "The screen took too long to start. Give it a moment, then retry."
        ScreenProblemKind.Reopen -> "The screen session expired. Reconnect, then take over."
        ScreenProblemKind.HubTooOld -> "Your hub is too old for Bot Screen. Update your hub."
        ScreenProblemKind.ViewerFailed -> "The screen viewer could not start on this phone" + (detail?.let { " ($it)" } ?: "") + ". Update the app or WebView and try again."
        ScreenProblemKind.Generic -> detail?.takeIf { it.isNotBlank() } ?: "The screen is unavailable right now."
    }
    return if (p.update && p.kind != ScreenProblemKind.HubTooOld) "$base Your hub is older than this app; update it for clearer screen errors." else base
}
