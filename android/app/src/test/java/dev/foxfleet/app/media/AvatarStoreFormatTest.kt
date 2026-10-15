package dev.foxfleet.app.media

import android.graphics.Bitmap
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Lint NewApi (0.3.12): WEBP_LOSSY only exists from API 30; minSdk 29 must use the legacy WEBP format. */
@RunWith(RobolectricTestRunner::class)
class AvatarStoreFormatTest {
    @Test @Config(sdk = [29]) fun api29UsesLegacyWebp() {
        @Suppress("DEPRECATION") assertEquals(Bitmap.CompressFormat.WEBP, AvatarStore.webpLossy())
    }

    @Test @Config(sdk = [34]) fun api30PlusUsesWebpLossy() {
        assertEquals(Bitmap.CompressFormat.WEBP_LOSSY, AvatarStore.webpLossy())
    }
}
