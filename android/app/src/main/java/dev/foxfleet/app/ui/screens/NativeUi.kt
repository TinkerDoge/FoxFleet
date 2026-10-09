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

/** Model for this chat (session-scoped) and the profile-wide busy default, with its warning. Everything disabled says why. */
@Composable
internal fun NativeControlsDialog(controls: NativeControls, hasSession: Boolean, streaming: Boolean, onDismiss: () -> Unit) {
    val c = LocalHubColors.current; val scope = rememberCoroutineScope()
    var providers by remember { mutableStateOf<List<HubApi.ModelProvider>?>(null) }; var busy by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }; var err by remember { mutableStateOf<String?>(null) }; var confirmMode by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { providers = controls.models() }.onFailure { err = it.message }; busy = runCatching { controls.busy() }.getOrDefault("") }
    val why = if (!hasSession) "Send the first message first: the model is set per conversation." else if (streaming) "Not available while the agent is replying" else null
    AlertDialog(onDismissRequest = onDismiss, confirmButton = { TextButton(onDismiss) { Text("Close") } }, title = { Text("Chat controls") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Model for this chat", style = MaterialTheme.typography.titleSmall, color = c.text)
            Text("Changes this conversation only. The Hermes default is not touched.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            if (why != null) Text(why, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            when {
                providers == null && err == null -> Text("Loading models…", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                providers.isNullOrEmpty() -> Text("This agent did not list any models.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                else -> Column(Modifier.height(160.dp).let { it }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    providers!!.take(6).forEach { p -> p.models.take(8).forEach { m ->
                        Text("${p.name} · $m", style = MaterialTheme.typography.bodyMedium, color = if (why == null) c.accent else c.textFaint,
                            modifier = Modifier.fillMaxWidth().clickable(enabled = why == null) { scope.launch { runCatching { controls.setModel(m, p.slug) }.onSuccess { note = it; err = null }.onFailure { err = it.message } } }.padding(vertical = 6.dp))
                    } }
                }
            }
            note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.text) }
            Text("Hermes default for messages sent while it works", style = MaterialTheme.typography.titleSmall, color = c.text)
            Text("This is a setting of the Hermes profile. Changing it affects every chat of this profile, including the terminal and messaging apps. The send mode next to the send button only changes what this app asks for.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            if (busy.isNotEmpty()) Text("Now: ${modeLabel(busy, true)}", style = MaterialTheme.typography.bodySmall, color = c.text)
            Row { listOf("queue", "steer", "interrupt").forEach { m -> TextButton({ confirmMode = m }, enabled = busy != m) { Text(modeLabel(m, true), color = c.accent) } } }
            err?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted) }
        }
    })
    confirmMode?.let { m ->
        AlertDialog(onDismissRequest = { confirmMode = null }, title = { Text("Change it for the whole Hermes profile?") }, text = { Text("Every chat of this profile will treat messages sent while it works as: ${modeLabel(m, true)}.") },
            confirmButton = { TextButton({ confirmMode = null; scope.launch { runCatching { controls.setBusy(m) }.onSuccess { busy = m; err = null }.onFailure { err = it.message } } }) { Text("Change the profile default") } },
            dismissButton = { TextButton({ confirmMode = null }) { Text("Cancel") } })
    }
}
