package dev.foxfleet.app.ui

import dev.foxfleet.app.ui.chat.ScrollFollow
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class ScrollFollowTest {
    private val vectors = run {
        var d = File("").absoluteFile
        while (!File(d, "contract/scroll-follow.vectors.json").exists()) d = d.parentFile ?: error("vectors not found")
        Json.parseToJsonElement(File(d, "contract/scroll-follow.vectors.json").readText()).jsonObject["cases"]!!.jsonArray
    }

    @Test fun matchesTheSharedVectors() {
        for (c in vectors) {
            val f = ScrollFollow(); val name = c.jsonObject["name"]!!.jsonPrimitive.content
            for (s in c.jsonObject["steps"]!!.jsonArray) {
                val o = s.jsonObject
                val r = when (o["e"]!!.jsonPrimitive.content) {
                    "scroll" -> f.scroll(o["distance"]!!.jsonPrimitive.float)
                    "content" -> f.content(o["count"]!!.jsonPrimitive.int, o["streaming"]!!.jsonPrimitive.boolean, o["lastRole"]?.jsonPrimitive?.contentOrNull, o["prepending"]?.jsonPrimitive?.booleanOrNull ?: false, o["loading"]?.jsonPrimitive?.booleanOrNull ?: false)
                    "jump" -> f.jump()
                    else -> f.reset()
                }
                for ((k, v) in o["expect"]!!.jsonObject) {
                    val got: Any = when (k) { "pinned" -> r.pinned; "far" -> r.far; "unread" -> r.unread; "action" -> if (r.scroll) "scroll" else "none"; "control" -> r.control; else -> error("unknown $k") }
                    val want: Any = v.jsonPrimitive.let { p -> if (p.isString) p.content else p.booleanOrNull ?: p.int }
                    assertEquals("$name: $o -> $k", want, got)
                }
            }
        }
    }
}
