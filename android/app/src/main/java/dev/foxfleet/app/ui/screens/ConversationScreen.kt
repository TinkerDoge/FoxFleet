package dev.foxfleet.app.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.foxfleet.app.ConversationRoomState
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.Conversation
import dev.foxfleet.app.data.ConversationMedia
import dev.foxfleet.app.data.ConversationMention
import dev.foxfleet.app.data.ConversationMentions
import dev.foxfleet.app.data.ConversationMessage
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.ChatBackgroundLayer
import dev.foxfleet.app.ui.chat.ChatBackgroundSheet
import dev.foxfleet.app.ui.chat.LocalChatBgActive
import dev.foxfleet.app.ui.chat.bgChip
import dev.foxfleet.app.ui.chat.rememberConversationBackground
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.components.SoftButton
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.presence
import dev.foxfleet.app.ui.components.AgentAvatar
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * One group room's transcript. Rooms are not agents: every message carries its sender, so each member's
 * bubbles are named and attributed; a room never borrows the DM [dev.foxfleet.app.ui.chat.ChatState].
 */
@Composable
fun ConversationScreen(
    roomId: String,
    state: ConversationRoomState,
    agents: List<AgentStatus>,
    meId: String?,
    link: dev.foxfleet.app.data.live.LinkState?,
    onBack: () -> Unit,
    onDetails: () -> Unit,
    onRetry: () -> Unit,
    onLoadOlder: () -> Unit,
    onSend: (String, List<ConversationMention>, String?, List<String>) -> Unit,
    onStop: () -> Unit,
    onResume: () -> Unit,
    onAnswerRequest: (agent: String, requestId: String, result: JsonObject) -> Unit,
    onLoadMessage: (String, (ConversationMessage) -> Unit) -> Unit,
    onUploadMedia: suspend (Uri, (Float) -> Unit) -> ConversationMedia,
    onMarkRead: () -> Unit,
    mediaUrl: (String) -> String,
    now: () -> Long = { System.currentTimeMillis() },
) {
    val c = LocalHubColors.current
    val room = state.conversation
    val me = meId
    val owner = room?.ownedBy(meId) == true
    val bg = rememberConversationBackground(roomId)
    var bgSheet by remember { mutableStateOf(false) }
    var text by remember(roomId) { mutableStateOf("") }
    var reply by remember(roomId) { mutableStateOf<ConversationMessage?>(null) }
    var attach by remember(roomId) { mutableStateOf<List<ConversationMedia>>(emptyList()) }
    var uploading by remember(roomId) { mutableStateOf(false) }
    var flash by remember(roomId) { mutableStateOf<String?>(null) }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val byId = remember(state.messages) { state.messages.associateBy { it.id } }
    val mentionToken = remember(text) { ConversationMentions.tokenAt(text, text.length) }
    val suggestions = remember(mentionToken?.query, room?.members) {
        val q = mentionToken?.query?.lowercase() ?: return@remember emptyList()
        room?.agentMembers.orEmpty().filter { it.name.lowercase().contains(q) }.take(6)
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        uploading = true
        scope.launch {
            for (uri in uris.take(4)) runCatching { onUploadMedia(uri) {} }.getOrNull()?.let { attach = attach + it }
            uploading = false
        }
    }

    LaunchedEffect(roomId) { onMarkRead() }
    LaunchedEffect(state.messages.size, state.loading) {
        if (!state.loading && state.messages.isNotEmpty()) list.scrollToItem(0)
    }

    CompositionLocalScope(bg) {
        Box(Modifier.fillMaxSize().background(c.bg)) {
            ChatBackgroundLayer(bg.bg, bg.bitmap)
            Column(Modifier.fillMaxSize().statusBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    SoftIconButton(FoxIcons.get("back"), "Back to rooms", onBack, tint = c.text)
                    Column(Modifier.weight(1f).padding(horizontal = 6.dp)) {
                        Text(room?.title ?: "Room", style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1)
                        val subtitle = room?.let { r ->
                            buildString {
                                append(if (r.members.size == 1) "1 member" else "${r.members.size} members")
                                if (r.paused) append(" · paused")
                                val names = state.typingNames(now()).map { id -> r.memberFor(id)?.name ?: id.removePrefix("agent:") }
                                if (names.isNotEmpty()) append(" · ${names.joinToString(", ")} typing…")
                            }
                        } ?: "Loading…"
                        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1)
                    }
                    if (owner && room != null) {
                        if (room.paused) SoftButton(onClick = onResume) { Text("Resume", color = c.accent) }
                        else SoftIconButton(FoxIcons.get("stop"), "Stop the room", onStop, tint = c.text)
                    }
                    SoftIconButton(FoxIcons.get("info"), "Room details", onDetails, tint = c.text)
                    SoftIconButton(FoxIcons.get("wallpaper"), "Room background", { bgSheet = true }, tint = c.text)
                }
                if (link == dev.foxfleet.app.data.live.LinkState.Offline) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Offline — showing saved messages", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.weight(1f))
                        SoftButton(onClick = onRetry) { Text("Retry", color = c.accent) }
                    }
                }
                state.error?.let { msg -> Text(msg, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).bgChip()) }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    androidx.compose.runtime.CompositionLocalProvider(LocalChatBgActive provides !bg.bg.isDefault) {
                        LazyColumn(Modifier.fillMaxSize(), state = list, reverseLayout = true, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
                            if (state.hasMore) item(key = "older") {
                                val load = { if (!state.loadingOlder) onLoadOlder() }
                                Text(if (state.loadingOlder) "Loading…" else "Load older messages", color = c.accent, style = MaterialTheme.typography.labelLarge,
                                    modifier = Modifier.fillMaxWidth().clickable(onClick = load).padding(12.dp))
                            }
                            items(state.messages.asReversed(), key = { it.id }) { m ->
                                RoomMessageRow(
                                    m, room, me, byId[m.replyTo], flash == m.id,
                                    onJump = { id ->
                                        val found = byId[id]
                                        if (found != null) {
                                            val i = state.messages.asReversed().indexOfFirst { it.id == id }
                                            if (i >= 0) scope.launch { list.animateScrollToItem(i) }
                                            flash = id
                                        } else onLoadMessage(id) { flash = id }
                                    },
                                    onReply = { reply = m },
                                    mediaUrl = { mid -> mediaUrl(mid) },
                                )
                            }
                            if (state.loading && state.messages.isEmpty()) item(key = "loading") { Text("Loading room…", color = c.textMuted, modifier = Modifier.padding(24.dp)) }
                            if (!state.loading && state.messages.isEmpty()) item(key = "empty") {
                                Text("No messages yet. Say hello or @mention an agent.", color = c.textMuted, modifier = Modifier.fillMaxWidth().padding(32.dp))
                            }
                        }
                    }
                }
                if (owner && room != null) {
                    room.agentMembers.forEach { m ->
                        state.requests[m.name].orEmpty().forEach { request ->
                            RequestCard(request, m.name) { id, result -> onAnswerRequest(m.name, id, result); null }
                        }
                    }
                }
                if (reply != null) {
                    val r = reply!!
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Replying to ${if (r.sender.id == me) "yourself" else r.sender.name}", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                            Text(r.text.replace(Regex("\\s+"), " ").take(120), style = MaterialTheme.typography.bodySmall, color = c.text, maxLines = 1)
                        }
                        SoftIconButton(FoxIcons.get("close"), "Cancel reply", { reply = null }, tint = c.textMuted)
                    }
                }
                if (attach.isNotEmpty()) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        attach.forEach { m ->
                            Row(Modifier.clip(RoundedCornerShape(50)).background(c.surfaceAlt).padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                                FoxIcon("file", size = 14.dp, tint = c.textMuted)
                                Text(m.name, style = MaterialTheme.typography.labelSmall, color = c.text, maxLines = 1)
                                Spacer(Modifier.width(4.dp))
                                Box(Modifier.size(18.dp).clickable { attach = attach - m }) { FoxIcon("close", size = 14.dp, tint = c.textMuted) }
                            }
                        }
                    }
                }
                if (suggestions.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(14.dp)).background(c.surface)) {
                        suggestions.forEach { m ->
                            Row(Modifier.fillMaxWidth().clickable {
                                val token = mentionToken ?: return@clickable
                                val next = "@${m.name} "
                                text = text.take(token.at) + next + text.drop(token.at + 1 + token.query.length)
                            }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                AgentAvatar(m.name, if (m.isAgent) dev.foxfleet.app.ui.components.Presence.Online else dev.foxfleet.app.ui.components.Presence.Offline, 28.dp)
                                Spacer(Modifier.width(8.dp))
                                Text("@${m.name}", color = c.text, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                    SoftIconButton(FoxIcons.get("add"), "Attach a file", { picker.launch(arrayOf("*/*")) }, tint = c.text)
                    Box(Modifier.weight(1f).heightIn(min = 44.dp, max = 140.dp).clip(RoundedCornerShape(22.dp)).background(c.surface).padding(horizontal = 14.dp, vertical = 11.dp)) {
                        if (text.isEmpty()) Text(if (uploading) "Uploading…" else "Message the room", color = c.textMuted, style = MaterialTheme.typography.bodyLarge)
                        BasicTextField(
                            text, { text = it }, textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text),
                            cursorBrush = SolidColor(c.accent), modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                    val canSend = (text.trim().isNotEmpty() || attach.isNotEmpty()) && !state.sending && !uploading
                    SoftIconButton(FoxIcons.get("send"), "Send", {
                        if (!canSend) return@SoftIconButton
                        val mentions = ConversationMentions.mentionsIn(text.trim(), room?.members.orEmpty())
                        onSend(text.trim(), mentions, reply?.id, attach.map { it.id })
                        text = ""; reply = null; attach = emptyList()
                    }, tint = if (canSend) c.accent else c.textFaint)
                }
            }
        }
        if (bgSheet) ChatBackgroundSheet(bg) { bgSheet = false }
    }
}

@Composable
private fun CompositionLocalScope(bg: dev.foxfleet.app.ui.chat.ChatBackgroundState, content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalChatBgActive provides !bg.bg.isDefault, content = content)
}

@Composable
private fun RoomMessageRow(
    m: ConversationMessage,
    room: Conversation?,
    me: String?,
    target: ConversationMessage?,
    flashing: Boolean,
    onJump: (String) -> Unit,
    onReply: (ConversationMessage) -> Unit,
    mediaUrl: (String) -> String,
) {
    val c = LocalHubColors.current
    if (m.system) {
        Text(m.text, style = MaterialTheme.typography.bodySmall, color = c.textMuted,
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).bgChip())
        return
    }
    val mine = m.isMine(me)
    val author = m.sender.name.ifBlank { m.sender.id }
    Column(Modifier.fillMaxWidth().padding(vertical = 3.dp).then(if (flashing) Modifier.background(c.accent.copy(alpha = 0.12f)) else Modifier)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (m.sender.isAgent) AgentAvatar(author, dev.foxfleet.app.ui.components.Presence.Online, 24.dp)
            Spacer(Modifier.width(6.dp))
            Text(author, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = if (mine) c.accent else c.text)
            if (mine) Text(" · you", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
            Text("  " + time(m.createdAt), style = MaterialTheme.typography.labelSmall, color = c.textFaint)
            if (m.edited) Text(" · edited", style = MaterialTheme.typography.labelSmall, color = c.textFaint)
            m.dispatchId?.let { Text(" · dispatch", style = MaterialTheme.typography.labelSmall, color = c.textFaint) }
        }
        Column(Modifier.fillMaxWidth().padding(start = if (m.sender.isAgent) 30.dp else 0.dp)) {
            m.replyTo?.let { id ->
                Row(Modifier.clip(RoundedCornerShape(10.dp)).background(c.surfaceAlt).clickable { onJump(id) }.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(3.dp).height(28.dp).background(c.accent))
                    Spacer(Modifier.width(8.dp))
                    Column {
                        Text(target?.sender?.name ?: "Earlier message", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                        Text((target?.text ?: "Tap to jump").replace(Regex("\\s+"), " ").take(110), style = MaterialTheme.typography.bodySmall, color = c.text, maxLines = 1)
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Box(Modifier.weight(1f, fill = false).clip(RoundedCornerShape(16.dp)).background(if (mine) c.userBubble else c.surface).padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(mentionText(m, room), style = MaterialTheme.typography.bodyMedium, color = c.text)
                }
                Spacer(Modifier.width(4.dp))
                SoftIconButton(FoxIcons.get("reply"), "Reply", { onReply(m) }, tint = c.textFaint)
            }
            if (m.media.isNotEmpty()) {
                Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    m.media.forEach { media -> RoomMediaCard(media, mediaUrl(media.id)) }
                }
            }
        }
    }
}

@Composable
private fun RoomMediaCard(media: ConversationMedia, url: String) {
    val c = LocalHubColors.current
    if (media.kind == "image") {
        AsyncImage(model = url, contentDescription = media.name, contentScale = ContentScale.Fit,
            modifier = Modifier.heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp)))
    } else {
        Row(Modifier.clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            FoxIcon(if (media.kind == "audio") "mic" else "file", size = 20.dp, tint = c.textMuted)
            Spacer(Modifier.width(8.dp))
            Column { Text(media.name, color = c.text, style = MaterialTheme.typography.bodyMedium, maxLines = 1); Text(humanSize(media.size), color = c.textMuted, style = MaterialTheme.typography.labelSmall) }
        }
    }
}

/** Mention spans become one accent run; nothing else in the text is interpreted. */
private fun mentionText(m: ConversationMessage, room: Conversation?): androidx.compose.ui.text.AnnotatedString {
    val text = m.text
    val spans = m.mentions.filter { it.offset >= 0 && it.length > 0 && it.offset + it.length <= text.length }.sortedBy { it.offset }
    if (spans.isEmpty()) return buildAnnotatedString { append(text) }
    return buildAnnotatedString {
        var at = 0
        spans.forEach { s ->
            if (s.offset < at) return@forEach
            if (s.offset > at) append(text.substring(at, s.offset))
            val name = room?.memberFor(s.id)?.name ?: s.id.removePrefix("agent:")
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("@$name") }
            at = s.offset + s.length
        }
        if (at < text.length) append(text.substring(at))
    }
}

private fun time(ms: Long): String = if (ms <= 0) "" else SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
private fun humanSize(n: Long): String = when {
    n >= 1_048_576 -> String.format(Locale.US, "%.1f MB", n / 1_048_576.0)
    n >= 1024 -> String.format(Locale.US, "%.0f KB", n / 1024.0)
    else -> "$n B"
}

/** The account's rooms as their own list: their own ids and member names, never [AgentStatus] rows. */
@Composable
fun ConversationListScreen(
    rooms: List<Conversation>,
    loading: Boolean,
    loadedOnce: Boolean,
    error: String?,
    onBack: () -> Unit,
    onNew: () -> Unit,
    onOpen: (Conversation) -> Unit,
    onRefresh: () -> Unit,
    now: () -> Long = { System.currentTimeMillis() },
) {
    val c = LocalHubColors.current
    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            SoftIconButton(FoxIcons.get("back"), "Back", onBack, tint = c.text)
            Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                Text("Rooms", style = MaterialTheme.typography.titleLarge, color = c.text)
                Text(if (rooms.size == 1) "1 room" else "${rooms.size} rooms", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            }
            SoftIconButton(FoxIcons.get("add"), "New room", onNew, tint = c.text)
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp)) }
        if (loading && rooms.isEmpty()) {
            Text("Loading rooms…", color = c.textMuted, modifier = Modifier.padding(24.dp))
        } else if (loadedOnce && rooms.isEmpty() && error == null) {
            Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                FoxIcon("users", size = 44.dp, tint = c.accent)
                Spacer(Modifier.height(10.dp))
                Text("No rooms yet", style = MaterialTheme.typography.titleMedium, color = c.text)
                Text("Bring a few agents into one conversation.", style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
                Spacer(Modifier.height(12.dp))
                SoftButton(onClick = onNew) { Text("Create a room", color = c.accent) }
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            items(rooms, key = { it.id }) { room ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(room) }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceAlt), contentAlignment = Alignment.Center) { FoxIcon("users", size = 22.dp, tint = c.textMuted) }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(room.title, style = MaterialTheme.typography.titleMedium, color = c.text, modifier = Modifier.weight(1f), maxLines = 1)
                            Text(if (room.lastMessageAt != null) time(room.lastMessageAt!!) else time(room.updatedAt), style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                        }
                        Text(room.members.joinToString(", ") { it.name }.ifBlank { "No members" }, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, maxLines = 1)
                    }
                    if (room.unreadCount > 0) Text("${room.unreadCount}", style = MaterialTheme.typography.labelMedium, color = c.onAccent,
                        modifier = Modifier.clip(CircleShape).background(c.accent).padding(horizontal = 7.dp, vertical = 2.dp))
                }
            }
        }
    }
}
