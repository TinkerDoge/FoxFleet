package dev.foxfleet.app.media

import java.nio.file.Files
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class MediaRepositoryTest {
    private fun repo(limit: Long = 32) = MediaRepository(Files.createTempDirectory("media-test").toFile(), limit)
    @Test fun `warm hit skips loader and scopes isolate accounts and messages`() = runBlocking {
        val r = repo(); val a = r.session("https://hub", "alice"); var loads = 0
        suspend fun load(s: MediaRepository.Session, key: String) = s.acquire(key) { f, _, _ -> loads++; f.writeText("abc") }
        load(a, "message1/ref").close(); load(a, "message1/ref").close(); assertEquals(1, loads)
        load(a, "message2/ref").close(); load(r.session("https://hub", "bob"), "message1/ref").close()
        load(r.session("https://other", "alice"), "message1/ref").close(); assertEquals(4, loads)
    }
    @Test fun `concurrent callers share download and cancelling one keeps other alive`() = runBlocking {
        val r = repo(); val s = r.session("hub", "alice"); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>(); var loads = 0
        val first = async { s.acquire("ref") { f, _, _ -> loads++; started.complete(Unit); finish.await(); f.writeText("abc") } }
        started.await()
        val second = async(start = CoroutineStart.UNDISPATCHED) { s.acquire("ref") { _, _, _ -> error("duplicate download") } }
        first.cancelAndJoin(); finish.complete(Unit); second.await().close(); assertEquals(1, loads)
    }
    @Test fun `last waiter cancellation removes partial bytes`() = runBlocking {
        val r = repo(); val s = r.session("hub", "alice"); val started = CompletableDeferred<Unit>(); val stopped = CompletableDeferred<Unit>()
        val job = launch { s.acquire("ref") { f, _, _ -> try { f.writeText("partial"); started.complete(Unit); awaitCancellation() } finally { stopped.complete(Unit) } } }
        started.await(); job.cancelAndJoin(); stopped.await()
        s.acquire("ref") { f, _, _ -> f.writeText("complete") }.use { assertEquals("complete", it.file.readText()) }
    }
    @Test fun `clear preserves leased playback until release and invalidates future hits`() = runBlocking {
        val r = repo(); val s = r.session("hub", "alice")
        val playing = s.acquire("video") { f, _, _ -> f.writeText("video") }
        r.clear(); assertTrue(playing.file.exists()); assertEquals(5L, r.usageBytes())
        val replacement = s.acquire("video") { f, _, _ -> f.writeText("new") }
        assertEquals("video", playing.file.readText()); assertEquals("new", replacement.file.readText())
        playing.close(); assertFalse(playing.file.exists()); replacement.close()
    }
    @Test fun `LRU evicts old unleased files and rejects oversized or incomplete downloads`() = runBlocking {
        val r = repo(8); val s = r.session("hub", "alice"); var loads = 0
        s.acquire("a") { f, _, _ -> loads++; f.writeText("aaaa") }.close()
        delay(5); s.acquire("b") { f, _, _ -> f.writeText("bbbb") }.close()
        delay(5); s.acquire("a") { _, _, _ -> error("warm") }.close()
        delay(5); s.acquire("c") { f, _, _ -> f.writeText("cccc") }.close()
        s.acquire("b") { f, _, _ -> loads++; f.writeText("bbbb") }.close(); assertEquals(2, loads); assertTrue(r.usageBytes() <= 8)
        assertTrue(runCatching { s.acquire("huge") { f, _, _ -> f.writeText("123456789") } }.isFailure)
        assertTrue(runCatching { s.acquire("broken") { f, _, _ -> f.writeText("partial"); error("network lost") } }.isFailure)
        assertTrue(r.usageBytes() <= 8)
    }
    @Test fun `closed account cannot read or complete a download`() = runBlocking {
        val r = repo(); val s = r.session("hub", "alice"); val started = CompletableDeferred<Unit>()
        val pending = async { s.acquire("x") { f, _, _ -> f.writeText("private"); started.complete(Unit); awaitCancellation() } }
        started.await(); s.close(purge = true); assertTrue(runCatching { pending.await() }.isFailure)
        assertTrue(runCatching { s.acquire("x") { _, _, _ -> error("must not load") } }.isFailure)
        assertEquals(0L, r.usageBytes())
    }
    @Test fun `persisted complete files survive repository recreation`() = runBlocking {
        val dir = Files.createTempDirectory("media-reopen").toFile()
        MediaRepository(dir, 32).session("hub", "alice").acquire("x") { f, _, _ -> f.writeText("ok") }.close()
        MediaRepository(dir, 32).session("hub", "alice").acquire("x") { _, _, _ -> error("warm disk hit") }.use { assertEquals("ok", it.file.readText()) }
    }
    // 0.4.3 C1: the durable directory (filesDir) keeps a warm hit across a brand new repository, as it does across a process restart.
    @Test fun `durable directory keeps a warm hit for a new repository instance`() = runBlocking {
        val filesDir = Files.createTempDirectory("app-files").toFile()
        MediaRepository(filesDir, 64).session("hub", "alice").acquire("durable") { f, _, _ -> f.writeText("kept") }.close()
        var loads = 0
        MediaRepository(filesDir, 64).session("hub", "alice").acquire("durable") { f, _, _ -> loads++; f.writeText("redownload") }.use { assertEquals("kept", it.file.readText()) }
        assertEquals(0, loads)
    }
    // 0.4.3 C2
    @Test fun `session delete drops the file so the next open downloads again`() = runBlocking {
        val r = repo(64); val s = r.session("hub", "alice"); var loads = 0; val id = MediaRepository.identity("agent", "inst", "m1")
        suspend fun load() = s.acquire(id) { f, _, _ -> loads++; f.writeText("m1") }
        load().close(); assertEquals(1, loads)
        s.delete(id)
        assertEquals(0L, r.usageBytes())
        load().close(); assertEquals(2, loads)
    }
    @Test fun `delete of a leased file waits for the viewer to close`() = runBlocking {
        val r = repo(64); val s = r.session("hub", "alice"); val id = MediaRepository.identity("agent", "inst", "v")
        val playing = s.acquire(id) { f, _, _ -> f.writeText("video") }
        s.delete(id)
        assertTrue("still playing", playing.file.exists())
        playing.close()
        assertFalse("removed once closed", playing.file.exists())
        assertEquals(0L, r.usageBytes())
    }
    @Test fun `deleteAgent removes every cached file of one agent only`() = runBlocking {
        val r = repo(128); val s = r.session("hub", "alice")
        s.acquire(MediaRepository.identity("sumi", "inst", "a")) { f, _, _ -> f.writeText("a") }.close()
        s.acquire(MediaRepository.identity("sumi", "inst", "b")) { f, _, _ -> f.writeText("b") }.close()
        s.acquire(MediaRepository.identity("other", "inst", "a")) { f, _, _ -> f.writeText("o") }.close()
        assertEquals(3L, r.usageBytes())
        s.deleteAgent("sumi")
        assertEquals(1L, r.usageBytes())
    }
    @Test fun `repository delete removes an identity across owners`() = runBlocking {
        val r = repo(128); val identity = MediaRepository.identity("sumi", "inst", "m")
        r.session("hub", "alice").acquire(identity) { f, _, _ -> f.writeText("x") }.close()
        r.session("hub", "bob").acquire(identity) { f, _, _ -> f.writeText("y") }.close()
        r.delete(identity)
        assertEquals(0L, r.usageBytes())
    }
}
