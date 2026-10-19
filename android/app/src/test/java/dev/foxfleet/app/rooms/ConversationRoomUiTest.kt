package dev.foxfleet.app.rooms

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import dev.foxfleet.app.ConversationRoomState
import dev.foxfleet.app.data.AppPrefs
import dev.foxfleet.app.data.Conversation
import dev.foxfleet.app.data.ConversationMember
import dev.foxfleet.app.data.ConversationMention
import dev.foxfleet.app.data.ConversationMessage
import dev.foxfleet.app.ui.FoxfleetTheme
import dev.foxfleet.app.ui.screens.ConversationScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The room transcript looks like the DM chat, with a real author per message: every agent keeps its own face and
 * name, and the thinking it published shows above its answer.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ConversationRoomUiTest {
    @get:Rule val compose = createComposeRule()

    private val owner = ConversationMember("u1", "Ada", "human", false)
    private val helper = ConversationMember("agent:helper", "helper", "agent", true)
    private val room = Conversation(
        id = "fc_abcdefghijklmnop", threadId = "fcr_abcdefghijklmnop", title = "Launch room",
        owner = owner, members = listOf(helper),
    )

    private fun show(messages: List<ConversationMessage>) {
        val state = ConversationRoomState().apply {
            conversation = room
            this.messages = messages
        }
        compose.setContent {
            FoxfleetTheme(AppPrefs()) {
                ConversationScreen(
                    room.id, state, emptyList(), "u1", null,
                    onBack = {}, onDetails = {}, onRetry = {}, onLoadOlder = {},
                    onSend = { _, _, _, _ -> }, onStop = {}, onResume = {},
                    onAnswerRequest = { _, _, _ -> }, onLoadMessage = { _, _ -> },
                    onUploadMedia = { _, _ -> error("no upload in this test") },
                    onMarkRead = {}, mediaUrl = { "https://example.test/$it" },
                )
            }
        }
        compose.waitForIdle()
    }

    @Test fun everyMessageKeepsItsAuthorAndTheThinkingShowsAboveTheAnswer() {
        show(
            listOf(
                ConversationMessage(
                    id = "fm_1", conversationId = room.id, sender = owner, text = "Hi @helper", createdAt = 1,
                    mentions = listOf(ConversationMention("agent", "agent:helper", 3, 7)),
                ),
                ConversationMessage(
                    id = "fm_2", conversationId = room.id, sender = helper, text = "Hello @helper, on it.", createdAt = 2,
                    mentions = listOf(ConversationMention("agent", "agent:helper", 6, 7)),
                    reasoning = "Let me read the logs first.",
                ),
            ),
        )
        // The agent's name is on the message, the answer is markdown, the thinking is a block of its own.
        compose.onNodeWithText("helper").assertIsDisplayed()
        compose.onNodeWithText("Hello @helper, on it.").assertIsDisplayed()
        compose.onNodeWithTag("reasoning").assertIsDisplayed()
    }
}
