package dev.foxfleet.app.fix041

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.ThemeMode
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.local.CapsCodec
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.screens.ChatScreen
import dev.foxfleet.app.ui.screens.NativeControls
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** 0.4.1 bug 2: /model opens the picker for every agent the hub has a model list for (not only native-gateway ones). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ModelPickerRegressionTest {
    @get:Rule val compose = createComposeRule()
    private fun agent(caps: Capabilities) = AgentStatus("atlas", online = true, chatReady = true, managementReady = true, kind = "hermes", label = "Atlas", capabilities = caps)
    private val controls = NativeControls(models = { listOf(HubApi.ModelProvider("openrouter", "OpenRouter", listOf("m1", "m2"), true)) }, setModel = { m, _ -> m }, busy = { "" }, setBusy = {})

    private fun typeModel(caps: Capabilities, controls: NativeControls?): MutableList<String> {
        val sent = mutableListOf<String>()
        val a = agent(caps); val state = ChatState().apply { load(listOf(UiMessage("user", "hi", hubId = "h.1", n = 1)), "s1") }
        compose.setContent { FoxfleetTheme(AppPrefs(theme = ThemeMode.Light)) { Box(Modifier.fillMaxSize()) {
            ChatScreen(a, listOf(a), state, emptyList(), { false }, { t, _ -> sent += t }, {}, {}, {}, {}, {}, {}, nativeControls = controls, initialInput = "/model")
        } } }
        compose.onNodeWithContentDescription("Send").performClick(); compose.waitForIdle()
        return sent
    }

    @Test fun requestModeAgentOpensThePicker() {
        val sent = typeModel(Capabilities(sessions = true, models = "request"), controls)
        assertTrue("not sent to the agent as text", sent.isEmpty())
        compose.onNodeWithText("Choose a provider").assertExists()
        compose.onNodeWithText("OpenRouter · 2").assertExists()
    }

    @Test fun nativeAgentOnAnOlderHubStillOpensThePicker() {
        assertTrue(typeModel(Capabilities(sessions = true, nativeUi = true), controls).isEmpty())
        compose.onNodeWithText("Choose a provider").assertExists()
    }

    /** A bot agent has no picker list: /model must reach the agent, whose own Hermes handler answers it. */
    @Test fun noModelListSendsTheCommandToTheAgent() {
        assertEquals(listOf("/model"), typeModel(Capabilities(sessions = true, models = "none", bot = true), null))
    }

    @Test fun olderHubWithoutTheFieldKeepsTheOldBehaviour() {
        assertEquals(listOf("/model"), typeModel(Capabilities(sessions = true), null))
    }

    @Test fun modelsModeFromTheHubAndTheCache() {
        assertEquals("request", Capabilities(models = "request").modelsMode)
        assertEquals("native", Capabilities(nativeUi = true).modelsMode)
        assertEquals("none", Capabilities().modelsMode)
        assertEquals("none", Capabilities(nativeUi = true, models = "none").modelsMode)
        assertEquals("native", Capabilities(nativeUi = true, models = "weird").modelsMode)
        for (c in listOf(Capabilities(models = "request", busy = listOf("queue", "interrupt")), Capabilities(nativeUi = true), Capabilities(models = "none", bot = true)))
            assertEquals(c, CapsCodec.decode(CapsCodec.encode(c)))
        assertEquals(Capabilities(images = true, busy = listOf("queue")), CapsCodec.decode("chat,images;busy=queue")) // a row from 0.4.0
    }

    /** The agents list of a 0.4.1 hub: `capabilities.models` is read; an unknown value is ignored. */
    @Test fun agentsParseTheModelsCapability() = runBlocking {
        val body = """{"agents":[{"name":"atlas","kind":"hermes","online":true,"capabilities":{"chat":true,"nativeUi":false,"models":"request","busy":["queue"]}},{"name":"bolt","kind":"hermes","capabilities":{"chat":true,"models":"later"}}]}"""
        val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        Thread { while (!sock.isClosed) { val c = try { sock.accept() } catch (_: Exception) { break }; c.getInputStream().bufferedReader().let { r -> r.readLine(); while (r.readLine().orEmpty().isNotEmpty()) { } }
            c.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body".toByteArray()); flush() }; c.close() } }.also { it.isDaemon = true }.start()
        try {
            val store = SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()); store.allowHttp = true; store.baseUrl = "http://127.0.0.1:${sock.localPort}"
            val agents = HubApi(store).agents()
            assertEquals("request", agents[0].capabilities.modelsMode); assertEquals(null, agents[1].capabilities.models)
        } finally { sock.close() }
    }
}
