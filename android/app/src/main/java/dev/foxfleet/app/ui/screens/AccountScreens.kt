package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.Device
import dev.foxfleet.app.data.HubAddress
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubEntry
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * First launch (and "Add hub"): the app ships with no address. The user types one, pastes it, or arrives via
 * foxfleet://connect?hub=… . https is required; plain http only for local-network hubs after an explicit opt-in.
 */
@Composable
fun HubAddressScreen(
    initial: String,
    allowHttpInitial: Boolean,
    api: HubApi?,
    onConnect: suspend (url: String, allowHttp: Boolean) -> Unit,
    onCancel: (() -> Unit)? = null,
    errorPreview: String? = null,
    onScanned: (String) -> Unit = {},
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val c = LocalHubColors.current
    var text by remember { mutableStateOf(initial) }
    var allowHttp by remember { mutableStateOf(allowHttpInitial) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(errorPreview) }
    val scope = rememberCoroutineScope()
    val (cleaned, problem) = HubAddress.normalize(text, allowHttp)

    fun go() {
        val clean = cleaned
        if (clean == null) { error = problem; return }
        busy = true; error = null
        scope.launch {
            try {
                // Probe the address once it is stored as the active hub; the caller does that and checks /api/auth.
                onConnect(clean, allowHttp)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Couldn't reach that hub") } finally { busy = false }
        }
    }
    Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.Center) {
        Spacer(Modifier.height(32.dp))
        dev.foxfleet.app.ui.components.BrandWordmark(Modifier.fillMaxWidth(0.82f).height(52.dp))
        Spacer(Modifier.height(18.dp))
        Text("Connect to your hub", style = MaterialTheme.typography.titleLarge, color = c.text)
        Spacer(Modifier.height(6.dp))
        Text("Your hub is the server that talks to your agents. Enter its address, or open a connect link from the hub.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        Spacer(Modifier.height(22.dp))
        OutlinedTextField(
            text, { text = it; error = null }, label = { Text("Hub address") }, placeholder = { Text(HubAddress.PLACEHOLDER, color = c.textFaint) },
            singleLine = true, shape = RoundedCornerShape(14.dp), colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = androidx.compose.ui.text.input.ImeAction.Go),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { go() }),
        )
        Row(Modifier.fillMaxWidth().clickable { allowHttp = !allowHttp }.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(allowHttp, { allowHttp = it }, colors = CheckboxDefaults.colors(checkedColor = c.accent))
            Column {
                Text("Allow http on this network", style = MaterialTheme.typography.bodyMedium, color = c.text)
                Text("Only for a hub on your home or office network, or for development. Public hubs must use https.", style = MaterialTheme.typography.bodySmall, color = c.textFaint)
            }
        }
        Spacer(Modifier.height(20.dp))
        PrimaryAction(if (busy) "Checking…" else "Continue", Modifier.fillMaxWidth(), busy, enabled = text.isNotBlank()) { go() }
        val shown = error ?: if (text.isNotBlank() && cleaned == null) problem else null
        shown?.let { Spacer(Modifier.height(14.dp)); Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.align(Alignment.CenterHorizontally)) }
        TextButton(onClick = {
            // Google code scanner: runs in Play services, so the app needs no camera permission and no camera code.
            val options = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder().setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build()
            com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(context, options).startScan()
                .addOnSuccessListener { code -> code.rawValue?.let { raw -> val link = HubAddress.parseLink(raw); if (link != null) { text = link.hub; error = null; onScanned(raw) } else error = "That QR isn't an Foxfleet pairing code" } }
                .addOnFailureListener { error = "QR scanning needs Google Play services. Type the address instead." }
        }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Scan QR", color = c.accent) }
        onCancel?.let { TextButton(onClick = it, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Cancel", color = c.textMuted) } }
    }
}

/** Settings → Hubs: every hub this phone knows. One is active; each keeps its own sign-in. */
@Composable
fun HubsScreen(hubs: List<HubEntry>, activeId: String, onBack: () -> Unit, onSwitch: (String) -> Unit, onAdd: () -> Unit, onRemove: (String) -> Unit) {
    val c = LocalHubColors.current
    var confirm by remember { mutableStateOf<HubEntry?>(null) }
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        TopBar("Hubs", onBack) { TextButton(onClick = onAdd) { Text("Add", color = c.accent) } }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            Text("Switch between hubs, for example home and work. Each hub has its own account and agents.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp, 8.dp))
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    hubs.forEachIndexed { i, h ->
                        if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                        Row(Modifier.fillMaxWidth().clickable { onSwitch(h.id) }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(h.name, style = MaterialTheme.typography.bodyLarge, color = c.text)
                                Text(if (h.id == activeId) "Active" else "Tap to switch", style = MaterialTheme.typography.bodySmall, color = if (h.id == activeId) c.accent else c.textFaint)
                            }
                            TextButton(onClick = { confirm = h }) { Text("Remove", color = c.textMuted) }
                        }
                    }
                }
            }
        }
    }
    confirm?.let { h ->
        AlertDialog(onDismissRequest = { confirm = null }, containerColor = c.surface,
            title = { Text("Remove ${h.name}?") }, text = { Text("This phone forgets the hub and its sign-in. Nothing on the hub is deleted.") },
            confirmButton = { TextButton(onClick = { confirm = null; onRemove(h.id) }) { Text("Remove", color = c.textMuted) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Keep", color = c.accent) } })
    }
}

/** Settings → Devices: where this account is signed in, with revoke, sign out everywhere and password change. */
@Composable
fun DevicesScreen(api: HubApi?, onBack: () -> Unit, onSignedOut: () -> Unit, previewDevices: List<Device>? = null) {
    val c = LocalHubColors.current
    val scope = rememberCoroutineScope()
    var devices by remember { mutableStateOf(previewDevices) }
    var error by remember { mutableStateOf<String?>(null) }
    var changing by remember { mutableStateOf(false) }
    var confirmAll by remember { mutableStateOf(false) }
    fun reload() { if (api == null) return; scope.launch { try { devices = api.devices() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Couldn't load devices") } } }
    androidx.compose.runtime.LaunchedEffect(Unit) { if (previewDevices == null) reload() }
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        TopBar("Devices & security", onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            SectionLabel("Signed in")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    val list = devices
                    if (list == null) Text("Loading…", color = c.textMuted, modifier = Modifier.padding(16.dp))
                    else list.forEachIndexed { i, d ->
                        if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(d.name + if (d.current) " · this device" else "", style = MaterialTheme.typography.bodyLarge, color = c.text)
                                Text((if (d.kind == "app") "App" else "Browser") + " · " + lastSeen(d.lastSeen), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                            }
                            if (!d.current) TextButton(onClick = { scope.launch { try { api?.revokeDevice(d.id); reload() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Couldn't sign it out") } } }) { Text("Sign out", color = c.textMuted) }
                        }
                    }
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(8.dp)) }
            SectionLabel("Security")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    Text("Change password", style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = Modifier.fillMaxWidth().clickable { changing = true }.padding(16.dp))
                    Hairline(Modifier.padding(start = 16.dp))
                    Text("Sign out everywhere", style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = Modifier.fillMaxWidth().clickable { confirmAll = true }.padding(16.dp))
                    Hairline(Modifier.padding(start = 16.dp))
                    Text("Two-factor sign-in (authenticator app) is planned.", style = MaterialTheme.typography.bodySmall, color = c.textFaint, modifier = Modifier.padding(16.dp))
                }
            }
        }
    }
    if (changing) ChangePasswordDialog(onDismiss = { changing = false }) { cur, next ->
        try { api?.changePassword(cur, next); changing = false; reload(); null } catch (e: CancellationException) { throw e } catch (e: Exception) { scrubAddresses(e.message ?: "Couldn't change it") }
    }
    if (confirmAll) AlertDialog(onDismissRequest = { confirmAll = false }, containerColor = c.surface,
        title = { Text("Sign out everywhere?") }, text = { Text("Every phone and browser, including this one, will need to sign in again.") },
        confirmButton = { TextButton(onClick = { confirmAll = false; scope.launch { api?.logoutEverywhere(); onSignedOut() } }) { Text("Sign out everywhere", color = c.accent) } },
        dismissButton = { TextButton(onClick = { confirmAll = false }) { Text("Cancel", color = c.textMuted) } })
}

internal fun lastSeen(ms: Long): String {
    if (ms <= 0) return "never"
    val mins = (System.currentTimeMillis() - ms) / 60000
    return when { mins < 2 -> "active now"; mins < 60 -> "$mins min ago"; mins < 60 * 24 -> "${mins / 60} h ago"; else -> "${mins / 1440} d ago" }
}

@Composable
private fun ChangePasswordDialog(onDismiss: () -> Unit, onSubmit: suspend (String, String) -> String?) {
    val c = LocalHubColors.current
    val scope = rememberCoroutineScope()
    var cur by remember { mutableStateOf("") }; var next by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }; var busy by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = onDismiss, containerColor = c.surface, title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(cur, { cur = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), colors = fieldColors())
                OutlinedTextField(next, { next = it }, label = { Text("New password (10+ characters)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), colors = fieldColors())
                Text("Your other devices are signed out.", style = MaterialTheme.typography.bodySmall, color = c.textFaint)
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted) }
            }
        },
        confirmButton = { TextButton(enabled = !busy && cur.isNotEmpty() && next.length >= 10, onClick = { busy = true; scope.launch { error = onSubmit(cur, next); busy = false } }) { Text("Change", color = c.accent) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = c.textMuted) } })
}
