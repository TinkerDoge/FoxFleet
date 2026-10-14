package vn.mint.taivideo

import android.app.Application
import android.content.Intent
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URI

sealed interface EngineState {
    data object Preparing : EngineState
    data class Ready(val version: String) : EngineState
    data class Error(val message: String) : EngineState
}

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val ctx get() = getApplication<Application>()
    private var queuedFetch = false

    var url by mutableStateOf("")
    var engineState by mutableStateOf<EngineState>(EngineState.Preparing)
    var meta by mutableStateOf<VideoMeta?>(null)
    var fetching by mutableStateOf(false)
    var fetchError by mutableStateOf<String?>(null)
    var quality by mutableStateOf(Quality.BEST)
    var history by mutableStateOf<List<HistoryItem>>(emptyList())
    var updating by mutableStateOf(false)
    var dlProgress by mutableStateOf<Float?>(null)
    var dlTitle by mutableStateOf("")
    var snack by mutableStateOf<String?>(null)
    var pendingDelete by mutableStateOf<HistoryItem?>(null)

    init {
        viewModelScope.launch {
            DownloadBus.state.collect { s ->
                when (s) {
                    is DlState.Running -> {
                        dlProgress = s.progress
                        dlTitle = s.title
                    }
                    is DlState.Done -> {
                        dlProgress = null
                        refreshHistory()
                        snack = ctx.getString(R.string.download_done)
                        DownloadBus.state.value = DlState.Idle
                    }
                    is DlState.Failed -> {
                        dlProgress = null
                        snack = s.message
                        DownloadBus.state.value = DlState.Idle
                    }
                    DlState.Idle -> Unit
                }
            }
        }
        initEngine()
        refreshHistory()
    }

    fun initEngine() {
        engineState = EngineState.Preparing
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { DownloadEngine.init(ctx) }
                val v = withContext(Dispatchers.IO) { DownloadEngine.version(ctx) }
                engineState = EngineState.Ready(v)
                if (url.isNotBlank()) fetchInfo()
            } catch (e: Exception) {
                Log.e("DogeDownloader", "Engine initialization failed", e)
                engineState = EngineState.Error(ctx.getString(R.string.engine_error))
            }
        }
    }

    fun editUrl(value: String) {
        if (url.trim() != value.trim()) {
            meta = null
            fetchError = null
        }
        url = value
    }

    fun fetchInfo() {
        val u = url.trim()
        if (u.isEmpty()) return
        if (engineState !is EngineState.Ready || updating) return
        if (fetching) {
            queuedFetch = true
            return
        }
        val valid = runCatching {
            val parsed = URI(u)
            (parsed.scheme.equals("https", true) || parsed.scheme.equals("http", true)) && !parsed.host.isNullOrBlank()
        }.getOrDefault(false)
        if (!valid) {
            fetchError = ctx.getString(R.string.invalid_url)
            meta = null
            return
        }
        fetching = true
        fetchError = null
        meta = null
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { DownloadEngine.fetchInfo(u) }
                if (url.trim() == u) meta = result
            } catch (e: Exception) {
                Log.e("DogeDownloader", "Video lookup failed", e)
                if (url.trim() == u) fetchError = ctx.getString(R.string.fetch_error)
            } finally {
                fetching = false
                if (queuedFetch) {
                    queuedFetch = false
                    fetchInfo()
                }
            }
        }
    }

    fun startDownload() {
        val u = url.trim()
        val m = meta ?: return
        if (engineState !is EngineState.Ready || dlProgress != null || updating) return
        val intent = Intent(ctx, DownloadService::class.java).apply {
            putExtra(DownloadService.EXTRA_URL, u)
            putExtra(DownloadService.EXTRA_QUALITY, quality.name)
            putExtra(DownloadService.EXTRA_TITLE, m.title)
        }
        dlTitle = m.title
        dlProgress = 0f
        try {
            ContextCompat.startForegroundService(ctx, intent)
        } catch (e: Exception) {
            Log.e("DogeDownloader", "Download service could not start", e)
            dlProgress = null
            snack = ctx.getString(R.string.download_failed)
        }
    }

    fun updateEngine() {
        if (updating || fetching || dlProgress != null) return
        updating = true
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { DownloadEngine.update(ctx) }
                val v = withContext(Dispatchers.IO) { DownloadEngine.version(ctx) }
                engineState = EngineState.Ready(v)
                snack = ctx.getString(R.string.updated)
            } catch (e: Exception) {
                Log.e("DogeDownloader", "Engine update failed", e)
                snack = ctx.getString(R.string.update_failed)
            } finally {
                updating = false
            }
        }
    }

    fun refreshHistory() {
        history = HistoryStore.load(ctx)
    }

    fun deleteItem(item: HistoryItem) {
        viewModelScope.launch(Dispatchers.IO) {
            val deleted = runCatching { val file = item.file(ctx); !file.exists() || file.delete() }.getOrDefault(false)
            if (!deleted) {
                withContext(Dispatchers.Main) { snack = ctx.getString(R.string.delete_failed) }
                return@launch
            }
            HistoryStore.remove(ctx, item)
            withContext(Dispatchers.Main) {
                refreshHistory()
                pendingDelete = null
            }
        }
    }

    fun openItem(item: HistoryItem) {
        val file = item.file(ctx)
        if (!file.exists()) {
            snack = ctx.getString(R.string.file_missing)
            return
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.provider", file)
        val mime = if (file.extension.equals("mp3", true)) "audio/mpeg" else "video/*"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            ctx.startActivity(Intent.createChooser(intent, ctx.getString(R.string.open)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.e("DogeDownloader", "File opening failed", e)
            snack = ctx.getString(R.string.open_failed)
        }
    }

    fun shareItem(item: HistoryItem) {
        val file = item.file(ctx)
        if (!file.exists()) {
            snack = ctx.getString(R.string.file_missing)
            return
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.provider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = if (file.extension.equals("mp3", true)) "audio/mpeg" else "video/*"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            ctx.startActivity(Intent.createChooser(intent, ctx.getString(R.string.share)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.e("DogeDownloader", "File sharing failed", e)
            snack = ctx.getString(R.string.share_failed)
        }
    }
}
