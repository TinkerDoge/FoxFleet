package dev.foxfleet.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AgentKind
import dev.foxfleet.app.data.KindField
import dev.foxfleet.app.data.Registry
import dev.foxfleet.app.data.SaveResult
import dev.foxfleet.app.data.SavedAgent
import dev.foxfleet.app.data.TestResult
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.SectionLabel
import dev.foxfleet.app.ui.components.SoftCard
import dev.foxfleet.app.ui.components.SoftIconButton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun TopBar(title: String, onBack: () -> Unit, trailing: @Composable () -> Unit = {}) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        SoftIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, tint = c.text)
        Spacer(Modifier.width(4.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, color = c.text, modifier = Modifier.weight(1f))
        trailing()
    }
}

fun kindName(kind: String) = when (kind) { "hermes" -> "Hermes agent"; "openai" -> "OpenAI-compatible"; "openrouter" -> "OpenRouter"; "zai" -> "Z.ai"; "opencode" -> "OpenCode"; "grok" -> "Grok"; "mcp-inbox" -> "MCP inbox"; else -> kind }

/** Settings → Agents: the hub's registry, in display order. Endpoints are never shown, only that they're saved. */
@Composable
fun AgentsScreen(
    agents: List<SavedAgent>?,
    error: String?,
    onBack: () -> Unit,
    onAdd: () -> Unit,
    onEdit: (String) -> Unit,
    onMove: (Int, Int) -> Unit,
    onMachines: () -> Unit = {},
) {
    val c = LocalHubColors.current
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        TopBar("Agents", onBack) { SoftIconButton(Icons.Filled.Add, "Add agent", onAdd, tint = c.accent) }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            Text("Everyone your hub can talk to. Addresses and keys stay on the hub; this phone never sees them.",
                style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp))
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp)) }
            SoftCard(Modifier.fillMaxWidth().padding(bottom = 12.dp), onClick = onMachines) {
                Column(Modifier.padding(16.dp)) {
                    Text("Machines", style = MaterialTheme.typography.titleMedium, color = c.text)
                    Text("Connect a computer once and share all of its Hermes profiles as agents.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                }
            }
            when {
                agents == null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), color = c.accent, strokeWidth = 2.dp) }
                agents.isEmpty() -> SoftCard(Modifier.fillMaxWidth().padding(top = 8.dp), onClick = onAdd) {
                    Column(Modifier.padding(20.dp)) {
                        Text("No agents yet", style = MaterialTheme.typography.titleMedium, color = c.text)
                        Text("Add a Hermes agent, any OpenAI-compatible API, or an MCP inbox.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
                    }
                }
                else -> {
                    SectionLabel("Order shown in your fleet")
                    SoftCard(Modifier.fillMaxWidth()) {
                        Column {
                            agents.forEachIndexed { i, a ->
                                if (i > 0) Hairline(Modifier.padding(start = 68.dp))
                                Row(Modifier.fillMaxWidth().clickable { onEdit(a.name) }.padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    AgentAvatar(a.name, null, 40.dp)
                                    Spacer(Modifier.width(12.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(a.label, style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1)
                                        Text(a.description.ifBlank { kindName(a.kind) }, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2)
                                    }
                                    Column {
                                        SoftIconButton(Icons.Filled.KeyboardArrowUp, "Move ${a.label} up", { onMove(i, -1) }, tint = if (i > 0) c.textMuted else c.hairline)
                                        SoftIconButton(Icons.Filled.KeyboardArrowDown, "Move ${a.label} down", { onMove(i, 1) }, tint = if (i < agents.lastIndex) c.textMuted else c.hairline)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

/**
 * Add or edit one agent. Add: pick a type, fill the friendly fields, test, save. Edit: saved endpoints and keys
 * show as "Saved" and stay unless replaced. Inbox agents get their MCP token once, after saving.
 */
@Composable
fun AgentEditorScreen(
    kinds: List<AgentKind>,
    existing: SavedAgent?,
    onBack: () -> Unit,
    onTest: suspend (AgentKind, Map<String, Any>) -> TestResult,
    onSave: suspend (AgentKind, Map<String, Any>) -> SaveResult,
    onDelete: suspend () -> Unit,
    onDone: () -> Unit,
    initialKind: String? = existing?.kind,
    initialTest: TestResult? = null,
    initialToken: String? = null,
    onNewToken: (suspend () -> String?)? = null,
) {
    val c = LocalHubColors.current
    val scope = rememberCoroutineScope()
    var kindId by remember { mutableStateOf(initialKind) }
    val kind = kinds.firstOrNull { it.kind == kindId }
    val form = remember(kindId) {
        mutableStateMapOf<String, String>().apply {
            kind?.fields?.forEach { f -> put(f.key, existing?.values?.get(f.key) ?: if (existing == null) f.default.orEmpty() else "") }
            if (existing != null) put("name", existing.name)
        }
    }
    var showAdvanced by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var test by remember { mutableStateOf(initialTest) }
    var token by remember { mutableStateOf(initialToken) }
    var confirmDelete by remember { mutableStateOf(false) }
    val editing = existing != null
    val title = when { token != null -> "Agent added"; editing -> "Edit ${existing!!.label}"; kind == null -> "Add agent"; else -> "New ${kind.label}" }

    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true; problem = null
        scope.launch {
            try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { problem = scrubAddresses(e.message ?: "Something went wrong") } finally { busy = false }
        }
    }

    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().imePadding()) {
        TopBar(title, onBack = { if (kind != null && !editing && token == null) kindId = null else onBack() })
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            val t = token
            if (t != null) {
                TokenCard(t, onDone)
                return@Column
            }
            if (kind == null) {
                Text("What kind of agent?", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp, 8.dp))
                kinds.forEach { k -> KindTile(k) { if (!k.planned) kindId = k.kind } ; Spacer(Modifier.height(10.dp)) }
                return@Column
            }
            val basic = kind.fields.filter { !it.advanced && it.visible(form, kind) }
            val advanced = kind.fields.filter { it.advanced && it.visible(form, kind) }
            kind.warnings.forEach { w -> Text(w, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp)) }
            SectionLabel(kind.label)
            SoftCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    basic.forEach { f -> FieldInput(f, form[f.key].orEmpty().ifBlank { if (f.isEnum) f.default.orEmpty() else "" }, editing, existing) { form[f.key] = it } }
                }
            }
            if (advanced.isNotEmpty()) {
                TextButton(onClick = { showAdvanced = !showAdvanced }) { Text(if (showAdvanced) "Hide advanced" else "Advanced", color = c.accent) }
                AnimatedVisibility(showAdvanced) {
                    SoftCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            advanced.forEach { f -> FieldInput(f, form[f.key].orEmpty().ifBlank { if (f.isEnum) f.default.orEmpty() else "" }, editing, existing) { form[f.key] = it } }
                        }
                    }
                }
            }
            test?.let { TestCard(it) }
            problem?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp, 12.dp)) }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedAction("Test connection", Modifier.weight(1f), enabled = !busy) {
                    val bad = Registry.validate(kind, form, editing, existing)
                    if (bad != null) { problem = bad; return@OutlinedAction }
                    run { test = onTest(kind, Registry.payload(kind, form, editing = false)) }
                }
                PrimaryAction(if (editing) "Save" else "Add agent", Modifier.weight(1f), busy) {
                    val bad = Registry.validate(kind, form, editing, existing)
                    if (bad != null) { problem = bad; return@PrimaryAction }
                    run { val r = onSave(kind, Registry.payload(kind, form, editing)); val shown = r.inboxToken; if (shown != null) token = shown else onDone() }
                }
            }
            if (editing && onNewToken != null && existing?.kind == "mcp-inbox") {
                TextButton(onClick = { run { onNewToken()?.let { token = it } } }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Get a new token", color = c.accent) }
            }
            if (editing) {
                Spacer(Modifier.height(24.dp))
                TextButton(onClick = { confirmDelete = true }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Remove agent", color = dangerColor()) }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
    if (confirmDelete && existing != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false }, containerColor = c.surface,
            title = { Text("Remove ${existing.label}?") },
            text = { Text("The hub forgets this agent and its saved keys. Nothing on the agent's own machine is deleted.") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; run { onDelete(); onDone() } }) { Text("Remove", color = dangerColor()) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Keep", color = c.textMuted) } },
        )
    }
}

@Composable
private fun dangerColor() = if (LocalHubColors.current.dark) androidx.compose.ui.graphics.Color(0xFFFF7B72) else androidx.compose.ui.graphics.Color(0xFFC4372B)

@Composable
private fun KindTile(k: AgentKind, onClick: () -> Unit) {
    val c = LocalHubColors.current
    SoftCard(Modifier.fillMaxWidth(), onClick = if (k.planned) null else onClick) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(c.surfaceAlt), contentAlignment = Alignment.Center) {
                Text(when (k.kind) { "hermes" -> "H"; "openai" -> "AI"; "openrouter" -> "OR"; "zai" -> "Z"; "opencode" -> "OC"; "grok" -> "G"; "mcp-inbox" -> "✉"; "a2a" -> "A2"; else -> "↗" }, style = MaterialTheme.typography.labelLarge, color = if (k.planned) c.textFaint else c.accent)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(k.label, style = MaterialTheme.typography.titleMedium, color = if (k.planned) c.textFaint else c.text)
                    if (k.planned) { Spacer(Modifier.width(8.dp)); Text("Soon", style = MaterialTheme.typography.labelSmall, color = c.textFaint) }
                }
                Text(k.summary, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            }
        }
    }
}

@Composable
private fun enumLabel(o: String) = when (o) { "direct" -> "Direct (advanced)"; "general" -> "General"; "coding" -> "Coding Plan"; else -> o.replaceFirstChar { it.uppercase() } }

@Composable
private fun FieldInput(f: KindField, value: String, editing: Boolean, existing: SavedAgent?, onChange: (String) -> Unit) {
    val c = LocalHubColors.current
    if (f.isEnum) {
        Column {
            Text(f.label, style = MaterialTheme.typography.labelMedium, color = c.textMuted)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
                f.options.forEach { o -> androidx.compose.material3.FilterChip(selected = value == o, onClick = { if (!(editing && f.key == "connection")) onChange(o) }, label = { Text(enumLabel(o)) }) }
            }
            f.help?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textFaint, modifier = Modifier.padding(top = 4.dp)) }
        }
        return
    }
    val locked = editing && f.key == "name"
    val saved = editing && f.writeOnly && existing?.hasSaved(f.key) == true
    val colors = OutlinedTextFieldDefaults.colors(
        focusedTextColor = c.text, unfocusedTextColor = c.text, disabledTextColor = c.textMuted,
        focusedBorderColor = c.accent, unfocusedBorderColor = c.hairline, disabledBorderColor = c.hairline,
        focusedContainerColor = c.surface, unfocusedContainerColor = c.surface, disabledContainerColor = c.surfaceAlt,
        cursorColor = c.accent, focusedLabelColor = c.accent, unfocusedLabelColor = c.textMuted, disabledLabelColor = c.textFaint,
    )
    OutlinedTextField(
        value, onChange, enabled = !locked,
        label = { Text(f.label + if (f.required && !saved && !locked) " *" else "") },
        placeholder = f.default?.let { d -> { Text(d, color = c.textFaint) } },
        // Write-only values never come back from the hub, so say they're there instead of showing them.
        supportingText = when {
            saved -> ({ Text("Saved on the hub · leave blank to keep", color = c.accent) })
            locked -> null
            else -> f.help?.let { h -> { Text(h, color = c.textFaint) } }
        },
        singleLine = f.type != "multiline", minLines = if (f.type == "multiline") 2 else 1,
        visualTransformation = if (f.isSecret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = when (f.type) { "port" -> KeyboardType.Number; "url" -> KeyboardType.Uri; "secret" -> KeyboardType.Password; else -> KeyboardType.Text }),
        shape = RoundedCornerShape(12.dp), colors = colors, modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun TestCard(t: TestResult) {
    val c = LocalHubColors.current
    Spacer(Modifier.height(12.dp))
    SoftCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (t.ok) "Connected" else "Not reachable yet", style = MaterialTheme.typography.titleMedium, color = c.text)
            t.checks.forEach { (key, r) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(if (r.ok) c.online else c.offline))
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(Registry.checkLabels[key] ?: key, style = MaterialTheme.typography.bodyMedium, color = c.text)
                        Text(r.message, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                    }
                }
            }
        }
    }
}

@Composable
private fun TokenCard(token: String, onDone: () -> Unit) {
    val c = LocalHubColors.current
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    Spacer(Modifier.height(8.dp))
    Text("Give this token to the agent's MCP connector as a Bearer key. It's shown only once; you can issue a new one later.",
        style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(4.dp))
    Spacer(Modifier.height(12.dp))
    SoftCard(Modifier.fillMaxWidth()) {
        Text(token, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = c.text, modifier = Modifier.padding(16.dp))
    }
    Spacer(Modifier.height(16.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedAction(if (copied) "Copied" else "Copy token", Modifier.weight(1f)) { clipboard.setText(AnnotatedString(token)); copied = true }
        PrimaryAction("Done", Modifier.weight(1f), false, onClick = onDone)
    }
}

@Composable
internal fun PrimaryAction(text: String, modifier: Modifier, busy: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Button(onClick = onClick, enabled = !busy && enabled, modifier = modifier.height(48.dp), shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.onAccent, disabledContainerColor = c.surfaceAlt, disabledContentColor = c.textFaint)) {
        if (busy) { CircularProgressIndicator(Modifier.size(16.dp), color = c.textFaint, strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
        Text(text)
    }
}

@Composable
internal fun OutlinedAction(text: String, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Box(modifier.height(48.dp).clip(RoundedCornerShape(14.dp)).border(1.dp, c.hairline, RoundedCornerShape(14.dp)).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center) { Text(text, style = MaterialTheme.typography.labelLarge, color = if (enabled) c.text else c.textFaint) }
}
