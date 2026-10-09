package dev.foxfleet.app.ui.screens

import dev.foxfleet.app.ui.FoxIcons
import androidx.compose.animation.core.Animatable
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

/** Agent list: pull to refresh, staggered entrance, status pills, unread dots. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(
    agents: List<AgentStatus>,
    loading: Boolean,
    loadedOnce: Boolean,
    error: String?,
    unread: (String) -> Boolean,
    onRefresh: () -> Unit,
    onOpen: (AgentStatus) -> Unit,
    onSettings: () -> Unit,
    onAvatarLongPress: (String) -> Unit = {},
) {
    val c = LocalHubColors.current
    var entered by rememberSaveable { mutableStateOf(false) }
    val animateIn = !entered && !reduceMotion()
    LaunchedEffect(agents.isNotEmpty()) { if (agents.isNotEmpty()) entered = true }

    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Agents", style = MaterialTheme.typography.headlineSmall, color = c.text)
                val ready = agents.count { it.chatReady }
                Text(
                    if (agents.isEmpty()) "Fleet console" else "$ready of ${agents.size} ready to chat",
                    style = MaterialTheme.typography.bodySmall, color = c.textMuted,
                )
            }
            SoftIconButton(FoxIcons.get("retry"), "Refresh", onRefresh)
            SoftIconButton(FoxIcons.get("settings"), "Settings", onSettings)
        }
        PullToRefreshBox(isRefreshing = loading && loadedOnce, onRefresh = onRefresh, modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                agents.isEmpty() && loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    ShimmerStatusText("Syncing fleet…")
                }
                agents.isEmpty() && error != null -> EmptyState("Couldn't reach the fleet", error, "Try again", onRefresh)
                agents.isEmpty() -> EmptyState("No agents yet", "Once an agent connects to the hub it shows up here.", "Refresh", onRefresh)
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (error != null) item(key = "error") {
                        Text("Last sync failed: $error", style = MaterialTheme.typography.bodySmall, color = c.textMuted,
                            modifier = Modifier.animateItem().padding(4.dp))
                    }
                    itemsIndexed(agents, key = { _, a -> a.name }) { i, a ->
                        val anim = remember { Animatable(if (animateIn) 0f else 1f) }
                        LaunchedEffect(Unit) {
                            if (anim.value < 1f) {
                                kotlinx.coroutines.delay(staggerDelayMs(i).toLong())
                                anim.animateTo(1f, tween(360))
                            }
                        }
                        AgentCard(
                            a, unread(a.name), onOpen, onAvatarLongPress,
                            Modifier.animateItem().graphicsLayer {
                                alpha = anim.value; translationY = (1f - anim.value) * 24.dp.toPx()
                            },
                        )
                    }
                    item(key = "footer") { Spacer(Modifier.navigationBarsPadding()) }
                }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun AgentCard(a: AgentStatus, unread: Boolean, onOpen: (AgentStatus) -> Unit, onAvatarLongPress: (String) -> Unit, modifier: Modifier) {
    val c = LocalHubColors.current
    val p = a.presence()
    SoftCard(modifier.fillMaxWidth().graphicsLayer { alpha = if (a.chatReady) alpha else alpha * 0.6f },
        onClick = if (a.chatReady) ({ onOpen(a) }) else null) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            AgentAvatar(a.name, p, 44.dp, Modifier.sharedAvatar(a.name).combinedClickable(onClick = { if (a.chatReady) onOpen(a) }, onLongClick = { onAvatarLongPress(a.name) }))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(a.label ?: a.name, style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    a.badge?.let { badge ->
                        Spacer(Modifier.width(6.dp))
                        Text(badge, style = MaterialTheme.typography.labelSmall, color = c.accent,
                            modifier = Modifier.clip(RoundedCornerShape(50)).background(c.accent.copy(alpha = 0.12f)).padding(horizontal = 7.dp, vertical = 2.dp))
                    }
                }
                Text(
                    fleetSubtitle(a),
                    style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                StatusPill(p)
                if (unread) {
                    Spacer(Modifier.height(6.dp))
                    Box(Modifier.width(8.dp).height(8.dp).clip(RoundedCornerShape(4.dp)).background(c.accent))
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
private fun EmptyState(title: String, body: String, action: String, onAction: () -> Unit) {
    val c = LocalHubColors.current
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.text)
        Spacer(Modifier.height(6.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        Spacer(Modifier.height(12.dp))
        SoftButton(onClick = onAction) { Text(action, color = c.accent) }
    }
}

/** Second line of an agent card: the owner's description, else what kind of agent it is. Never an address. */
fun fleetSubtitle(a: AgentStatus): String = buildString {
    append(a.description.lineSequence().firstOrNull()?.takeIf { it.isNotBlank() } ?: when (a.kind) {
        "mcp-inbox" -> "Mailbox · replies when ${a.displayName} checks in"
        "openai" -> "OpenAI-compatible"
        "hermes" -> "Hermes agent"
        else -> a.kind
    })
    a.activeSessions?.takeIf { it > 0 }?.let { append(" · $it active") }
}
