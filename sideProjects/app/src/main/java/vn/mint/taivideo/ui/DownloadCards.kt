package vn.mint.taivideo.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import vn.mint.taivideo.HistoryItem
import vn.mint.taivideo.MainViewModel
import vn.mint.taivideo.EngineState
import vn.mint.taivideo.Quality
import vn.mint.taivideo.R
import vn.mint.taivideo.VideoMeta
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
internal fun VideoCard(meta: VideoMeta, vm: MainViewModel) {
    Card(shape = RoundedCornerShape(24.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_pixel_video), null, Modifier.size(48.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                if (meta.thumbnail != null) AsyncImage(model = meta.thumbnail, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                if (meta.durationSec > 0) Surface(
                    modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp), shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.75f),
                ) { Text(formatDuration(meta.durationSec), Modifier.padding(horizontal = 8.dp, vertical = 4.dp), color = Color.White, style = MaterialTheme.typography.labelSmall) }
            }
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(meta.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                meta.uploader?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Text(stringResource(R.string.quality), style = MaterialTheme.typography.labelLarge)
                QualityPicker(vm.quality, enabled = vm.dlProgress == null) { vm.quality = it }
                Button(
                    onClick = vm::startDownload,
                    enabled = vm.dlProgress == null && !vm.updating && vm.engineState is EngineState.Ready,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(14.dp),
                ) {
                    Icon(painterResource(R.drawable.ic_pixel_download), null, Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(if (vm.dlProgress == null) R.string.download else R.string.download_in_progress))
                }
            }
        }
    }
}

@Composable
private fun QualityPicker(selected: Quality, enabled: Boolean, onSelect: (Quality) -> Unit) {
    val labels = mapOf(
        Quality.BEST to stringResource(R.string.q_best), Quality.P720 to stringResource(R.string.q_720),
        Quality.P480 to stringResource(R.string.q_480), Quality.AUDIO to stringResource(R.string.q_audio),
    )
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Quality.entries.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                pair.forEach { quality ->
                    FilterChip(
                        selected = selected == quality, onClick = { onSelect(quality) }, enabled = enabled,
                        label = { Text(labels.getValue(quality), style = MaterialTheme.typography.labelMedium) },
                        leadingIcon = if (selected == quality) ({ Icon(painterResource(R.drawable.ic_pixel_check), null, Modifier.size(16.dp)) }) else null,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp), shape = RoundedCornerShape(12.dp),
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                            selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            selectedLeadingIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        ),
                    )
                }
            }
        }
    }
}

@Composable
internal fun ProgressCard(title: String, progress: Float) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AnimatedDownloadIcon(Modifier.size(20.dp))
                Text(stringResource(R.string.download_in_progress), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(stringResource(R.string.progress_percent, (progress.coerceIn(0f, 1f) * 100).toInt()), style = MaterialTheme.typography.titleSmall)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PixelShiba(ShibaPose.Downloading, Modifier.size(56.dp))
                Text(title, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            if (progress <= 0f || progress >= 1f) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
            Text(stringResource(if (progress >= 1f) R.string.finishing_download else R.string.background_download_hint), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
internal fun EmptyHistory() {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(MaterialTheme.colorScheme.surface).padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PixelShiba(modifier = Modifier.size(88.dp))
        Text(stringResource(R.string.history_empty_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.history_empty), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun HistoryCard(item: HistoryItem, vm: MainViewModel) {
    var menu by remember(item.fileName) { mutableStateOf(false) }
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                    Icon(painterResource(if (item.fileName.endsWith(".mp3", ignoreCase = true)) R.drawable.ic_pixel_music else R.drawable.ic_pixel_video), null, Modifier.padding(12.dp).size(22.dp), MaterialTheme.colorScheme.onPrimaryContainer)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(item.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${formatDate(item.timestamp)} · ${formatSize(item.size)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { vm.openItem(item) }) { ActionLabel(R.drawable.ic_pixel_play, stringResource(R.string.open)) }
                TextButton(onClick = { vm.shareItem(item) }) { ActionLabel(R.drawable.ic_pixel_share, stringResource(R.string.share)) }
                Spacer(Modifier.weight(1f))
                Box {
                    IconButton(onClick = { menu = true }) { Icon(painterResource(R.drawable.ic_pixel_more), stringResource(R.string.more_actions)) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_pixel_delete), null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { menu = false; vm.pendingDelete = item },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ActionLabel(icon: Int, label: String) {
    Icon(painterResource(icon), null, Modifier.size(18.dp))
    Spacer(Modifier.width(6.dp))
    Text(label)
}

private fun formatDuration(seconds: Long): String {
    val minutes = seconds / 60
    return if (minutes >= 60) String.format(Locale.ROOT, "%d:%02d:%02d", minutes / 60, minutes % 60, seconds % 60)
    else String.format(Locale.ROOT, "%d:%02d", minutes, seconds % 60)
}

private fun formatDate(timestamp: Long): String = SimpleDateFormat("dd/MM/yyyy · HH:mm", Locale.forLanguageTag("vi-VN")).format(Date(timestamp))

private fun formatSize(bytes: Long): String =
    if (bytes < 1024 * 1024) String.format(Locale.forLanguageTag("vi-VN"), "%d KB", bytes / 1024)
    else String.format(Locale.forLanguageTag("vi-VN"), "%.1f MB", bytes / 1024f / 1024f)
