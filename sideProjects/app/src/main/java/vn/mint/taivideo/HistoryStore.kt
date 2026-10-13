package vn.mint.taivideo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class HistoryItem(
    val title: String,
    val url: String,
    val fileName: String,
    val timestamp: Long,
    val size: Long,
) {
    fun file(context: Context): File =
        File(context.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS), "taivideo/$fileName")
}

/** Tiny JSON-backed download history. */
object HistoryStore {
    private fun storeFile(context: Context) = File(context.filesDir, "history.json")

    fun load(context: Context): List<HistoryItem> {
        val f = storeFile(context)
        if (!f.exists()) return emptyList()
        return try {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                HistoryItem(
                    title = o.optString("title"),
                    url = o.optString("url"),
                    fileName = o.optString("fileName"),
                    timestamp = o.optLong("timestamp"),
                    size = o.optLong("size"),
                )
            }.filter { it.fileName.isNotBlank() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun add(context: Context, item: HistoryItem) {
        val items = load(context).toMutableList()
        items.removeAll { it.fileName == item.fileName }
        items.add(0, item)
        save(context, items.take(200))
    }

    fun remove(context: Context, item: HistoryItem) {
        save(context, load(context).filter { it.fileName != item.fileName })
    }

    private fun save(context: Context, items: List<HistoryItem>) {
        try {
            val arr = JSONArray()
            items.forEach {
                arr.put(
                    JSONObject()
                        .put("title", it.title)
                        .put("url", it.url)
                        .put("fileName", it.fileName)
                        .put("timestamp", it.timestamp)
                        .put("size", it.size),
                )
            }
            storeFile(context).writeText(arr.toString())
        } catch (_: Exception) {
        }
    }
}
