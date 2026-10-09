package dev.foxfleet.app.ui

import dev.foxfleet.app.data.*
import dev.foxfleet.app.ui.screens.AuthMode
import dev.foxfleet.app.ui.screens.authModeFor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class V1LogicTest {
    private fun ok(input: String, allowHttp: Boolean = false) = HubAddress.normalize(input, allowHttp).also { assertNull(input, it.second) }.first

    @Test fun addressDefaultsToHttpsAndTrims() {
        assertEquals("https://hub.example.com", ok("  hub.example.com/ "))
        assertEquals("https://hub.example.com", ok("https://HUB.example.com"))
        assertEquals("https://hub.example.com:8443", ok("https://hub.example.com:8443"))
    }

    @Test fun addressRejectsJunk() {
        for (bad in listOf("", "has space.com", "https://user:pw@hub.example.com", "https://hub.example.com/path", "https://hub.example.com?x=1", "ftp://hub.example.com", "://")) {
            val (url, err) = HubAddress.normalize(bad, true); assertNull(bad, url); assertNotNull(bad, err)
        }
    }

    @Test fun httpOnlyOnLocalNetworkAfterOptIn() {
        assertNotNull(HubAddress.normalize("http://hub.example.com", true).second)
        assertNotNull(HubAddress.normalize("http://192.168.1.20:3080", false).second)
        assertEquals("http://192.168.1.20:3080", ok("http://192.168.1.20:3080", true))
        assertEquals("http://10.0.0.5", ok("http://10.0.0.5", true))
        assertEquals("http://localhost:3080", ok("http://localhost:3080", true))
        assertEquals("http://nas.local", ok("http://nas.local", true))
        assertNotNull(HubAddress.normalize("http://8.8.8.8", true).second)
        assertNotNull(HubAddress.normalize("http://172.32.0.1", true).second)
    }

    @Test fun connectLinks() {
        assertEquals("https://hub.example.com", HubAddress.fromLink("foxfleet://connect?hub=https%3A%2F%2Fhub.example.com"))
        assertEquals("https://hub.example.com", HubAddress.fromLink("foxfleet://connect?name=Home&hub=https://hub.example.com"))
        assertNull(HubAddress.fromLink("foxfleet://connect"))
        assertNull(HubAddress.fromLink("https://evil.example/connect?hub=https://x"))
        assertEquals("hub.example.com", HubAddress.nameFor("https://hub.example.com:8443"))
    }

    @Test fun noBakedInAddress() {
        // The placeholder is an example domain, never a real deployment.
        assertTrue(HubAddress.PLACEHOLDER.contains("example.com"))
        assertFalse(HubAddress.PLACEHOLDER.contains("foxfleet"))
    }

    @Test fun authModeFollowsHub() {
        assertEquals(AuthMode.SignIn, authModeFor(null, false))
        assertEquals(AuthMode.Setup, authModeFor(AuthInfo(setupRequired = true), false))
        assertEquals(AuthMode.Setup, authModeFor(AuthInfo(setupRequired = true, registration = "open"), true))
        assertEquals(AuthMode.SignIn, authModeFor(AuthInfo(registration = "closed"), true))
        assertEquals(AuthMode.Register, authModeFor(AuthInfo(registration = "invite"), true))
        assertEquals(AuthMode.SignIn, authModeFor(AuthInfo(registration = "open"), false))
    }

    @Test fun parsesAuthInfoAndDevices() {
        val info = HubApi.parseAuthInfo(Json.parseToJsonElement("""{"required":true,"setupRequired":false,"setupCodeRequired":false,"registration":"invite","authenticated":true,"user":{"username":"owner1","role":"owner"}}""").jsonObject)
        assertEquals(AuthInfo(true, true, false, false, "invite", "owner1", "owner"), info)
        val devices = HubApi.parseDevices(Json.parseToJsonElement("""{"devices":[{"id":"a1","name":"Pixel","kind":"app","lastSeen":1700000000000,"current":true},{"id":"b2","name":"Web browser","kind":"web","created":1,"lastSeen":5,"current":false}]}""").jsonObject)
        assertEquals(listOf("Pixel", "Web browser"), devices.map { it.name }); assertTrue(devices[0].current); assertFalse(devices[1].current)
    }

    private val kinds = HubApi.parseKinds(Json.parseToJsonElement("""{"kinds":[
      {"kind":"hermes","label":"Hermes agent","summary":"s","auth":["none"],"fields":[
        {"key":"name","label":"ID","type":"id","required":true,"writeOnly":false},
        {"key":"connection","label":"Connection","type":"enum","required":false,"writeOnly":false,"default":"connector","options":["connector","direct"]},
        {"key":"host","label":"Host","type":"host","required":true,"writeOnly":true,"advanced":true,"when":{"connection":"direct"}},
        {"key":"dashboardPass","label":"Dashboard password","type":"secret","required":false,"writeOnly":true}]},
      {"kind":"zai","label":"Z.ai (GLM)","summary":"s","auth":["api_key"],"warnings":["Coding Plan is restricted"],"fields":[
        {"key":"name","label":"ID","type":"id","required":true,"writeOnly":false},
        {"key":"endpoint","label":"Endpoint","type":"enum","required":false,"writeOnly":false,"default":"general","options":["general","coding"]},
        {"key":"apiKey","label":"API key","type":"secret","required":true,"writeOnly":true}]}]}""").jsonObject)

    @Test fun parsesPluginSchemaExtras() {
        val hermes = kinds[0]; val host = hermes.fields[2]
        assertEquals(listOf("connector", "direct"), hermes.fields[1].options); assertTrue(hermes.fields[1].isEnum)
        assertEquals("connection", host.whenKey); assertEquals("direct", host.whenValue)
        assertEquals(listOf("api_key"), kinds[1].auth); assertEquals(1, kinds[1].warnings.size)
    }

    @Test fun connectorHermesNeedsNoHost() {
        val hermes = kinds[0]
        val form = mapOf("name" to "Remote")
        assertNull(Registry.validate(hermes, form, editing = false))
        val sent = Registry.payload(hermes, form, editing = false)
        assertEquals("connector", sent["connection"]); assertFalse(sent.containsKey("host"))
        val direct = mapOf("name" to "Box", "connection" to "direct")
        assertEquals("Host is required", Registry.validate(hermes, direct, editing = false))
        assertNull(Registry.validate(hermes, direct + ("host" to "10.0.0.5"), editing = false))
        assertEquals("10.0.0.5", Registry.payload(hermes, direct + ("host" to "10.0.0.5"), editing = false)["host"])
    }

    @Test fun apiKeyPluginRequiresKeyAndDefaultsEndpoint() {
        val zai = kinds[1]
        assertEquals("API key is required", Registry.validate(zai, mapOf("name" to "GLM"), editing = false))
        val sent = Registry.payload(zai, mapOf("name" to "GLM", "apiKey" to "k"), editing = false)
        assertEquals("general", sent["endpoint"]); assertEquals("zai", sent["kind"])
    }

    @Test fun errorsNeverShowAddresses() {
        assertEquals("[hidden]", scrubAddresses("https://hub.example.com/api"))
    }
}
