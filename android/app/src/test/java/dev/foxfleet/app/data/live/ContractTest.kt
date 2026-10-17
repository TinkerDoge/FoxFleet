package dev.foxfleet.app.data.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContractTest {
    @Test fun messageNewParsesAndIgnoresUnknownFields() {
        val o = Contract.obj("""{"seq":7,"type":"message.new","at":1,"agent":"nova","chat":"c","future":1,
            "message":{"hub_id":"h1","upstream_id":"u1","n":3,"role":"user","text":"hi","at":5,"source":"app","status":"delivered","images":[{"url":"https://x","mime":"image/png"}],"new_field":{}}}""")!!
        val e = Contract.event(o) as V2Event.MessageNew
        assertEquals(7, e.seq); assertEquals("h1", e.message.hubId); assertEquals(3, e.message.n); assertEquals(listOf("https://x"), e.message.images)
        val ui = e.message.toUi(); assertEquals("h1", ui.hubId); assertEquals("u1", ui.id); assertEquals("delivered", ui.status)
    }

    @Test fun unknownTypeOrBrokenKnownTypeIsUnknownNotDropped() {
        assertTrue(Contract.event(Contract.obj("""{"seq":1,"type":"poll.created","agent":"a"}""")!!) is V2Event.Unknown)
        assertTrue(Contract.event(Contract.obj("""{"seq":2,"type":"message.new","agent":"a","chat":"c","message":{"role":"user"}}""")!!) is V2Event.Unknown)
        assertNull(Contract.event(Contract.obj("""{"type":"message.new"}""")!!))
    }

    @Test fun chatRowAndSnapshot() {
        val snap = Contract.snapshot(Contract.obj("""{"chats":[{"agent":"nova","label":"Nova","unread_count":3,"archived":false,"muted":{"until":null},"pinned":true,"pin_order":0,
            "working":false,"needs_input":false,"updated_at":9,"last_message":{"hub_id":"h","role":"assistant","sender":"Nova","preview":"Done","at":8,"status":null}},
            {"agent":"bolt","label":"Bolt","unread_count":0,"archived":true,"muted":null,"pinned":false,"working":true,"needs_input":false,"updated_at":1,"manual_unread":true}],
            "cursor":"s:5","total_unread":0,"total_unread_all":3}""")!!)
        assertEquals("s:5", snap.cursor); assertEquals(2, snap.chats.size)
        val nova = snap.chats[0]; assertTrue(nova.muted); assertNull(nova.mutedUntil); assertTrue(nova.mutedAt(Long.MAX_VALUE)); assertEquals("Done", nova.last!!.preview)
        val bolt = snap.chats[1]; assertTrue(bolt.archived); assertEquals(1, bolt.badge)
    }

    @Test fun typingClampsTtlAndTool() {
        val t = Contract.typing(Contract.obj("""{"agent":"a","chat":"c","state":"tool","tool":"${"x".repeat(200)}","ttl_ms":999999}""")!!)!!
        assertEquals(60_000, t.ttlMs); assertEquals(80, t.tool!!.length)
    }

    @Test fun featuresByNameNeverVersion() {
        val f = HubFeatures.of(listOf("live", "chats", "notifyReply"))
        assertTrue(f.live && f.chats && f.notifyReply); assertTrue(!f.live2 && !f.readReceipts)
        assertEquals(HubFeatures.NONE, HubFeatures.of(listOf("0.4.0")))
    }
}
