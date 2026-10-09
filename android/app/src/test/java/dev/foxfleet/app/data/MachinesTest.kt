package dev.foxfleet.app.data

import dev.foxfleet.app.ui.screens.pairingStatusText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MachinesTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test fun parsesMachinesWithoutAnyAddress() {
        val list = HubApi.parseMachines(obj("""{"machines":[{"id":"${"a".repeat(32)}","name":"Desk","online":true,"lastSeen":5,"paired":true,"profiles":[{"profile":"default","agent":"default"},{"profile":"coder","agent":"coder-2"}]}]}"""))
        assertEquals(listOf("default", "coder-2"), list.single().profiles); assertEquals("Desk", list.single().name); assertEquals(true, list.single().online)
    }
    @Test fun parsesPairingAndStates() {
        val p = HubApi.parsePairing(obj("""{"code":"ABCDEFGHJK","display":"ABCDE-FGHJK","expires":9,"url":"https://h/c/ABCDEFGHJK","link":"foxfleet://pair?hub=x&code=ABCDEFGHJK","rows":["101"],"commands":{"sh":"curl -fsSL https://h/c/ABCDEFGHJK | sh","powershell":"irm","node":"n"}}"""))
        assertEquals("ABCDE-FGHJK", p.display); assertEquals("curl -fsSL https://h/c/ABCDEFGHJK | sh", p.sh); assertEquals(listOf("101"), p.rows)
        assertEquals(PairingState.Waiting, HubApi.parsePairingState(obj("""{"state":"waiting"}""")))
        assertEquals(PairingState.Expired, HubApi.parsePairingState(obj("""{"state":"expired"}""")))
        assertEquals(PairingState.Paired(null), HubApi.parsePairingState(obj("""{"state":"paired"}""")))
    }
    @Test fun statusLineMatchesTheWeb() {
        assertEquals("Waiting for the machine…", pairingStatusText(PairingState.Waiting))
        assertEquals("Machine connected. Looking for profiles…", pairingStatusText(PairingState.Paired(Machine("m", "M", true, null, emptyList()))))
        assertEquals("Found 3 profiles: default, coder, research", pairingStatusText(PairingState.Paired(Machine("m", "M", true, null, listOf("default", "coder", "research")))))
        assertEquals("Found 1 profile: default", pairingStatusText(PairingState.Paired(Machine("m", "M", true, null, listOf("default")))))
    }
    @Test fun pairLink() {
        val l = HubAddress.parsePairLink("foxfleet://pair?hub=https%3A%2F%2Fhub.example.com&code=abcde-fghjk")!!
        assertEquals("https://hub.example.com", l.hub); assertEquals("ABCDEFGHJK", l.code)
        assertNull(HubAddress.parsePairLink("foxfleet://pair?hub=https%3A%2F%2Fh&code=short")); assertNull(HubAddress.parsePairLink("foxfleet://connect?hub=https%3A%2F%2Fh"))
    }
}
