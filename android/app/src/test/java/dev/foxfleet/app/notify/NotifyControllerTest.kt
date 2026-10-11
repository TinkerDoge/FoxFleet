package dev.foxfleet.app.notify

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotifyControllerTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val s get() = NotifyController.store(ctx)
    private val b = NotifyBinding("hub1", "me")

    private fun signedInWithNotificationsOn() {
        NotifyController.onAuthed(ctx, "hub1", "me")
        s.setEnabled(b, true); s.setMutes(b, listOf(MuteRule("nova", null, null))); s.setLastId(b, 42)
    }

    @Test fun aSingle401KeepsTheBindingTheSwitchAndTheResumeIdAndSaysLogInAgain() {
        signedInWithNotificationsOn()
        NotifyController.onServerSignedOut(ctx)
        assertEquals(b, s.binding); assertTrue(s.enabled(b)); assertEquals(42L, s.lastId(b)); assertEquals(1, s.mutes(b).size)
        assertTrue(s.needsLogin); assertEquals(NotifyLink.SignedOut, NotifyController.link.value)
        // it survives a process restart: a new store over the same file still says it
        assertTrue(NotifyStore(ctx).needsLogin)
        val ui = NotifyUiState(serviceOn = true, link = NotifyLink.SignedOut)
        assertEquals("Log in again to get notifications.", NotifyStatus.line(ui)); assertEquals(NotifyStatus.Tone.Bad, NotifyStatus.tone(ui))
    }

    @Test fun theNextSuccessfulLoginClearsTheFlagAndKeepsTheSwitch() {
        signedInWithNotificationsOn(); NotifyController.onServerSignedOut(ctx)
        NotifyController.onAuthed(ctx, "hub1", "me")
        assertFalse(s.needsLogin); assertTrue(s.enabled(b)); assertEquals(42L, s.lastId(b))
    }

    @Test fun bootDoesNotRestartAServiceThatNeedsALogin() {
        signedInWithNotificationsOn(); NotifyController.onServerSignedOut(ctx)
        NotifyController.onBoot(ctx) // would start the service if it did not check the flag; Robolectric would show it
        assertNull(org.robolectric.Shadows.shadowOf(ctx as android.app.Application).nextStartedService)
    }

    @Test fun aRealSignOutStillClearsEverything() {
        signedInWithNotificationsOn(); NotifyController.onServerSignedOut(ctx)
        NotifyController.onSignedOut(ctx)
        assertNull(s.binding); assertFalse(s.enabled(b)); assertNull(s.lastId(b)); assertTrue(s.mutes(b).isEmpty()); assertFalse(s.needsLogin)
    }

    @Test fun aDifferentOwnerStartsFromScratch() {
        signedInWithNotificationsOn(); NotifyController.onServerSignedOut(ctx)
        NotifyController.onAuthed(ctx, "hub1", "someone-else")
        assertEquals(NotifyBinding("hub1", "someone-else"), s.binding); assertFalse(s.enabled(b)); assertNull(s.lastId(b)); assertFalse(s.needsLogin)
    }

    @Test fun batteryGuidanceOpensTheSystemBatteryListOrAppInfo() {
        assertTrue(NotifyText.BATTERY_HINT.contains("battery")); assertFalse(NotifyController.batterySettingsIntent(ctx).action.isNullOrBlank())
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LaunchLinkTest {
    private fun link() = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("foxfleet://chat?hub=h&agent=nova&chat=c1"))

    @Test fun theLaunchIntentIsConsumedOnceSoRotationDoesNotReopenTheChat() {
        val i = link()
        assertEquals("foxfleet://chat?hub=h&agent=nova&chat=c1", LaunchLink.consume(null, i)) // first onCreate
        assertNull(LaunchLink.consume(null, i)) // the same intent object again: already consumed
    }

    @Test fun aRecreatedActivityNeverHandlesItsOriginalIntent() {
        val i = link()
        assertNull(LaunchLink.consume(android.os.Bundle(), i)) // rotation: savedInstanceState != null
        assertNotNull(i.data) // untouched, so a real new intent still works elsewhere
    }

    @Test fun aNewIntentIsHandledAgain() {
        assertNotNull(LaunchLink.consume(null, link())); assertNotNull(LaunchLink.consume(null, link()))
    }
}
