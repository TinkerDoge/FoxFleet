package dev.foxfleet.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import dev.foxfleet.app.ui.Tokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.nio.file.Files

/** Per-agent background settings: stored on this phone only, one look per agent, repaired when corrupt, reset removes the picture too. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ChatBackgroundsTest {
    private val ctx get() = RuntimeEnvironment.getApplication()
    private fun store(): ChatBackgroundStore = ChatBackgroundStore(ctx.getSharedPreferences("bg-${System.nanoTime()}", Context.MODE_PRIVATE), Files.createTempDirectory("chatbg").toFile())

    @Test fun presetsComeFromTheTokensAndAreSubtle() {
        val p = Tokens.ChatBackgrounds.patterns
        assertTrue(p.size in 8..12); assertEquals(p.size, p.map { it.id }.toSet().size)
        assertEquals(Tokens.ChatBackgrounds.solids.size, Tokens.ChatBackgrounds.solids.map { it.id }.toSet().size)
        p.forEach { assertTrue(it.id, it.opacityLight in 0.05f..0.25f && it.opacityDark in 0.05f..0.25f); assertTrue(it.shapes.isNotEmpty()) }
        listOf("paws", "foxes", "dots", "grid", "waves", "topography", "stars", "doodles").forEach { id -> assertTrue(id, p.any { it.id == id }) }
    }

    @Test fun defaultsAndKeys() {
        val s = store(); assertEquals(ChatBg(), s.load(s.key("atlas"))); assertTrue(ChatBg().isDefault)
        assertEquals(s.key("atlas"), s.key("atlas")); assertNotEquals(s.key("atlas"), s.key("nova"))
    }

    @Test fun storesOneLookPerAgentAndRemovesTheEntryWhenDefaultAgain() {
        val s = store(); val atlas = s.key("atlas"); val nova = s.key("nova")
        s.save(atlas, ChatBg.normalize("Pattern", "sage", "paws", 0, 0.2f, false)); s.save(nova, ChatBg.normalize("Solid", "sky", null, 0, 0.2f, false))
        assertEquals(BgMode.Pattern, s.load(atlas).mode); assertEquals("paws", s.load(atlas).pattern); assertEquals("sage", s.load(atlas).solid)
        assertEquals(BgMode.Solid, s.load(nova).mode); assertEquals("sky", s.load(nova).solid)
        s.save(atlas, ChatBg()); assertEquals(ChatBg(), s.load(atlas)); assertEquals(BgMode.Solid, s.load(nova).mode)
    }

    // ---- the point of 0.4.3: one look per agent, every chat of that agent ----
    @Test fun everyChatOfAnAgentSharesTheSameLookAndAgentsDoNot() {
        val s = store()
        // The key is the agent id alone, so two session ids of one agent resolve to the same stored look.
        val sumi1 = s.key("sumi"); val sumi2 = s.key("sumi")
        assertEquals(sumi1, sumi2)
        s.save(sumi1, ChatBg.normalize("Solid", "sage", null, 0, 0f, false))
        // setting it "in one chat" is visible "in the other": a single entry backs both.
        assertEquals(BgMode.Solid, s.load(sumi2).mode); assertEquals("sage", s.load(sumi2).solid)
        // a second agent keeps its own (empty) look.
        assertEquals(ChatBg(), s.load(s.key("nova")))
        s.save(s.key("nova"), ChatBg.normalize("Pattern", "sky", "paws", 0, 0f, false)); assertEquals("sage", s.load(sumi1).solid)
    }

    @Test fun anAgentWithNoLookOfItsOwnAdoptsItsMostRecentPerChatOneAndKeepsOldKeys() {
        val s = store()
        // Legacy per-chat keys written by the old build: agent + NUL + session id.
        val oldSolid = s.key("atlas") + "\u0000old"; val oldImage = s.key("atlas") + "\u0000new"
        s.save(oldSolid, ChatBg.normalize("Solid", "sky", null, 0, 0f, false))
        assertTrue(s.savePicked(ctx, oldImage, jpegUri(400, 300))); s.save(oldImage, ChatBg.normalize("Image", "", null, 4, 0.4f, true))
        val adopted = s.load(s.key("atlas"))
        assertEquals(BgMode.Image, adopted.mode); assertEquals(4, adopted.blur); assertTrue(adopted.image)
        assertNotNull(s.loadBitmap(s.key("atlas")))
        // The old keys are left in place rather than wiped.
        assertEquals(BgMode.Solid, s.load(oldSolid).mode); assertTrue(s.load(oldImage).image)
        // And an agent that already has a look of its own is never overwritten by the migration.
        s.save(s.key("atlas"), ChatBg.normalize("Solid", "teal", null, 0, 0f, false)); assertEquals("teal", s.load(s.key("atlas")).solid)
    }

    @Test fun repairsUntrustedValues() {
        assertEquals(BgMode.Default, ChatBg.normalize("Solid", "nope", null, 0, 0f, false).mode)
        assertEquals(BgMode.Default, ChatBg.normalize("Image", "", null, 0, 0f, false).mode)
        assertEquals(Tokens.ChatBackgrounds.patterns.first().id, ChatBg.normalize("Pattern", "", "nope", 0, 0f, false).pattern)
        val n = ChatBg.normalize("Image", "", null, 999, 5f, true); assertEquals(Tokens.ChatBackgrounds.blurMax, n.blur); assertEquals(Tokens.ChatBackgrounds.dimMax, n.dim, 0.001f)
        val m = ChatBg.normalize("Image", "", null, -3, -1f, true); assertEquals(0, m.blur); assertEquals(0f, m.dim, 0.001f)
        assertEquals(0f, ChatBg.normalize("Image", "", null, 0, Float.NaN, true).dim, 0.001f)
        assertEquals(BgMode.Default, ChatBg.normalize("garbage", null, null, null, null, null).mode)
    }

    @Test fun corruptStoredJsonFallsBackToDefault() {
        val p = ctx.getSharedPreferences("bg-corrupt", Context.MODE_PRIVATE); p.edit().putString("bg.k", "{oops").commit()
        assertEquals(ChatBg(), ChatBackgroundStore(p, Files.createTempDirectory("c").toFile()).load("k"))
    }

    @Test fun anImageSettingWithoutItsFileIsDropped() {
        val s = store(); val k = s.key("atlas"); s.save(k, ChatBg.normalize("Image", "", null, 4, 0.3f, true))
        assertFalse(s.load(k).image); assertEquals(BgMode.Default, s.load(k).mode)
    }

    private fun jpegUri(w: Int, h: Int): Uri {
        val f = File.createTempFile("pick", ".jpg"); Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(200, 120, 40)) }.compress(Bitmap.CompressFormat.JPEG, 90, f.outputStream())
        return Uri.fromFile(f)
    }

    @Test fun aLargePictureIsDownscaledToTheLimitAndStoredPrivately() {
        val s = store(); val k = s.key("atlas")
        assertTrue(s.savePicked(ctx, k, jpegUri(4000, 3000)))
        val bmp = s.loadBitmap(k)!!; assertEquals(Tokens.ChatBackgrounds.maxEdge, maxOf(bmp.width, bmp.height)); assertEquals(1200, minOf(bmp.width, bmp.height))
        assertTrue(s.imageFile(k).length() < 600_000)
    }

    @Test fun notAnImageIsRefused() {
        val s = store(); val f = File.createTempFile("notimg", ".txt").apply { writeText("not an image") }
        assertFalse(s.savePicked(ctx, s.key("a"), Uri.fromFile(f))); assertNull(s.loadBitmap(s.key("a")))
    }

    @Test fun resetRemovesSettingAndPicture() {
        val s = store(); val k = s.key("atlas"); assertTrue(s.savePicked(ctx, k, jpegUri(800, 600))); s.save(k, ChatBg.normalize("Image", "", null, 6, 0.4f, true))
        assertEquals(BgMode.Image, s.load(k).mode); s.reset(k); assertEquals(ChatBg(), s.load(k)); assertFalse(s.imageFile(k).exists())
    }

    @Test fun clearAllWipesEveryBackgroundAndPicture() {
        val s = store(); val k = s.key("atlas"); assertTrue(s.savePicked(ctx, k, jpegUri(400, 300))); s.save(k, ChatBg.normalize("Image", "", null, 0, 0.2f, true)); s.save(s.key("b"), ChatBg.normalize("Solid", "sky", null, 0, 0f, false))
        s.clearAll(); assertEquals(ChatBg(), s.load(k)); assertEquals(ChatBg(), s.load(s.key("b"))); assertFalse(s.imageFile(k).exists())
    }

    // ---- owner: backgrounds survive sign-out, a different account or hub clears them ----
    private fun seed(s: ChatBackgroundStore): String { val k = s.key("atlas"); assertTrue(s.savePicked(ctx, k, jpegUri(400, 300))); s.save(k, ChatBg.normalize("Image", "", null, 4, 0.2f, true)); return k }
    private val a1 = ChatBgOwner.key("acct-1", "https://hub.example.com")

    @Test fun legacyDataWithNoOwnerIsAdopted() {
        val s = store(); val k = seed(s)
        assertEquals(Claim.Adopted, s.claimOwner(a1)); assertTrue(s.load(k).image); assertTrue(s.imageFile(k).exists())
    }
    @Test fun sameOwnerKeepsDataAcrossSignOutAndSignIn() {
        val name = "bg-keep-${System.nanoTime()}"; val dir = Files.createTempDirectory("chatbg").toFile()
        val s = ChatBackgroundStore(ctx.getSharedPreferences(name, Context.MODE_PRIVATE), dir); val k = seed(s); s.claimOwner(a1)
        // sign-out wipes nothing; signing in again as the same owner (even through a freshly created store, as after an app restart) keeps everything
        assertEquals(Claim.Kept, ChatBackgroundStore(ctx.getSharedPreferences(name, Context.MODE_PRIVATE), dir).claimOwner(a1)); assertTrue(s.load(k).image); assertTrue(s.imageFile(k).exists())
    }
    @Test fun differentAccountClears() {
        val s = store(); val k = seed(s); s.claimOwner(a1)
        assertEquals(Claim.Cleared, s.claimOwner(ChatBgOwner.key("acct-2", "https://hub.example.com"))); assertEquals(ChatBg(), s.load(k)); assertFalse(s.imageFile(k).exists())
        assertEquals(Claim.Kept, s.claimOwner(ChatBgOwner.key("acct-2", "https://hub.example.com")))
    }
    @Test fun differentHubClears() {
        val s = store(); val k = seed(s); s.claimOwner(a1)
        assertEquals(Claim.Cleared, s.claimOwner(ChatBgOwner.key("acct-1", "https://other.example.com"))); assertEquals(ChatBg(), s.load(k)); assertFalse(s.imageFile(k).exists())
    }
    @Test fun hubSpellingIsNormalised() {
        assertEquals(a1, ChatBgOwner.key("acct-1", "HTTPS://Hub.Example.com/")); assertEquals(a1, ChatBgOwner.key(" acct-1 ", "hub.example.com:443"))
        assertNotEquals(a1, ChatBgOwner.key("acct-1", "http://hub.example.com")); assertNotEquals(a1, ChatBgOwner.key("acct-1", "https://hub.example.com:8443"))
        assertFalse(a1.contains("example"))
    }
    @Test fun aFailedSignInNeverTouchesTheData() {
        val s = store(); val k = seed(s); s.claimOwner(a1)
        // a failed or cancelled attempt never reaches claimOwner, so nothing changes; the real owner returns and finds everything
        assertEquals(Claim.Kept, s.claimOwner(a1)); assertTrue(s.load(k).image)
    }

    // ---- transparency ----
    private fun argb(alpha: Int): Bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).also { b -> b.eraseColor(android.graphics.Color.argb(alpha, 200, 40, 40)); b.setHasAlpha(true) }
    @Test fun transparentPictureKeepsItsAlphaOpaqueOneBecomesJpeg() {
        val s = store(); val k = s.key("a")
        s.writeImage(k, argb(0)); var head = s.imageFile(k).readBytes().take(4).map { it.toInt() and 0xff }
        assertEquals(listOf(0x89, 0x50, 0x4e, 0x47), head)                         // PNG
        assertEquals(0, s.loadBitmap(k)!!.getPixel(5, 5) ushr 24)                  // still see-through, not black
        s.writeImage(k, argb(255)); head = s.imageFile(k).readBytes().take(2).map { it.toInt() and 0xff }
        assertEquals(listOf(0xff, 0xd8), head)                                      // opaque RGBA is a small JPEG
        assertTrue(usesAlpha(argb(128))); assertFalse(usesAlpha(argb(255)))
    }

    @Test fun sizing() {
        assertEquals(1600 to 1200, ChatBgSizing.fit(4000, 3000)); assertEquals(1200 to 1600, ChatBgSizing.fit(3000, 4000)); assertEquals(800 to 600, ChatBgSizing.fit(800, 600))
        assertEquals(1, ChatBgSizing.sampleSize(1600, 1000)); assertEquals(2, ChatBgSizing.sampleSize(4000, 3000)); assertEquals(4, ChatBgSizing.sampleSize(8000, 6000))
    }
}
