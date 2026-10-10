package dev.foxfleet.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import coil3.request.ImageRequest
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors

/**
 * A picture in the chat (one the user attached, or one in loaded history). While it loads there is a calm placeholder; when it cannot be
 * decoded or fetched there is a tile that says so with a Retry, never an empty rounded rectangle. [model] is a File, a data: URL or an https URL.
 */
@Composable
fun ChatImage(model: Any, description: String, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop, onClick: (() -> Unit)? = null) {
    val c = LocalHubColors.current
    var attempt by remember { mutableIntStateOf(0) }
    val ctx = LocalContext.current
    val request = remember(model, attempt) { ImageRequest.Builder(ctx).data(model).memoryCacheKey("$model#$attempt").diskCacheKey("$model#$attempt").build() }
    SubcomposeAsyncImage(
        model = request, contentDescription = description, contentScale = contentScale,
        modifier = modifier.background(c.surfaceAlt).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        loading = { Box(Modifier.testTag("image-loading"), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), color = c.textMuted, strokeWidth = 2.dp) } },
        error = {
            Column(Modifier.testTag("image-failed").padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
                Icon(FoxIcons.get("attach"), null, tint = c.textMuted, modifier = Modifier.size(22.dp))
                Spacer(Modifier.height(4.dp))
                Text("Couldn't load this picture", style = MaterialTheme.typography.labelMedium, color = c.textMuted, textAlign = TextAlign.Center)
                Text("Retry", style = MaterialTheme.typography.labelLarge, color = c.accent,
                    modifier = Modifier.defaultMinSize(minHeight = 44.dp, minWidth = 44.dp).clickable { attempt++ }.padding(horizontal = 12.dp, vertical = 12.dp).semantics { contentDescription = "Retry loading the picture" })
            }
        },
    )
}
