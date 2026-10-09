package dev.foxfleet.app.data

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsStoreTest {
    private fun prefs() = RuntimeEnvironment.getApplication().getSharedPreferences("t-${System.nanoTime()}", Context.MODE_PRIVATE)

    @Test fun defaults() {
        assertEquals(AppPrefs(), SettingsStore(prefs()).appPrefs)
    }

    @Test fun appPrefsRoundTripAcrossInstances() {
        val p = prefs()
        val want = AppPrefs(ThemeMode.Dark, accent = 3, textSize = TextSize.Large, reduceMotion = true, haptics = false)
        SettingsStore(p).appPrefs = want
        assertEquals(want, SettingsStore(p).appPrefs)
    }

    @Test fun badValuesFallBack() {
        val p = prefs()
        p.edit().putString("theme", "Neon").putInt("accent", 42).putString("text_size", "Huge").commit()
        val got = SettingsStore(p).appPrefs
        assertEquals(ThemeMode.System, got.theme)
        assertEquals(SettingsStore.ACCENT_COUNT - 1, got.accent)
        assertEquals(TextSize.Medium, got.textSize)
    }

    @Test fun urlTrimmedAndSessionCleared() {
        val s = SettingsStore(prefs())
        s.baseUrl = "  https://hub.example/  "
        assertEquals("https://hub.example", s.baseUrl)
        s.sessionToken = "dev.secret"
        s.clearSession()
        assertNull(s.sessionToken)
    }

    @Test fun noBuiltInHub() {
        val s = SettingsStore(prefs())
        assertEquals("", s.baseUrl); assertEquals(emptyList<HubEntry>(), s.hubs)
    }

    @Test fun multipleHubsKeepSeparateSessions() {
        val s = SettingsStore(prefs())
        val a = s.addHub("https://one.example"); s.sessionToken = "tok-a"
        val b = s.addHub("https://two.example"); assertNull(s.sessionToken); s.sessionToken = "tok-b"
        assertEquals(b.id, s.activeHubId); assertEquals("https://two.example", s.baseUrl)
        s.switchHub(a.id); assertEquals("tok-a", s.sessionToken); assertEquals("https://one.example", s.baseUrl)
        assertEquals(a.id, s.addHub("https://one.example").id); assertEquals(2, s.hubs.size)
        s.removeHub(a.id); assertEquals(b.id, s.activeHubId); assertEquals("tok-b", s.sessionToken)
        s.removeHub(b.id); assertEquals("", s.baseUrl)
    }
}
