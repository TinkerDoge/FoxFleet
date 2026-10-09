package dev.foxfleet.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.mikepenz.markdown.coil3.Coil3ImageTransformerImpl
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import androidx.compose.material3.MaterialTheme
import dev.foxfleet.app.ui.LocalHubColors

/** Markdown for agent replies: headings, lists, code, tables, links, inline images (Coil 3). */
@Composable
fun RichText(text: String, modifier: Modifier = Modifier) {
    val c = LocalHubColors.current
    Markdown(
        content = text,
        colors = markdownColor(
            text = c.text,
            codeBackground = c.surfaceAlt,
            inlineCodeBackground = c.surfaceAlt,
            dividerColor = c.hairline,
            tableBackground = c.surface,
        ),
        typography = markdownTypography(
            h1 = MaterialTheme.typography.titleLarge,
            h2 = MaterialTheme.typography.titleMedium.copy(fontSize = MaterialTheme.typography.titleMedium.fontSize * 1.08f),
            h3 = MaterialTheme.typography.titleMedium,
            h4 = MaterialTheme.typography.labelLarge,
            h5 = MaterialTheme.typography.labelLarge,
            h6 = MaterialTheme.typography.labelLarge,
            text = MaterialTheme.typography.bodyLarge,
            paragraph = MaterialTheme.typography.bodyLarge,
        ),
        imageTransformer = Coil3ImageTransformerImpl,
        modifier = modifier,
    )
}
