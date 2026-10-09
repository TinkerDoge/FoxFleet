package dev.foxfleet.app.ui

import dev.foxfleet.app.ui.chat.HermesCatalog
import dev.foxfleet.app.ui.chat.LocalCommand
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.chat.parseLocal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The full Hermes slash-command list (from hermes-agent's registry) in the phone's autocomplete. */
class CommandsTest {
    @Test fun fullCatalogIsBundledAndGrouped() {
        val all = commandSuggestions("/", emptyList(), limit = 500)
        assertTrue("expected the whole registry, got ${all.size}", all.size > 90)
        for (n in listOf("/new", "/compress", "/model", "/reasoning", "/skills", "/bg", "/reset", "/compact")) assertTrue(n, all.any { it.label == n })
        assertTrue(all.map { it.group }.toSet().size > 3)
        assertEquals(12, commandSuggestions("/", emptyList()).size)
        val compress = all.first { it.label == "/compress" }; assertTrue(compress.args.contains("here")); assertEquals("chat", compress.availability)
    }

    @Test fun terminalOnlyCommandsAreFlaggedNotAvailableRemotely() {
        val clear = commandSuggestions("/", emptyList(), limit = 500).first { it.label == "/clear" }
        assertEquals("unavailable", clear.availability); assertTrue(clear.hint.contains("erminal"))
        assertNotNull(HermesCatalog.unavailableReason("/clear")); assertNull(HermesCatalog.unavailableReason("/new")); assertNull(HermesCatalog.unavailableReason("hello"))
    }

    @Test fun appRunsItsOwnCommandsWithArgsWhereTheyMakeSense() {
        assertEquals(LocalCommand.New to "", parseLocal(" /new ")); assertEquals(LocalCommand.Sessions to "", parseLocal("/history")); assertEquals(LocalCommand.Retry to "", parseLocal("/retry"))
        assertEquals(LocalCommand.Title to "Weekly plan", parseLocal("/title Weekly plan")); assertNull(parseLocal("/title")); assertNull(parseLocal("/new now")); assertNull(parseLocal("/usage"))
    }

    @Test fun otherAgentKindsNeverSeeHermesCommandsOrSkills() {
        assertEquals(listOf("/new", "/sessions", "/stop"), commandSuggestions("/", listOf("model-x"), agentCommands = false).map { it.label })
        assertTrue(commandSuggestions("/mo", listOf("model-x"), agentCommands = false).isEmpty()); assertTrue(commandSuggestions("#mo", listOf("model-x"), agentCommands = false).isEmpty())
        assertNull(parseLocal("/retry", agentCommands = false)); assertEquals(LocalCommand.New to "", parseLocal("/new", agentCommands = false))
    }

    @Test fun skillsStillComplete() { assertEquals("#gaming-news", commandSuggestions("#gam", listOf("gaming-news", "other")).first().label) }
}
