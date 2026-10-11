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
}
