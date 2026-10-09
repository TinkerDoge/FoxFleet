package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AdminUser
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.Invite
import dev.foxfleet.app.data.Shareable
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Draws a QR from the hub's matrix rows ('1' dark). Always black on white with a quiet zone, so any scanner reads it. */
@Composable
fun QrCode(rows: List<String>, modifier: Modifier = Modifier.size(220.dp)) {
    Canvas(modifier.clip(RoundedCornerShape(12.dp)).background(Color.White)) {
        val n = rows.size.coerceAtLeast(1); val quiet = 3; val cell = size.minDimension / (n + quiet * 2)
        rows.forEachIndexed { r, row -> row.forEachIndexed { c, ch -> if (ch == '1') drawRect(Color.Black, Offset((c + quiet) * cell, (r + quiet) * cell), Size(cell + 0.5f, cell + 0.5f)) } }
    }
}

/** Owner-only: who may join, invites (copy link / QR / revoke), users (disable), and the phone pairing QR. */
@Composable
fun AdminScreen(
    api: HubApi?, onBack: () -> Unit,
    previewMode: String? = null, previewPairing: Shareable? = null, previewInvites: List<Invite>? = null, previewUsers: List<AdminUser>? = null, previewNewInvite: Shareable? = null,
) {
    val c = LocalHubColors.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var mode by remember { mutableStateOf(previewMode) }
    var pairing by remember { mutableStateOf(previewPairing) }
    var invites by remember { mutableStateOf(previewInvites) }
    var users by remember { mutableStateOf(previewUsers) }
    var fresh by remember { mutableStateOf(previewNewInvite) }
    var error by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf<String?>(null) }
    fun guarded(block: suspend () -> Unit) { scope.launch { try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = scrubAddresses(e.message ?: "Something went wrong") } } }
    fun reload() = guarded {
        api ?: return@guarded
        mode = api.registrationMode(); invites = api.invites(); users = api.adminUsers()
        if (pairing == null) pairing = api.pairing()
    }
    LaunchedEffect(Unit) { if (previewMode == null) reload() }
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        TopBar("Admin", onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(8.dp)) }

            SectionLabel("Pair a phone")
            SoftCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    val p = pairing
                    if (p?.rows != null) QrCode(p.rows) else Text(if (p == null) "Loading…" else "This hub address is too long for a QR. Share the link instead.", color = c.textMuted)
                    Text("On the other phone: first screen → Scan QR.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(top = 10.dp))
                    if (p != null) TextButton(onClick = { clipboard.setText(AnnotatedString(p.link)); copied = "pair" }) { Text(if (copied == "pair") "Link copied" else "Copy link", color = c.accent) }
                }
            }

            SectionLabel("Who can join")
            SoftCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Segmented(listOf("Closed", "Invite", "Open"), listOf("closed", "invite", "open").indexOf(mode).coerceAtLeast(0)) { i ->
                        val next = listOf("closed", "invite", "open")[i]; guarded { api?.setRegistration(next); mode = next }
                    }
                    Text(when (mode) { "open" -> "Anyone who can reach your hub can create an account."; "invite" -> "Only people with an invite link can create an account."; else -> "Nobody can create an account. You add people with an invite when you're ready." },
                        style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(top = 10.dp))
                }
            }

            SectionLabel("Invites")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    fresh?.let { f ->
                        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("New invite · single use · 3 days", style = MaterialTheme.typography.labelLarge, color = c.text)
                            Spacer(Modifier.height(10.dp))
                            if (f.rows != null) QrCode(f.rows, Modifier.size(180.dp))
                            TextButton(onClick = { clipboard.setText(AnnotatedString(f.link)); copied = "invite" }) { Text(if (copied == "invite") "Link copied" else "Copy invite link", color = c.accent) }
                        }
                        Hairline(Modifier.padding(start = 16.dp))
                    }
                    val list = invites
                    if (list.isNullOrEmpty()) Text(if (list == null) "Loading…" else "No open invites.", color = c.textMuted, modifier = Modifier.padding(16.dp))
                    else list.forEachIndexed { i, inv ->
                        if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(if (inv.used) "Used" else "Open invite", style = MaterialTheme.typography.bodyLarge, color = c.text)
                                Text("Expires in " + expiresIn(inv.expires), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                            }
                            TextButton(onClick = { guarded { api?.revokeInvite(inv.id); invites = api?.invites(); fresh = null } }) { Text("Revoke", color = c.textMuted) }
                        }
                    }
                    Hairline(Modifier.padding(start = 16.dp))
                    Text("Create invite", color = c.accent, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().clickable { guarded { fresh = api?.createInvite(); copied = null; invites = api?.invites() } }.padding(16.dp))
                }
            }

            SectionLabel("People")
            SoftCard(Modifier.fillMaxWidth()) {
                Column {
                    val list = users
                    if (list == null) Text("Loading…", color = c.textMuted, modifier = Modifier.padding(16.dp))
                    else list.forEachIndexed { i, u ->
                        if (i > 0) Hairline(Modifier.padding(start = 16.dp))
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(u.username, style = MaterialTheme.typography.bodyLarge, color = if (u.disabled) c.textFaint else c.text)
                                Text(if (u.role == "owner") "Owner" else if (u.disabled) "Disabled" else "Member", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                            }
                            if (u.role != "owner") TextButton(onClick = { guarded { api?.setUserDisabled(u.id, !u.disabled); users = api?.adminUsers() } }) { Text(if (u.disabled) "Enable" else "Disable", color = c.textMuted) }
                        }
                    }
                }
            }
            Text("Disabling someone signs them out everywhere and blocks sign-in. Their agents and keys are kept.", style = MaterialTheme.typography.bodySmall, color = c.textFaint, modifier = Modifier.padding(8.dp))
            Spacer(Modifier.height(24.dp))
        }
    }
}

private fun expiresIn(ms: Long): String {
    val h = (ms - System.currentTimeMillis()) / 3_600_000
    return if (h >= 48) "${h / 24} days" else if (h >= 1) "$h h" else "under an hour"
}
