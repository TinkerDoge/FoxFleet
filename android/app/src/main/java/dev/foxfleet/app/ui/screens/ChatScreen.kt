package dev.foxfleet.app.ui.screens

import dev.foxfleet.app.ui.FoxIcons
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.ShimmerStatusText
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.presence
import dev.foxfleet.app.ui.motion.pressScale
import dev.foxfleet.app.ui.motion.reduceMotion
import dev.foxfleet.app.ui.motion.rememberHaptic
import dev.foxfleet.app.ui.motion.sharedAvatar
import kotlinx.coroutines.launch
import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import coil3.compose.AsyncImage
import dev.foxfleet.app.data.ImageAttachment
import dev.foxfleet.app.data.FileRef
import dev.foxfleet.app.data.FileMarker
import dev.foxfleet.app.media.ImageEncoder
import dev.foxfleet.app.ui.chat.LocalCommand
import dev.foxfleet.app.ui.chat.MediaRef
import dev.foxfleet.app.ui.chat.HermesCatalog
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.chat.opensCommandBrowser
import dev.foxfleet.app.ui.chat.parseLocal
import dev.foxfleet.app.ui.chat.parseHub
import dev.foxfleet.app.ui.chat.CommandDef
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.window.Dialog
import dev.foxfleet.app.ui.chat.extractMedia
import dev.foxfleet.app.ui.chat.localCommandFor
import dev.foxfleet.app.ui.components.MediaViewer
import dev.foxfleet.app.ui.components.AssistantBody
import dev.foxfleet.app.ui.components.AgentMediaCards
import dev.foxfleet.app.ui.chat.MediaTags
import dev.foxfleet.app.ui.components.RichText
import dev.foxfleet.app.ui.components.VoiceInput
import dev.foxfleet.app.ui.components.mergeDictation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import androidx.compose.foundation.lazy.itemsIndexed
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** Chars at the tail of a streaming reply that fade in instead of popping. */
const val STREAM_FADE_CHARS = 24

/** Alpha for char [i] of a [len]-char streaming text: 1 except a soft ramp over the tail. */
fun streamAlpha(i: Int, len: Int, fade: Int = STREAM_FADE_CHARS): Float {
    val fromEnd = len - 1 - i
    if (fade <= 0 || fromEnd >= fade) return 1f
    return 0.25f + 0.75f * (fromEnd + 1).toFloat() / fade
}

/** Status line under the header / in the stream: tool > reasoning > thinking. */
fun statusLine(agent: String, tool: String?, reasoning: Boolean, hasText: Boolean): String? = when {
    tool != null -> "Using $tool…"
    hasText -> null
    reasoning -> "$agent is thinking…"
    else -> "$agent is working…"
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(
    agent: AgentStatus,
    agents: List<AgentStatus>,
    state: ChatState,
    sessions: List<SessionInfo>,
    unread: (String) -> Boolean,
    onSend: (String, List<ImageAttachment>) -> Unit,
    onStop: () -> Unit,
    onBack: () -> Unit,
    onNewChat: () -> Unit,
    onSwitchAgent: (AgentStatus) -> Unit,
    onOpenSession: (String) -> Unit,
    onDrawerOpened: () -> Unit,
    sessionsTotal: Int = sessions.size,
    sessionsLoading: Boolean = false,
    historyError: String? = null,
    onRefreshSessions: () -> Unit = {},
    onLoadMoreSessions: () -> Unit = {},
    onRenameSession: (String, String) -> Unit = { _, _ -> },
    onDeleteSession: (String) -> Unit = {},
    onLoadOlder: () -> Unit = {},
    historyOpen: Boolean = false,
    onRetry: () -> Unit = {},
    /** The hub's queue controls. */
    onResumeQueue: () -> Unit = {},
    onCancelQueued: (String) -> Unit = {},
    /** Native Hermes sessions: answer a question/approval card; model picker and profile busy setting. Null for every other agent. */
    onAnswerRequest: (suspend (String, kotlinx.serialization.json.JsonObject) -> String?)? = null,
    nativeControls: NativeControls? = null,
    commandDefs: List<CommandDef>? = null,
    onSendMode: ((String, List<ImageAttachment>, String) -> Unit)? = null,
    initialInput: String = "",
    skills: List<String> = emptyList(),
    onAvatarLongPress: (String) -> Unit = {},
    httpClient: OkHttpClient? = null,
    initialAttachments: List<ImageAttachment> = emptyList(),
    initialViewing: MediaRef? = null,
    allowImages: Boolean = true,
    onUploadFile: (suspend (Uri, (Float) -> Unit) -> FileRef)? = null,
    onOpenScreen: (() -> Unit)? = null,
    initialFiles: List<FileRef> = emptyList(),
) {
    val c = LocalHubColors.current
    var viewing by remember { mutableStateOf(initialViewing) }
    val scope = rememberCoroutineScope()
    var history by remember { mutableStateOf(historyOpen) }
    var picker by remember { mutableStateOf<PickerCard?>(null) }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding().imePadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text)
                Spacer(Modifier.width(4.dp))
                AgentAvatar(agent.name, agent.presence(), 34.dp, Modifier.sharedAvatar(agent.name)
                    .combinedClickable(onClick = {}, onLongClick = { onAvatarLongPress(agent.name) }))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(agent.label ?: agent.name, style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1)
                        agent.badge?.let { Spacer(Modifier.width(6.dp)); KindBadge(it) }
                    }
                    val sub = statusLine(agent.name, state.toolLabel, state.streamReasoning.isNotBlank(), state.streamText.isNotBlank())
                    if (state.reconnecting) ShimmerStatusText("Reconnecting…", style = MaterialTheme.typography.bodySmall)
                    else if (state.streaming && sub != null) ShimmerStatusText(sub, style = MaterialTheme.typography.bodySmall)
                    else Text(state.sessionId?.let { "Session ${it.take(8)}" } ?: "New conversation", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                }
                if (onOpenScreen != null) SoftIconButton(FoxIcons.get("screen"), "Agent's screen", onOpenScreen)
                if (agent.capabilities.sessions) SoftIconButton(FoxIcons.get("history"), "Chat history", { history = true })
                SoftIconButton(FoxIcons.get("add"), "New chat", onNewChat)
            }
            Hairline()
            Transcript(agent.name, state, Modifier.weight(1f), onLoadOlder, onResumeQueue, onCancelQueued, onAnswerRequest) { viewing = it }
            Composer(
                agent.name, state.streaming, skills, onSendMode ?: { t, i, _ -> onSend(t, i) }, onStop, initialInput, initialAttachments,
                modes = agent.capabilities.busy, native = agent.capabilities.nativeUi, onModel = { args -> modelCommand(args, nativeControls, state, picker = { picker = PickerCard(state.sessionId, "model") }) }, onChoices = { cmd, opts -> picker = PickerCard(state.sessionId, "choice", cmd, opts) }, defs = commandDefs, waiting = state.queue.count { it.state == "queued" || it.state == "awaiting_stop" },
                allowImages = allowImages, onUploadFile = onUploadFile, initialFiles = initialFiles,
                placeholder = if (agent.isInbox) "Message ${agent.label ?: agent.name} (inbox)" else null,
                agentCommands = agent.capabilities.skills,
                onLocal = { cmd, args ->
                    when (cmd) {
                        LocalCommand.New -> onNewChat()
                        LocalCommand.Sessions -> history = true
                        LocalCommand.Stop -> onStop()
                        LocalCommand.Retry -> onRetry()
                        LocalCommand.Title -> state.sessionId?.let { onRenameSession(it, args) }
                    }
                },
            )
        }
    }
    // A choice card belongs to the chat that opened it: another chat, a new chat or five minutes later and it is gone.
    LaunchedEffect(state.sessionId) { picker = null }
    picker?.takeIf { it.valid(state.sessionId) }?.let { pc ->
        if (pc.kind == "model" && nativeControls != null) ModelPickerSheet(nativeControls, state.sessionId != null, { state.addNotice(it); picker = null }, { picker = null })
        else if (pc.kind == "choice") ChoiceSheet(pc.command.orEmpty(), pc.options, { picker = null; (onSendMode ?: { t, i, _ -> onSend(t, i) })(it, emptyList(), "interrupt") }, { picker = null })
    }
    if (history) HistorySheet(agent.name, sessions, sessionsTotal, state.sessionId, sessionsLoading, historyError, onOpenSession, onNewChat, onRefreshSessions, onLoadMoreSessions, onRenameSession, onDeleteSession) { history = false }
    AnimatedVisibility(viewing != null, enter = fadeIn(), exit = fadeOut()) {
        viewing?.let { MediaViewer(it, httpClient) { viewing = null } }
    }
}


@Composable
private fun Transcript(agentName: String, state: ChatState, modifier: Modifier, onLoadOlder: () -> Unit, onResumeQueue: () -> Unit, onCancelQueued: (String) -> Unit, onAnswerRequest: (suspend (String, kotlinx.serialization.json.JsonObject) -> String?)?, onOpen: (MediaRef) -> Unit) {
    val c = LocalHubColors.current
    val list = rememberLazyListState()
    // reverseLayout pins the newest message to the bottom: when the keyboard opens or the
    // composer grows the list shrinks from the top, never hiding the latest reply.
    LaunchedEffect(state.messages.size) {
        if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0)
    }
    // Long conversations load in pages: reaching the oldest loaded message fetches the next older page.
    val nearTop by remember { derivedStateOf { list.layoutInfo.let { it.totalItemsCount > 0 && (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 3 } } }
    LaunchedEffect(nearTop, state.hasOlder, state.messages.size) { if (nearTop && state.hasOlder && !state.loadingOlder) onLoadOlder() }
    if (state.messages.isEmpty() && !state.streaming && !state.loading && state.error == null) {
        Column(modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            AgentAvatar(agentName, null, 56.dp)
            Spacer(Modifier.size(14.dp))
            Text("Start a conversation with $agentName", style = MaterialTheme.typography.titleMedium, color = c.text)
            Text("Replies stream in live. Swipe from the left edge to switch agents.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        }
        return
    }
    LazyColumn(
        state = list, reverseLayout = true, modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.Bottom),
    ) {
        itemsIndexed(state.notices.reversed(), key = { i, _ -> "notice-$i" }) { _, n ->
            Text(n, style = MaterialTheme.typography.bodySmall, color = c.textMuted, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp))
        }
        state.error?.let { e ->
            item(key = "error") {
                Text(e, style = MaterialTheme.typography.bodySmall, color = c.textMuted,
                    modifier = Modifier.animateItem().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(12.dp))
            }
        }
        // Newest at the bottom: what the hub still holds for this chat sits under the reply that is streaming.
        if (state.halted && state.queue.any { it.state == "queued" }) item(key = "q-paused") {
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Text("Queue paused", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                Text("Resume queue", style = MaterialTheme.typography.labelLarge, color = c.accent, modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onResumeQueue() }.padding(10.dp))
            }
        }
        // cards for what the agent is waiting on sit at the very bottom, where the eye is
        if (onAnswerRequest != null && state.requests.isNotEmpty()) items(state.requests.size, key = { "req-" + state.requests[it].id }) { i -> RequestCard(state.requests[i], agentName, onAnswerRequest) }
        val waiting = state.queue.asReversed()
        items(waiting.size, key = { "q-" + waiting[it].id }) { i ->
            val q = waiting[i]
            Column(Modifier.fillMaxWidth().padding(start = 48.dp), horizontalAlignment = Alignment.End) {
                Text(q.text, style = MaterialTheme.typography.bodyLarge, color = c.text,
                    modifier = Modifier.alpha(0.78f).clip(RoundedCornerShape(16.dp)).background(c.surfaceAlt).padding(horizontal = 12.dp, vertical = 8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(queueItemLabel(q), style = MaterialTheme.typography.labelSmall, color = c.textFaint)
                    if (q.state == "queued" || q.state == "awaiting_stop") {
                        if (state.canCancel) Text("Take back", style = MaterialTheme.typography.labelSmall, color = c.accent, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onCancelQueued(q.id) }.padding(8.dp))
                        else Text("Hermes holds this message; it cannot be taken back from here", style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.padding(start = 8.dp))
                    } else if (q.state == "rejected" || q.state == "failed") Text("Dismiss", style = MaterialTheme.typography.labelSmall, color = c.accent, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onCancelQueued(q.id) }.padding(8.dp))
                }
            }
        }
        if (state.streaming) item(key = "stream") {
            StreamingMessage(agentName, state, Modifier.animateItem(), onOpen)
        }
        if (state.loading) item(key = "loading") { ShimmerStatusText("Loading conversation…", Modifier.padding(8.dp)) }
        val rev = state.messages.asReversed()
        items(rev.size, key = { state.keyBase + rev.size - 1 - it }) { i ->
            MessageRow(agentName, rev[i], Modifier.animateItem(), onOpen)
        }
        if (state.loadingOlder) item(key = "older") { ShimmerStatusText("Loading earlier messages…", Modifier.padding(8.dp)) }
    }
}

@Composable
private fun MessageRow(agentName: String, m: UiMessage, modifier: Modifier, onOpen: (MediaRef) -> Unit) {
    val c = LocalHubColors.current
    if (m.role == "user") {
        Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            m.imageUrls.forEach { u -> AsyncImage(model = u, contentDescription = "Attached image", contentScale = ContentScale.Crop, modifier = Modifier.padding(bottom = 6.dp).size(180.dp).clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt).clickable { onOpen(MediaRef(u, MediaRef.Kind.Image)) }) }
            if (m.images.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                m.images.forEach { img ->
                    AsyncImage(
                        model = java.io.File(img.localPath), contentDescription = "Attached image", contentScale = ContentScale.Crop,
                        modifier = Modifier.size(if (m.images.size == 1) 180.dp else 96.dp).clip(RoundedCornerShape(14.dp))
                            .background(c.surfaceAlt).clickable { onOpen(MediaRef(java.io.File(img.localPath).toURI().toString(), MediaRef.Kind.Image)) },
                    )
                }
            }
            val (bodyText, files) = remember(m.content) { FileMarker.split(m.content) }
            files.forEach { (path, size) -> FileChip(path.substringAfterLast('/').substringAfter('-'), size, Modifier.padding(bottom = 6.dp)) }
            if (bodyText.isNotBlank()) Text(bodyText, style = MaterialTheme.typography.bodyLarge, color = c.text,
                modifier = Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp))
                    .background(c.userBubble).padding(horizontal = 14.dp, vertical = 10.dp))
        }
    } else {
        Row(modifier.fillMaxWidth()) {
            AgentAvatar(agentName, null, 28.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                if (m.reasoning.isNotBlank()) Reasoning(m.reasoning, live = false)
                if (m.steps.isNotEmpty()) ToolSteps(m.steps)
                m.imageUrls.forEach { u -> AsyncImage(model = u, contentDescription = "Image from the conversation", contentScale = ContentScale.Fit,
                    modifier = Modifier.padding(bottom = 6.dp).widthIn(max = 280.dp).clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt).clickable { onOpen(MediaRef(u, MediaRef.Kind.Image)) }) }
                AssistantBody(agentName, m.content, onOpen = onOpen) { RichText(it) }
                if (m.ts > 0) Text(agoLabel(m.ts), style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.padding(top = 4.dp))
                val media = remember(m.content) { extractMedia(MediaTags.parse(m.content).text) }
                media.forEach { ref -> MediaCard(ref) { onOpen(ref) } }
            }
        }
    }
}

@Composable
private fun StreamingMessage(agentName: String, state: ChatState, modifier: Modifier, onOpen: (MediaRef) -> Unit) {
    val c = LocalHubColors.current
    val reduce = reduceMotion()
    Row(modifier.fillMaxWidth()) {
        AgentAvatar(agentName, null, 28.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).animateContentSize()) {
            if (state.streamReasoning.isNotBlank()) Reasoning(state.streamReasoning, live = true)
            val parsedStream = remember(state.streamText) { MediaTags.parseStreaming(state.streamText) }
            val text = parsedStream.text
            val status = if (state.reconnecting) "Reconnecting…" else statusLine(agentName, state.toolLabel, state.streamReasoning.isNotBlank(), text.isNotBlank())
            if (text.isNotBlank()) {
                val fadeFrom = if (reduce) text.length else maxOf(0, text.length - STREAM_FADE_CHARS)
                Text(
                    buildAnnotatedString {
                        append(text.substring(0, fadeFrom))
                        for (i in fadeFrom until text.length) {
                            withStyle(SpanStyle(color = c.text.copy(alpha = streamAlpha(i, text.length)))) { append(text[i]) }
                        }
                    },
                    style = MaterialTheme.typography.bodyLarge, color = c.text,
                )
            }
            AgentMediaCards(agentName, parsedStream.media, onOpen)
            if (status != null) ShimmerStatusText(status, Modifier.padding(top = 4.dp))
        }
    }
}

/** "Used 2 tools ▸": one calm line per assistant turn, expands to the steps. The raw tool JSON never shows. */
@Composable
private fun ToolSteps(steps: List<dev.foxfleet.app.data.ToolStep>) {
    val c = LocalHubColors.current
    var open by rememberSaveable { mutableStateOf(false) }
    val failed = steps.count { !it.ok }
    Column(Modifier.padding(bottom = 8.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).clickable { open = !open }.animateContentSize().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text((if (steps.size == 1) "Used 1 tool" else "Used ${steps.size} tools") + (if (failed > 0) " · $failed failed" else "") + (if (open) " ▾" else " ▸"), style = MaterialTheme.typography.labelMedium, color = c.textMuted)
        if (open) steps.forEach { t ->
            Column(Modifier.padding(top = 6.dp)) {
                Text(t.name + if (!t.ok) " ⚠" else "", style = MaterialTheme.typography.labelMedium, color = c.text)
                if (t.args.isNotBlank()) Text(t.args, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (t.result.isNotBlank()) Text(t.result, style = MaterialTheme.typography.bodySmall, color = c.textFaint, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun Reasoning(text: String, live: Boolean) {
    val c = LocalHubColors.current
    var open by rememberSaveable { mutableStateOf(live) }
    Column(
        Modifier.padding(bottom = 8.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt)
            .clickable { open = !open }.animateContentSize().padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(if (open) "Reasoning ▾" else "Reasoning ▸", style = MaterialTheme.typography.labelMedium, color = c.textMuted)
        if (open) Text(text, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = if (live) 6 else Int.MAX_VALUE,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun MediaCard(ref: MediaRef, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Box(
        Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(max = 220.dp).clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (ref.kind == MediaRef.Kind.Image) AsyncImage(ref.url, ref.alt.ifBlank { "Image" }, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 220.dp))
        else Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(FoxIcons.get("play"), null, tint = c.accent, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(8.dp))
            Text(ref.url.substringAfterLast('/').take(40), style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1)
        }
    }
}

/** What a plain message means while the agent works (no picker). */
internal fun plainMode(native: Boolean, modes: List<String>) = if (native) "auto" else if ("interrupt" in modes) "interrupt" else "queue"
/** /model typed in the chat: no argument opens the picker; with arguments it sets the model of this chat only (never the profile default). */
internal fun modelCommand(args: String, controls: NativeControls?, state: ChatState, picker: () -> Unit) {
    if (args.isEmpty()) { picker(); return }
    if (Regex("(^|\\s)--global(\\s|$)").containsMatchIn(args)) { state.addNotice("Changing the Hermes default is not done from the chat. Use the agent settings."); return }
    if (state.sessionId == null || controls == null) { state.addNotice("Send the first message first: the model is set per conversation."); return }
    val provider = Regex("--provider\\s+(\\S+)").find(args)?.groupValues?.get(1); val model = args.replace(Regex("--provider\\s+\\S+"), "").trim()
    CoroutineScope(Dispatchers.Main).launch { runCatching { controls.setModel(model, provider) }.onSuccess { state.addNotice(modelSetMessage(model)) }.onFailure { state.addNotice("Could not change the model") } }
}
/** Honest names for the send modes. */
internal fun modeLabel(mode: String) = when (mode) { "steer" -> "Steer"; "interrupt" -> "Interrupt & send"; else -> "Queue" }
internal fun queueStateLabel(state: String) = when (state) {
    "queued" -> "Queued"; "awaiting_stop" -> "Waiting for the reply to stop"; "sending" -> "Sending…"
    "guidance_accepted" -> "Guidance accepted (not confirmed used yet)"; "failed" -> "Not sent"; else -> state
}

@Composable
private fun Composer(
    agentName: String,
    streaming: Boolean,
    skills: List<String>,
    onSend: (String, List<ImageAttachment>, String) -> Unit,
    onStop: () -> Unit,
    initialInput: String,
    initialAttachments: List<ImageAttachment>,
    onLocal: (LocalCommand, String) -> Unit,
    allowImages: Boolean = true,
    onUploadFile: (suspend (Uri, (Float) -> Unit) -> FileRef)? = null,
    initialFiles: List<FileRef> = emptyList(),
    placeholder: String? = null,
    agentCommands: Boolean = true,
    modes: List<String> = listOf("queue"),
    native: Boolean = false,
    onModel: (String) -> Unit = {},
    onChoices: (String, List<String>) -> Unit = { _, _ -> },
    defs: List<CommandDef>? = null,
    waiting: Int = 0,
) {
    val c = LocalHubColors.current
    val mode = plainMode(native, modes)
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var input by rememberSaveable { mutableStateOf(initialInput) }
    var attachments by remember { mutableStateOf(initialAttachments) }
    var encoding by remember { mutableStateOf(0) }
    var files by remember { mutableStateOf(initialFiles) }
    var uploads by remember { mutableStateOf(mapOf<Long, Float>()) }
    var note by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var browser by remember { mutableStateOf(false) }
    var browserQuery by remember { mutableStateOf("") }
    var showHidden by remember { mutableStateOf(false) }
    val haptic = rememberHaptic()
    val reduce = reduceMotion()
    val voice = remember { VoiceInput(ctx.applicationContext) }
    DisposableEffect(Unit) { onDispose { voice.release() } }
    var dictationBase by remember { mutableStateOf("") }

    fun addUris(uris: List<Uri>) {
        val room = MAX_IMAGES - attachments.size
        if (room <= 0) { note = "Up to $MAX_IMAGES images per message"; return }
        uris.take(room).forEach { uri ->
            encoding++
            scope.launch {
                val r = runCatching { withContext(Dispatchers.IO) { ImageEncoder.encode(ctx, uri) } }
                encoding--
                r.onSuccess { attachments = attachments + it }.onFailure { note = "Couldn't attach that image" }
            }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES)) { addUris(it) }
    val docPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val upload = onUploadFile ?: return@rememberLauncherForActivityResult
        uris.take(MAX_FILES - files.size).forEach { uri ->
            val key = System.nanoTime()
            uploads = uploads + (key to 0f)
            scope.launch {
                val r = runCatching { upload(uri) { p -> uploads = uploads + (key to p) } }
                uploads = uploads - key
                r.onSuccess { files = files + it }.onFailure { note = it.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Upload failed" }
            }
        }
    }
    var cameraUri by remember { mutableStateOf<Uri?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) cameraUri?.let { addUris(listOf(it)) } }
    fun startVoice() {
        dictationBase = input
        voice.start { heard, _ -> input = mergeDictation(dictationBase, heard) }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoice() else note = "Microphone permission is off"
    }
    LaunchedEffect(voice.error) { voice.error?.let { note = it } }
    LaunchedEffect(note) { if (note != null) { delay(2500); note = null } }

    val suggestions = remember(input, skills, agentCommands, defs) { commandSuggestions(input, skills, limit = Int.MAX_VALUE, agentCommands = agentCommands, defs = defs) }
    val canSend = (input.isNotBlank() || attachments.isNotEmpty() || files.isNotEmpty()) && encoding == 0 && uploads.isEmpty()
    fun send() {
        if (!canSend) return
        if (attachments.isEmpty() && files.isEmpty()) {
            if (agentCommands && opensCommandBrowser(input)) { input = ""; browser = true; browserQuery = ""; showHidden = false; return }
            parseLocal(input, agentCommands)?.let { (cmd, args) -> onLocal(cmd, args); input = ""; return }
            if (native) Regex("^/model(?:\\s+(.*))?$", RegexOption.IGNORE_CASE).find(input.trim())?.let { m -> input = ""; onModel(m.groupValues[1].trim()); return }
            if (native) Regex("^/([A-Za-z0-9_-]+)$").find(input.trim())?.let { m ->
                (defs ?: HermesCatalog.defs).firstOrNull { it.name == m.groupValues[1].lowercase() || m.groupValues[1].lowercase() in it.aliases }
                    ?.takeIf { it.executable && it.subcommands.size > 1 && !it.handler.startsWith("hub:") }?.let { d -> input = ""; onChoices(d.name, d.subcommands); return }
            }
            parseHub(input, defs ?: HermesCatalog.defs)?.takeIf { agentCommands || it.cmd != "steer" }?.let { h ->
                if (!h.def.executable) { note = "/${h.def.name}: ${h.def.disabledReason.ifEmpty { "Not available for this agent" }}"; return }
                when (h.cmd) {
                    "busy" -> { note = "Behaviour while Hermes works is a profile setting: Agents \u25B8 your Hermes agent. Use /steer, /queue or /stop for one message." + if (waiting > 0) " \u00B7 $waiting waiting" else ""; input = ""; return }
                    "queue" -> if (h.args.isNotEmpty() && !Regex("^(list|rm|clear|edit|move)\\b").containsMatchIn(h.args)) { input = ""; onSend(h.args.removePrefix("add ").trim(), emptyList(), "queue"); return } else { note = "/queue <message>"; return }
                    "steer" -> if (h.args.isNotEmpty()) { input = ""; onSend(h.args, emptyList(), "steer"); return } else { note = "/steer <guidance>"; return }
                }
            }
            HermesCatalog.unavailableReason(input).takeIf { agentCommands }?.let { note = "${input.trim().substringBefore(' ')}: $it"; return }
        }
        val t = FileMarker.compose(input.trim(), files); val imgs = attachments
        input = ""; attachments = emptyList(); files = emptyList(); voice.stop()
        haptic(HapticFeedbackType.Confirm); onSend(t, imgs, mode)
    }

    val browserRows = if (browser) commandSuggestions(if (browserQuery.isBlank()) "/" else "/$browserQuery", skills, limit = Int.MAX_VALUE, agentCommands = agentCommands, defs = defs, includeHidden = showHidden) else emptyList()
    Column(Modifier.fillMaxWidth()) {
        if (browser) Dialog(onDismissRequest = { browser = false }) {
            Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).clip(RoundedCornerShape(16.dp)).background(c.surface).padding(16.dp)) {
                Text("Commands", style = MaterialTheme.typography.titleMedium, color = c.text)
                Spacer(Modifier.size(8.dp))
                BasicTextField(
                    value = browserQuery, onValueChange = { browserQuery = it }, singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(10.dp),
                    decorationBox = { inner -> if (browserQuery.isEmpty()) Text("Search commands", color = c.textFaint, style = MaterialTheme.typography.bodyLarge); inner() },
                )
                Row(Modifier.padding(top = 8.dp).clickable { showHidden = !showHidden }, verticalAlignment = Alignment.CenterVertically) {
                    Text(if (showHidden) "☑" else "☐", color = c.accent)
                    Spacer(Modifier.width(8.dp))
                    Text("Show commands that can't run from here", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                }
                Column(Modifier.padding(top = 8.dp).heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    if (browserRows.isEmpty()) Text("No matching commands.", color = c.textMuted)
                    browserRows.forEachIndexed { i, s ->
                        if (s.group.isNotEmpty() && s.group != browserRows.getOrNull(i - 1)?.group)
                            Text(s.group.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.padding(top = 8.dp))
                        Text(
                            s.label + if (s.hint.isNotEmpty()) "  ${s.hint}" else "",
                            color = if (s.availability == "unavailable") c.textFaint else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().clickable {
                                if (s.availability == "unavailable") note = "${s.label}: ${s.reason.ifEmpty { "Not available remotely" }}"
                                else if (s.local != null && s.local != LocalCommand.Title) { onLocal(s.local, ""); input = "" } else input = s.insert
                                browser = false
                            }.padding(vertical = 8.dp),
                        )
                    }
                }
                Text("Close", color = c.accent, modifier = Modifier.padding(top = 8.dp).clickable { browser = false })
            }
        }
        AnimatedVisibility(suggestions.isNotEmpty() && !browser, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            Column(
                Modifier.padding(horizontal = 12.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.surface)
                    .heightIn(max = 260.dp).verticalScroll(rememberScrollState()).padding(vertical = 4.dp),
            ) {
                suggestions.forEachIndexed { i, s ->
                    if (s.group.isNotEmpty() && s.group != suggestions.getOrNull(i - 1)?.group)
                        Text(s.group.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 2.dp))
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            if (s.label == "/help" || s.label == "/palette") { input = ""; browser = true; browserQuery = ""; showHidden = false }
                            else if (s.availability == "unavailable") note = "${s.label}: ${s.reason.ifEmpty { "Not available remotely" }}"
                            else if (s.local != null && s.local != LocalCommand.Title) { onLocal(s.local, ""); input = "" } else input = s.insert
                        }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(s.label + if (s.args.isNotEmpty()) " " + s.args else "", style = MaterialTheme.typography.bodyLarge, color = if (s.availability == "unavailable") c.textFaint else c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 190.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(s.hint, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(start = 20.dp, top = 6.dp)) }
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).clip(RoundedCornerShape(26.dp))
                .background(c.surface).animateContentSize(),
        ) {
            if (files.isNotEmpty() || uploads.isNotEmpty()) Column(
                Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                files.forEach { f -> FileChip(f.name, FileMarker.humanSize(f.size), onRemove = { files = files - f }) }
                uploads.values.forEach { p ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(progress = { p }, modifier = Modifier.size(18.dp), color = c.accent, strokeWidth = 2.dp, trackColor = c.surfaceAlt)
                        Spacer(Modifier.width(8.dp))
                        Text("Uploading… ${(p * 100).toInt()}%", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                    }
                }
            }
            if (attachments.isNotEmpty() || encoding > 0) Row(
                Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                attachments.forEach { a ->
                    Box(Modifier.size(64.dp)) {
                        AsyncImage(java.io.File(a.localPath), "Attachment", contentScale = ContentScale.Crop,
                            modifier = Modifier.size(64.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt))
                        Box(
                            Modifier.align(Alignment.TopEnd).padding(3.dp).size(20.dp).clip(CircleShape).background(Color(0x99000000))
                                .clickable { attachments = attachments - a },
                            contentAlignment = Alignment.Center,
                        ) { Icon(FoxIcons.get("close"), "Remove", tint = Color.White, modifier = Modifier.size(14.dp)) }
                    }
                }
                repeat(encoding) {
                    Box(Modifier.size(64.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = c.textMuted, strokeWidth = 2.dp)
                    }
                }
            }
            Row(Modifier.padding(start = 4.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.Bottom) {
                if (allowImages || onUploadFile != null) Box {
                    SoftIconButton(FoxIcons.get("attach"), "Attach", { menu = true })
                    DropdownMenu(menu, { menu = false }, containerColor = c.surface) {
                        if (onUploadFile != null) DropdownMenuItem(text = { Text("File (PDF, docs, zip…)") }, onClick = {
                            menu = false; docPicker.launch(arrayOf("*/*"))
                        })
                        if (allowImages) DropdownMenuItem(text = { Text("Photo library") }, onClick = {
                            menu = false; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        })
                        if (allowImages) DropdownMenuItem(text = { Text("Take photo") }, onClick = {
                            menu = false
                            val dir = java.io.File(ctx.cacheDir, "camera").apply { mkdirs() }
                            val f = java.io.File(dir, "cam-${System.currentTimeMillis()}.jpg")
                            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
                            cameraUri = uri
                            runCatching { camera.launch(uri) }.onFailure { note = "No camera app found" }
                        })
                    }
                }
                Box(Modifier.weight(1f).heightIn(min = 40.dp).padding(vertical = 10.dp, horizontal = 6.dp), contentAlignment = Alignment.CenterStart) {
                    if (input.isEmpty()) Text(
                        if (voice.listening) "Listening…" else placeholder ?: "Message $agentName",
                        style = MaterialTheme.typography.bodyLarge, color = c.textFaint,
                    )
                    BasicTextField(
                        value = input, onValueChange = { input = it }, maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text),
                        cursorBrush = SolidColor(c.accent),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                val showMic = input.isBlank() && attachments.isEmpty() && files.isEmpty()
                if (showMic) {
                    val pulse by animateFloatAsState(if (voice.listening && !reduce) 1f + 0.25f * voice.level else 1f, label = "mic")
                    val src = remember { MutableInteractionSource() }
                    Box(
                        Modifier.size(40.dp).pressScale(src, 0.88f).graphicsLayer { scaleX = pulse; scaleY = pulse }.clip(CircleShape)
                            .background(if (voice.listening) c.accent else c.surfaceAlt)
                            .clickable(interactionSource = src, indication = null) {
                                when {
                                    voice.listening -> voice.stop()
                                    !voice.available -> note = "Voice input isn't available on this phone"
                                    ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> startVoice()
                                    else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            },
                        contentAlignment = Alignment.Center,
                    ) { Icon(FoxIcons.get("mic"), if (voice.listening) "Stop voice input" else "Voice input", tint = if (voice.listening) c.onAccent else c.textMuted, modifier = Modifier.size(22.dp)) }
                } else {
                    if (streaming) {
                        val stopSrc = remember { MutableInteractionSource() }
                        Box(
                            Modifier.size(40.dp).pressScale(stopSrc, 0.88f).clip(CircleShape).background(c.surfaceAlt)
                                .clickable(interactionSource = stopSrc, indication = null, onClickLabel = "Stop") { onStop() },
                            contentAlignment = Alignment.Center,
                        ) { Icon(FoxIcons.get("stop"), "Stop", tint = c.text, modifier = Modifier.size(22.dp)) }
                    }
                    val src = remember { MutableInteractionSource() }
                    val active = canSend
                    Box(
                        Modifier.size(40.dp).pressScale(src, 0.88f).clip(CircleShape)
                            .background(if (active) c.accent else c.surfaceAlt)
                            .clickable(interactionSource = src, indication = null, enabled = active, onClickLabel = "Send") { send() },
                        contentAlignment = Alignment.Center,
                    ) { Icon(FoxIcons.get("send"), "Send", tint = if (active) c.onAccent else c.textFaint, modifier = Modifier.size(22.dp)) }
                }
            }
        }
    }
}

const val MAX_IMAGES = 4

private const val MAX_FILES = 4

@Composable
private fun KindBadge(label: String) {
    val c = LocalHubColors.current
    Text(label, style = MaterialTheme.typography.labelSmall, color = c.accent,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(c.accent.copy(alpha = 0.12f)).padding(horizontal = 7.dp, vertical = 2.dp))
}

/** Document chip: used in the composer (removable) and in sent bubbles. */
@Composable
fun FileChip(name: String, size: String, modifier: Modifier = Modifier, onRemove: (() -> Unit)? = null) {
    val c = LocalHubColors.current
    Row(
        modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt).padding(start = 10.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(c.accent.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
            Text(name.substringAfterLast('.', "").take(4).uppercase().ifBlank { "FILE" }, style = MaterialTheme.typography.labelSmall, color = c.accent, maxLines = 1)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f, fill = false)) {
            Text(name, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(size, style = MaterialTheme.typography.labelSmall, color = c.textMuted)
        }
        if (onRemove != null) {
            Spacer(Modifier.width(4.dp))
            Box(Modifier.size(24.dp).clip(CircleShape).clickable(onClick = onRemove), contentAlignment = Alignment.Center) {
                Icon(FoxIcons.get("close"), "Remove", tint = c.textMuted, modifier = Modifier.size(16.dp))
            }
        } else Spacer(Modifier.width(6.dp))
    }
}
