package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.ui.LocalHubColors
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What Hermes answered to a message sent while it worked, in words. Shown as received, never predicted. */
internal fun ackLabel(ack: String) = when (ack) {
    "streaming" -> "Hermes started it"; "queued" -> "Hermes queued it"; "steered" -> "Hermes accepted it as guidance"
    "redirected" -> "Hermes switched to it"; "rejected" -> "Hermes did not accept it"; else -> ack
}
/** Native: Interrupt is a live redirect that Hermes may refuse. Other agents: it stops the reply and then sends. */
internal fun modeLabel(mode: String, native: Boolean) = if (mode == "interrupt" && native) "Redirect" else modeLabel(mode)
internal fun modeHelp(mode: String, native: Boolean) = if (native) when (mode) {
    "steer" -> "Guidance for the reply in progress; Hermes decides whether and when it uses it"
    "interrupt" -> "Asks Hermes to switch its current work to this message. Hermes may refuse; its answer is shown under the message."
    else -> "Hermes holds it and runs it after the current reply"
} else when (mode) {
    "steer" -> "Guidance for the reply in progress; it keeps working"
    "interrupt" -> "Stops the reply, waits until it has stopped, then sends this as a new turn (not a live redirect)"
    else -> "Sent after the current reply finishes"
}
internal fun queueItemLabel(q: HubApi.QueuedMessage) = q.error ?: q.ack?.let(::ackLabel) ?: when (q.state) {
    "uncertain" -> "Not sure it arrived. Checking with Hermes…"; "rejected" -> "Hermes did not accept it. Your text is kept below."; else -> queueStateLabel(q.state)
}
/** The reply for a card: the picked choice, or the typed text when there is one; an approval is Allow once or Deny only. */
internal fun clarifyAnswers(r: HubApi.OpenRequest, picked: Map<String, List<String>>, typed: Map<String, String>): JsonObject = buildJsonObject {
    put("answers", buildJsonObject {
        r.questions.forEach { q -> val t = typed[q.id].orEmpty().trim(); put(q.id, t.ifEmpty { (picked[q.id] ?: emptyList()).let { p -> if (q.multi) p.joinToString(", ") else p.firstOrNull().orEmpty() } }) }
    })
}
internal fun approvalAnswer(allow: Boolean): JsonObject = buildJsonObject { put("choice", if (allow) "once" else "deny") }

/** Hooks of a native agent's extra controls (null for every other agent). */
class NativeControls(
    val models: suspend () -> List<HubApi.ModelProvider>,
    val setModel: suspend (model: String, provider: String?) -> String,
    val busy: suspend () -> String,
    val setBusy: suspend (String) -> Unit,
)

@Composable
internal fun RequestCard(r: HubApi.OpenRequest, agentName: String, onAnswer: suspend (String, JsonObject) -> String?) {
    val c = LocalHubColors.current; val scope = rememberCoroutineScope()
    var sending by remember(r.id) { mutableStateOf(false) }; var err by remember(r.id) { mutableStateOf<String?>(null) }
    val picked = remember(r.id) { mutableStateOf(mapOf<String, List<String>>()) }; val typed = remember(r.id) { mutableStateOf(mapOf<String, String>()) }
    fun go(result: JsonObject) { if (sending) return; sending = true; err = null; scope.launch { val e = onAnswer(r.id, result); if (e != null) { err = e; sending = false } } }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(16.dp)).background(c.surfaceAlt).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (r.kind == "approval") {
            Text("$agentName asks permission", style = MaterialTheme.typography.titleSmall, color = c.text)
            r.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.text) }
            r.command?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.bg).padding(8.dp)) }
            Row { TextButton({ go(approvalAnswer(true)) }, enabled = !sending) { Text("Allow once", color = c.accent) }; TextButton({ go(approvalAnswer(false)) }, enabled = !sending) { Text("Deny", color = c.accent) } }
        } else {
            Text("$agentName has a question", style = MaterialTheme.typography.titleSmall, color = c.text)
            if (r.questions.isEmpty()) Text("The agent asked something without a question text. You can send an empty answer to let it continue.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            r.questions.forEach { q ->
                Text(q.question, style = MaterialTheme.typography.bodyMedium, color = c.text)
                q.choices.forEach { ch ->
                    val on = ch in (picked.value[q.id] ?: emptyList())
                    Row(Modifier.fillMaxWidth().clickable(enabled = !sending) { picked.value = picked.value + (q.id to if (q.multi) (if (on) (picked.value[q.id] ?: emptyList()) - ch else (picked.value[q.id] ?: emptyList()) + ch) else listOf(ch)) }, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        if (q.multi) Checkbox(on, null) else RadioButton(on, null); Spacer(Modifier.height(0.dp)); Text(ch, style = MaterialTheme.typography.bodyMedium, color = c.text, modifier = Modifier.padding(start = 8.dp))
                    }
                }
                OutlinedTextField(typed.value[q.id].orEmpty(), { typed.value = typed.value + (q.id to it) }, enabled = !sending, singleLine = true, label = { Text(if (q.choices.isEmpty()) "Your answer" else "Or type your own answer") }, modifier = Modifier.fillMaxWidth())
            }
            TextButton({ go(clarifyAnswers(r, picked.value, typed.value)) }, enabled = !sending) { Text("Send answer", color = c.accent) }
        }
        err?.let { Text("Could not send the answer: $it", style = MaterialTheme.typography.bodySmall, color = c.textMuted) }
    }
}

/** A Telegram-style choice card. It belongs to the chat (session) that opened it and expires. */
class PickerCard(val sessionId: String?, val kind: String, val command: String? = null, val options: List<String> = emptyList(), val openedAt: Long = System.currentTimeMillis()) {
    fun valid(session: String?, now: Long = System.currentTimeMillis()) = session == sessionId && now - openedAt <= PICKER_TTL_MS
    companion object { const val PICKER_TTL_MS = 5 * 60_000L }
}
internal const val PICKER_PAGE = 6
internal val PICKER_ROW_DP = 52.dp

/** One page of a filtered list: rows, page count, the page actually shown. */
internal fun <T> pageOf(items: List<T>, page: Int, size: Int = 8): Triple<List<T>, Int, Int> {
    val pages = maxOf(1, (items.size + size - 1) / size); val p = page.coerceIn(0, pages - 1)
    return Triple(items.drop(p * size).take(size), pages, p)
}
internal fun modelSetMessage(model: String) = "Model for this chat is now $model. Your Hermes default is unchanged."

/**
 * /model: step 1 the providers, step 2 that provider's models (paged, searchable). Choosing sets the model for this chat only.
 * Back and Cancel are always there. Opened as a bottom sheet so the keyboard and the composer stay usable.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun ModelPickerSheet(controls: NativeControls, hasSession: Boolean, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, containerColor = LocalHubColors.current.surface) { ModelPickerContent(controls, hasSession, onDone, onDismiss) }
}

/** The two steps themselves (also what the screenshots render, since a sheet window is not part of the root). */
@Composable
internal fun ModelPickerContent(controls: NativeControls, hasSession: Boolean, onDone: (String) -> Unit, onDismiss: () -> Unit, startProvider: String? = null, startQuery: String = "") {
    val c = LocalHubColors.current; val scope = rememberCoroutineScope()
    var providers by remember { mutableStateOf<List<HubApi.ModelProvider>?>(null) }; var err by remember { mutableStateOf<String?>(null) }
    var sel by remember { mutableStateOf(startProvider) }; var q by remember { mutableStateOf(startQuery) }; var page by remember { mutableStateOf(0) }; var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { runCatching { providers = controls.models() }.onFailure { err = it.message ?: "Could not load the models" } }
    val p = providers?.firstOrNull { it.slug == sel }
    run {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (p == null) "Choose a provider" else "Models from ${p.name}", style = MaterialTheme.typography.titleMedium, color = c.text)
            if (!hasSession) Text("Send the first message first: the model is set per conversation.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            when {
                providers == null && err == null -> Text("Loading models…", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                providers.isNullOrEmpty() -> Text("This agent did not list any models.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                else -> {
                    OutlinedTextField(q, { q = it; page = 0 }, singleLine = true, label = { Text(if (p == null) "Search providers" else "Search models") }, modifier = Modifier.fillMaxWidth())
                    // one fixed-height list for both steps: six rows tall whatever is in it, so the sheet does not jump between pages or while searching
                    val needle = q.trim()
                    val (rows, pages, shown) = if (p == null) pageOf(providers!!.filter { "${it.name} ${it.slug}".contains(needle, ignoreCase = true) }, page, PICKER_PAGE)
                        else pageOf(p.models.filter { it.contains(needle, ignoreCase = true) }, page, PICKER_PAGE)
                    Column(Modifier.fillMaxWidth().height(PICKER_ROW_DP * PICKER_PAGE + 6.dp * (PICKER_PAGE - 1)), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (rows.isEmpty()) Text("Nothing matches", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                        rows.forEach { row ->
                            if (row is HubApi.ModelProvider) ChoiceRow("${row.name} · ${row.models.size}", true) { sel = row.slug; q = ""; page = 0 }
                            else { val m = row.toString(); ChoiceRow(m, hasSession && !busy) {
                                busy = true
                                scope.launch { runCatching { controls.setModel(m, p!!.slug) }.onSuccess { onDone(modelSetMessage(m)) }.onFailure { err = it.message; busy = false } }
                            } }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        TextButton({ page = shown - 1 }, enabled = shown > 0) { Text("Previous", color = c.accent) }
                        Text("Page ${shown + 1} of $pages", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                        TextButton({ page = shown + 1 }, enabled = shown < pages - 1) { Text("Next", color = c.accent) }
                    }
                }
            }
            err?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted) }
            Row { if (p != null) TextButton({ sel = null; q = "" }) { Text("Back", color = c.accent) }; TextButton(onDismiss) { Text("Cancel", color = c.accent) } }
        }
    }
}

/** Any command with fixed choices: tap one and it is sent as that command. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun ChoiceSheet(command: String, options: List<String>, onChoose: (String) -> Unit, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("/$command", style = MaterialTheme.typography.titleMedium, color = c.text)
            options.forEach { o -> ChoiceRow(o, true) { onChoose("/$command $o") } }
            TextButton(onDismiss) { Text("Cancel", color = c.accent) }
        }
    }
}

@Composable
private fun ChoiceRow(label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Text(label, style = MaterialTheme.typography.bodyLarge, color = if (enabled) c.text else c.textFaint,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp, vertical = 14.dp))
}

/** Agent settings, not chat: the Hermes profile default for messages sent while it works. It affects every chat of the profile, so it asks first. */
@Composable
fun ProfileBusyCard(controls: NativeControls) {
    val c = LocalHubColors.current; val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }; var err by remember { mutableStateOf<String?>(null) }; var confirmMode by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { busy = runCatching { controls.busy() }.getOrNull() }
    val now = busy ?: return // not a native Hermes agent: nothing to set here
    Column(Modifier.fillMaxWidth().padding(top = 16.dp).clip(RoundedCornerShape(16.dp)).background(c.surfaceAlt).padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Hermes default for messages sent while it works", style = MaterialTheme.typography.titleSmall, color = c.text)
        Text("This is a setting of the Hermes profile. Changing it affects every chat of this profile, including the terminal and messaging apps.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        if (now.isNotEmpty()) Text("Now: ${modeLabel(now, true)}", style = MaterialTheme.typography.bodySmall, color = c.text)
        Row { listOf("queue", "steer", "interrupt").forEach { m -> TextButton({ confirmMode = m }, enabled = now != m) { Text(modeLabel(m, true), color = c.accent) } } }
        err?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted) }
    }
    confirmMode?.let { m ->
        AlertDialog(onDismissRequest = { confirmMode = null }, title = { Text("Change it for the whole Hermes profile?") }, text = { Text("Every chat of this profile will treat messages sent while it works as: ${modeLabel(m, true)}.") },
            confirmButton = { TextButton({ confirmMode = null; scope.launch { runCatching { controls.setBusy(m) }.onSuccess { busy = m; err = null }.onFailure { err = it.message } } }) { Text("Change the profile default") } },
            dismissButton = { TextButton({ confirmMode = null }) { Text("Cancel") } })
    }
}
