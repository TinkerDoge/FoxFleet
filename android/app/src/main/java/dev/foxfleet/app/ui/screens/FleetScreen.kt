package dev.foxfleet.app.ui.screens

import androidx.lifecycle.repeatOnLifecycle
import dev.foxfleet.app.ui.FoxIcons
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import dev.foxfleet.app.ui.AgentList
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.motion.pressScale
import dev.foxfleet.app.ui.motion.rememberHaptic
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import dev.foxfleet.app.ui.components.SoftButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.live.HubChat
import dev.foxfleet.app.data.live.LinkState
import dev.foxfleet.app.ui.ChatRows
import dev.foxfleet.app.ui.components.ArchiveGlyph
import dev.foxfleet.app.ui.components.MutedGlyph
import dev.foxfleet.app.ui.components.StatusTicks
import androidx.compose.foundation.layout.defaultMinSize
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.AgentAvatar
import dev.foxfleet.app.ui.components.Presence
import dev.foxfleet.app.ui.components.ShimmerStatusText
import dev.foxfleet.app.ui.components.SoftCard
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.components.presence
import dev.foxfleet.app.ui.motion.reduceMotion
import dev.foxfleet.app.ui.motion.sharedAvatar
import dev.foxfleet.app.ui.motion.staggerDelayMs

/** Agent list, messenger style: avatar, name, last message, time, unread dot; pinned on top; newest activity first. Swipe or long-press to pin. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(
    agents: List<AgentStatus>,
    loading: Boolean,
    loadedOnce: Boolean,
    error: String?,
    unread: (AgentStatus) -> Boolean,
    onRefresh: () -> Unit,
    onOpen: (AgentStatus) -> Unit,
    onSettings: () -> Unit,
    onAvatarLongPress: (String) -> Unit = {},
    onPin: (AgentStatus) -> Unit = {},
    onAddAgent: (() -> Unit)? = null,
    onPoll: () -> Unit = {},
    running: (String) -> Boolean = { false },
    userInitials: String = "",
    now: () -> Long = { System.currentTimeMillis() },
    /** Phase 1 (`chats`): the hub's row per agent (badge, preview with sender, archived, muted). Empty = the agent list as before. */
    rows: Map<String, HubChat> = emptyMap(),
    archivedView: Boolean = false,
    onArchivedView: (Boolean) -> Unit = {},
    /** Swipe and menu actions on rows; null on hubs without `chats` (swipe pins, as before). */
    rowActions: ChatRowActions? = null,
    /** Connection indicator (Connecting…, Updating…, Offline); null = live or nothing to say. */
    link: LinkState? = null,
    /** The agent's typing line from the live stream ("typing…", "thinking…"), or null. */
    typingLabel: (String) -> String? = { null },
) {
    val c = LocalHubColors.current
    var entered by rememberSaveable { mutableStateOf(false) }
    val animateIn = !entered && !reduceMotion()
    LaunchedEffect(agents.isNotEmpty()) { if (agents.isNotEmpty()) entered = true }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    // Keeps previews, times and pins fresh while the list is open and the app is in the foreground (no polling in the background).
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.RESUMED) { while (true) { kotlinx.coroutines.delay(12_000); onPoll() } } }
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val listed = remember(agents, rows, archivedView) { if (rows.isEmpty()) agents else ChatRows.visible(agents, rows, archivedView) }
    val archived = remember(agents, rows) { if (rows.isEmpty()) emptyList() else ChatRows.visible(agents, rows, true) }
    val shown = remember(listed, query, rows) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) listed else listed.filter { "${it.displayName} ${it.name} ${it.lastMessagePreview.orEmpty()} ${rows[it.name]?.last?.preview.orEmpty()}".lowercase().contains(q) }
    }
    androidx.activity.compose.BackHandler(archivedView) { onArchivedView(false) }

    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (archivedView) SoftIconButton(FoxIcons.get("back"), "Back to chats", { onArchivedView(false) }, tint = c.text)
            else Box(
                Modifier.size(44.dp).clip(CircleShape).background(c.surfaceAlt).clickable(onClick = onSettings).semantics { contentDescription = "Settings" },
                contentAlignment = Alignment.Center,
            ) { if (userInitials.isNotBlank()) Text(userInitials, color = c.text, style = MaterialTheme.typography.labelLarge) else FoxIcon("settings", tint = c.text) }
            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                // The title says how the link is while it is not live (messenger pattern); the list below stays usable from the cache.
                val linkText = ChatRows.linkLabel(link)
                if (linkText != null) LinkTitle(link!!, linkText)
                else Text(if (archivedView) "Archived chats" else "Agents", style = MaterialTheme.typography.titleLarge, color = c.text, maxLines = 1)
                val ready = agents.count { it.chatReady }
                if (archivedView) Text(if (listed.size == 1) "1 chat" else "${listed.size} chats", style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1)
                else if (agents.isNotEmpty()) Text("$ready of ${agents.size} ready", style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1)
            }
            SoftIconButton(FoxIcons.get(if (searching) "close" else "search"), if (searching) "Close search" else "Search agents", { searching = !searching; if (!searching) query = "" }, background = c.surfaceAlt, tint = c.text)
            if (onAddAgent != null) SoftIconButton(FoxIcons.get("add"), "Add agent", onAddAgent, background = c.surfaceAlt, tint = c.text)
        }
        androidx.compose.animation.AnimatedVisibility(searching) {
            SearchField(query, { query = it }, Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        }
        PullToRefreshBox(isRefreshing = loading && loadedOnce, onRefresh = onRefresh, modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                agents.isEmpty() && loading -> SkeletonRows()
                agents.isEmpty() && error != null -> EmptyState("agents", "Couldn't reach the fleet", error, "Try again", onRefresh)
                agents.isEmpty() -> EmptyState("agents", "No agents yet", "Once an agent connects to the hub it shows up here.", "Refresh", onRefresh)
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 4.dp, bottom = 24.dp)) {
                    if (error != null) item(key = "error") {
                        Text(error, style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.animateItem().padding(horizontal = 20.dp, vertical = 6.dp))
                    }
                    if (!archivedView && archived.isNotEmpty() && query.isBlank()) item(key = "archived", contentType = "archived") {
                        ArchivedEntry(archived.size, archived.sumOf { rows[it.name]?.badge ?: 0 }, Modifier.animateItem()) { onArchivedView(true) }
                    }
                    if (shown.isEmpty() && archivedView) item(key = "noarchived") { Text("No archived chats", color = c.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth().padding(32.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
                    else if (shown.isEmpty()) item(key = "nomatch") { Text("No agent matches", color = c.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth().padding(32.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
                    itemsIndexed(shown, key = { _, a -> a.name }, contentType = { _, _ -> "agent" }) { i, a ->
                        val anim = remember { Animatable(if (animateIn) 0f else 1f) }
                        LaunchedEffect(Unit) { if (anim.value < 1f) { kotlinx.coroutines.delay(staggerDelayMs(i).toLong()); anim.animateTo(1f, tween(360)) } }
                        AgentRow(
                            a, unread(a), running(a.name), now(), onOpen, onPin, onAvatarLongPress,
                            Modifier.animateItem().graphicsLayer { alpha = anim.value; translationY = (1f - anim.value) * 24.dp.toPx() },
                            row = rows[a.name], actions = rowActions, typing = typingLabel(a.name),
                        )
                    }
                    item(key = "footer") { Spacer(Modifier.navigationBarsPadding()) }
                }
            }
        }
    }
}

@Composable
private fun SearchField(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = LocalHubColors.current
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Row(modifier.fillMaxWidth().height(44.dp).clip(CircleShape).background(c.surfaceAlt).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        FoxIcon("search", size = 18.dp)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text("Search agents", color = c.textMuted, style = MaterialTheme.typography.bodyLarge)
            androidx.compose.foundation.text.BasicTextField(
                value, onChange, singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(c.accent),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Search agents" },
            )
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun AgentRow(
    a: AgentStatus, unread: Boolean, runningHere: Boolean, now: Long, onOpen: (AgentStatus) -> Unit, onPin: (AgentStatus) -> Unit,
    onChangePicture: (String) -> Unit, modifier: Modifier, row: HubChat? = null, actions: ChatRowActions? = null, typing: String? = null,
) {
    val c = LocalHubColors.current
    val haptic = rememberHaptic()
    val p = a.presence()
    val preview = AgentList.preview(a, runningHere)
    var menu by remember { mutableStateOf(false) }
    val src = remember { MutableInteractionSource() }
    val muted = row?.mutedAt(now) == true
    val rowSwipe = actions != null && row != null
    // With the hub's rows: swipe left archives (or unarchives), swipe right mutes (or unmutes). Otherwise both directions pin, as before.
    val swipe = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
        if (v != SwipeToDismissBoxValue.Settled) {
            haptic(HapticFeedbackType.LongPress)
            if (rowSwipe) { if (v == SwipeToDismissBoxValue.EndToStart) actions!!.onArchive(a.name, !row!!.archived) else actions!!.onMute(a.name) } else onPin(a)
        }
        false // snaps back: the row moves because the order or list changed, not because it was dismissed
    })
    SwipeToDismissBox(
        state = swipe, modifier = modifier,
        backgroundContent = {
            Box(Modifier.fillMaxSize().background(c.accent.copy(alpha = 0.16f)).padding(horizontal = 24.dp), contentAlignment = if (swipe.dismissDirection == SwipeToDismissBoxValue.StartToEnd) Alignment.CenterStart else Alignment.CenterEnd) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when {
                        !rowSwipe -> { FoxIcon(if (a.pinned) "unpin" else "pin", tint = c.accent); Text(if (a.pinned) "Unpin" else "Pin", color = c.accent, style = MaterialTheme.typography.labelLarge) }
                        swipe.dismissDirection == SwipeToDismissBoxValue.EndToStart -> { ArchiveGlyph(c.accent); Text(if (row!!.archived) "Unarchive" else "Archive", color = c.accent, style = MaterialTheme.typography.labelLarge) }
                        else -> { MutedGlyph(c.accent, size = 20.dp); Text(if (muted) "Unmute" else "Mute", color = c.accent, style = MaterialTheme.typography.labelLarge) }
                    }
                }
            }
        },
    ) {
        Box(Modifier.background(c.bg)) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 72.dp).pressScale(src, 0.985f)
                    .combinedClickable(interactionSource = src, indication = null, onClick = { if (a.chatReady) onOpen(a) }, onLongClick = { haptic(HapticFeedbackType.LongPress); menu = true })
                    .graphicsLayer { alpha = if (a.chatReady) 1f else 0.6f }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AgentAvatar(a.name, p, 52.dp, Modifier.sharedAvatar(a.name))
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                            Text(a.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            a.badge?.let { badge ->
                                Spacer(Modifier.width(6.dp))
                                Text(badge, style = MaterialTheme.typography.labelSmall, color = c.accent, maxLines = 1,
                                    modifier = Modifier.clip(RoundedCornerShape(50)).background(c.accent.copy(alpha = 0.12f)).padding(horizontal = 7.dp, vertical = 2.dp))
                            }
                        }
                        Spacer(Modifier.width(8.dp))
                        if (muted) { MutedGlyph(c.textMuted); Spacer(Modifier.width(4.dp)) }
                        if (a.pinned || row?.pinned == true) { FoxIcon("pin", tint = c.textMuted, size = 14.dp); Spacer(Modifier.width(4.dp)) }
                        if (row?.last?.role == "user") { StatusTicks(row.last.status, c.textMuted, c.accent, MaterialTheme.colorScheme.error); Spacer(Modifier.width(4.dp)) }
                        Text(AgentList.time(row?.last?.at ?: a.lastActivityAt, now), style = MaterialTheme.typography.labelSmall, color = if (unread && !muted) c.accent else c.textMuted, maxLines = 1)
                    }
                    Spacer(Modifier.height(2.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val rp = row?.let { ChatRows.preview(it) }
                        Box(Modifier.weight(1f)) {
                            when {
                                typing != null -> Row(verticalAlignment = Alignment.CenterVertically) { Text(typing, style = MaterialTheme.typography.bodyMedium, color = c.accent, maxLines = 1); TypingDots(c.accent) }
                                rp != null && preview.kind != AgentList.Kind.Approval && preview.kind != AgentList.Kind.Typing -> Text(
                                    buildAnnotatedString { rp.sender?.let { withStyle(SpanStyle(color = c.text.copy(alpha = 0.75f))) { append("$it: ") } }; append(rp.text) },
                                    style = MaterialTheme.typography.bodyMedium, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                else -> PreviewText(preview, a)
                            }
                        }
                        val count = row?.badge ?: 0
                        if (row != null && count > 0) {
                            Spacer(Modifier.width(8.dp))
                            val label = ChatRows.badgeText(count)
                            Text(label, style = MaterialTheme.typography.labelMedium, color = if (muted) androidx.compose.ui.graphics.Color.White else c.onAccent, maxLines = 1,
                                modifier = Modifier.defaultMinSize(minWidth = 22.dp).clip(CircleShape).background(if (muted) c.textFaint else c.accent).padding(horizontal = 7.dp, vertical = 2.dp)
                                    .semantics { contentDescription = if (row.unread > 0) "$label unread" + if (muted) ", muted" else "" else "Marked unread" },
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                        } else if (row == null && unread) {
                            Spacer(Modifier.width(8.dp))
                            Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent).semantics { contentDescription = "Unread" })
                        }
                    }
                }
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(
                    text = { Text(if (a.pinned) "Unpin" else "Pin to top") },
                    leadingIcon = { FoxIcon(if (a.pinned) "unpin" else "pin", tint = c.text) },
                    onClick = { menu = false; onPin(a) },
                )
                if (actions != null && row != null) {
                    val isUnread = row.badge > 0
                    DropdownMenuItem(text = { Text(if (isUnread) "Mark as read" else "Mark as unread") }, leadingIcon = { FoxIcon(if (isUnread) "check" else "chat", tint = c.text) }, onClick = { menu = false; actions.onUnread(a.name, !isUnread) })
                    DropdownMenuItem(text = { Text(if (muted) "Unmute" else "Mute") }, leadingIcon = { MutedGlyph(c.text, size = 20.dp) }, onClick = { menu = false; actions.onMute(a.name) })
                    DropdownMenuItem(text = { Text(if (row.archived) "Unarchive" else "Archive") }, leadingIcon = { ArchiveGlyph(c.text) }, onClick = { menu = false; actions.onArchive(a.name, !row.archived) })
                }
                DropdownMenuItem(text = { Text("Change picture") }, leadingIcon = { FoxIcon("image", tint = c.text) }, onClick = { menu = false; onChangePicture(a.name) })
            }
        }
    }
}

/** Archive and mute from the list (feature `chats`). */
data class ChatRowActions(val onArchive: (agent: String, archived: Boolean) -> Unit, val onMute: (agent: String) -> Unit, val onUnread: (agent: String, unread: Boolean) -> Unit)

/** The "Archived chats" entry on top of the main list (messenger pattern): count of chats, unread among them in a quiet badge. */
@Composable
private fun ArchivedEntry(count: Int, unread: Int, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Row(modifier.fillMaxWidth().heightIn(min = 60.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp).semantics { contentDescription = "Archived chats, $count" },
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(52.dp).clip(CircleShape).background(c.surfaceAlt), contentAlignment = Alignment.Center) { ArchiveGlyph(c.textMuted, size = 26.dp) }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text("Archived chats", style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1)
            Text(if (count == 1) "1 chat" else "$count chats", style = MaterialTheme.typography.bodyMedium, color = c.textMuted, maxLines = 1)
        }
        if (unread > 0) Text(ChatRows.badgeText(unread), style = MaterialTheme.typography.labelMedium, color = androidx.compose.ui.graphics.Color.White,
            modifier = Modifier.defaultMinSize(minWidth = 22.dp).clip(CircleShape).background(c.textFaint).padding(horizontal = 7.dp, vertical = 2.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

/** The title while the link is not live: a small spinner-like pulse for Connecting/Updating, a quiet dot for Offline. */
@Composable
fun LinkTitle(state: LinkState, text: String, modifier: Modifier = Modifier) {
    val c = LocalHubColors.current
    Row(modifier.semantics { contentDescription = text }, verticalAlignment = Alignment.CenterVertically) {
        if (state == LinkState.Offline) Box(Modifier.size(8.dp).clip(CircleShape).background(c.textFaint))
        else TypingDots(c.accent, Modifier.padding(end = 2.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.titleLarge, color = if (state == LinkState.Offline) c.textMuted else c.text, maxLines = 1)
    }
}

@Composable
private fun PreviewText(p: AgentList.Preview, a: AgentStatus) {
    val c = LocalHubColors.current
    val style = MaterialTheme.typography.bodyMedium
    when (p.kind) {
        AgentList.Kind.Typing -> Row(verticalAlignment = Alignment.CenterVertically) { Text("Typing", style = style, color = c.accent, maxLines = 1); TypingDots(c.accent) }
        AgentList.Kind.Approval -> Text("Needs approval", style = style, color = c.accent, fontWeight = FontWeight.Medium, maxLines = 1)
        AgentList.Kind.Text -> Text(
            buildAnnotatedString { if (p.you) withStyle(SpanStyle(color = c.text.copy(alpha = 0.75f))) { append("You: ") }; append(p.text) },
            style = style, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        AgentList.Kind.Empty -> Text(p.text.ifBlank { fleetSubtitle(a).ifBlank { "No messages yet" } }, style = style, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Three dots: 600 ms loop, 150 ms phase offset (static under reduce motion). */
@Composable
fun TypingDots(color: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    val reduce = reduceMotion()
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "typing")
    Row(modifier.padding(start = 6.dp), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val v by t.animateFloat(
                0f, 1f,
                androidx.compose.animation.core.infiniteRepeatable(
                    androidx.compose.animation.core.keyframes { durationMillis = 600; 0f at 0; 1f at 180; 0f at 360; 0f at 600 },
                    initialStartOffset = androidx.compose.animation.core.StartOffset(i * 150), repeatMode = androidx.compose.animation.core.RepeatMode.Restart,
                ), label = "dot$i",
            )
            val k = if (reduce) 0.7f else v
            Box(Modifier.size(5.dp).graphicsLayer { translationY = -3.dp.toPx() * k; alpha = 0.4f + 0.6f * k }.clip(CircleShape).background(color))
        }
    }
}

/** Skeleton rows while the first sync runs: calm placeholders instead of a spinner or a blank screen. */
@Composable
fun SkeletonRows(count: Int = 6) {
    val c = LocalHubColors.current
    val reduce = reduceMotion()
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "sk")
    val x by t.animateFloat(0f, 1f, androidx.compose.animation.core.infiniteRepeatable(tween(1400, easing = androidx.compose.animation.core.LinearEasing)), label = "skx")
    val base = c.surfaceAlt
    val hi = androidx.compose.ui.graphics.lerp(c.surfaceAlt, c.surface, 0.6f)
    val brush = if (reduce) androidx.compose.ui.graphics.SolidColor(base) else androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(base, hi, base), startX = -400f + 1200f * x, endX = 400f + 1200f * x)
    Column(Modifier.fillMaxSize().semantics { contentDescription = "Loading agents" }) {
        repeat(count) {
            Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(52.dp).clip(CircleShape).background(brush))
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.fillMaxWidth(0.4f).height(14.dp).clip(RoundedCornerShape(7.dp)).background(brush))
                    Box(Modifier.fillMaxWidth(0.8f).height(12.dp).clip(RoundedCornerShape(6.dp)).background(brush))
                }
            }
        }
    }
}

@Composable
fun StatusPill(p: Presence) {
    val c = LocalHubColors.current
    val (label, tone, text) = when (p) {
        Presence.Ready -> Triple("Ready", c.online, c.onlineText)
        Presence.Online -> Triple("Online", c.idle, c.idleText)
        Presence.Offline -> Triple("Offline", c.offline, c.textMuted)
    }
    Text(
        label, style = MaterialTheme.typography.labelMedium, color = text,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(tone.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

@Composable
private fun EmptyState(icon: String, title: String, body: String, action: String, onAction: () -> Unit) {
    val c = LocalHubColors.current
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(88.dp).clip(CircleShape).background(c.accent.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) { FoxIcon(icon, tint = c.accent, size = 40.dp) }
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.text)
        Spacer(Modifier.height(6.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        SoftButton(onClick = onAction) { Text(action, color = c.accent) }
    }
}

/** Second line of an agent card: the owner's description, else what kind of agent it is. Never an address. */
fun fleetSubtitle(a: AgentStatus): String = buildString {
    append(a.description.lineSequence().firstOrNull()?.takeIf { it.isNotBlank() } ?: kindName(a.kind))
    a.activeSessions?.takeIf { it > 0 }?.let { append(" · $it active") }
}
