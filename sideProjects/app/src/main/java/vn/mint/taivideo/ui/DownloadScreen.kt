package vn.mint.taivideo.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import vn.mint.taivideo.EngineState
import vn.mint.taivideo.MainViewModel
import vn.mint.taivideo.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DogeDownloaderScreen(vm: MainViewModel) {
    val snackHost = remember { SnackbarHostState() }
    val snack = vm.snack
    val downloadDone = stringResource(R.string.download_done)
    val mascotPose = when {
        vm.dlProgress != null || vm.fetching -> ShibaPose.Downloading
        vm.engineState is EngineState.Error || vm.fetchError != null -> ShibaPose.Error
        snack == downloadDone -> ShibaPose.Success
        else -> ShibaPose.Idle
    }
    LaunchedEffect(snack) {
        if (snack != null) {
            snackHost.showSnackbar(snack)
            if (vm.snack == snack) vm.snack = null
        }
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                            PixelShiba(mascotPose, Modifier.size(48.dp).padding(2.dp))
                        }
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(stringResource(R.string.brand_subtitle), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                },
                actions = {
                    if (vm.updating) AnimatedRefreshIcon(Modifier.padding(12.dp).size(24.dp), stringResource(R.string.updating))
                    else IconButton(onClick = vm::updateEngine, enabled = vm.engineState !is EngineState.Preparing && !vm.fetching && vm.dlProgress == null) {
                        Icon(painterResource(R.drawable.ic_pixel_refresh), stringResource(R.string.update_engine))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        snackbarHost = { SnackbarHost(snackHost) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item { LinkCard(vm) }
            item { EngineStatus(vm.engineState, vm.updating, vm::initEngine) }
            vm.meta?.let { meta -> item { VideoCard(meta, vm) } }
            vm.dlProgress?.let { progress -> item { ProgressCard(vm.dlTitle, progress) } }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(stringResource(R.string.history), style = MaterialTheme.typography.titleLarge)
                    if (vm.history.isNotEmpty()) Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                        Text(stringResource(R.string.history_count, vm.history.size), Modifier.padding(horizontal = 10.dp, vertical = 6.dp), style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            if (vm.history.isEmpty()) item { EmptyHistory() }
            else items(vm.history, key = { it.fileName }) { item -> HistoryCard(item, vm) }
            item { Text(stringResource(R.string.save_location), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
    vm.pendingDelete?.let { item ->
        AlertDialog(
            onDismissRequest = { vm.pendingDelete = null },
            icon = { Icon(painterResource(R.drawable.ic_pixel_delete), null) },
            title = { Text(stringResource(R.string.confirm_delete_title)) },
            text = { Text(stringResource(R.string.confirm_delete_msg, item.title)) },
            confirmButton = {
                TextButton(onClick = { vm.deleteItem(item) }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                    Text(stringResource(R.string.confirm_yes))
                }
            },
            dismissButton = { TextButton(onClick = { vm.pendingDelete = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun LinkCard(vm: MainViewModel) {
    val clipboard = LocalClipboardManager.current
    val focus = LocalFocusManager.current
    val emptyClipboard = stringResource(R.string.clipboard_empty)
    val available = vm.engineState is EngineState.Ready && !vm.fetching && !vm.updating
    Card(
        modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(R.string.link_heading), style = MaterialTheme.typography.headlineMedium)
            Text(stringResource(R.string.link_description), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                value = vm.url, onValueChange = vm::editUrl, modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.url_label)) }, placeholder = { Text(stringResource(R.string.url_hint)) },
                leadingIcon = { Icon(painterResource(R.drawable.ic_pixel_link), null) },
                trailingIcon = {
                    IconButton(onClick = {
                        val text = clipboard.getText()?.text.orEmpty().trim()
                        if (text.isBlank()) vm.snack = emptyClipboard
                        else vm.editUrl(Regex("https?://\\S+", RegexOption.IGNORE_CASE).find(text)?.value ?: text)
                    }) { Icon(painterResource(R.drawable.ic_pixel_clipboard), stringResource(R.string.paste_link)) }
                },
                isError = vm.fetchError != null, singleLine = true, shape = RoundedCornerShape(14.dp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (available && vm.url.isNotBlank()) { focus.clearFocus(); vm.fetchInfo() } }),
            )
            vm.fetchError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = { focus.clearFocus(); vm.fetchInfo() }, enabled = vm.url.isNotBlank() && available,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(14.dp),
            ) {
                if (vm.fetching) AnimatedRefreshIcon(Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onPrimary)
                else Icon(Icons.AutoMirrored.Filled.ArrowForward, null, Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(if (vm.fetching) R.string.fetching else R.string.fetch_info))
            }
            Text(stringResource(R.string.supported_sites), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun EngineStatus(state: EngineState, updating: Boolean, retry: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        when {
            updating || state is EngineState.Preparing -> {
                AnimatedRefreshIcon(Modifier.size(16.dp))
                Text(stringResource(if (updating) R.string.updating else R.string.engine_preparing), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            }
            state is EngineState.Error -> {
                Icon(painterResource(R.drawable.ic_pixel_error), null, Modifier.size(18.dp), MaterialTheme.colorScheme.error)
                Text(stringResource(R.string.engine_error), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = retry) { Text(stringResource(R.string.retry)) }
            }
            else -> {
                Icon(painterResource(R.drawable.ic_pixel_check), null, Modifier.size(16.dp), MaterialTheme.colorScheme.primary)
                Text(stringResource(R.string.engine_ready), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
