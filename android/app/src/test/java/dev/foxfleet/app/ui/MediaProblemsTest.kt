package dev.foxfleet.app.ui

import dev.foxfleet.app.ui.components.HubFailure
import dev.foxfleet.app.ui.components.MediaProblem
import dev.foxfleet.app.ui.components.allowMediaCommand
import dev.foxfleet.app.ui.components.mediaProblem
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class MediaProblemsTest {
    private val cases = run {
        var dir = File("").absoluteFile
        while (!File(dir, "contract/media-problems.vectors.json").exists()) dir = dir.parentFile ?: error("contract/media-problems.vectors.json not found")
        Json.parseToJsonElement(File(dir, "contract/media-problems.vectors.json").readText()).jsonObject["cases"]!!.jsonArray
    }

    @Test fun matchesTheSharedVectors() {
        for (c in cases) {
            val i = c.jsonObject["in"]!!.jsonObject
            val got = mediaProblem(HubFailure(i["status"]?.jsonPrimitive?.intOrNull ?: 0, i["code"]?.jsonPrimitive?.contentOrNull, i["message"]?.jsonPrimitive?.contentOrNull, i["network"]?.jsonPrimitive?.booleanOrNull ?: false))
            assertEquals("$i", MediaProblem.byKey(c.jsonObject["kind"]!!.jsonPrimitive.content), got)
        }
    }

    @Test fun theOneTapFixSharesTheFilesFolderAndNeverForUrls() {
        assertEquals("foxfleet connector allow-media \"/home/u/work/out\"", allowMediaCommand("/home/u/work/out/a.png"))
        assertEquals("", allowMediaCommand("https://x.example/a.png"))
    }
}
