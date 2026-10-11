package dev.foxfleet.app.notify

import java.util.concurrent.ConcurrentHashMap

/**
 * Per-agent state that the UI thread mutates and the notification service reads. A plain HashMap with getOrPut from two threads can corrupt or throw;
 * this wraps a ConcurrentHashMap, and [peek] never creates an entry (the service must not create chat state).
 */
class AgentChats<T : Any> {
    private val map = ConcurrentHashMap<String, T>()
    fun getOrPut(agent: String, make: () -> T): T = map[agent] ?: map.computeIfAbsent(agent) { make() }
    fun peek(agent: String): T? = map[agent]
    fun clear() = map.clear()
    val size: Int get() = map.size
}

/** The intent that launched the activity is consumed once: a recreation (rotation, theme change) must not re-open the chat of the notification that started it. */
object LaunchLink {
    fun consume(savedInstanceState: Any?, intent: android.content.Intent?): String? {
        if (savedInstanceState != null) return null
        val data = intent?.dataString ?: return null
        intent.data = null
        return data
    }
}
