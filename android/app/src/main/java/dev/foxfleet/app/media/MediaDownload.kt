package dev.foxfleet.app.media

import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** Credentials belong to an origin; third-party images must never receive the hub token. */
internal fun sameMediaOrigin(url: HttpUrl, hub: HttpUrl): Boolean = url.scheme == hub.scheme && url.host == hub.host && url.port == hub.port
fun scopedMediaClient(baseUrl: String, token: String?): OkHttpClient {
    val hub = baseUrl.toHttpUrlOrNull()
    return OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.MINUTES)
        .addNetworkInterceptor { chain ->
            val request = chain.request().newBuilder().removeHeader("Authorization")
            if (hub != null && token != null && sameMediaOrigin(chain.request().url, hub)) request.header("Authorization", "Bearer $token")
            chain.proceed(request.build())
        }.build()
}

/** Cancellation closes a blocked socket as well as removing the partial cache file. */
suspend fun downloadMedia(client: OkHttpClient, url: String, destination: File, limit: Long, progress: (MediaRepository.Progress) -> Unit) = withContext(Dispatchers.IO) {
    val call = client.newCall(Request.Builder().url(url).build())
    coroutineScope {
        val cancelSocket = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { call.cancel() } }
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw dev.foxfleet.app.data.HubApiException(response.code, "Could not download media")
                val body = response.body ?: throw IOException("Empty media")
                val total = body.contentLength().takeIf { it >= 0 }
                if (total != null && total > limit) throw IOException("Media is larger than the 256 MB cache limit")
                var size = 0L
                body.byteStream().use { input -> destination.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer); if (count < 0) break
                        size += count
                        if (size > limit) throw IOException("Media is larger than the 256 MB cache limit")
                        output.write(buffer, 0, count); progress(MediaRepository.Progress(size, total))
                    }
                    output.flush()
                } }
                if (size == 0L || total != null && size != total) throw IOException("Incomplete media download")
            }
        } finally { cancelSocket.cancel() }
    }
}
