package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import dev.foxfleet.app.ui.components.SoftButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.Machine
import dev.foxfleet.app.data.Pairing
import dev.foxfleet.app.data.PairingState
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the live status line says; shared by the screen and its tests. */
fun pairingStatusText(state: PairingState): String = when (state) {
    PairingState.Waiting -> "Waiting for the machine…"
    PairingState.Expired -> "This code has expired."
    is PairingState.Paired -> state.machine?.profiles?.takeIf { it.isNotEmpty() }?.let { "Found ${it.size} profile${if (it.size == 1) "" else "s"}: ${it.joinToString(", ")}" } ?: "Machine connected. Looking for profiles…"
}

/**
 * Manage > Machines. Lists computers running the connector (status, profiles, last seen) and runs the
 * "Connect a machine" flow: hub makes a 15-minute single-use code, the owner pastes the one-line command on the
 * computer (or opens the QR/link there), and the status line updates as the machine and its profiles arrive.
 * A foxfleet://pair link opened on this phone shows that code so the owner can finish at the machine.
 */
@Composable
fun MachinesScreen(api: HubApi, hub: String, initialCode: String?, onBack: () -> Unit, onChanged: () -> Unit) {
    var machines by remember { mutableStateOf<List<Machine>?>(null) }
    var pairing by remember { mutableStateOf<Pairing?>(initialCode?.let { fromCode(hub, it) }) }
    var machineId by remember { mutableStateOf<String?>(null) }
    var state by remember { mutableStateOf<PairingState>(PairingState.Waiting) }
    var error by remember { mutableStateOf<String?>(null) }
    var revoke by remember { mutableStateOf<Machine?>(null) }
    val scope = rememberCoroutineScope()
    fun load() { scope.launch { try { machines = api.machines() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Couldn't load machines"); if (machines == null) machines = emptyList() } } }
    fun start(id: String?) { scope.launch { try { error = null; machineId = id; state = PairingState.Waiting; pairing = if (id == null) api.createPairing() else api.rotateMachine(id) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Couldn't create a code") } } }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(pairing?.code) {
        val code = pairing?.code ?: return@LaunchedEffect
        while (state !is PairingState.Expired) {
            try {
                val s = api.pairingStatus(code)
                state = if (s is PairingState.Paired && s.machine != null) s.copy(machine = api.machines().firstOrNull { it.id == s.machine.id } ?: s.machine) else s
            } catch (e: CancellationException) { throw e } catch (_: Exception) { }
            delay(2000)
        }
    }
    MachinesContent(machines, pairing, state, error, onBack = { if (pairing != null) { pairing = null; load(); onChanged() } else onBack() },
        onConnect = { start(null) }, onRepair = { start(it.id) }, onRevoke = { revoke = it }, onNewCode = { start(machineId) })
    revoke?.let { m ->
        AlertDialog(onDismissRequest = { revoke = null }, title = { Text("Revoke ${m.name}?") }, text = { Text("It disconnects and its agents are removed. You can connect it again later with a new code.") },
            confirmButton = { SoftButton(onClick = { revoke = null; scope.launch { try { api.revokeMachine(m.id); load(); onChanged() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Couldn't revoke") } } }) { Text("Revoke") } },
            dismissButton = { SoftButton(onClick = { revoke = null }) { Text("Cancel") } })
    }
}

private fun fromCode(hub: String, code: String): Pairing {
    val url = hub.trimEnd('/') + "/c/" + code
    return Pairing(code, code.take(5) + "-" + code.drop(5), System.currentTimeMillis() + 15 * 60_000, url, "foxfleet://pair?hub=" + java.net.URLEncoder.encode(hub, "UTF-8") + "&code=" + code, null,
        "curl -fsSL $url | sh", "irm $url.ps1 | iex", "curl -fsSL ${hub.trimEnd('/')}/connector.mjs -o foxfleet-connector.mjs && node foxfleet-connector.mjs pair --hub ${hub.trimEnd('/')} --code $code")
}

@Composable
fun MachinesContent(
    machines: List<Machine>?, pairing: Pairing?, state: PairingState, error: String?,
    onBack: () -> Unit, onConnect: () -> Unit, onRepair: (Machine) -> Unit, onRevoke: (Machine) -> Unit, onNewCode: () -> Unit,
) {
    val c = LocalHubColors.current
    val clipboard = LocalClipboardManager.current
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        TopBar(if (pairing != null) "Connect a machine" else "Machines", onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp)) }
            if (pairing != null) {
                Text("Open a terminal on the computer that runs Hermes (macOS, Linux or WSL) and paste this. It needs Node.js 22 or newer; nothing else is installed.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp))
                Spacer(Modifier.height(10.dp))
                SoftCard(Modifier.fillMaxWidth()) { Text(pairing.sh, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = c.text, modifier = Modifier.padding(16.dp)) }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedAction("Copy command", Modifier.weight(1f)) { clipboard.setText(AnnotatedString(pairing.sh)) }
                    OutlinedAction("Copy Windows", Modifier.weight(1f)) { clipboard.setText(AnnotatedString(pairing.powershell)) }
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedAction("Copy as a prompt", Modifier.weight(1f)) { clipboard.setText(AnnotatedString("Run this command on this computer and answer its questions: ${pairing.sh}")) }
                    OutlinedAction("Copy link", Modifier.weight(1f)) { clipboard.setText(AnnotatedString(pairing.link)) }
                }
                SectionLabel("Pairing code")
                Text(pairing.display, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Monospace, letterSpacing = androidx.compose.ui.unit.TextUnit(2f, androidx.compose.ui.unit.TextUnitType.Sp)), color = c.text, modifier = Modifier.padding(horizontal = 4.dp))
                Text("Works once, for 15 minutes.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 4.dp))
                if (pairing.rows != null) {
                    Spacer(Modifier.height(14.dp))
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { QrCode(pairing.rows, Modifier.size(200.dp)) }
                    Text("Scan with a camera to open the pairing link in the machine's browser, or show this screen to it.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(8.dp))
                }
                Spacer(Modifier.height(12.dp))
                SoftCard(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(pairingStatusText(state), style = MaterialTheme.typography.titleMedium, color = if (state is PairingState.Paired && state.machine?.profiles?.isNotEmpty() == true) c.text else c.textMuted, modifier = Modifier.weight(1f))
                        if (state is PairingState.Expired) SoftButton(onClick = onNewCode) { Text("New code", color = c.accent) }
                    }
                }
                Spacer(Modifier.height(32.dp))
            } else {
                Text("A machine is a computer running the Foxfleet connector. One connector shares all of its Hermes profiles, and nothing on it needs an open port.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp))
                PrimaryAction("Connect a machine", Modifier.fillMaxWidth(), false, onClick = onConnect)
                Spacer(Modifier.height(12.dp))
                when {
                    machines == null -> Unit
                    machines.isEmpty() -> Text("No machines yet. Connect one and its Hermes profiles show up as agents.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(8.dp))
                    else -> SoftCard(Modifier.fillMaxWidth()) {
                        Column {
                            machines.forEachIndexed { i, m ->
                                if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(Modifier.size(10.dp).clip(CircleShape).background(if (m.online) c.online else c.offline))
                                        Spacer(Modifier.size(8.dp))
                                        Text(m.name, style = MaterialTheme.typography.titleMedium, color = c.text, modifier = Modifier.weight(1f))
                                        Text(if (m.online) "Online" else m.lastSeen?.let { "Last seen " + lastSeen(it) } ?: "Never connected", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                                    }
                                    Text(if (m.profiles.isEmpty()) "No profiles shared yet" else m.profiles.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(start = 18.dp, top = 2.dp))
                                    Row { SoftButton(onClick = { onRepair(m) }) { Text("Re-pair", color = c.accent) }; SoftButton(onClick = { onRevoke(m) }) { Text("Revoke", color = androidx.compose.ui.graphics.Color(0xFFC4372B)) } }
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(32.dp))
            }
        }
    }
}
