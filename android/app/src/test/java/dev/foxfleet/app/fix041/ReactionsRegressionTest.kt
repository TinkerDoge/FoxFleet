package dev.foxfleet.app.fix041

import androidx.test.core.app.ApplicationProvider
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.ReactionSnapshot
import dev.foxfleet.app.data.SettingsStore
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.data.live.Contract
import dev.foxfleet.app.data.live.HubFeatures
import dev.foxfleet.app.data.live.LiveEffect
import dev.foxfleet.app.data.live.LiveReducer
import dev.foxfleet.app.data.live.V2Event
import dev.foxfleet.app.data.local.CacheDb
import dev.foxfleet.app.data.local.ChatCache
import dev.foxfleet.app.ui.chat.ChatState
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.MessageMerge
import dev.foxfleet.app.ui.chat.apply
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Collections

/** 0.4.1 reactions: one test per root cause found in the audit (see the release's REACTIONS-HUB-NEEDS.md), against the contract in SHAPES.md. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReactionsRegressionTest {
    /** A tiny hub: answers by request line, records method + path + body (unlike HistoryTest.Json it reads the body). */
    class Hub(val answer: (method: String, path: String, body: String) -> Pair<Int, String>) : AutoCloseable {
        val seen: MutableList<String> = Collections.synchronizedList(mutableListOf())
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
        val port get() = sock.localPort
        init {
            Thread {
                while (!sock.isClosed) {
                    val c = try { sock.accept() } catch (_: Exception) { break }
                    val input = java.io.BufferedInputStream(c.getInputStream())
                    fun line(): String { val b = java.io.ByteArrayOutputStream(); while (true) { val x = input.read(); if (x < 0 || x == '\n'.code) break; if (x != '\r'.code) b.write(x) }; return b.toString("UTF-8") }
                    val first = line(); var len = 0
                    while (true) { val h = line(); if (h.isEmpty()) break; if (h.lowercase().startsWith("content-length:")) len = h.substringAfter(':').trim().toInt() }
                    val bytes = ByteArray(len); var got = 0; while (got < len) { val k = input.read(bytes, got, len - got); if (k < 0) break; got += k }
                    val line = first; val buf = String(bytes, 0, got, Charsets.UTF_8)
                    val (method, path) = line.split(' ').let { it[0] to it.getOrElse(1) { "" } }
                    val body = buf; seen += "$method $path $body"
                    val (code, out) = answer(method, path, body)
                    c.getOutputStream().apply { write(("HTTP/1.1 $code X\r\nContent-Type: application/json\r\nContent-Length: ${out.toByteArray().size}\r\nConnection: close\r\n\r\n$out").toByteArray()); flush() }; c.close()
                }
            }.also { it.isDaemon = true }.start()
        }
        override fun close() { sock.close() }
    }
    private fun api(port: Int) = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:$port" })
    private val me = ReactionActor("user:minh", "minh", "human"); private val atlas = ReactionActor("agent:atlas", "Atlas", "agent")
    private val meJson = """{"id":"user:minh","name":"minh","kind":"human"}"""; private val atlasJson = """{"id":"agent:atlas","name":"Atlas","kind":"agent"}"""

    // Root cause 1 (ChatState.reconcile, 0.3.x-0.4.0): a live turn got its provider ids only when the stored text matched the streamed
    // text exactly. A reply whose stored copy joins its steps with a blank line never got one, so it showed no chips and no quick row.
    @Test fun liveTurnGetsItsIdsByHubIdEvenWhenTheStoredTextDiffers() = runBlocking {
        val page = """{"messages":[{"role":"user","content":"draft it","id":"100","hub_id":"h.3","n":3},{"role":"assistant","content":"Let me write it.\n\nDone.","id":"101","hub_id":"h.4","n":4}],"has_more":false}"""
        Hub { _, _, _ -> 200 to page }.use { hub ->
            val s = ChatState().apply { load(listOf(UiMessage("user", "draft it", hubId = "h.3", n = 3), UiMessage("assistant", "Let me write it.Done.", hubId = "h.4", n = 4)), "s1") }
            s.reconcile(api(hub.port), "atlas")
            assertEquals(listOf("100", "101"), s.messages.map { it.id })
            assertEquals("Let me write it.Done.", s.messages[1].content) // only the ids move, the shown copy stays
        }
    }

    @Test fun bindIdsTouchesOnlyMessagesWithoutIds_andNeedsIdsLooksAtTheNewest() {
        val shown = listOf(UiMessage("user", "a", id = "1", hubId = "h.1"), UiMessage("assistant", "b", hubId = "h.2"), UiMessage("user", "local only"))
        val page = listOf(UiMessage("user", "a", id = "X", hubId = "h.1"), UiMessage("assistant", "b!", id = "2", hubId = "h.2"))
        val out = MessageMerge.bindIds(shown, page)
        assertEquals(listOf("1", "2", null), out.map { it.id })
        assertTrue(MessageMerge.needsIds(shown)); assertFalse(MessageMerge.needsIds(listOf(UiMessage("user", "a", id = "1"))))
        assertTrue(MessageMerge.bindIds(out, page) === out)
    }

    // Root cause 2 (ChatScreen canReact / heart, ChatState.react): a message with no provider id could not be reacted to at all.
    // Hubs with `reactionEvents` take its hub id; the toggle sends PUT or DELETE (never a blind toggle).
    @Test fun aLiveMessageIsReactedToByItsHubId_putThenDelete() = runBlocking {
        Hub { m, p, b ->
            if (!p.contains("/reactions")) return@Hub 404 to "{}"
            val on = m == "PUT"
            200 to """{"actor":$meJson,"messages":{},"by_hub_id":{"h.4":${if (on) """[{"emoji":"👍","actors":[$meJson]}]""" else "[]"}},"hidden":[],"changed":true}"""
        }.use { hub ->
            val s = ChatState().apply { load(listOf(UiMessage("assistant", "Done.", hubId = "h.4", n = 4)), "s1"); simulateReactions(ReactionSnapshot(me, emptyMap(), emptySet(), emptyMap())); hubIdReactions = true }
            val m = s.messages.single(); assertTrue(MessageActions.canReact(m))
            s.toggleReaction(api(hub.port), "atlas", m, "👍")
            assertEquals(listOf("👍"), s.reactions!!.groupsFor(m).map { it.emoji })
            s.toggleReaction(api(hub.port), "atlas", m, "👍")
            assertEquals(emptyList<ReactionGroup>(), s.reactions!!.groupsFor(m))
            val calls = hub.seen.filter { it.contains("/reactions") }
            assertTrue(calls[0], calls[0].startsWith("PUT ") && calls[0].contains("\"message_id\":\"h.4\"") && calls[0].contains("👍"))
            assertTrue(calls[1], calls[1].startsWith("DELETE ") && calls[1].contains("\"message_id\":\"h.4\""))
        }
    }

    // Errors (SHAPES.md codes): the optimistic chip goes away again and the reason is short.
    @Test fun refusedReactionRollsBackWithItsReason() = runBlocking {
        Hub { m, p, _ -> if (m == "PUT") 409 to """{"error":"Reaction limit reached","code":"reaction_limit"}""" else 200 to """{"actor":$meJson,"messages":{"7":[{"emoji":"🎉","actors":[$atlasJson]}]},"by_hub_id":{"h.7":[{"emoji":"🎉","actors":[$atlasJson]}]},"hidden":[]}""" }.use { hub ->
            val before = ReactionSnapshot(me, mapOf("7" to listOf(ReactionGroup("🎉", listOf(atlas)))), emptySet(), mapOf("h.7" to listOf(ReactionGroup("🎉", listOf(atlas)))))
            val s = ChatState().apply { load(listOf(UiMessage("assistant", "x", id = "7", hubId = "h.7")), "s1"); simulateReactions(before); hubIdReactions = true }
            s.toggleReaction(api(hub.port), "atlas", s.messages.single(), "🔥")
            assertEquals(listOf("🎉"), s.reactions!!.groupsFor(s.messages.single()).map { it.emoji })
            assertEquals("This message has too many reactions.", s.reactionError)
        }
        assertEquals("That emoji can't be used as a reaction.", HubApi.reactionErrorText(dev.foxfleet.app.data.HubApiException(400, "x", code = "invalid_emoji")))
        assertEquals("That message can't take reactions yet.", HubApi.reactionErrorText(dev.foxfleet.app.data.HubApiException(404, "x", code = "message_not_found")))
    }

    // Older hubs (no `reactionEvents`): the provider id is learned first (one history read), then the reaction goes by it.
    @Test fun olderHubResolvesTheProviderIdBeforeReacting() = runBlocking {
        Hub { m, p, _ -> when {
            p.contains("/messages") -> 200 to """{"messages":[{"role":"assistant","content":"Done.\n\nok","id":"101","hub_id":"h.4","n":4}],"has_more":false}"""
            else -> 200 to """{"actor":$meJson,"messages":{"101":[{"emoji":"❤️","actors":[$meJson]}]},"hidden":[]}"""
        } }.use { hub ->
            val s = ChatState().apply { load(listOf(UiMessage("assistant", "Done.ok", hubId = "h.4", n = 4)), "s1"); simulateReactions(ReactionSnapshot(me, emptyMap(), emptySet())) }
            s.toggleReaction(api(hub.port), "atlas", s.messages.single(), "❤️")
            assertEquals("101", s.messages.single().id)
            val put = hub.seen.first { it.startsWith("PUT ") }
            assertTrue(put, put.contains("\"message_id\":\"101\""))
            assertEquals(listOf("❤️"), s.reactions!!.groupsFor(s.messages.single()).map { it.emoji })
        }
    }

    // Root cause 3 (no live event): `message.reaction` carries the FULL set and replaces it; [] clears; a broken event is not "none".
    @Test fun messageReactionEventReplacesTheSet() {
        fun ev(s: String) = Contract.event(Json.parseToJsonElement(s).jsonObject)
        val e = ev("""{"seq":9,"type":"message.reaction","agent":"atlas","chat":"s1","hub_id":"h.3","upstream_id":null,"reactions":[{"emoji":"❤️","actors":[$atlasJson]}],"change":{"emoji":"❤️","present":true,"actor":$atlasJson}}""") as V2Event.MessageReaction
        assertEquals("h.3", e.hubId); assertNull(e.upstreamId); assertEquals(listOf(ReactionGroup("❤️", listOf(atlas))), e.reactions)
        assertTrue(ev("""{"seq":10,"type":"message.reaction","agent":"atlas","chat":"s1","hub_id":"h.3"}""") is V2Event.Unknown)
        val s = ChatState().apply { load(listOf(UiMessage("user", "draft it", id = "100", hubId = "h.3")), "s1")
            simulateReactions(ReactionSnapshot(me, mapOf("100" to listOf(ReactionGroup("👍", listOf(me)))), emptySet(), mapOf("h.3" to listOf(ReactionGroup("👍", listOf(me)))))) }
        s.applyReactionEvent(e.hubId, e.upstreamId, e.reactions)
        assertEquals(listOf("❤️"), s.reactions!!.groupsFor(s.messages.single()).map { it.emoji }) // replaced, not merged with 👍
        assertEquals(listOf("❤️"), s.reactions!!.messages["100"]!!.map { it.emoji }) // provider key follows (upstream_id null: the shown id)
        s.applyReactionEvent("h.3", null, emptyList())
        assertEquals(emptyList<ReactionGroup>(), s.reactions!!.groupsFor(s.messages.single()))
        assertTrue(HubFeatures.of(listOf("live2", "reactionEvents")).reactionEvents); assertFalse(HubFeatures.of(listOf("live2")).reactionEvents)
    }

    // Root cause 4 (Room cache had no reactions): the reducer writes `message.reaction` into the stored snapshot (stream, replay and
    // resync all go through it) and messages that carry `reactions` do the same.
    @Test fun reducerKeepsTheCachedSnapshotCurrent() = runBlocking {
        val db = CacheDb.build(ApplicationProvider.getApplicationContext(), name = null)
        try {
            val cache = ChatCache(db, "o"); val r = LiveReducer(cache)
            cache.saveReactions("atlas", "s1", ReactionSnapshot(me, emptyMap(), emptySet(), emptyMap()))
            val fx = r.apply(V2Event.MessageReaction(5, "atlas", "s1", "h.3", "100", listOf(ReactionGroup("❤️", listOf(atlas)))))
            assertEquals(listOf(LiveEffect.Reactions("atlas", "s1", "h.3", "100", listOf(ReactionGroup("❤️", listOf(atlas))))), fx)
            assertEquals(listOf("❤️"), cache.reactions("atlas", "s1")!!.byHub!!["h.3"]!!.map { it.emoji })
            assertEquals(listOf("❤️"), cache.reactions("atlas", "s1")!!.messages["100"]!!.map { it.emoji })
            // the same event again (a replay) leaves the same snapshot
            r.apply(V2Event.MessageReaction(5, "atlas", "s1", "h.3", "100", listOf(ReactionGroup("❤️", listOf(atlas)))))
            assertEquals(1, cache.reactions("atlas", "s1")!!.byHub!!["h.3"]!!.single().actors.size)
        } finally { db.close() }
    }

    // A reply that is only its REACT: line draws no bubble (hub flag or the line itself) and is not counted as a new reply.
    @Test fun reactionOnlyReplyIsNotABubble() {
        val m = Contract.message(Json.parseToJsonElement("""{"hub_id":"h.4","n":4,"role":"assistant","text":"REACT: ❤️","reaction_only":true,"reactions":[{"emoji":"👍","actors":[$meJson]}]}""").jsonObject)!!
        assertTrue(m.reactionOnly); assertEquals(listOf("👍"), m.reactions!!.map { it.emoji })
        assertTrue(MessageActions.emptyReply(m.toUi()))
        assertTrue(MessageActions.emptyReply(UiMessage("assistant", "REACT: 🎉")))
        assertFalse(MessageActions.emptyReply(UiMessage("assistant", "Sure.\nREACT: 🎉")))
        val user = Contract.message(Json.parseToJsonElement("""{"hub_id":"h.3","n":3,"role":"user","text":"hi","reaction_only":true}""").jsonObject)!!
        assertFalse(user.reactionOnly) // only a reply can be reaction-only
        assertNull(Contract.message(Json.parseToJsonElement("""{"hub_id":"h.5","n":5,"role":"assistant","text":"ok"}""").jsonObject)!!.reactions) // absent = unknown, not none
    }

    @Test fun snapshotParsesByHubId_andRoundTripsThroughItsJson() {
        val s = HubApi.parseReactions(Json.parseToJsonElement("""{"actor":$meJson,"messages":{"100":[{"emoji":"❤️","actors":[$atlasJson]}]},"by_hub_id":{"h.3":[{"emoji":"❤️","actors":[$atlasJson]}],"h.9":[]},"hidden":["5"],"changed":false}""").jsonObject)
        assertEquals(mapOf("h.3" to listOf(ReactionGroup("❤️", listOf(atlas)))), s.byHub)
        assertEquals(s, HubApi.parseReactions(Json.parseToJsonElement(HubApi.reactionsJson(s)).jsonObject))
        assertNull(HubApi.parseReactions(Json.parseToJsonElement("""{"actor":$meJson,"messages":{}}""").jsonObject).byHub)
        // chips: by hub id first, provider id for messages the hub has not numbered
        assertEquals(listOf("❤️"), s.groupsFor(UiMessage("user", "x", hubId = "h.3")).map { it.emoji })
        assertEquals(listOf("❤️"), s.groupsFor(UiMessage("user", "x", id = "100")).map { it.emoji })
        // optimistic: yours goes under both keys the message is shown by
        val after = s.apply(UiMessage("user", "x", id = "100", hubId = "h.3"), "👍", true)
        assertEquals(listOf("❤️", "👍"), after.byHub!!["h.3"]!!.map { it.emoji }); assertEquals(listOf("❤️", "👍"), after.messages["100"]!!.map { it.emoji })
    }
}
