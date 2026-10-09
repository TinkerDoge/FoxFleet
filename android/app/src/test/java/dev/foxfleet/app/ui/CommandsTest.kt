package dev.foxfleet.app.ui

import dev.foxfleet.app.ui.chat.HermesCatalog
import dev.foxfleet.app.ui.chat.LocalCommand
import dev.foxfleet.app.ui.chat.commandSuggestions
import dev.foxfleet.app.ui.chat.opensCommandBrowser
import dev.foxfleet.app.ui.chat.parseLocal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The full Hermes slash-command list (from hermes-agent's registry) in the phone's autocomplete. */
class CommandsTest {
    @Test fun bareSlashKeepsUsefulCommandsAndSkillsAndDropsAliases() {
        val skills = listOf("deploy-notes")
        val all = commandSuggestions("/", skills, limit = Int.MAX_VALUE)
        val labels = all.map { it.label }
        for (n in listOf("/new", "/compress", "/model", "/help", "/usage", "/memory", "/skills", "/reasoning", "/deploy-notes")) assertTrue(n, labels.contains(n))
        for (n in listOf("/clear", "/reset", "/compact", "/palette")) assertTrue(n, !labels.contains(n))
        assertTrue(labels.indexOf("/deploy-notes") in (labels.indexOf("/new") + 1) until labels.indexOf("/model"))
        assertTrue(all.map { it.group }.toSet().size > 3)
        assertEquals(12, commandSuggestions("/", emptyList()).size)
        val compress = all.first { it.label == "/compress" }; assertTrue(compress.args.contains("here")); assertEquals("chat", compress.availability)
        assertEquals("/reset", commandSuggestions("/reset", emptyList()).first().label)
        assertEquals(LocalCommand.New, commandSuggestions("/reset", emptyList()).first().local)
        assertTrue(commandSuggestions("/token", emptyList()).any { it.label == "/usage" })
        assertTrue(commandSuggestions("/", emptyList(), limit = Int.MAX_VALUE, includeHidden = true).any { it.label == "/clear" })
        assertTrue(opensCommandBrowser("/help") && opensCommandBrowser("/palette") && !opensCommandBrowser("/help skills"))
    }

    @Test fun terminalOnlyCommandsAreFlaggedNotAvailableRemotely() {
        val clear = commandSuggestions("/clear", emptyList()).first { it.label == "/clear" }
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
