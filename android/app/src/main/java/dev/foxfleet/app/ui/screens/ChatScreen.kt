package dev.foxfleet.app.ui.screens

import dev.foxfleet.app.data.MessageKeys
import dev.foxfleet.app.ui.components.messagePress
import dev.foxfleet.app.data.MessageKinds
import dev.foxfleet.app.ui.FoxIcons
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.draw.shadow
import dev.foxfleet.app.ui.chat.ScrollFollow
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
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.SessionInfo
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.Hairline
import dev.foxfleet.app.ui.components.ShimmerStatusText
import dev.foxfleet.app.ui.motion.messageEnter
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
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.CompositionLocalProvider
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.chat.ChatBackgroundLayer
import dev.foxfleet.app.ui.chat.ChatBackgroundSheet
import dev.foxfleet.app.ui.chat.LocalChatBgActive
import dev.foxfleet.app.ui.chat.bgChip
import dev.foxfleet.app.ui.chat.rememberChatBackground
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
import dev.foxfleet.app.ui.chat.DossierMedia
import dev.foxfleet.app.ui.chat.HermesCatalog
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.chat.opensCommandBrowser
import dev.foxfleet.app.ui.chat.parseLocal
import dev.foxfleet.app.ui.chat.parseHub
import dev.foxfleet.app.ui.chat.CommandDef
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.liveRegion
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
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.ui.semantics.customActions
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import dev.foxfleet.app.ui.chat.HEART
import dev.foxfleet.app.ui.chat.MessageAction
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.ReplyTarget
import dev.foxfleet.app.ui.components.HeartPop
import dev.foxfleet.app.ui.components.MessageMenuSheet
import dev.foxfleet.app.ui.components.ReplyQuote
import dev.foxfleet.app.ui.components.SelectTextDialog
import dev.foxfleet.app.ui.components.SwipeToReply

/** Chars at the tail of a streaming reply that fade in instead of popping. */
const val STREAM_FADE_CHARS = 24

/** The viewer's list plus the page it opened on (0.4.3 C3). */
private data class Viewed(val items: List<MediaRef>, val index: Int)

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
    /** Delete a cached media file from this device (0.4.3 C2); null hides the viewer's trash action. */
    onDeleteMedia: ((MediaRef) -> Unit)? = null,
    /** Reactions (agents whose hub keeps them): re-read after replies and every 30 s while the chat is on screen. */
    onSyncReactions: () -> Unit = {},
    /** A chip under a message: [present] = what tapping it makes (add yours, or take it back). */
    onReact: (message: UiMessage, emoji: String, present: Boolean) -> Unit = { _, _, _ -> },
    /** Quick row, picker, double tap: add the emoji, or take yours back when you already gave it. */
    onToggleReaction: (message: UiMessage, emoji: String) -> Unit = { m, e -> state.reactions?.let { s -> onReact(m, e, MessageActions.nextReaction(s.groupsFor(m), s.actor.id, e)) } },
    /** Delete for me (hub hidden list); null hides the action. */
    onHide: ((messageId: String, present: Boolean) -> Unit)? = null,
    /** Edit (Hermes only): run /undo on [target]'s exchange, then call the given function to put its text back. */
    onEditLast: ((target: UiMessage, onUndone: () -> Unit) -> Unit)? = null,
    /** Screenshot tests: open with a reply already chosen. */
    initialReply: ReplyTarget? = null,
    /** Phase 1 live v2: the agent's typing line ("typing…", "thinking…", "running bash…") and the connection indicator. */
    typingLabel: String? = null,
    link: dev.foxfleet.app.data.live.LinkState? = null,
) {
    val c = LocalHubColors.current
    // The viewer (0.4.3 C3) opens on the chat's whole media list so horizontal swipe moves between siblings.
    var viewing by remember { mutableStateOf(initialViewing?.let { Viewed(listOf(it), 0) }) }
    val chatMedia = remember(agent.name, state.sessionId, state.messages) { DossierMedia.refs(agent.name, state.sessionId.orEmpty(), state.messages) }
    fun openMedia(ref: MediaRef) {
        val list = chatMedia
        val merged = if (list.any { DossierMedia.matches(it, ref) }) list else list + ref
        viewing = Viewed(merged, merged.indexOfFirst { DossierMedia.matches(it, ref) }.coerceAtLeast(0))
    }
    var reactingTo by remember { mutableStateOf<UiMessage?>(null) }
    var menuFor by remember { mutableStateOf<UiMessage?>(null) }
    var selecting by remember { mutableStateOf<String?>(null) }
    var reply by remember(state.sessionId) { mutableStateOf(initialReply) }
    var prefill by remember { mutableStateOf<String?>(null) }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val ctx = LocalContext.current
    // The Undo row stays 5 s; a newer hide restarts it, a failed hide or another chat clears it (ChatState).
    LaunchedEffect(state.hiddenUndo) { state.hiddenUndo?.let { id -> withContext(Dispatchers.Default) { delay(5_000) }; state.expireUndo(id) } }
    val replyTo = { m: UiMessage -> reply = ReplyTarget(if (m.role == "user") "You" else agent.label ?: agent.name, MessageActions.excerpt(m)) }
    // Quick row and picker toggle like the pills: an emoji you already gave is taken back. Bot agents have no reactions at all.
    val reactionsOn = agent.capabilities.reactions
    val toggle = { m: UiMessage, e: String -> onToggleReaction(m, e) }
    // 0.4.2: per message, whether the hub can take a reaction on it now. An older hub (no reactions at all, or no hub-id targets for a
    // message that only arrived live) gets a clear "Update your hub" line instead of a quick row, pills and double tap that silently were not there.
    val hubIds = state.hubIdReactions
    val reactStateOf = { m: UiMessage -> MessageActions.reactState(agent.capabilities, hubIds, m) }
    val reactHintToast = { st: dev.foxfleet.app.ui.chat.ReactState ->
        if (st == dev.foxfleet.app.ui.chat.ReactState.Pending) onSyncReactions() // an older hub learns the message's id from its transcript
        android.widget.Toast.makeText(ctx, MessageActions.HUB_HINT, android.widget.Toast.LENGTH_SHORT).show()
    }
    fun act(m: UiMessage, a: MessageAction) {
        menuFor = null
        when (a) {
            MessageAction.Reply -> replyTo(m)
            MessageAction.Copy -> clipboard.setText(androidx.compose.ui.text.AnnotatedString(MessageActions.displayText(m)))
            MessageAction.Select -> selecting = MessageActions.displayText(m)
            MessageAction.Share -> runCatching {
                ctx.startActivity(android.content.Intent.createChooser(
                    android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, MessageActions.displayText(m)), null))
            }
            MessageAction.Retry -> onRetry()
            MessageAction.Edit -> onEditLast?.invoke(m) { prefill = MessageActions.displayText(m) }
            MessageAction.Delete -> m.id?.let { id -> onHide?.invoke(id, true) }
        }
    }
    val gestures = MessageGestures(
        onMenu = { menuFor = it },
        onHeart = { m -> when (val st = reactStateOf(m)) { dev.foxfleet.app.ui.chat.ReactState.Ready -> toggle(m, HEART); dev.foxfleet.app.ui.chat.ReactState.Off -> Unit; else -> reactHintToast(st) } },
        onReply = replyTo,
        onUndoHide = { id -> onHide?.invoke(id, false) },
    )
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(state.sessionId, state.streaming, state.loading, state.messages.lastOrNull()?.id) { if (!state.streaming && !state.loading && state.sessionId != null) onSyncReactions() }
    LaunchedEffect(state.sessionId, lifecycle, state.hubIdReactions) {
        // Wall-clock wait off the frame clock: the poll never keeps the UI (or a UI test) busy.
        // hubs with `reactionEvents` push every change (message.reaction); the poll stays for older hubs only
        if (state.sessionId != null && !state.hubIdReactions) lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.RESUMED) { while (true) { withContext(Dispatchers.Default) { delay(30_000) }; if (!state.streaming) onSyncReactions() } }
    }
    val scope = rememberCoroutineScope()
    var history by remember { mutableStateOf(historyOpen) }
    var picker by remember { mutableStateOf<PickerCard?>(null) }
    // Per-chat background (kept on this phone only); a new chat's look moves to the chat when the hub gives it an id.
    val bgState = rememberChatBackground(agent.name, state.sessionId, state.messages.isNotEmpty() || state.streaming)
    var bgSheet by remember { mutableStateOf(false) }
    CompositionLocalProvider(LocalChatBgActive provides !bgState.bg.isDefault) {
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding().imePadding()) {
            // Narrow phones (under 400 dp) or large text: Screen, Background and History move into one "More" menu so the name keeps room; New chat stays an icon. All targets stay 44 dp or more.
            val compact = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp < 400 || androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.15f
            var moreMenu by remember { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text)
                Spacer(Modifier.width(4.dp))
                AgentAvatar(agent.name, agent.presence(), 34.dp, Modifier.sharedAvatar(agent.name)
                    .combinedClickable(onClick = {}, onLongClick = { onAvatarLongPress(agent.name) }))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(agent.label ?: agent.name, style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        agent.badge?.let { Spacer(Modifier.width(6.dp)); KindBadge(it) }
                    }
                    // Connection here; what the agent is doing shows once, under the reply it is writing.
                    val linkText = dev.foxfleet.app.ui.ChatRows.linkLabel(link)
                    if (state.reconnecting) ShimmerStatusText("Reconnecting…", style = MaterialTheme.typography.bodySmall)
                    else if (typingLabel != null) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics { contentDescription = "${agent.label ?: agent.name} is $typingLabel" }) {
                        Text(typingLabel, style = MaterialTheme.typography.bodySmall, color = c.accent, maxLines = 1); TypingDots(c.accent)
                    }
                    // Offline is a state, not progress: a static label (the shimmer dips below 4.5:1 mid-sweep). Connecting/Updating keep the shimmer.
                    else if (link == dev.foxfleet.app.data.live.LinkState.Offline && linkText != null) Text(linkText, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1, modifier = Modifier.semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite })
                    else if (linkText != null) ShimmerStatusText(linkText, style = MaterialTheme.typography.bodySmall)
                    else Text(if (agent.online) "Online" else "Offline", style = MaterialTheme.typography.bodySmall, color = if (agent.online) c.onlineText else c.textMuted, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                }
                if (!compact) {
                    if (onOpenScreen != null) SoftIconButton(FoxIcons.get("screen"), "Agent's screen", onOpenScreen)
                    SoftIconButton(FoxIcons.get("wallpaper"), "Chat background", { bgSheet = true })
                    if (agent.capabilities.sessions) SoftIconButton(FoxIcons.get("history"), "Chat history", { history = true })
                }
                SoftIconButton(FoxIcons.get("add"), "New chat", onNewChat)
                if (compact) Box {
                    SoftIconButton(FoxIcons.get("more"), "More actions", { moreMenu = true })
                    DropdownMenu(moreMenu, { moreMenu = false }, containerColor = c.surface) {
                        if (onOpenScreen != null) DropdownMenuItem(text = { Text("Agent's screen") }, leadingIcon = { FoxIcon("screen", null, tint = c.textMuted) }, onClick = { moreMenu = false; onOpenScreen() })
                        DropdownMenuItem(text = { Text("Chat background") }, leadingIcon = { FoxIcon("wallpaper", null, tint = c.textMuted) }, onClick = { moreMenu = false; bgSheet = true })
                        if (agent.capabilities.sessions) DropdownMenuItem(text = { Text("Chat history") }, leadingIcon = { FoxIcon("history", null, tint = c.textMuted) }, onClick = { moreMenu = false; history = true })
                    }
                }
            }
            Hairline()
            Box(Modifier.weight(1f).fillMaxWidth()) {
                ChatBackgroundLayer(bgState.bg, bgState.bitmap)
                Transcript(agent.name, state, Modifier.fillMaxSize(), onLoadOlder, onResumeQueue, onCancelQueued, onAnswerRequest, reactionsOn = reactionsOn, reactStateOf = reactStateOf, onReact = onReact, onPickReaction = { reactingTo = it }, gestures = gestures, agentLabel = agent.displayName) { openMedia(it) }
            }
            Composer(
                agent.name, state.streaming, skills, onSendMode ?: { t, i, _ -> onSend(t, i) }, onStop, initialInput, initialAttachments,
                modes = agent.capabilities.busy, native = agent.capabilities.nativeUi, models = agent.capabilities.modelsMode, modelsKnown = agent.capabilities.models != null, onModel = { args -> modelCommand(args, nativeControls, state, picker = { picker = PickerCard(state.sessionId, "model") }, onConfirm = { m, p, r -> picker = PickerCard(state.sessionId, "model", ask = Triple(m, p, r)) }) }, onChoices = { cmd, opts -> picker = PickerCard(state.sessionId, "choice", cmd, opts) }, defs = commandDefs, waiting = state.queue.count { it.state == "queued" || it.state == "awaiting_stop" },
                allowImages = allowImages, onUploadFile = onUploadFile, initialFiles = initialFiles,
                agentCommands = agent.capabilities.skills,
                reply = reply, onClearReply = { reply = null }, disabled = state.loading,
                prefill = prefill, onPrefilled = { applied -> prefill = null; if (!applied) state.addNotice("Your edited text wasn't put back because the box isn't empty.") },
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
        if (pc.kind == "model" && nativeControls != null) ModelPickerSheet(nativeControls, state.sessionId != null, { state.addNotice(it); picker = null }, { picker = null }, startAsk = pc.ask)
        else if (pc.kind == "choice") ChoiceSheet(pc.command.orEmpty(), pc.options, { picker = null; (onSendMode ?: { t, i, _ -> onSend(t, i) })(it, emptyList(), "interrupt") }, { picker = null })
    }
    // The menu follows its message: a reloaded copy (same hub id) keeps it open; a message that went away (or was hidden) closes it.
    val menuMsg = menuFor?.let { mf ->
        val hidden = state.reactions?.hidden.orEmpty()
        (state.messages.firstOrNull { it === mf } ?: mf.hubId?.let { h -> state.messages.firstOrNull { it.hubId == h } } ?: mf.id?.let { id -> state.messages.firstOrNull { it.id == id } })?.takeIf { it.id == null || it.id !in hidden }
    }
    LaunchedEffect(menuFor, menuMsg) { if (menuFor != null && menuMsg == null) menuFor = null }
    // an older hub: opening the menu on a message it cannot address yet asks for its id (the quick row appears once it is known)
    val menuReact = menuMsg?.let(reactStateOf)
    LaunchedEffect(menuFor, menuReact) { if (menuReact == dev.foxfleet.app.ui.chat.ReactState.Pending) onSyncReactions() }
    menuMsg?.let { m ->
        val newest = MessageActions.newestTargets(state.messages)
        val busy = state.streaming || state.queuePending
        MessageMenuSheet(
            actions = MessageActions.actions(m, newestAssistant = m === newest.assistant, newestUser = m === newest.user, busy = busy, hermes = agent.isHermes && onEditLast != null, canHide = onHide != null && state.reactions?.hidden != null),
            // a message that only arrived live (hub id, no provider id yet) can be reacted to as well (0.4.0 offered no row for it)
            canReact = menuReact == dev.foxfleet.app.ui.chat.ReactState.Ready,
            reactHint = menuReact?.let(MessageActions::reactHint),
            onReact = { e -> menuFor = null; toggle(m, e) },
            onMoreReactions = { menuFor = null; reactingTo = m },
            onAction = { act(m, it) }, onDismiss = { menuFor = null },
        )
    }
    reactingTo?.let { m -> dev.foxfleet.app.ui.components.EmojiPickerSheet(onPick = { e -> reactingTo = null; toggle(m, e) }, onDismiss = { reactingTo = null }) }
    selecting?.let { SelectTextDialog(it) { selecting = null } }
    if (history) HistorySheet(agent.name, sessions, sessionsTotal, state.sessionId, sessionsLoading, historyError, onOpenSession, onNewChat, onRefreshSessions, onLoadMoreSessions, onRenameSession, onDeleteSession) { history = false }
    if (bgSheet) ChatBackgroundSheet(bgState) { bgSheet = false }
    AnimatedVisibility(viewing != null, enter = fadeIn(), exit = fadeOut()) {
        viewing?.let { v -> MediaViewer(v.items, v.index, httpClient, onClose = { viewing = null }, onDelete = onDeleteMedia) }
    }
    }
}


/**
 * [agentName] is the agent's id: media (`/api/agents/{id}/media`), avatars, list keys and every hub call use it.
 * [agentLabel] is its display name, for text only ("Start a conversation with …", the live status line, request card titles).
 * 0.4.2 vc31 passed the label as [agentName], so every MEDIA card of a labelled agent asked the hub for an unknown agent (404).
 */
@Composable
private fun Transcript(agentName: String, state: ChatState, modifier: Modifier, onLoadOlder: () -> Unit, onResumeQueue: () -> Unit, onCancelQueued: (String) -> Unit, onAnswerRequest: (suspend (String, kotlinx.serialization.json.JsonObject) -> String?)?, reactionsOn: Boolean = true, reactStateOf: (UiMessage) -> dev.foxfleet.app.ui.chat.ReactState = { if (reactionsOn) dev.foxfleet.app.ui.chat.ReactState.Ready else dev.foxfleet.app.ui.chat.ReactState.Off }, onReact: (UiMessage, String, Boolean) -> Unit = { _, _, _ -> }, onPickReaction: (UiMessage) -> Unit = {}, gestures: MessageGestures? = null, agentLabel: String = agentName, onOpen: (MediaRef) -> Unit) {
    val c = LocalHubColors.current
    val list = rememberLazyListState()
    // reverseLayout pins the newest message to the bottom: when the keyboard opens or the
    // composer grows the list shrinks from the top, never hiding the latest reply.
    // "Follow" rules (shared with the web app): pinned = stay at the newest message; scrolled up = a round arrow, or a "New message" pill that never yanks the view.
    val follow = remember(agentName, state.sessionId) { ScrollFollow() }
    var ui by remember(follow) { mutableStateOf(ScrollFollow.Result(true, false, 0, false)) }
    var lastKeyBase by remember(follow) { mutableStateOf(state.keyBase) }
    val reduce = dev.foxfleet.app.ui.motion.reduceMotion()
    val scope = rememberCoroutineScope()
    LaunchedEffect(follow) {
        snapshotFlow { list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset }.collect { (i, off) ->
            // reverseLayout: index 0 is the newest; each hidden newer item is at least a line high, so count it as ~150px
            val r = follow.scroll(off + i * 150f); if (r.pinned != ui.pinned || r.far != ui.far || r.unread != ui.unread) ui = r
        }
    }
    // Rows from the device cache count as shown: the first draw pins to the newest one, and the hub's page that follows is
    // an ordinary update (it never yanks a reader who already scrolled up; new rows feed the "new messages" pill).
    val settled = !state.loading || state.fromCache
    LaunchedEffect(state.messages.size, state.streaming, settled, state.keyBase, state.streamText.length > 0) {
        val prepending = state.keyBase < lastKeyBase; lastKeyBase = state.keyBase
        val r = follow.content(state.messages.size, state.streaming, state.messages.lastOrNull()?.role, prepending, !settled)
        ui = r
        if (r.scroll) list.scrollToItem(0)
    }
    LaunchedEffect(state.streamText) { if (ui.pinned && state.streaming) list.scrollToItem(0) }
    // Long conversations load in pages: reaching the oldest loaded message fetches the next older page.
    val nearTop by remember { derivedStateOf { list.layoutInfo.let { it.totalItemsCount > 0 && (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 3 } } }
    LaunchedEffect(nearTop, state.hasOlder, state.messages.size) { if (nearTop && state.hasOlder && !state.loadingOlder) onLoadOlder() }
    if (state.messages.isEmpty() && !state.streaming && !state.loading && state.error == null) {
        Column(modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            AgentAvatar(agentName, null, 56.dp)
            Spacer(Modifier.size(14.dp))
            Text("Start a conversation with $agentLabel", style = MaterialTheme.typography.titleMedium, color = c.text, modifier = Modifier.bgChip())
            Spacer(Modifier.size(6.dp))
            Text("Replies stream in live. Long-press a message for more.", style = MaterialTheme.typography.bodySmall, color = if (LocalChatBgActive.current) c.text else c.textMuted, modifier = Modifier.bgChip())
        }
        return
    }
    var baseline by remember { mutableStateOf<Int?>(null) }
    // Hidden messages and reaction-only replies draw no row; parsed once per change, not on every recomposition or reaction sync.
    val hiddenIds = state.reactions?.hidden.orEmpty()
    val visible = remember(state.messages, hiddenIds) { MessageActions.visible(state.messages, hiddenIds) }
    val msgKeys = remember(state.messages) { MessageKeys.keys(state.messages) }
    androidx.compose.runtime.LaunchedEffect(state.loading, state.fromCache, state.messages.isNotEmpty()) { if ((!state.loading || state.fromCache) && baseline == null) { kotlinx.coroutines.delay(700); baseline = state.keyBase + state.messages.size } }
    Box(modifier.fillMaxWidth()) {
    LazyColumn(
        state = list, reverseLayout = true, modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.Bottom),
    ) {
        itemsIndexed(state.notices.reversed(), key = { i, _ -> "notice-$i" }, contentType = { _, _ -> "notice" }) { _, n ->
            Text(n, style = MaterialTheme.typography.bodySmall, color = c.textMuted, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp).wrapContentWidth().bgChip())
        }
        state.hiddenUndo?.let { id -> item(key = "hide-undo", contentType = "notice") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Text("Message hidden", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                Box(Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp).clip(RoundedCornerShape(10.dp)).clickable(role = Role.Button) { gestures?.onUndoHide?.invoke(id) }.padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text("Undo", style = MaterialTheme.typography.labelLarge, color = c.accent)
                }
            }
        } }
        state.reactionError?.let { e -> item(key = "react-error", contentType = "notice") { Text(e, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.fillMaxWidth().padding(4.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center) } }
        state.error?.let { e ->
            item(key = "error", contentType = "notice") {
                Text(e, style = MaterialTheme.typography.bodySmall, color = c.textMuted,
                    modifier = Modifier.animateItem().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(12.dp))
            }
        }
        // Newest at the bottom: what the hub still holds for this chat sits under the reply that is streaming.
        if (state.halted && state.queue.any { it.state == "queued" }) item(key = "q-paused", contentType = "notice") {
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Text("Queue paused", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                Text("Resume queue", style = MaterialTheme.typography.labelLarge, color = c.accent, modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onResumeQueue() }.padding(10.dp))
            }
        }
        // cards for what the agent is waiting on sit at the very bottom, where the eye is
        if (onAnswerRequest != null && state.requests.isNotEmpty()) items(state.requests.size, key = { "req-" + state.requests[it].id }, contentType = { "request" }) { i -> RequestCard(state.requests[i], agentLabel, onAnswerRequest) }
        val waiting = state.queue.asReversed()
        items(waiting.size, key = { "q-" + waiting[it].id }, contentType = { "queued" }) { i ->
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
        if (state.streaming) item(key = "stream", contentType = "stream") {
            StreamingMessage(agentName, state, Modifier.animateItem(), onOpen, agentLabel = agentLabel)
        }
        if (state.loading) item(key = "loading", contentType = "status") { ShimmerStatusText("Loading conversation…", Modifier.padding(8.dp)) }
        // Keys are the message's own identity (hub id, or a content hash), never a list position:
        // a cache page swapped for the hub's page, an older page added at the far end, or a hidden
        // row leaves every other row's key alone, so LazyColumn keeps the reader's anchor in place.
        val rev = visible.asReversed()
        items(rev.size, key = { msgKeys.getOrElse(rev[it].index) { "i:${state.keyBase + rev[it].index}" } }, contentType = { MessageKinds.of(rev[it].value) }) { i ->
            // only messages that arrive after the history has been shown animate in (never old ones scrolled back into view)
            val (index, m) = rev[i]; val b = baseline; val isNew = b != null && state.keyBase + index >= b
            // chips by hub id when the hub keys them so (0.4.1), else by provider id; none for agents without reactions (bots)
            val snap = state.reactions
            // 0.4.2: no snapshot yet (or the hub could not read it) no longer takes the double tap away: no pills to show, the tap still reacts
            val st = reactStateOf(m)
            val reactions = if (st == dev.foxfleet.app.ui.chat.ReactState.Ready) MessageReactions(snap?.groupsFor(m).orEmpty(), snap?.actor?.id.orEmpty(), { e, on -> onReact(m, e, on) }, { onPickReaction(m) }) else null
            val canHeart = st != dev.foxfleet.app.ui.chat.ReactState.Off
            // animateItem stays on the item's root: the swipe wrapper when there is one
            val itemMod = Modifier.animateItem().messageEnter(isNew)
            if (gestures != null) SwipeToReply({ gestures.onReply(m) }, itemMod) { MessageRow(agentName, m, Modifier, onOpen, state.sessionId.orEmpty(), reactions, gestures, canHeart) }
            else MessageRow(agentName, m, itemMod, onOpen, state.sessionId.orEmpty(), reactions)
        }
        if (state.loadingOlder) item(key = "older", contentType = "status") { ShimmerStatusText("Loading earlier messages…", Modifier.padding(8.dp)) }
    }
    val kind = if (ui.pinned) "none" else if (ui.unread > 0) "pill" else if (ui.far) "arrow" else "none"
    AnimatedVisibility(kind != "none", modifier = Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 12.dp),
        enter = if (reduce) fadeIn(snap()) else fadeIn(tween(150)) + scaleIn(tween(150), initialScale = 0.85f), exit = if (reduce) fadeOut(snap()) else fadeOut(tween(150)) + scaleOut(tween(150), targetScale = 0.85f)) {
        val label = if (ui.unread > 1) "${ui.unread} new messages" else if (ui.unread == 1) "New message" else "Go to the latest message"
        Row(Modifier.defaultMinSize(minWidth = 44.dp, minHeight = 44.dp).shadow(4.dp, CircleShape).clip(CircleShape).background(if (kind == "pill") c.accent else c.surfaceAlt)
            .semantics { contentDescription = label }
            .clickable { ui = follow.jump(); scope.launch { if (reduce) list.scrollToItem(0) else list.animateScrollToItem(0) } }
            .padding(horizontal = if (kind == "pill") 14.dp else 0.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            if (kind == "pill") { Text(if (ui.unread > 1) "${ui.unread} new messages" else "New message", style = MaterialTheme.typography.labelLarge, color = androidx.compose.ui.graphics.Color.White); Spacer(Modifier.width(4.dp)) }
            Icon(FoxIcons.get("chevronDown"), null, tint = if (kind == "pill") androidx.compose.ui.graphics.Color.White else c.text, modifier = Modifier.size(22.dp))
        }
    }
    }
}

@Composable
private fun MessageRow(agentName: String, m: UiMessage, modifier: Modifier, onOpen: (MediaRef) -> Unit, sessionId: String, reactions: MessageReactions? = null, gestures: MessageGestures? = null, canHeart: Boolean = reactions != null) {
    val c = LocalHubColors.current
    val haptic = rememberHaptic()
    // One frame per message: everything it carries (pictures, files, text, time) sits inside, so it is clear what a reaction is on.
    // Long-press the frame (or the TalkBack action) for the message menu; double tap hearts it (needs a hub or provider id and loaded reactions).
    // Only the frame listens: pictures, links and buttons inside it keep their own taps. The frame lights up while pressed.
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    var pop by remember { mutableIntStateOf(0) }
    // double tap: hearts a message that can take it; on an older hub that cannot, onHeart says "Update your hub" instead (no heart pop)
    val heart: (() -> Unit)? = if (gestures != null && canHeart) ({ haptic(HapticFeedbackType.LongPress); gestures.onHeart(m); if (reactions != null) pop++ }) else null
    val menu: (() -> Unit)? = gestures?.let { g -> { haptic(HapticFeedbackType.LongPress); g.onMenu(m) } }
    // The press detector keeps running across recompositions (keyed on which gestures exist, not on the lambdas): it must call the
    // current ones, for the message as it is now (ids learned, edited), not the first copy this row drew.
    val menuNow by androidx.compose.runtime.rememberUpdatedState(menu); val heartNow by androidx.compose.runtime.rememberUpdatedState(heart)
    val reactable = if (gestures == null) Modifier else Modifier
        // TalkBack: activating the frame opens the menu (outermost, so it wins over the empty touch tap below)
        .semantics(mergeDescendants = true) { onClick(label = "Message actions") { gestures.onMenu(m); true } }
        .semantics { onLongClick(label = "Message actions") { gestures.onMenu(m); true } }
        // anywhere in the frame, links and pictures included (a link inside a reply used to take both gestures for itself)
        .messagePress(press, onLongPress = menu?.let { { menuNow?.invoke() } }, onDoubleTap = heart?.let { { heartNow?.invoke() } })
    val edge = if (pressed) c.accent else c.hairline
    val lift = if (reactions?.groups?.isNotEmpty() == true) 10.dp else 0.dp // room inside the frame for the pills hanging on its edge
    // Reactions hang on the frame's bottom edge (Messenger / iMessage), not loose under it.
    val pills: @Composable (Modifier) -> Unit = { mod -> reactions?.let { r -> dev.foxfleet.app.ui.components.ReactionPills(r.groups, r.me, r.onReact, r.onPick, mod.layout { m, k -> val pl = m.measure(k); val up = 14.dp.roundToPx(); layout(pl.width, maxOf(0, pl.height - up)) { pl.place(0, -up) } }.padding(horizontal = 10.dp)) } }
    if (m.role == "user") {
        Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            val shape = RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp)
            val (bodyText, files) = remember(m.content) { FileMarker.split(m.content) }
            Box(contentAlignment = Alignment.Center) {
            Column(
                Modifier.widthIn(max = 300.dp).clip(shape).background(if (LocalChatBgActive.current) androidx.compose.ui.graphics.lerp(c.surface, c.accent, c.userBubble.alpha) else c.userBubble).border(1.dp, if (pressed) c.accent else Color.Transparent, shape).then(reactable).padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 6.dp + lift),
                horizontalAlignment = Alignment.End,
            ) {
                m.imageUrls.forEach { u -> dev.foxfleet.app.ui.components.ChatImage(u, "Attached image", Modifier.padding(bottom = 4.dp).size(220.dp).clip(RoundedCornerShape(14.dp)), onClick = { onOpen(MediaRef(u, MediaRef.Kind.Image)) }, onLongClick = null) }
                if (m.images.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(bottom = 4.dp)) {
                    m.images.forEach { img ->
                        // The cached file can be gone (cache cleared, other app id): fall back to the data URL we sent, then to a tile with Retry.
                        val src = dev.foxfleet.app.media.attachmentSource(img.localPath, img.dataUrl)
                        dev.foxfleet.app.ui.components.ChatImage(src, "Attached image", Modifier.size(if (m.images.size == 1) 220.dp else 104.dp).clip(RoundedCornerShape(14.dp)),
                            onClick = { onOpen(MediaRef(src, MediaRef.Kind.Image)) }, onLongClick = null)
                    }
                }
                files.forEach { (path, size) -> FileChip(path.substringAfterLast('/').substringAfter('-'), size, Modifier.padding(bottom = 4.dp)) }
                // a reply starts with the quoted line: drawn as a quote bubble, not as "> text"
                val quoted = remember(bodyText) { MessageActions.splitQuote(bodyText) }
                if (quoted != null) ReplyQuote(quoted.quote, Modifier.align(Alignment.Start).padding(horizontal = 8.dp, vertical = 4.dp))
                val shownText = quoted?.body ?: bodyText
                if (shownText.isNotBlank()) Text(shownText, style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = Modifier.align(Alignment.Start).padding(horizontal = 8.dp, vertical = 4.dp))
                if (m.ts > 0 || m.status != null) Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (m.ts > 0) Text(agoLabel(m.ts), style = MaterialTheme.typography.labelSmall, color = c.textFaint)
                    if (m.status != null) { Spacer(Modifier.width(4.dp)); dev.foxfleet.app.ui.components.StatusTicks(m.status, c.textFaint, c.accent, MaterialTheme.colorScheme.error) }
                }
            }
            HeartPop(pop)
            }
            pills(Modifier)
        }
    } else {
        Row(modifier.fillMaxWidth()) {
            AgentAvatar(agentName, null, 28.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                val shape = RoundedCornerShape(6.dp, 18.dp, 18.dp, 18.dp)
                Box(contentAlignment = Alignment.Center) {
                Column(Modifier.clip(shape).background(c.surface).border(1.dp, edge, shape).then(reactable).padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 10.dp + lift)) {
                    if (m.reasoning.isNotBlank()) dev.foxfleet.app.ui.components.ReasoningBlock(MediaTags.parseStreaming(m.reasoning).text, live = false, stateKey = "r:" + m.ts + ":" + m.reasoning.take(32).hashCode(), durationMs = m.reasoningMs)
                    if (m.steps.isNotEmpty()) { val log = remember(m.steps) { dev.foxfleet.app.ui.chat.StepLog.of(m.steps) }; dev.foxfleet.app.ui.components.StepsPanel(log, live = false, stateKey = "s:" + (m.hubId ?: m.runId ?: "${m.ts}:${m.content.hashCode()}")) }
                    m.imageUrls.forEach { u -> AsyncImage(model = u, contentDescription = "Image from the conversation", contentScale = ContentScale.Fit,
                        modifier = Modifier.padding(bottom = 6.dp).widthIn(max = 280.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).clickable { onOpen(MediaRef(u, MediaRef.Kind.Image)) }) }
                    AssistantBody(agentName, m.content, instance = sessionId + ":" + (m.id ?: "${m.ts}:${m.content.hashCode()}"), onOpen = onOpen) { RichText(it) }
                    val media = remember(m.content) { extractMedia(MediaTags.parse(m.content).text) }
                    media.forEach { ref -> MediaCard(ref, null) { onOpen(ref) } }
                    if (m.ts > 0) Text(agoLabel(m.ts), style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.align(Alignment.End).padding(top = 4.dp))
                }
                HeartPop(pop)
                }
                pills(Modifier)
            }
        }
    }
}

/** What one message row needs for reactions: its groups, who "you" are, toggle, and open the picker. */
private class MessageReactions(val groups: List<dev.foxfleet.app.data.ReactionGroup>, val me: String, val onReact: (String, Boolean) -> Unit, val onPick: () -> Unit)

/** What a message row does with the hand: long press opens the menu, double tap hearts, swipe right replies; plus the hidden-message Undo. */
private class MessageGestures(val onMenu: (UiMessage) -> Unit, val onHeart: (UiMessage) -> Unit, val onReply: (UiMessage) -> Unit, val onUndoHide: (String) -> Unit)

/** Screenshot tests: render the live step card opened. */
internal val LocalStepsOpen = androidx.compose.runtime.staticCompositionLocalOf { false }

/** [agentName] is the id (avatar, media); [agentLabel] the display name for the status line. */
@Composable
private fun StreamingMessage(agentName: String, state: ChatState, modifier: Modifier, onOpen: (MediaRef) -> Unit, stepsStartOpen: Boolean = LocalStepsOpen.current, agentLabel: String = agentName) {
    val c = LocalHubColors.current
    val reduce = reduceMotion()
    Row(modifier.fillMaxWidth()) {
        AgentAvatar(agentName, null, 28.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f).animateContentSize()) {
            val parsedStream = remember(state.streamText) { MediaTags.parseStreaming(state.streamText) }
            val text = parsedStream.text
            val active = state.tools.active
            val steps = state.steps
            // the step card carries what runs now; the chip below only speaks while there is nothing else to show
            val status = if (state.reconnecting) "Reconnecting…" else if (active.isNotEmpty() || steps.running.isNotEmpty()) null else statusLine(agentLabel, if (steps.isEmpty) state.toolLabel else null, state.streamReasoning.isNotBlank(), text.isNotBlank())
            // The reply being written already sits in the frame it will keep; activity and status stay outside it.
            val shape = RoundedCornerShape(6.dp, 18.dp, 18.dp, 18.dp)
            if (state.streamReasoning.isNotBlank() || text.isNotBlank() || parsedStream.media.isNotEmpty() || !steps.isEmpty) Column(Modifier.clip(shape).background(c.surface).border(1.dp, c.hairline, shape).padding(horizontal = 14.dp, vertical = 10.dp)) {
            if (state.streamReasoning.isNotBlank()) dev.foxfleet.app.ui.components.ReasoningBlock(MediaTags.parseStreaming(state.streamReasoning).text, live = state.streamText.isEmpty() && steps.running.isEmpty(), stateKey = "live", durationMs = state.reasoningMs)
            dev.foxfleet.app.ui.components.StepsPanel(steps, live = true, stateKey = "live-steps", startOpen = stepsStartOpen)
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
            }
            if (steps.isEmpty) ToolActivityStrip(active)
            androidx.compose.animation.Crossfade(status, animationSpec = androidx.compose.animation.core.tween(dev.foxfleet.app.ui.Tokens.motionStatusMs), label = "status") { st ->
                if (st != null) Row(Modifier.padding(top = 4.dp).heightIn(min = 24.dp).bgChip(), verticalAlignment = Alignment.CenterVertically) { ShimmerStatusText(st); TypingDots(c.textMuted) }
            }
        }
    }
}

/** One quiet line per running tool call (icon + safe description); each leaves when its call ends. */
@Composable
private fun ToolActivityStrip(active: List<dev.foxfleet.app.ui.chat.ActiveTool>) {
    val c = LocalHubColors.current
    if (active.isEmpty()) return
    Column(Modifier.padding(top = 6.dp).semantics { contentDescription = "Agent activity" }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        active.forEach { t ->
            val (icon, label) = dev.foxfleet.app.ui.chat.toolPresentation(t.name)
            Row(Modifier.clip(RoundedCornerShape(50)).background(c.accent.copy(alpha = 0.09f)).padding(start = 10.dp, end = 12.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(FoxIcons.get(icon), null, tint = c.accent, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text(label, style = MaterialTheme.typography.labelMedium, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                TypingDots(c.textMuted)
            }
        }
    }
}

@Composable
private fun MediaCard(ref: MediaRef, onLongClick: (() -> Unit)?, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Box(
        Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(max = 220.dp).clip(RoundedCornerShape(14.dp)).background(c.surfaceAlt)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick, onLongClickLabel = if (onLongClick != null) "Message actions" else null),
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
internal fun modelCommand(args: String, controls: NativeControls?, state: ChatState, picker: () -> Unit, onConfirm: (model: String, provider: String?, reason: String) -> Unit = { _, _, _ -> }) {
    if (args.isEmpty()) { picker(); return }
    if (Regex("(^|\\s)--global(\\s|$)", RegexOption.IGNORE_CASE).containsMatchIn(args)) { state.addNotice("Changing the Hermes default is not done from the chat. Use the agent settings."); return }
    if (state.sessionId == null || controls == null) { state.addNotice("Send the first message first: the model is set per conversation."); return }
    val provider = Regex("--provider\\s+(\\S+)").find(args)?.groupValues?.get(1); val model = args.replace(Regex("--provider\\s+\\S+"), "").trim()
    CoroutineScope(Dispatchers.Main).launch { runCatching { controls.setModel(model, provider) }.onSuccess { state.addNotice(modelSetMessage(model)) }.onFailure { if (it is HubApi.ModelConfirmRequired) onConfirm(model, provider, it.reason) else state.addNotice("Could not change the model") } }
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
    /** How /model works for this agent (0.4.1): "native", "request" or "none"; [modelsKnown] false on hubs that do not say. */
    models: String = if (native) "native" else "none",
    modelsKnown: Boolean = false,
    onModel: (String) -> Unit = {},
    onChoices: (String, List<String>) -> Unit = { _, _ -> },
    defs: List<CommandDef>? = null,
    waiting: Int = 0,
    reply: ReplyTarget? = null,
    onClearReply: () -> Unit = {},
    /** While the chat loads (also Edit's reload) nothing is sent, as on web. */
    disabled: Boolean = false,
    /** Text to put back (Edit); [onPrefilled] says whether it went in (only into an empty box). */
    prefill: String? = null,
    onPrefilled: (applied: Boolean) -> Unit = {},
) {
    val c = LocalHubColors.current
    val mode = plainMode(native, modes)
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var input by rememberSaveable { mutableStateOf(initialInput) }
    // Edit puts the old text back, but never over something the user already typed.
    LaunchedEffect(prefill) { prefill?.let { val applied = input.isBlank(); if (applied) input = it; onPrefilled(applied) } }
    val focus = remember { FocusRequester() }
    LaunchedEffect(reply) { if (reply != null) runCatching { focus.requestFocus() } }
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
    val canSend = (input.isNotBlank() || attachments.isNotEmpty() || files.isNotEmpty()) && encoding == 0 && uploads.isEmpty() && !disabled
    fun send() {
        if (!canSend) return
        if (attachments.isEmpty() && files.isEmpty()) {
            if (agentCommands && opensCommandBrowser(input)) { input = ""; browser = true; browserQuery = ""; showHidden = false; return }
            parseLocal(input, agentCommands)?.let { (cmd, args) -> onLocal(cmd, args); input = ""; return }
            Regex("^/model(?:\\s+(.*))?$", RegexOption.IGNORE_CASE).find(input.trim())?.let { m ->
                // the picker whenever the hub has a model list for this agent (native gateway or the hub's request path)
                if (models != "none") { input = ""; onModel(m.groupValues[1].trim()); return }
                // No picker list for this agent (bot agents): send /model as typed — the agent's own
                // Hermes /model handler answers it or switches the chat's model. Never refuse here.
            }
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
        // A slash command is sent as typed (a quote in front would stop the agent reading it as a command); the reply stays for the next message.
        val quote = reply != null && !input.trim().startsWith("/")
        val body = FileMarker.compose(input.trim(), files); val t = if (quote) MessageActions.withQuote(reply, body) else body; val imgs = attachments
        input = ""; attachments = emptyList(); files = emptyList(); voice.stop()
        haptic(HapticFeedbackType.Confirm); onSend(t, imgs, mode); if (quote) onClearReply()
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
        if (reply != null) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            ReplyQuote(reply.excerpt, Modifier.weight(1f), label = "Replying to ${reply.author}")
            SoftIconButton(FoxIcons.get("close"), "Cancel reply", onClearReply)
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
                        if (onUploadFile != null) DropdownMenuItem(text = { Text("File (PDF, docs, zip…)") }, leadingIcon = { FoxIcon("file", null, tint = c.textMuted) }, onClick = {
                            menu = false; docPicker.launch(arrayOf("*/*"))
                        })
                        if (allowImages) DropdownMenuItem(text = { Text("Photo library") }, leadingIcon = { FoxIcon("image", null, tint = c.textMuted) }, onClick = {
                            menu = false; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        })
                        if (allowImages) DropdownMenuItem(text = { Text("Take photo") }, leadingIcon = { FoxIcon("camera", null, tint = c.textMuted) }, onClick = {
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
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
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
