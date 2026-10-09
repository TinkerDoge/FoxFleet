package dev.foxfleet.app.ui

import dev.foxfleet.app.data.AgentKind
import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.KindField
import dev.foxfleet.app.data.Registry
import dev.foxfleet.app.data.containsAddress
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.screens.fleetSubtitle
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V05LogicTest {
    // Shape of hub 0.5 GET /api/agents (see server/test/v05.test.js).
    private val agentsJson = """{"agents":[
      {"id":"Atlas","name":"Atlas","displayName":"Atlas","kind":"hermes","order":0,"description":"Studio lead","avatar":null,"status":"ready","online":true,"chatReady":true,"managementReady":true,
       "capabilities":{"chat":true,"images":true,"files":true,"screen":true,"voice":true,"skills":true,"sessions":true,"mailbox":false},"activeSessions":2,"checks":{"api":{"ok":true,"message":"Chat API authenticated"}}},
      {"id":"GLM","name":"GLM","displayName":"GLM 5.3","kind":"openai","order":1,"description":"","status":"ready","online":true,"chatReady":true,"managementReady":false,
       "capabilities":{"chat":true,"images":true,"files":false,"screen":false,"voice":false,"skills":false,"sessions":false,"mailbox":false},"checks":{}},
      {"id":"Scribe","name":"Scribe","displayName":"Scribe","kind":"mcp-inbox","order":2,"description":"","status":"ready","online":false,"chatReady":true,"managementReady":false,"lastSeen":null,
       "capabilities":{"chat":true,"images":false,"files":false,"screen":false,"voice":false,"skills":false,"sessions":true,"mailbox":true},"checks":{}}]}"""

    @Test fun parsesPrivacySafeAgentList() {
        val agents = HubApi.parseAgents(agentsJson)
        assertEquals(listOf("Atlas", "GLM", "Scribe"), agents.map { it.name })
        assertEquals("GLM 5.3", agents[1].displayName); assertNull(agents[0].label)
        assertTrue(agents[0].capabilities.screen && agents[0].capabilities.files)
        assertFalse(agents[1].capabilities.files || agents[1].capabilities.screen || agents[1].capabilities.skills)
        assertTrue(agents[2].capabilities.mailbox)
        assertEquals("Studio lead · 2 active", fleetSubtitle(agents[0]))
        for (a in agents) assertFalse(a.toString(), containsAddress(a.toString()))
    }

    @Test fun oldHubsWithoutCapabilitiesFallBackByKind() {
        val a = HubApi.parseAgent(Json.parseToJsonElement("""{"name":"Old","host":"192.0.2.10","profile":"x","online":true,"chatReady":true,"managementReady":true,"kind":"openai"}""").jsonObject)
        assertEquals(Capabilities.forKind("openai"), a.capabilities)
        assertFalse("host must not be kept", a.toString().contains("10.77"))
    }

    @Test fun scrubsAddressesFromAnythingShown() {
        assertEquals("Failed to connect to [hidden]", scrubAddresses("Failed to connect to /192.0.2.10:3080"))
        assertEquals("Can't reach [hidden] now", scrubAddresses("Can't reach https://agents.example.com/api now"))
        assertEquals("on [hidden] and [hidden]", scrubAddresses("on box-01 and orion.lan"))
        assertEquals("[hidden] refused", scrubAddresses("studio-pc:9119 refused"))
        assertEquals("Chat API authenticated", scrubAddresses("Chat API authenticated"))
        assertEquals("Revenue up 12.5% at 10:30", scrubAddresses("Revenue up 12.5% at 10:30"))
    }

    private val hermes = AgentKind("hermes", "Hermes agent", "", false, listOf(
        KindField("name", "ID", "id", required = true),
        KindField("description", "Description", "multiline"),
        KindField("host", "Host or IP", "host", required = true, writeOnly = true),
        KindField("dashboardPort", "Dashboard port", "port", writeOnly = true, default = "9119"),
        KindField("dashboardPass", "Dashboard password", "secret", writeOnly = true),
    ))

    @Test fun formPayloadKeepsSavedWriteOnlyFieldsOnEdit() {
        val add = Registry.payload(hermes, mapOf("name" to "Desk", "host" to "10.0.0.5", "dashboardPort" to "9119", "dashboardPass" to "pw"), editing = false)
        assertEquals(mapOf("kind" to "hermes", "name" to "Desk", "host" to "10.0.0.5", "dashboardPort" to 9119, "dashboardPass" to "pw"), add)
        val edit = Registry.payload(hermes, mapOf("name" to "Desk", "description" to "", "host" to "", "dashboardPass" to ""), editing = true)
        assertEquals(mapOf<String, Any>("description" to ""), edit)
    }

    @Test fun formValidation() {
        assertEquals("ID: letters, digits, . _ - (up to 64)", Registry.validate(hermes, mapOf("name" to "../x", "host" to "h"), editing = false))
        assertEquals("Host or IP is required", Registry.validate(hermes, mapOf("name" to "Desk"), editing = false))
        assertEquals("Dashboard port must be 1–65535", Registry.validate(hermes, mapOf("name" to "Desk", "host" to "h", "dashboardPort" to "70000"), editing = false))
        val saved = HubApi.parseSaved(Json.parseToJsonElement("""{"name":"Desk","kind":"hermes","profile":"default","hasHost":true,"hasDashboardPass":false}""").jsonObject)
        assertTrue(saved.hasSaved("host")); assertFalse(saved.hasSaved("dashboardPass"))
        assertNull(Registry.validate(hermes, mapOf("name" to "Desk"), editing = true, existing = saved))
    }

    @Test fun reorderMovesOneStep() {
        assertEquals(listOf("b", "a", "c"), Registry.moved(listOf("a", "b", "c"), 1, -1))
        assertEquals(listOf("a", "b", "c"), Registry.moved(listOf("a", "b", "c"), 0, -1))
        assertEquals(listOf("a", "c", "b"), Registry.moved(listOf("a", "b", "c"), 1, 1))
    }

    @Test fun nonHermesAgentsOnlyGetLocalCommands() {
        assertTrue(commandSuggestions("/", emptyList(), limit = 500, agentCommands = true).any { it.label == "/usage" })
        assertEquals(listOf("/new", "/sessions", "/stop"), commandSuggestions("/", emptyList(), agentCommands = false).map { it.label })
    }

    @Test fun testResultsAreScrubbed() {
        val r = HubApi.parseTest(Json.parseToJsonElement("""{"ok":false,"checks":{"api":{"ok":false,"message":"refused by 192.168.1.4:8642"}}}""").jsonObject)
        assertFalse(r.ok); assertEquals("refused by [hidden]", r.checks.single().second.message)
    }
}
