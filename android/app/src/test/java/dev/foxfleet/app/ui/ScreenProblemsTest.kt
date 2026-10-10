package dev.foxfleet.app.ui

import dev.foxfleet.app.ui.screens.ScreenProblem
import dev.foxfleet.app.ui.screens.ScreenProblemKind
import dev.foxfleet.app.ui.screens.screenProblem
import dev.foxfleet.app.ui.screens.screenProblemText
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ScreenProblemsTest {
    private val vectors = run {
        var dir = File("").absoluteFile
        while (!File(dir, "contract/screen-problems.vectors.json").exists()) dir = dir.parentFile ?: error("contract/screen-problems.vectors.json not found")
        Json.parseToJsonElement(File(dir, "contract/screen-problems.vectors.json").readText()).jsonObject["cases"]!!.jsonArray
    }

    @Test fun matchesTheSharedVectors() {
        for (c in vectors) {
            val i = c.jsonObject["in"]!!.jsonObject
            val got = screenProblem(
                status = i["status"]?.jsonPrimitive?.intOrNull, code = i["code"]?.jsonPrimitive?.contentOrNull, state = i["state"]?.jsonPrimitive?.contentOrNull,
                network = i["network"]?.jsonPrimitive?.booleanOrNull ?: false, hubKnown = i["hubKnown"]?.jsonPrimitive?.booleanOrNull ?: true,
            )
            assertEquals("$i", ScreenProblemKind.byKey(c.jsonObject["kind"]!!.jsonPrimitive.content), got.kind)
            assertEquals("$i update", c.jsonObject["update"]?.jsonPrimitive?.booleanOrNull ?: false, got.update)
        }
    }

    @Test fun everyProblemSaysSomethingActionable() {
        for (k in ScreenProblemKind.entries) { val t = screenProblemText(ScreenProblem(k), "low memory", listOf("Xvnc")); assertTrue(k.name, t.length > 25) }
        assertTrue(screenProblemText(ScreenProblem(ScreenProblemKind.NotInstalled), null, listOf("Xvnc", "xfce4")).contains("Xvnc, xfce4"))
        assertTrue(screenProblemText(ScreenProblem(ScreenProblemKind.Generic, update = true)).contains("update it"))
    }
}
