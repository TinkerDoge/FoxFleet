package dev.foxfleet.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    private fun manifest(code: Int = 35, url: String = "https://cdn.example/FoxFleet.apk", sha: String = "abc123") =
        UpdateManifest(code, "0.4.3", url, sha)

    @Test fun onlyAStrictlyNewerVersionCodeIsAnUpdate() {
        assertTrue(UpdatePolicy.isNewer(34, manifest(35)))
        assertFalse(UpdatePolicy.isNewer(34, manifest(34)))
        assertFalse(UpdatePolicy.isNewer(35, manifest(34)))
    }

    @Test fun aHashMustMatchAndNeverBeBlank() {
        assertTrue(UpdatePolicy.shaMatches("AbC123", "abc123"))
        assertFalse(UpdatePolicy.shaMatches("abc123", "abc124"))
        assertFalse(UpdatePolicy.shaMatches("", "abc123"))
        assertFalse(UpdatePolicy.shaMatches("abc123", ""))
    }

    @Test fun downloadsAreHttpsOnly() {
        assertTrue(UpdatePolicy.isHttps("https://cdn.example/a.apk"))
        assertTrue(UpdatePolicy.isHttps("HTTPS://CDN.EXAMPLE/a.apk"))
        assertFalse(UpdatePolicy.isHttps("http://cdn.example/a.apk"))
        assertFalse(UpdatePolicy.isHttps("httpsdrive.google.com/file"))
    }

    @Test fun decideInstallsOnlyWhenNewerAndSafe() {
        assertEquals(UpdatePlan.UpToDate, UpdatePlan.decide(34, manifest(34)))
        assertEquals(UpdatePlan.UpToDate, UpdatePlan.decide(35, manifest(34)))
        assertEquals(UpdatePlan.Update(manifest(35)), UpdatePlan.decide(34, manifest(35)))
        assertTrue(UpdatePlan.decide(34, manifest(35, url = "http://cdn.example/a.apk")) is UpdatePlan.Refused)
        assertTrue(UpdatePlan.decide(34, manifest(35, sha = "")) is UpdatePlan.Refused)
    }
}

class UpdateManifestsTest {
    @Test fun parsesACompleteManifestAndIgnoresUnknownKeys() {
        val m = UpdateManifests.parse(
            """{"versionCode":35,"versionName":"0.4.3-alpha","apkUrl":"https://cdn.example/FoxFleet.apk","sha256":"DEADBEEF","notes":"Fixes media","extra":1}"""
        )
        assertEquals(UpdateManifest(35, "0.4.3-alpha", "https://cdn.example/FoxFleet.apk", "DEADBEEF", "Fixes media"), m)
    }

    @Test fun notesAreOptional() {
        val m = UpdateManifests.parse("""{"versionCode":35,"versionName":"0.4.3","apkUrl":"https://cdn.example/a.apk","sha256":"ab"}""")
        assertEquals(null, m?.notes)
    }

    @Test fun refusesAnythingIncompleteOrMalformed() {
        listOf(
            "",
            "not json",
            """{"versionName":"0.4.3","apkUrl":"https://a/b.apk","sha256":"ab"}""",
            """{"versionCode":35,"apkUrl":"https://a/b.apk","sha256":"ab"}""",
            """{"versionCode":35,"versionName":"0.4.3","sha256":"ab"}""",
            """{"versionCode":35,"versionName":"0.4.3","apkUrl":"https://a/b.apk"}""",
        ).forEach { assertNull(it, UpdateManifests.parse(it)) }
    }
}

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34])
class UpdateStoreTest {
    private fun store() = UpdateStore(androidx.test.core.app.ApplicationProvider.getApplicationContext<android.app.Application>())

    @Test fun aColdStartCheckIsDueAfterTwelveHours() {
        val s = store()
        val now = 1_000_000_000_000L
        assertTrue(s.due(now))
        s.markChecked(now)
        assertFalse(s.due(now + UpdateStore.INTERVAL_MS - 1))
        assertTrue(s.due(now + UpdateStore.INTERVAL_MS))
    }
}
