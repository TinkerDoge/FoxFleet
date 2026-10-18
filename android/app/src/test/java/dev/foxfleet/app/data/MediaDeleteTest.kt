package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** 0.4.3 "delete for everyone": `HubApi.deleteMedia` builds the DELETE request the hub expects (path + ref body). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaDeleteTest {
    @Test fun deleteMediaSendsDeleteWithTheRefBody() = runBlocking {
        val seen = mutableListOf<String>()
        NativeChatTest.Fake(mapOf("DELETE /media" to Triple(200, "application/json", """{"ok":true,"deleted":true}""")), seen).use { f ->
            val api = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:${f.port}" })
            api.deleteMedia("sumi", "/home/me/chart.png")
            assertEquals(1, seen.size)
            assertTrue("method and path: ${seen[0]}", seen[0].startsWith("DELETE /api/agents/sumi/media "))
            assertTrue("ref body: ${seen[0]}", seen[0].contains("\"ref\":\"/home/me/chart.png\""))
        }
    }

    @Test fun deleteMediaThrowsOnFailure() = runBlocking {
        val seen = mutableListOf<String>()
        NativeChatTest.Fake(mapOf("DELETE /media" to Triple(403, "application/json", """{"error":"forbidden"}""")), seen).use { f ->
            val api = HubApi(SettingsStore(ApplicationProvider.getApplicationContext<android.content.Context>()).also { it.allowHttp = true; it.baseUrl = "http://127.0.0.1:${f.port}" })
            try {
                api.deleteMedia("sumi", "/home/me/chart.png")
                org.junit.Assert.fail("expected a HubApiException")
            } catch (e: HubApiException) {
                assertEquals(403, e.status)
            }
        }
    }
}
