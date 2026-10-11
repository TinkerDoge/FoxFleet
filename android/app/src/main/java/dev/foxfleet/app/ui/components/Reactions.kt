package dev.foxfleet.app.ui.components

import androidx.compose.ui.graphics.compositeOver
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.QUICK_REACTIONS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** One bundled Twemoji entry: the Unicode value we store, its name for search, and its artwork file. */
data class EmojiEntry(val emoji: String, val name: String, val asset: String)

/** The bundled Twemoji catalog (assets/emoji), read once. Artwork is only how we draw it; Unicode is what the hub stores. */
object EmojiCatalog {
    @Volatile private var list: List<EmojiEntry>? = null
    @Volatile private var byEmoji: Map<String, String> = emptyMap()
    private fun strip(e: String) = e.replace("️", "")
    fun loaded(): List<EmojiEntry>? = list
    fun asset(emoji: String): String? = byEmoji[emoji] ?: byEmoji[strip(emoji)]
    suspend fun load(context: Context): List<EmojiEntry> = list ?: withContext(Dispatchers.IO) {
        val parsed = runCatching {
            Json.parseToJsonElement(context.assets.open("emoji/catalog.json").use { it.readBytes().decodeToString() }).jsonArray.mapNotNull { el ->
                val o = el.jsonObject
                EmojiEntry(o["emoji"]?.jsonPrimitive?.content ?: return@mapNotNull null, o["name"]?.jsonPrimitive?.content.orEmpty(), o["asset"]?.jsonPrimitive?.content ?: return@mapNotNull null)
            }
        }.getOrDefault(emptyList())
        val map = HashMap<String, String>(parsed.size * 2)
        parsed.forEach { e -> map[e.emoji] = e.asset; map.putIfAbsent(strip(e.emoji), e.asset) }
        byEmoji = map; list = parsed; parsed
    }
}

/** Twemoji picture when bundled, else the emoji as text (future emoji are kept, never dropped). */
@Composable
fun EmojiGlyph(value: String, size: Dp = 18.dp) {
    val context = LocalContext.current
    var ready by remember { mutableStateOf(EmojiCatalog.loaded() != null) }
    LaunchedEffect(Unit) { if (!ready) { EmojiCatalog.load(context); ready = true } }
    val asset = if (ready) EmojiCatalog.asset(value) else null
    if (asset != null) AsyncImage("file:///android_asset/emoji/$asset.png", null, Modifier.size(size))
    else Text(value, fontSize = (size.value * 0.9f).sp)
}

/** Pills under a message: tap yours to remove it, tap another to add yours. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReactionPills(groups: List<ReactionGroup>, me: String, onReact: (String, Boolean) -> Unit, onAdd: () -> Unit, modifier: Modifier = Modifier) {
    if (groups.isEmpty()) return
    val c = LocalHubColors.current
    FlowRow(modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        groups.forEach { g ->
            val mine = g.actors.any { it.id == me }
            val who = g.actors.joinToString { if (it.id == me) "You" else if (it.kind == "agent") "${it.name} (agent)" else it.name }
            Row(
                Modifier.heightIn(min = 32.dp).clip(RoundedCornerShape(50))
                    .background(if (mine) c.accent.copy(alpha = 0.14f).compositeOver(c.surface) else c.surface) // opaque: pills sit on the message frame's edge
                    .border(1.dp, if (mine) c.accent.copy(alpha = 0.55f) else c.hairline, RoundedCornerShape(50))
                    .semantics { contentDescription = "${g.emoji} ${g.actors.size}: $who"; selected = mine }
                    .clickable(role = Role.Button) { onReact(g.emoji, !mine) }
                    .padding(horizontal = 9.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                EmojiGlyph(g.emoji, 16.dp)
                Spacer(Modifier.width(4.dp))
                Text("${g.actors.size}", style = MaterialTheme.typography.labelMedium, color = if (mine) c.accent else c.text)
            }
        }
        Box(Modifier.size(32.dp).clip(RoundedCornerShape(50)).background(c.surface).border(1.dp, c.hairline, RoundedCornerShape(50)).semantics { contentDescription = "Add reaction" }.clickable(role = Role.Button, onClick = onAdd), contentAlignment = Alignment.Center) {
            Icon(FoxIcons.get("react"), null, tint = c.textMuted, modifier = Modifier.size(16.dp))
        }
    }
}

/** Long-press sheet: quick row, then the whole searchable catalog (skin tones and joined sequences included when searched). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmojiPickerSheet(onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    val context = LocalContext.current
    var all by remember { mutableStateOf(EmojiCatalog.loaded()) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { if (all == null) all = EmojiCatalog.load(context) }
    val shown = remember(all, query) {
        val q = query.trim().lowercase()
        all.orEmpty().filter { if (q.isEmpty()) !it.name.contains("skin tone") else it.name.contains(q) || it.emoji == query.trim() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Text("React", style = MaterialTheme.typography.titleMedium, color = c.text, modifier = Modifier.padding(bottom = 8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                QUICK_REACTIONS.forEach { e ->
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).semantics { contentDescription = e }.clickable(role = Role.Button) { onPick(e) }, contentAlignment = Alignment.Center) { EmojiGlyph(e, 28.dp) }
                }
            }
            Row(Modifier.padding(vertical = 10.dp).fillMaxWidth().heightIn(min = 44.dp).clip(RoundedCornerShape(50)).background(c.surfaceAlt).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(FoxIcons.get("search"), null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text("Search emoji", style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
                    BasicTextField(query, { query = it }, singleLine = true, textStyle = MaterialTheme.typography.bodyMedium.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Search emoji" })
                }
            }
            when {
                all == null -> Text("Loading emoji…", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(8.dp))
                shown.isEmpty() -> Text("No emoji match.", style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(8.dp))
                else -> LazyVerticalGrid(GridCells.Adaptive(44.dp), Modifier.fillMaxWidth().heightIn(max = 320.dp)) {
                    items(shown, key = { it.emoji }) { e ->
                        Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).semantics { contentDescription = e.name }.clickable(role = Role.Button) { onPick(e.emoji) }, contentAlignment = Alignment.Center) {
                            AsyncImage("file:///android_asset/emoji/${e.asset}.png", null, Modifier.size(28.dp))
                        }
                    }
                }
            }
            Text("Emoji: Twemoji, CC BY 4.0", style = MaterialTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.align(Alignment.End).padding(top = 8.dp))
        }
    }
}
