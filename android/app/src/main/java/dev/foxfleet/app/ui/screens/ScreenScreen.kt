package dev.foxfleet.app.ui.screens

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.SoftIconButton
import dev.foxfleet.app.ui.motion.reduceMotion
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.json.JSONObject

/** Bot Screen session phases (pure, unit-tested). */
enum class ScreenPhase { Checking, Stopped, Starting, Connecting, Watching, Control, Disconnected, Failed }

fun screenPhaseLabel(p: ScreenPhase): String = when (p) {
    ScreenPhase.Checking -> "Checking…"
    ScreenPhase.Stopped -> "Screen off"
    ScreenPhase.Starting -> "Starting desktop…"
    ScreenPhase.Connecting -> "Connecting…"
    ScreenPhase.Watching -> "Watching"
    ScreenPhase.Control -> "You're in control"
    ScreenPhase.Disconnected -> "Disconnected"
    ScreenPhase.Failed -> "Unavailable"
}

/** "14:05" until the hub hands control back on its own. */
fun handBackCountdown(remainingMs: Long): String {
    val s = (remainingMs.coerceAtLeast(0) + 999) / 1000
    return "%d:%02d".format(s / 60, s % 60)
}

private val ControlRed = Color(0xFFE5484D)
private const val APP_PAGE = "https://appassets.androidplatform.net/assets/screen.html"

/**
 * Watch, take over and hand back an agent's Xfce desktop. noVNC runs in a locked WebView
 * (bundled assets only, no navigation); the window is FLAG_SECURE while this screen is shown.
 * [preview] draws a placeholder desktop instead of the WebView (screenshot tests).
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ScreenScreen(
    agentName: String,
    api: HubApi?,
    onBack: () -> Unit,
    onLeaveInControl: () -> Unit,
    preview: Boolean = false,
    initialPhase: ScreenPhase = ScreenPhase.Checking,
    initialHandBackAt: Long = 0L,
) {
    val c = LocalHubColors.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var phase by remember { mutableStateOf(initialPhase) }
    var note by remember { mutableStateOf<String?>(null) }
    var handBackAt by remember { mutableLongStateOf(initialHandBackAt) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var busy by remember { mutableStateOf(false) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var pageReady by remember { mutableStateOf(false) }
    var pendingUrl by remember { mutableStateOf<String?>(null) }
    val reduce = reduceMotion()

    // No screenshots, screen recording or recents thumbnail of the agent's desktop.
    DisposableEffect(Unit) {
        val window = (ctx as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            if (phase == ScreenPhase.Control) onLeaveInControl()
            web?.let { w -> w.evaluateJavascript("window.hub && hub.disconnect()", null); w.destroy() }
        }
    }
    fun js(code: String) { web?.evaluateJavascript(code, null) }
    fun connectSocket(url: String) { if (pageReady) js("hub.connect(${JSONObject.quote(url)})") else pendingUrl = url }

    suspend fun guarded(block: suspend () -> Unit) {
        busy = true
        try { block() } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) {
            phase = ScreenPhase.Failed; note = "Sign in again to view the screen"
        } catch (e: Exception) { note = e.message?.let { dev.foxfleet.app.data.scrubAddresses(it) } ?: "Screen request failed" } finally { busy = false }
    }
    suspend fun observe() {
        val a = api ?: return
        phase = ScreenPhase.Connecting
        val obs = a.screen(agentName, "observe")
        val ticket = obs["ticket"]?.jsonPrimitive?.content ?: error("No screen ticket")
        connectSocket(a.screenSocketUrl(agentName, ticket))
    }
    suspend fun open() = guarded {
        val a = api ?: return@guarded
        val st = a.parseScreen(a.screen(agentName, "status"))
        when {
            !st.supported -> { phase = ScreenPhase.Failed; note = "This agent has no Bot Screen" }
            !st.running -> phase = ScreenPhase.Stopped
            else -> observe()
        }
    }
    fun start() = scope.launch { guarded { phase = ScreenPhase.Starting; api?.screen(agentName, "start"); observe() } }
    fun takeOver() = scope.launch {
        guarded {
            val r = api?.screen(agentName, "takeover") ?: return@guarded
            handBackAt = r["autoHandBackAt"]?.jsonPrimitive?.longOrNull ?: (System.currentTimeMillis() + 15 * 60_000)
            phase = ScreenPhase.Control; js("hub.setControl(true)")
        }
    }
    fun handBack() = scope.launch {
        js("hub.setControl(false)")
        guarded { api?.screen(agentName, "handback"); if (phase == ScreenPhase.Control) phase = ScreenPhase.Watching }
    }

    LaunchedEffect(Unit) { if (!preview) open() }
    LaunchedEffect(phase) {
        while (phase == ScreenPhase.Control) {
            now = System.currentTimeMillis()
            if (handBackAt in 1..now) { js("hub.setControl(false)"); phase = ScreenPhase.Watching; note = "Control went back to $agentName" }
            delay(1000)
        }
    }
    LaunchedEffect(note) { if (note != null) { delay(4000); note = null } }

    val border by animateColorAsState(if (phase == ScreenPhase.Control) ControlRed else Color.Transparent, label = "control-border")
    Column(Modifier.fillMaxSize().background(Color(0xFF0B0B0C)).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            SoftIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, tint = Color.White)
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f)) {
                Text("$agentName's screen", style = MaterialTheme.typography.titleMedium, color = Color.White)
                Text(
                    if (phase == ScreenPhase.Control && handBackAt > 0) "Auto hand-back in ${handBackCountdown(handBackAt - now)}" else "Xfce desktop · view only until you take over",
                    style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.6f),
                )
            }
            val tone = when (phase) { ScreenPhase.Control -> ControlRed; ScreenPhase.Watching -> c.online; else -> Color.White.copy(alpha = 0.5f) }
            Text(screenPhaseLabel(phase), style = MaterialTheme.typography.labelMedium, color = tone,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(tone.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 4.dp))
            Spacer(Modifier.width(6.dp))
        }
        Box(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 6.dp).clip(RoundedCornerShape(12.dp))
                .border(3.dp, if (reduce && phase == ScreenPhase.Control) ControlRed else border, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (preview) PreviewDesktop()
            else AndroidView(
                factory = { context ->
                    val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
                    val main = Handler(Looper.getMainLooper())
                    WebView(context).apply {
                        setBackgroundColor(android.graphics.Color.BLACK)
                        settings.javaScriptEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.setSupportMultipleWindows(false)
                        settings.javaScriptCanOpenWindowsAutomatically = false
                        if ((api?.baseUrl ?: "").startsWith("http://")) settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        webViewClient = object : WebViewClient() {
                            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true // never navigate away
                        }
                        addJavascriptInterface(object {
                            @JavascriptInterface fun onEvent(type: String, detail: String) = main.post {
                                when (type) {
                                    "ready" -> { pageReady = true; pendingUrl?.let { u -> pendingUrl = null; evaluateJavascript("hub.connect(${JSONObject.quote(u)})", null) } }
                                    "connected" -> if (phase != ScreenPhase.Control) phase = ScreenPhase.Watching
                                    "disconnected" -> if (phase in setOf(ScreenPhase.Watching, ScreenPhase.Control, ScreenPhase.Connecting)) { phase = ScreenPhase.Disconnected; handBackAt = 0 }
                                    "error" -> note = detail.take(120)
                                }
                            }
                        }, "FoxfleetBridge")
                        loadUrl(APP_PAGE)
                        web = this
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
            when (phase) {
                ScreenPhase.Checking, ScreenPhase.Connecting, ScreenPhase.Starting ->
                    CircularProgressIndicator(Modifier.size(28.dp), color = Color.White.copy(alpha = 0.7f), strokeWidth = 2.dp)
                ScreenPhase.Stopped -> Overlay("$agentName's desktop is off", "Start it to watch what the agent does.", "Start screen", busy) { start() }
                ScreenPhase.Disconnected -> Overlay("Disconnected", "The screen connection closed.", "Reconnect", busy) { scope.launch { guarded { observe() } } }
                ScreenPhase.Failed -> Overlay("Screen unavailable", note ?: "Check that the agent has Bot Screen (TigerVNC + Xfce).", "Retry", busy) { scope.launch { open() } }
                else -> {}
            }
        }
        note?.takeIf { phase != ScreenPhase.Failed }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f), modifier = Modifier.padding(start = 16.dp, top = 8.dp))
        }
        if (phase == ScreenPhase.Control) Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("Keyboard" to "hub.showKeyboard()", "Esc" to "hub.key('Escape')", "Tab" to "hub.key('Tab')", "Enter" to "hub.key('Enter')", "⌫" to "hub.key('Backspace')").forEach { (label, code) ->
                Text(label, style = MaterialTheme.typography.labelLarge, color = Color.White,
                    modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Color.White.copy(alpha = 0.12f)).clickable { js(code) }.padding(horizontal = 12.dp, vertical = 8.dp))
            }
        }
        val canAct = phase == ScreenPhase.Watching || phase == ScreenPhase.Control
        val control = phase == ScreenPhase.Control
        Box(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp).height(52.dp).clip(RoundedCornerShape(26.dp))
                .background(if (!canAct) Color.White.copy(alpha = 0.08f) else if (control) Color.White else ControlRed)
                .clickable(enabled = canAct && !busy) { if (control) handBack() else takeOver() },
            contentAlignment = Alignment.Center,
        ) {
            if (busy && canAct) CircularProgressIndicator(Modifier.size(20.dp), color = if (control) Color.Black else Color.White, strokeWidth = 2.dp)
            else Text(if (control) "Hand back to $agentName" else "Take over", fontWeight = FontWeight.SemiBold,
                color = if (!canAct) Color.White.copy(alpha = 0.35f) else if (control) Color.Black else Color.White)
        }
    }
}

@Composable
private fun Overlay(title: String, body: String, action: String, busy: Boolean, onAction: () -> Unit) {
    Column(Modifier.fillMaxSize().background(Color(0xE60B0B0C)).padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = Color.White)
        Spacer(Modifier.height(6.dp))
        Text(body, style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.65f))
        Spacer(Modifier.height(18.dp))
        Box(Modifier.clip(RoundedCornerShape(22.dp)).background(Color.White).clickable(enabled = !busy, onClick = onAction).padding(horizontal = 20.dp, vertical = 10.dp)) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Color.Black, strokeWidth = 2.dp)
            else Text(action, color = Color.Black, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Stand-in desktop for screenshot tests (WebView does not render under Robolectric). */
@Composable
private fun PreviewDesktop() {
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFF2B3A55), Color(0xFF4A5D7E))))) {
        Box(Modifier.fillMaxWidth().height(22.dp).background(Color(0xFF1E1E22)))
        Column(Modifier.padding(start = 18.dp, top = 40.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            repeat(3) { Box(Modifier.size(34.dp).clip(RoundedCornerShape(6.dp)).background(Color.White.copy(alpha = 0.25f))) }
        }
        Box(Modifier.align(Alignment.Center).padding(24.dp).fillMaxWidth().height(220.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFF2F2F2))) {
            Box(Modifier.fillMaxWidth().height(26.dp).background(Color(0xFFDADADA)))
            Column(Modifier.padding(start = 14.dp, top = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf(0.8f, 0.6f, 0.7f, 0.4f).forEach { Box(Modifier.fillMaxWidth(it).height(10.dp).clip(RoundedCornerShape(5.dp)).background(Color(0xFFBDBDBD))) }
            }
        }
    }
}
