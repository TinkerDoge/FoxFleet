package dev.foxfleet.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.ui.LocalHubColors

/** Stable pastel tint per agent name so each agent keeps its colour across screens. */
fun avatarHue(name: String): Float = ((name.lowercase().hashCode().toLong() and 0xffffffffL) % 360L).toFloat()

fun initials(name: String): String {
    val parts = name.trim().split(' ', '-', '_', '.').filter { it.isNotBlank() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2).replaceFirstChar { it.uppercase() }
        else -> (parts[0].take(1) + parts[1].take(1)).uppercase()
    }
}

enum class Presence { Ready, Online, Offline }

fun AgentStatus.presence(): Presence = when {
    chatReady -> Presence.Ready
    online -> Presence.Online
    else -> Presence.Offline
}

@Composable
fun AgentAvatar(name: String, presence: Presence?, size: Dp = 40.dp, modifier: Modifier = Modifier) {
    val c = LocalHubColors.current
    val tint = Color.hsl(avatarHue(name), 0.45f, if (c.dark) 0.32f else 0.82f)
    val ink = Color.hsl(avatarHue(name), 0.5f, if (c.dark) 0.85f else 0.28f)
    val store = dev.foxfleet.app.media.LocalAvatarStore.current
    val custom = store?.let { s -> s.versions[s.key(name)]; s.fileFor(name) }
    Box(modifier.size(size)) {
        Box(
            Modifier.size(size).clip(CircleShape).background(tint),
            contentAlignment = Alignment.Center,
        ) {
            if (custom != null) coil3.compose.AsyncImage(
                model = custom, contentDescription = name, contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                modifier = Modifier.size(size),
            ) else Text(initials(name), color = ink, fontWeight = FontWeight.Medium, fontSize = (size.value * 0.38f).sp)
        }
        if (presence != null) {
            val dot = when (presence) { Presence.Ready -> c.online; Presence.Online -> c.idle; Presence.Offline -> c.offline }
            val d = (size.value * 0.28f).dp
            Box(
                Modifier.align(Alignment.BottomEnd).offset(x = 1.dp, y = 1.dp).size(d)
                    .clip(CircleShape).background(dot).border(2.dp, c.bg, CircleShape),
            )
        }
    }
}
