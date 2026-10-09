package dev.foxfleet.app.ui

import dev.foxfleet.app.data.Capabilities
import dev.foxfleet.app.ui.chat.HermesCatalog
import dev.foxfleet.app.ui.chat.argSuggestions
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.chat.parseHub
import dev.foxfleet.app.ui.chat.resolveCommand
import dev.foxfleet.app.ui.screens.modeLabel
import dev.foxfleet.app.ui.screens.queueStateLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Command arguments, aliases, the hub's per-agent catalog and honest send-mode labels (docs/HERMES-CHAT-CONTROLS.md stages 1, 2, 5). */
class ChatControlsTest {
    private val hubCatalog = """{"source":"bundled","busy":["queue","steer","interrupt"],"commands":[
      {"name":"busy","aliases":[],"description":"Control how messages behave","category":"Configuration","args":"[queue|steer|interrupt|status]","subcommands":["queue","steer","interrupt","status"],"availability":"app","handler":"hub:busy","executable":true},
      {"name":"queue","aliases":["q"],"description":"Queue a prompt","category":"Session","args":"[<prompt>|list|rm N|clear]","subcommands":["add","list","rm","clear"],"availability":"chat","handler":"hub:queue","executable":true,"unavailableSubcommands":{"edit":"not remote"}},
      {"name":"steer","aliases":["s"],"description":"Inject guidance","category":"Session","args":"<prompt>","subcommands":[],"availability":"chat","handler":"hub:steer","executable":false,"disabledReason":"This agent has no native steering"},
      {"name":"clear","aliases":[],"description":"Clear","category":"Session","args":"","subcommands":[],"availability":"unavailable","reason":"Needs a terminal","executable":false,"disabledReason":"Needs a terminal"}]}"""
    private val defs = HermesCatalog.parseDefs(hubCatalog)

    @Test fun busyOpensChoicesAndFilters() {
        assertEquals(listOf("queue", "steer", "interrupt", "status"), argSuggestions("/busy ", defs).map { it.label })
        assertEquals(listOf("steer", "status"), argSuggestions("/busy st", defs).map { it.label })
        assertEquals(listOf("/busy steer", "/busy status"), argSuggestions("/busy st", defs).map { it.insert })
        assertTrue(argSuggestions("/busy status", defs).isEmpty()) // exact and only: Enter sends it
        assertEquals(listOf("/busy steer", "/busy status"), commandSuggestions("/busy st", emptyList(), defs = defs).map { it.insert })
    }

    @Test fun aliasesResolveAndFreeTextIsLeftAlone() {
        assertEquals("queue", resolveCommand("q", defs)?.name)
        assertEquals(listOf("/q list"), argSuggestions("/q li", defs).map { it.insert })
        assertTrue(argSuggestions("/queue fix the readme now", defs).isEmpty())
        assertTrue(argSuggestions("/steer use postgres please", defs).isEmpty())
        assertEquals("steer", parseHub("/s use PostgreSQL", defs)?.cmd); assertEquals("use PostgreSQL", parseHub("/s use PostgreSQL", defs)?.args)
        assertEquals("queue", parseHub("/q hello world", defs)?.cmd)
        assertNull(parseHub("/clear", defs))
        assertNull(parseHub("hello", defs))
    }

    @Test fun commandsTheAgentCannotRunAreListedDisabledWithAReason() {
        val s = commandSuggestions("/ste", emptyList(), defs = defs).first()
        assertEquals("unavailable", s.availability); assertEquals("This agent has no native steering", s.reason)
        assertEquals("unavailable", commandSuggestions("/cl", emptyList(), defs = defs).first().availability)
        assertFalse(defs.first { it.name == "steer" }.executable)
        assertEquals("not remote", defs.first { it.name == "queue" }.unavailableSubcommands["edit"])
    }

    @Test fun genericAgentCatalogHasNoHermesCommands() {
        val generic = HermesCatalog.parseDefs("""{"commands":[{"name":"new","aliases":["reset"],"description":"New","category":"Session","args":"","subcommands":[],"availability":"app"}]}""")
        assertEquals(listOf("/new", "/reset"), commandSuggestions("/", emptyList(), defs = generic).map { it.label }.sorted())
    }

    @Test fun supportedBusyModesFallBackSensibly() {
        assertEquals(listOf("queue", "interrupt"), Capabilities.forKind("hermes").busy)
        assertEquals(listOf("queue", "interrupt"), Capabilities.forKind("openai").busy)
        assertEquals(listOf("queue"), Capabilities.forKind("mcp-inbox").busy)
    }

    @Test fun labelsAreHonest() {
        assertEquals("Interrupt & send", modeLabel("interrupt")); assertEquals("Steer", modeLabel("steer")); assertEquals("Queue", modeLabel("queue"))
        assertTrue(queueStateLabel("guidance_accepted").contains("not confirmed used"))
        assertEquals("Waiting for the reply to stop", queueStateLabel("awaiting_stop"))
    }
}
