package dev.foxfleet.app.ui

import dev.foxfleet.app.data.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class V1bLogicTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test fun pairingLinkCarriesHubAndOptionalInvite() {
        assertEquals(ConnectLink("https://hub.example.com", null), HubAddress.parseLink("foxfleet://connect?hub=https://hub.example.com"))
        assertEquals(ConnectLink("https://hub.example.com", "Xk2mQ9vTzR4nB7wLpA3"), HubAddress.parseLink("foxfleet://connect?hub=https%3A%2F%2Fhub.example.com&invite=Xk2mQ9vTzR4nB7wLpA3"))
        assertNull("junk invites are dropped", HubAddress.parseLink("foxfleet://connect?hub=https://h.example.com&invite=<script>")!!.invite)
        assertNull(HubAddress.parseLink("foxfleet://other?hub=https://h.example.com"))
        assertNull(HubAddress.parseLink("https://hub.example.com"))
        assertNull(HubAddress.parseLink("foxfleet://connect?invite=abcdefghij"))
    }

    @Test fun scannedHubStillGoesThroughAddressValidation() {
        val hub = HubAddress.parseLink("foxfleet://connect?hub=http://hub.example.com")!!.hub
        assertNotNull("plain http to a public host is refused even from a QR", HubAddress.normalize(hub, true).second)
    }

    @Test fun parsesAdminPayloads() {
        val users = HubApi.parseAdminUsers(obj("""{"users":[{"id":"1","username":"owner1","role":"owner","disabled":false},{"id":"2","username":"alice","role":"user","disabled":true}]}"""))
        assertEquals(listOf("owner1", "alice"), users.map { it.username }); assertTrue(users[1].disabled); assertFalse(users[0].disabled)
        val invites = HubApi.parseInvites(obj("""{"invites":[{"id":"a","created":1,"expires":1900000000000,"used":false}]}"""))
        assertEquals(Invite("a", 1900000000000, false), invites[0])
        val s = HubApi.parseShareable(obj("""{"id":"i1","code":"c","expires":5,"link":"foxfleet://connect?hub=https://h.example.com&invite=c","rows":["101","010","101"]}"""))
        assertEquals(3, s.rows!!.size); assertEquals("i1", s.invite!!.id); assertTrue(s.link.startsWith("foxfleet://"))
        assertNull(HubApi.parseShareable(obj("""{"link":"x","rows":null}""")).rows)
    }

    @Test fun ownerFlagFromAuthInfo() {
        assertTrue(HubApi.parseAuthInfo(obj("""{"required":true,"authenticated":true,"user":{"username":"d","role":"owner"}}""")).isOwner)
        assertFalse(HubApi.parseAuthInfo(obj("""{"required":true,"authenticated":true,"user":{"username":"a","role":"user"}}""")).isOwner)
        assertFalse(HubApi.parseAuthInfo(obj("""{"required":true,"authenticated":false}""")).isOwner)
    }
}
