package dev.foxfleet.app.ui.chat

import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PaintingStyle
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.BgMode
import dev.foxfleet.app.data.ChatBackgroundStore
import dev.foxfleet.app.data.ChatBg
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.Tokens
import dev.foxfleet.app.ui.components.FoxIcon
import dev.foxfleet.app.ui.components.SoftButton
import dev.foxfleet.app.ui.components.SoftButtonKind

/** True when a chat has its own background: bubbles go opaque and loose text gets a quiet chip, so everything reads over any picture. */
val LocalChatBgActive = compositionLocalOf { false }

fun solidColor(id: String, dark: Boolean): Color? = Tokens.ChatBackgrounds.solids.firstOrNull { it.id == id }?.let { if (dark) it.dark else it.light }
fun patternOf(id: String) = Tokens.ChatBackgrounds.patterns.firstOrNull { it.id == id }

/** One chat's background: settings + decoded picture, read from and written to the private [ChatBackgroundStore]. */
@Stable
class ChatBackgroundState(private val store: ChatBackgroundStore, private val context: Context, initialKey: String) {
    var key by mutableStateOf(initialKey); private set
    var bg by mutableStateOf(store.load(initialKey)); private set
    var bitmap by mutableStateOf<Bitmap?>(if (bg.image) store.loadBitmap(initialKey) else null); private set
    var failed by mutableStateOf(false); private set

    /** Switch to another chat. A new chat's look moves to the chat when it gets its id ([adopt] = true). */
    fun switchTo(newKey: String, adopt: Boolean) {
        if (newKey == key) return
        if (adopt) store.move(key, newKey)
        key = newKey; bg = store.load(newKey); bitmap = if (bg.image) store.loadBitmap(newKey) else null; failed = false
    }
    fun update(patch: (ChatBg) -> ChatBg) {
        val n = patch(bg); bg = ChatBg.normalize(n.mode.name, n.solid, n.pattern, n.blur, n.dim, n.image); store.save(key, bg)
    }
    fun pick(uri: android.net.Uri) {
        failed = false
        if (store.savePicked(context, key, uri)) { bitmap = store.loadBitmap(key); update { it.copy(image = true, mode = BgMode.Image) } } else failed = true
    }
    fun reset() { store.reset(key); bg = ChatBg(); bitmap = null; failed = false }
}

@Composable
fun rememberChatBackground(agent: String, sessionId: String?, hasMessages: Boolean): ChatBackgroundState {
    val ctx = LocalContext.current.applicationContext
    val store = remember { ChatBackgroundStore(ctx) }
    val key = store.key(agent, sessionId)
    val st = remember { ChatBackgroundState(store, ctx, key) }
    var last by remember { mutableStateOf(Triple(agent, sessionId, hasMessages)) }
    if (key != st.key) {
        // new chat -> its first message got an id: keep the look; anything else is just another chat
        st.switchTo(key, adopt = last.first == agent && last.second == null && sessionId != null && hasMessages)
    }
    last = Triple(agent, sessionId, hasMessages)
    return st
}

// ---- drawing ----

/** One pattern tile as an image (drawn once per pattern, colour and density), then repeated by a shader. */
@Composable
private fun rememberTile(p: Tokens.ChatBackgrounds.Pattern, ink: Color): ImageBitmap {
    val d = LocalDensity.current.density
    return remember(p.id, ink, d) {
        val w = (p.width * d).toInt().coerceAtLeast(1); val h = (p.height * d).toInt().coerceAtLeast(1)
        val bmp = ImageBitmap(w, h); val canvas = androidx.compose.ui.graphics.Canvas(bmp)
        canvas.scale(d, d)
        p.shapes.forEach { s ->
            val path = PathParser().parsePathString(s.d).toPath()
            val paint = Paint().apply {
                color = ink; isAntiAlias = true
                if (s.fill) style = PaintingStyle.Fill else { style = PaintingStyle.Stroke; strokeWidth = p.stroke; strokeCap = StrokeCap.Round; strokeJoin = StrokeJoin.Round }
            }
            canvas.drawPath(path, paint)
        }
        bmp
    }
}

/** Behind the transcript. Decorative. */
@Composable
fun ChatBackgroundLayer(bg: ChatBg, bitmap: Bitmap?, modifier: Modifier = Modifier) {
    if (bg.isDefault) return
    val c = LocalHubColors.current
    Box(modifier.fillMaxSize().clip(androidx.compose.ui.graphics.RectangleShape)) {
        if ((bg.mode == BgMode.Solid || bg.mode == BgMode.Pattern) && bg.solid.isNotEmpty()) solidColor(bg.solid, c.dark)?.let { Box(Modifier.fillMaxSize().background(it)) }
        if (bg.mode == BgMode.Pattern) patternOf(bg.pattern)?.let { p ->
            val alpha = if (c.dark) p.opacityDark else p.opacityLight
            val tile = rememberTile(p, c.text.copy(alpha = alpha))
            Box(Modifier.fillMaxSize().drawBehind { drawRect(ShaderBrush(ImageShader(tile, TileMode.Repeated, TileMode.Repeated))) })
        }
        if (bg.mode == BgMode.Image && bitmap != null) {
            // Android 12+ blurs live; older phones get a soft look from a smaller, smoothly enlarged copy.
            val soft = remember(bitmap, bg.blur) {
                if (bg.blur > 0 && Build.VERSION.SDK_INT < 31) {
                    val f = 1f + bg.blur / 2f; Bitmap.createScaledBitmap(bitmap, (bitmap.width / f).toInt().coerceAtLeast(8), (bitmap.height / f).toInt().coerceAtLeast(8), true)
                } else bitmap
            }
            Image(soft.asImageBitmap(), null, Modifier.fillMaxSize().let { if (bg.blur > 0 && Build.VERSION.SDK_INT >= 31) it.blur(bg.blur.dp) else it }, contentScale = ContentScale.Crop)
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = bg.dim)))
        }
    }
}

/** Quiet chip behind loose text (notices, status, empty state) while a chat has its own background. */
@Composable
fun Modifier.bgChip(): Modifier {
    if (!LocalChatBgActive.current) return this
    val c = LocalHubColors.current
    return this.clip(RoundedCornerShape(50)).background(c.surface.copy(alpha = 0.88f)).padding(horizontal = 12.dp, vertical = 4.dp)
}

// ---- the picker ----

private val modes = listOf(BgMode.Default to "Default", BgMode.Solid to "Colour", BgMode.Pattern to "Pattern", BgMode.Image to "Picture")

/** Every change shows in the chat straight away (the sheet has no scrim) and is saved for this chat on this phone. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChatBackgroundSheet(state: ChatBackgroundState, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) state.pick(uri) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.surface, scrimColor = Color.Transparent) {
        ChatBackgroundContent(state) { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
    }
}

/** The panel's body: type switch, colours, patterns, blur and dim sliders, choose/reset. [choose] opens the system photo picker. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChatBackgroundContent(state: ChatBackgroundState, choose: () -> Unit) {
    val c = LocalHubColors.current
    val bg = state.bg
    run {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Chat background", style = MaterialTheme.typography.titleMedium, color = c.text)
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.surfaceAlt).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                modes.forEach { (m, label) ->
                    val on = bg.mode == m
                    Box(
                        Modifier.weight(1f).heightIn44().clip(RoundedCornerShape(9.dp)).background(if (on) c.surface else Color.Transparent)
                            .clickable(role = Role.RadioButton) { if (m == BgMode.Image && !bg.image) choose() else state.update { it.copy(mode = m, solid = if (m == BgMode.Solid && it.solid.isEmpty()) Tokens.ChatBackgrounds.solids.first().id else it.solid) } }
                            .semantics { selected = on; stateDescription = if (on) "Selected" else "Not selected" },
                        contentAlignment = Alignment.Center,
                    ) { Text(label, style = MaterialTheme.typography.labelLarge, color = if (on) c.text else c.textMuted) }
                }
            }
            if (bg.mode == BgMode.Solid || bg.mode == BgMode.Pattern) {
                Text("Colours", style = MaterialTheme.typography.labelMedium, color = c.textMuted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (bg.mode == BgMode.Pattern) Swatch("Default", c.bg, bg.solid.isEmpty()) { state.update { it.copy(solid = "") } }
                    Tokens.ChatBackgrounds.solids.forEach { s -> Swatch(s.name, if (c.dark) s.dark else s.light, bg.solid == s.id) { state.update { it.copy(solid = s.id) } } }
                }
            }
            if (bg.mode == BgMode.Pattern) {
                Text("Patterns", style = MaterialTheme.typography.labelMedium, color = c.textMuted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Tokens.ChatBackgrounds.patterns.forEach { p ->
                        val base = solidColor(bg.solid, c.dark) ?: c.bg
                        Swatch(p.name, base, bg.pattern == p.id, pattern = p) { state.update { it.copy(pattern = p.id) } }
                    }
                }
            }
            if (bg.mode == BgMode.Image) {
                if (!bg.image) Text("Choose a picture to preview it here.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                LabeledSlider("Blur", bg.blur.toFloat(), 0f, Tokens.ChatBackgrounds.blurMax.toFloat(), "${bg.blur}") { v -> state.update { it.copy(blur = v.toInt()) } }
                LabeledSlider("Dim", bg.dim * 100, 0f, Tokens.ChatBackgrounds.dimMax * 100, "${(bg.dim * 100).toInt()}%") { v -> state.update { it.copy(dim = v / 100f) } }
            }
            if (state.failed) Text("Couldn't use that picture.", style = MaterialTheme.typography.bodySmall, color = c.accent)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                SoftButton(choose, kind = SoftButtonKind.Outlined) { FoxIcon("image", null, tint = c.text, size = 18.dp); Text(if (bg.image) "Change picture" else "Choose picture", color = c.text) }
                SoftButton({ state.reset() }, enabled = !bg.isDefault || bg.image, kind = SoftButtonKind.Tonal) { FoxIcon("reset", null, tint = c.text, size = 18.dp); Text("Reset to default", color = c.text) }
            }
            Text("Stays on this phone. Never uploaded.", style = MaterialTheme.typography.bodySmall, color = c.textFaint)
        }
    }
}

private fun Modifier.heightIn44() = this.then(Modifier.defaultMinSize(minHeight = 44.dp))

@Composable
private fun Swatch(name: String, color: Color, selected: Boolean, pattern: Tokens.ChatBackgrounds.Pattern? = null, onClick: () -> Unit) {
    val c = LocalHubColors.current
    Box(
        Modifier.size(48.dp).clip(RoundedCornerShape(12.dp)).background(color)
            .border(if (selected) 2.dp else 1.dp, if (selected) c.accent else c.hairline, RoundedCornerShape(12.dp))
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = name; this.selected = selected },
    ) {
        if (pattern != null) {
            val tile = rememberTile(pattern, c.text.copy(alpha = minOf(1f, 3 * (if (c.dark) pattern.opacityDark else pattern.opacityLight))))
            Box(Modifier.fillMaxSize().drawBehind { drawRect(ShaderBrush(ImageShader(tile, TileMode.Repeated, TileMode.Repeated))) })
        }
    }
}

@Composable
private fun LabeledSlider(label: String, value: Float, min: Float, max: Float, shown: String, onChange: (Float) -> Unit) {
    val c = LocalHubColors.current
    Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.size(width = 48.dp, height = 24.dp))
        Slider(
            value, onChange, Modifier.weight(1f).semantics { contentDescription = label; stateDescription = shown }, valueRange = min..max,
            colors = SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent, inactiveTrackColor = c.surfaceAlt),
        )
        Text(shown, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.size(width = 44.dp, height = 24.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End)
    }
}
