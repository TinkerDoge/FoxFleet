package dev.foxfleet.app.data

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TermsTest {
    private val prefs get() = Terms.prefs(ApplicationProvider.getApplicationContext())

    @Test fun acceptanceIsPerHubAndPerVersion() {
        val p = prefs
        assertFalse(Terms.accepted(p, "https://a.example", "1.0"))
        Terms.remember(p, "https://a.example", "1.0")
        assertTrue(Terms.accepted(p, "https://a.example", "1.0"))
        assertFalse(Terms.accepted(p, "https://b.example", "1.0"))
        assertFalse(Terms.accepted(p, "https://a.example", "2.0"))
    }

    @Test fun linksPointAtTheHostedLegalPages() {
        assertEquals("https://tinkerdoge.github.io/FoxFleet/legal/terms", Terms.TERMS_URL)
        assertEquals("https://tinkerdoge.github.io/FoxFleet/legal/privacy", Terms.PRIVACY_URL)
    }

    @Test fun authInfoParsesTheTermsVersion() {
        val o = kotlinx.serialization.json.Json.parseToJsonElement("""{"required":true,"authenticated":false,"termsVersion":"1.0"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("1.0", HubApi.parseAuthInfo(o).termsVersion)
    }
}
