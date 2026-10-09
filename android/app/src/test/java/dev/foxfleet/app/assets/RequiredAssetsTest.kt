package dev.foxfleet.app.assets

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the screen-takeover assets: ScreenScreen loads assets/screen.html, which loads screen.js and the noVNC core.
 * A refactor once deleted them without any test noticing (the APK still built). The same check runs in CI as
 * `node scripts/check-android-assets.mjs` against the built APK.
 */
class RequiredAssetsTest {
    private val assets: File = listOf("src/main/assets", "app/src/main/assets").map(::File).first { it.isDirectory }
    private val importRe = Regex("""(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}/[^'"]+)['"]|import\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""")

    private fun reachable(): Pair<Set<String>, List<String>> {
        val seen = linkedSetOf<String>(); val missing = mutableListOf<String>()
        fun visit(rel: String) {
            if (!seen.add(rel)) return
            val f = File(assets, rel)
            if (!f.isFile) { missing += rel; return }
            if (!rel.endsWith(".js")) return
            val dir = rel.substringBeforeLast('/', "")
            for (m in importRe.findAll(f.readText())) {
                val target = m.groupValues[1].ifEmpty { m.groupValues[2] }
                visit(File(if (dir.isEmpty()) target else "$dir/$target").normalize().path.replace('\\', '/').removePrefix("./"))
            }
        }
        visit("screen.html"); visit("screen.js"); visit("novnc/core/rfb.js")
        return seen to missing
    }

    @Test fun screenAssetsAndTheNoVncCoreArePresent() {
        val (seen, missing) = reachable()
        assertTrue("missing assets: $missing", missing.isEmpty())
        assertTrue("noVNC core looks incomplete (${seen.size} files)", seen.size >= 10)
    }

    @Test fun screenHtmlLoadsScreenJs() {
        assertTrue(File(assets, "screen.html").readText().contains("screen.js"))
    }
}
