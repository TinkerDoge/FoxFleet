package dev.foxfleet.app.notify

import dev.foxfleet.app.data.AgentStatus
import dev.foxfleet.app.data.AuthRequiredException
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.ui.AgentList
import dev.foxfleet.app.ui.LocalLast
import kotlinx.coroutines.CancellationException

data class ReplyText(val text: String, val at: Long)
sealed interface RequestLookup {
    data class Found(val text: String?) : RequestLookup
    /** The hub answered and the request is not open any more (answered elsewhere or cancelled): no notification. */
    data object Gone : RequestLookup
    /** The hub could not tell (network): show a plain line. */
    data object Unknown : RequestLookup
}

/** What the hub knows, fetched on demand because events carry ids only. Implementations throw [AuthRequiredException] when the login is gone. */
interface NotifyContent {
    suspend fun agentLabel(agent: String): String
    suspend fun lastReply(agent: String, chat: String): ReplyText?
    suspend fun openRequest(agent: String, chat: String, requestId: String): RequestLookup
    /** After a gap: chats with something the user has not seen (agent, newest chat id). */
    suspend fun unreadChats(): List<Pair<String, String>>
}

/** Turns events into notifications: policy first, then the fetch, then the builder. The Android-free core of the service. */
class NotifyDispatcher(
    private val hubId: String,
    private val content: NotifyContent,
    private val notifier: Notifier,
    private val categories: () -> Set<NotifyCategory>,
    private val mutes: () -> List<MuteRule>,
    private val chatOpen: (agent: String?, chat: String?) -> Boolean,
    private val now: () -> Long = { System.currentTimeMillis() },
) : NotifySink {

    override suspend fun onEvents(events: List<NotifyEvent>, replay: Boolean) {
        val list = if (replay) NotifyPolicy.coalesceReplay(events, now()) else events
        for (e in list) handle(e)
    }

    /** Resync instead of assuming completeness: ask the hub which chats have unseen replies and notify for them. */
    override suspend fun onGap(gap: NotifyFrame.Gap) {
        val chats = try { content.unreadChats() } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (_: Exception) { return }
        chats.take(MAX_RESYNC).forEach { (agent, chat) ->
            handle(NotifyEvent(id = 0, type = NotifyType.ReplyFinished, agent = agent, chat = chat, high = false, at = now(), muted = false))
        }
    }

    suspend fun handle(e: NotifyEvent) {
        if (e.type == NotifyType.Test) { if (!e.muted) notifier.postTest(); return }
        val decision = NotifyPolicy.decide(e, categories(), mutes(), now(), chatOpen(e.agent, e.chat))
        if (decision !is NotifyPolicy.Decision.Show) return
        val agent = e.agent ?: return; val chat = e.chat ?: return
        val label = runCatching { content.agentLabel(agent) }.getOrElse { if (it is AuthRequiredException || it is CancellationException) throw it else agent }
        val notice = when (e.type) {
            NotifyType.ReplyFinished -> {
                val reply = fetch { content.lastReply(agent, chat) }
                ChatNotice(hubId, agent, label, chat, e.type, reply?.text, reply?.at ?: e.at)
            }
            NotifyType.Approval -> {
                val id = e.requestId ?: return
                val look = try { content.openRequest(agent, chat, id) } catch (ex: CancellationException) { throw ex } catch (ex: AuthRequiredException) { throw ex } catch (_: Exception) { RequestLookup.Unknown }
                if (look is RequestLookup.Gone) return
                ChatNotice(hubId, agent, label, chat, e.type, (look as? RequestLookup.Found)?.text, e.at, requestId = id)
            }
            NotifyType.Error -> ChatNotice(hubId, agent, label, chat, e.type, e.message ?: "The agent turn failed", e.at)
            else -> return
        }
        notifier.post(notice)
    }

    private suspend fun <T> fetch(block: suspend () -> T?): T? = try { block() } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { throw e } catch (_: Exception) { null }

    companion object { const val MAX_RESYNC = 5 }
}

/** The real thing: the hub's own message, queue and agent routes through the app's [HubApi]. */
class HubNotifyContent(private val api: HubApi, private val seenAt: (String) -> Long?, private val chatOpen: (String) -> Boolean = { false }, private val now: () -> Long = { System.currentTimeMillis() }) : NotifyContent {
    private var agents: List<AgentStatus> = emptyList(); private var agentsAt = 0L

    private suspend fun agentList(force: Boolean = false): List<AgentStatus> {
        if (force || now() - agentsAt > 60_000 || agents.isEmpty()) { agents = api.agents(); agentsAt = now() }
        return agents
    }

    override suspend fun agentLabel(agent: String) = agentList().firstOrNull { it.name == agent }?.displayName ?: agent

    override suspend fun lastReply(agent: String, chat: String): ReplyText? {
        val m = api.messages(agent, chat, 0, 6).messages.lastOrNull { it.role == "assistant" && it.content.isNotBlank() } ?: return null
        val text = LocalLast.preview(m.content).ifBlank { if (m.imageUrls.isNotEmpty() || m.content.contains("MEDIA:")) "Sent a picture or file" else return null }
        return ReplyText(text, m.ts.takeIf { it > 0 } ?: now())
    }

    override suspend fun openRequest(agent: String, chat: String, requestId: String): RequestLookup {
        val open = api.queue(agent, chat).openRequests.firstOrNull { it.id == requestId } ?: return RequestLookup.Gone
        val text = (open.description ?: open.questions.firstOrNull()?.question ?: open.command)?.let { LocalLast.preview(it) }?.takeIf { it.isNotBlank() }
        return RequestLookup.Found(text)
    }

    override suspend fun unreadChats(): List<Pair<String, String>> {
        val unread = agentList(force = true).filter { AgentList.unread(it, seenAt(it.name), chatOpen(it.name)) }
        return unread.mapNotNull { a -> api.sessions(a.name, limit = 1).sessions.firstOrNull()?.let { a.name to it.id } }
    }
}
