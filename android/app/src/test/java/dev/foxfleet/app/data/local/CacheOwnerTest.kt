package dev.foxfleet.app.data.local

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CacheOwnerTest {
    private val o = CacheOwner(ApplicationProvider.getApplicationContext<android.content.Context>())

    @Test fun differentOwnerMeansWipe() {
        assertFalse(o.claim("u1@hub", "u1", "https://hub")) // first claim: nothing to wipe
        assertFalse(o.claim("u1@hub", "u1", "https://hub"))
        assertTrue(o.claim("u2@hub", "u2", "https://hub"))
        assertEquals("u2", o.account)
    }

    @Test fun offlineOnlyForTheSameHub() {
        o.claim("u1@hub", "u1", "https://hub")
        assertEquals("u1@hub", o.offlineOwner("https://hub"))
        assertNull(o.offlineOwner("https://other"))
        o.forget(); assertNull(o.offlineOwner("https://hub"))
    }
}
