package dev.foxfleet.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.components.RiveAvatar
import dev.foxfleet.app.ui.isDark
import dev.foxfleet.app.ui.motion.LocalNavAnimScope
import dev.foxfleet.app.ui.motion.LocalSharedScope
import dev.foxfleet.app.ui.motion.reduceMotion
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.FleetScreen
import dev.foxfleet.app.ui.screens.LoginScreen
import dev.foxfleet.app.ui.screens.SettingsScreen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: HubViewModel by viewModels()

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let { vm.openConnectLink(it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        coil3.SingletonImageLoader.setSafe { ctx ->
            coil3.ImageLoader.Builder(ctx)
                .components { add(coil3.network.okhttp.OkHttpNetworkFetcherFactory(callFactory = { vm.api.httpClient })) }
                .build()
        }
        intent?.dataString?.let { vm.openConnectLink(it) }
        setContent {
            val dark = isDark(vm.prefs.theme, isSystemInDarkTheme())
            LaunchedEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(style, style)
            }
            FoxfleetTheme(vm.prefs) {
                CompositionLocalProvider(dev.foxfleet.app.media.LocalAvatarStore provides vm.avatars) { FoxfleetApp(vm) }
            }
        }
    }
}

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
private fun FoxfleetApp(vm: HubViewModel) {
    val c = LocalHubColors.current
    val reduce = reduceMotion()
    if (vm.hubSetup) {
        dev.foxfleet.app.ui.screens.HubAddressScreen(
            initial = vm.hubDraft, allowHttpInitial = vm.settings.allowHttp, api = vm.api,
            onConnect = { url, allowHttp -> vm.connectHub(url, allowHttp) },
            onScanned = { vm.openConnectLink(it) },
            onCancel = if (vm.addingHub && vm.settings.baseUrl.isNotBlank()) ({ vm.cancelAddHub() }) else null,
        )
        return
    }
    when (vm.authed) {
        null -> Box(Modifier.fillMaxSize().background(c.bg), contentAlignment = Alignment.Center) { dev.foxfleet.app.ui.components.BrandLogo(96.dp) }
        false -> LoginScreen(vm.hubName, vm.api, vm.bootError, inviteCode = vm.inviteDraft, onChangeHub = { vm.startAddHub() }, onLoggedIn = { vm.onLoggedIn() })
        true -> {
            // Predictive back: the current page shrinks and slides with the gesture, then pops.
            var backProgress by remember { mutableFloatStateOf(0f) }
            PredictiveBackHandler(enabled = vm.route != Route.Fleet) { progress ->
                try {
                    progress.collect { backProgress = it.progress }
                    vm.back()
                } catch (e: CancellationException) {
                    throw e
                } finally { backProgress = 0f }
            }
            AvatarFlow(vm)
            SharedTransitionLayout {
                AnimatedContent(
                    targetState = vm.route,
                    modifier = Modifier.background(c.bg),
                    transitionSpec = {
                        if (reduce) fadeIn(tween(0)) togetherWith fadeOut(tween(0))
                        else {
                            val fwd = targetState.depth() >= initialState.depth()
                            (slideInHorizontally(tween(320)) { w -> if (fwd) w / 4 else -w / 4 } + fadeIn(tween(260))) togetherWith
                                (slideOutHorizontally(tween(320)) { w -> if (fwd) -w / 6 else w / 4 } + fadeOut(tween(200)))
                        }
                    },
                    label = "nav",
                ) { route ->
                    CompositionLocalProvider(LocalSharedScope provides this@SharedTransitionLayout, LocalNavAnimScope provides this) {
                        val page = Modifier.graphicsLayer {
                            if (route != Route.Fleet && backProgress > 0f) {
                                val s = 1f - 0.08f * backProgress
                                scaleX = s; scaleY = s; translationX = size.width * 0.06f * backProgress
                            }
                        }
                        Box(page) { RouteContent(vm, route) }
                    }
                }
            }
        }
    }
}

@Composable
private fun RouteContent(vm: HubViewModel, route: Route) {
    LaunchedEffect(vm.authed, vm.pendingPair) { vm.consumePendingPair() }
    when (route) {
        Route.Fleet -> FleetScreen(
            agents = vm.agents, loading = vm.fleetLoading, loadedOnce = vm.fleetLoadedOnce, error = vm.fleetError,
            unread = { vm.chatFor(it).unread }, onRefresh = vm::refreshFleet,
            onOpen = { vm.navigate(Route.Chat(it.name)) }, onSettings = { vm.navigate(Route.Settings) },
            onAvatarLongPress = { vm.avatarTarget = it },
        )
        is Route.Chat -> {
            val agent = vm.agent(route.agent)
            if (agent == null) { LaunchedEffect(Unit) { vm.back() }; return }
            ChatScreen(
                agent = agent, agents = vm.agents, state = vm.chatFor(agent.name),
                sessions = vm.sessions[agent.name].orEmpty(), unread = { vm.chatFor(it).unread },
                onSend = { t, imgs -> vm.send(agent.name, t, imgs) }, onStop = { vm.stop(agent.name) },
                onBack = { vm.back() }, onNewChat = { vm.newChat(agent.name) },
                onSwitchAgent = { vm.navigate(Route.Chat(it.name)) },
                onOpenSession = { vm.openSession(agent.name, it) },
                onDrawerOpened = { if (vm.sessions[agent.name] == null) vm.loadSessions(agent.name) },
                sessionsTotal = vm.sessionTotals[agent.name] ?: vm.sessions[agent.name].orEmpty().size,
                sessionsLoading = vm.sessionsLoading[agent.name] == true, historyError = vm.historyError,
                onRefreshSessions = { vm.loadSessions(agent.name) }, onLoadMoreSessions = { vm.loadSessions(agent.name, more = true) },
                onRenameSession = { id, t -> vm.renameSession(agent.name, id, t) }, onDeleteSession = { vm.deleteSession(agent.name, it) },
                onLoadOlder = { vm.loadOlder(agent.name) },
                skills = vm.skills[agent.name].orEmpty(),
                onAvatarLongPress = { vm.avatarTarget = it },
                httpClient = vm.api.httpClient,
                // Features follow the agent's capabilities from the hub registry.
                allowImages = agent.capabilities.images,
                onUploadFile = if (agent.capabilities.files) ({ uri, progress -> vm.uploadFile(agent.name, uri, progress) }) else null,
                onOpenScreen = if (agent.capabilities.screen) ({ vm.navigate(Route.Screen(agent.name)) }) else null,
            )
            LaunchedEffect(agent.name) { if (agent.capabilities.skills) vm.loadSkills(agent.name) }
            if (agent.capabilities.mailbox) LaunchedEffect(agent.name) {
                while (true) { vm.pollInbox(agent.name); kotlinx.coroutines.delay(15_000) }
            }
        }
        is Route.Screen -> dev.foxfleet.app.ui.screens.ScreenScreen(
            agentName = route.agent, api = vm.api, onBack = { vm.back() },
            onLeaveInControl = { vm.handBackScreen(route.agent) },
        )
        Route.Settings -> SettingsScreen(
            prefs = vm.prefs, onChange = vm::updatePrefs,
            onSignOut = vm::signOut, onBack = { vm.back() }, onAgents = { vm.navigate(Route.Agents) },
            hubName = vm.hubName, username = vm.username, isOwner = vm.isOwner, onAdmin = { vm.navigate(Route.Admin) }, onHubs = { vm.navigate(Route.Hubs) }, onDevices = { vm.navigate(Route.Devices) },
        )
        Route.Hubs -> dev.foxfleet.app.ui.screens.HubsScreen(
            hubs = vm.settings.hubs, activeId = vm.settings.activeHubId, onBack = { vm.back() },
            onSwitch = vm::switchHub, onAdd = vm::startAddHub, onRemove = vm::removeHub,
        )
        Route.Admin -> dev.foxfleet.app.ui.screens.AdminScreen(api = vm.api, onBack = { vm.back() })
        is Route.Machines -> dev.foxfleet.app.ui.screens.MachinesScreen(api = vm.api, hub = vm.settings.baseUrl, initialCode = route.code, onBack = { vm.back() }, onChanged = { vm.loadRegistry(); vm.refreshFleet() })
        Route.Devices -> dev.foxfleet.app.ui.screens.DevicesScreen(api = vm.api, onBack = { vm.back() }, onSignedOut = vm::signOut)
        Route.Agents -> {
            LaunchedEffect(Unit) { vm.loadRegistry() }
            dev.foxfleet.app.ui.screens.AgentsScreen(
                agents = vm.savedAgents, error = vm.registryError, onBack = { vm.back() },
                onAdd = { vm.navigate(Route.AgentEditor(null)) }, onEdit = { vm.navigate(Route.AgentEditor(it)) },
                onMove = vm::moveAgent, onMachines = { vm.navigate(Route.Machines()) },
            )
        }
        is Route.AgentEditor -> {
            LaunchedEffect(Unit) { if (vm.agentKinds.isEmpty() || vm.savedAgents == null) vm.loadRegistry() }
            val existing = route.agent?.let { n -> vm.savedAgents?.firstOrNull { it.name == n } }
            if (route.agent != null && existing == null) {
                Box(Modifier.fillMaxSize().background(LocalHubColors.current.bg))
            } else dev.foxfleet.app.ui.screens.AgentEditorScreen(
                kinds = vm.agentKinds, existing = existing, onBack = { vm.back() },
                onTest = { _, fields -> vm.api.testAgent(fields) },
                onSave = { _, fields -> vm.saveAgent(route.agent, fields) },
                onDelete = { vm.deleteAgent(route.agent!!) },
                onDone = { vm.navigate(Route.Agents) },
                onNewToken = { existing?.let { vm.api.newInboxToken(it.name) } },
            )
        }
    }
}

/** Long-press avatar → sheet (change/reset) → photo picker → circle crop → saved locally. */
@Composable
private fun AvatarFlow(vm: HubViewModel) {
    val target = vm.avatarTarget ?: return
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var bitmap by remember(target) { androidx.compose.runtime.mutableStateOf<android.graphics.Bitmap?>(null) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val picker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri == null) { vm.avatarTarget = null; return@rememberLauncherForActivityResult }
        scope.launch {
            bitmap = runCatching {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { dev.foxfleet.app.media.AvatarStore.loadForCrop(ctx, uri) }
            }.getOrNull()
            if (bitmap == null) vm.avatarTarget = null
        }
    }
    val b = bitmap
    if (b != null) {
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { vm.avatarTarget = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            dev.foxfleet.app.ui.screens.AvatarCropScreen(target, b, onDone = { l, t, s ->
                vm.avatars.save(target, dev.foxfleet.app.media.AvatarStore.cropSquare(b, l, t, s)); vm.avatarTarget = null
            }, onCancel = { vm.avatarTarget = null })
        }
        return
    }
    val c = LocalHubColors.current
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { vm.avatarTarget = null },
        containerColor = c.surface,
        title = { androidx.compose.material3.Text("$target's photo") },
        text = { androidx.compose.material3.Text("Pick a photo from your library. It stays on this phone.") },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = {
                picker.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly))
            }) { androidx.compose.material3.Text("Choose photo", color = c.accent) }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = { vm.avatars.reset(target); vm.avatarTarget = null }) {
                androidx.compose.material3.Text("Reset", color = c.textMuted)
            }
        },
    )
}
