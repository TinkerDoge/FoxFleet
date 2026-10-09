package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A 401 from ONE agent's route (a non-default Hermes profile refusing the hub) must not look like "your login ended" (phone re-login bug). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ProfileAuthTest {
    private class Hub(val sessionValid: Boolean) : AutoCloseable {
        private val sock = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1")); val port get() = sock.localPort
        init {
            Thread {
                while (!sock.isClosed) {
                    val c = try { sock.accept() } catch (_: Exception) { break }
                    val r = c.getInputStream().bufferedReader(); val line = r.readLine().orEmpty(); while (r.readLine().orEmpty().isNotEmpty()) { }
                    val (status, body) = when {
                        line.contains("/api/auth ") -> "200 OK" to """{"required":true,"authenticated":$sessionValid}"""
                        else -> "401 Unauthorized" to """{"error":"agent said no"}"""
                    }
                    c.getOutputStream().apply { write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body".toByteArray()); flush() }; c.close()
                }
            }.also { it.isDaemon = true }.start()
        }
        override fun close() { sock.close() }
    }

    private fun api(port: Int): HubApi {
        val store = SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()); store.allowHttp = true; store.baseUrl = "http://127.0.0.1:$port"
        return HubApi(store)
    }

    @Test fun agentRouteRefusalWithValidLoginIsAnAgentError() = runBlocking {
        Hub(sessionValid = true).use { h ->
            try { api(h.port).sessions("coder"); fail("expected an error") }
            catch (e: AuthRequiredException) { fail("the user must not be signed out") }
            catch (e: HubApiException) { assertEquals(502, e.status) }
        }
    }

    @Test fun realSessionLossStillSignsOut() = runBlocking {
        Hub(sessionValid = false).use { h ->
            try { api(h.port).sessions("coder"); fail("expected sign-out") } catch (e: AuthRequiredException) { assertTrue(true) }
        }
    }
}
