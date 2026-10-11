package dev.foxfleet.app.media

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow

/** Complete private media only. Filenames contain hashes, never URLs, tokens or remote paths. */
class MediaRepository(private val directory: File, val maxBytes: Long = 256L * 1024 * 1024) {
    data class Progress(val bytes: Long = 0, val total: Long? = null)
    private val lock = Any()
    private val pins = HashMap<File, Int>()
    private val retired = HashSet<File>()
    private val flights = HashMap<String, Flight>()
    private var generation = 0L
    private class Flight(val task: Deferred<File>, val progress: MutableStateFlow<Progress>, var waiters: Int = 0)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        require(maxBytes > 0)
        directory.mkdirs()
        directory.listFiles()?.filter { it.extension == "part" }?.forEach { it.delete() }
        synchronized(lock) { trim(0) }
    }
    fun session(hub: String, account: String) = Session(digest("$hub\u0000$account"))
    fun usageBytes(): Long = synchronized(lock) { files().sumOf { it.length() } }
    /** Leased files remain until their viewer closes; new callers never reuse cleared entries. */
    fun clear() = synchronized(lock) {
        generation++
        flights.values.forEach { it.task.cancel() }; flights.clear()
        files().forEach { retire(it) }
    }
    inner class Lease internal constructor(val file: File) : Closeable {
        private var released = false
        override fun close() = synchronized(lock) {
            if (!released) {
                released = true
                val remaining = (pins[file] ?: 1) - 1
                if (remaining <= 0) { pins.remove(file); if (retired.remove(file)) file.delete() } else pins[file] = remaining
            }
        }
    }
    inner class Session internal constructor(private val owner: String) {
        @Volatile private var closed = false
        private val jobs = HashSet<Deferred<File>>()
        fun close(purge: Boolean = false) = synchronized(lock) {
            closed = true
            jobs.forEach { it.cancel() }; jobs.clear()
            if (purge) files().filter { it.name.startsWith("$owner-") }.forEach { retire(it) }
        }
        suspend fun acquire(
            identity: String,
            onProgress: (Progress) -> Unit = {},
            load: suspend (destination: File, limit: Long, progress: (Progress) -> Unit) -> Unit,
        ): Lease = withContext(Dispatchers.IO) {
            val key = "$owner-${digest(identity)}"
            while (true) {
                var hit: Lease? = null
                val flight = synchronized(lock) {
                    checkOpen()
                    files().firstOrNull { it.name.startsWith("$key-") && it !in retired && it.length() > 0 }?.let { hit = lease(it) }
                    if (hit != null) null else {
                        flights[key]?.takeIf { it.task.isActive || it.task.isCompleted && !it.task.isCancelled }?.also { it.waiters++ }
                            ?: run {
                                val startGeneration = generation
                                val progress = MutableStateFlow(Progress())
                                val task = scope.async(start = CoroutineStart.LAZY) {
                                    val temporary = File(directory, "$key-${UUID.randomUUID()}.part")
                                    try {
                                        load(temporary, maxBytes) { progress.value = it }
                                        currentCoroutineContext().ensureActive()
                                        synchronized(lock) {
                                            checkOpen()
                                            if (startGeneration != generation) throw CancellationException("Cache cleared")
                                            val size = temporary.length()
                                            if (size <= 0 || size > maxBytes) throw IOException("Media exceeds available cache space or is empty")
                                            trim(size)
                                            if (files().sumOf { it.length() } + size > maxBytes) throw IOException("Close other media to free cache space")
                                            val complete = File(directory, temporary.nameWithoutExtension + ".media")
                                            if (!temporary.renameTo(complete)) throw IOException("Could not save media")
                                            complete.setLastModified(System.currentTimeMillis())
                                            complete
                                        }
                                    } finally { temporary.delete() }
                                }
                                Flight(task, progress, 1).also { flights[key] = it; jobs.add(task); task.start() }
                            }
                    }
                }
                hit?.let { return@withContext it }
                val active = flight!!
                try {
                    val file = coroutineScope {
                        val observer = launch { active.progress.collect { onProgress(it) } }
                        try { active.task.await() } finally { observer.cancel() }
                    }
                    synchronized(lock) {
                        checkOpen()
                        if (file.exists() && file !in retired) return@withContext lease(file)
                    }
                } finally {
                    synchronized(lock) {
                        active.waiters--
                        if (active.waiters == 0) {
                            if (flights[key] === active) flights.remove(key)
                            jobs.remove(active.task)
                            if (active.task.isActive) active.task.cancel()
                        }
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }
        private fun checkOpen() { if (closed) throw CancellationException("Media account changed") }
    }
    private fun lease(file: File): Lease { pins[file] = (pins[file] ?: 0) + 1; file.setLastModified(System.currentTimeMillis()); return Lease(file) }
    private fun files() = directory.listFiles()?.filter { it.extension == "media" }.orEmpty()
    private fun retire(file: File) { if ((pins[file] ?: 0) > 0) retired.add(file) else file.delete() }
    private fun trim(incoming: Long) {
        var size = files().sumOf { it.length() }
        for (file in files().filter { it !in pins }.sortedBy { it.lastModified() }) {
            if (size + incoming <= maxBytes) break
            val bytes = file.length(); if (file.delete()) { retired.remove(file); size -= bytes }
        }
    }
    companion object {
        fun identity(agent: String, instance: String, ref: String) = "$agent\u0000$instance\u0000$ref"
        private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

/** A single source is used by the thumbnail and fullscreen image, including after cache eviction. */
fun attachmentSource(path: String, dataUrl: String): String = File(path).takeIf { it.isFile && it.length() > 0 }?.toURI()?.toString() ?: dataUrl
