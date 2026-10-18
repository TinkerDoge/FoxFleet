"""The empty-finalize placeholder must never hide a reply, and must never lose one.

Hermes closes a native stream that accumulated no visible content with a lone "✅"
(``_accumulated or "✅"`` in stream_consumer) so the client's thinking bubble ends. That tick is
ambiguous: it may be a bubble close whose real text arrives moments later by the gateway's #71643
stale-finalize recovery, or the agent's actual one-character reply. Persisting it as a final reply
(the old behaviour) stored a bare ✅, ended the live run, and the recovery text then landed in a run
the client was no longer following — the reply only appeared after a reload.

The adapter now stores the tick NON-final, and the recovery send edits that same message into the
reply and ends the turn. With no recovery the tick stays as the answer, which is what it was.
Everything here runs against the REAL hub and the REAL Hermes stream consumer.
"""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig

from fakehub import wait_for
from realhub import RealHub, make_data_dir, remove_data_dir, skip_reason
from test_realhub import real, make_adapter, _poll, _finished, _handler  # noqa: F401  (fixtures)

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")]


@pytest_asyncio.fixture
async def brisk(monkeypatch):
    """A second REAL hub that ends an idle reply run quickly (replyIdleMs 300, not 30 s)."""
    if skip_reason() is not None:
        pytest.skip(skip_reason())
    data_dir = make_data_dir()
    hub = RealHub(data_dir, {"replyIdleMs": 300})
    try:
        await hub.start()
        await hub.setup_owner()
        await hub.create_agent()
        yield hub
    finally:
        await hub.stop()
        remove_data_dir(data_dir)


async def test_the_placeholder_tick_is_replaced_by_the_recovery_reply(real, make_adapter):
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))  # DETERMINISTIC TEST HANDLER (no LLM/provider)
    assert await adapter.connect() is True
    chat = (await real.post_message("reasoning only, no content deltas"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    try:
        consumer = GatewayStreamConsumer(adapter, chat, StreamConsumerConfig(
            edit_interval=0.01, buffer_threshold=1, cursor=""))
        runner = asyncio.create_task(consumer.run())
        await asyncio.sleep(0.2)  # the consumer seeds the native stream (typing bubble, no content)
        consumer.finish("")  # no content ever arrived: the gateway finalizes with the ✅ placeholder
        await asyncio.wait_for(runner, timeout=5)
        # the tick is on the hub but does NOT end the turn, so it can still be replaced
        _, body = await real.call(f"/api/agents/helper/sessions/{chat}/messages", expect=200)
        assert [m["content"] for m in body["messages"]] == ["reasoning only, no content deltas", "✅"]
        tick_id = body["messages"][-1]["id"]
        assert not sse.ended, "the placeholder must not end the live run"
        # the gateway's #71643 recovery delivers the real text through send() as a notified final
        result = await adapter.send(chat, "The authoritative reply after the recovery", metadata={"notify": True})
        assert result.success and result.message_id == tick_id, "the reply replaces the tick in place"
        await _finished(sse, timeout=10)
        assert sse.done
        assert any(e["event"] == "foxfleet.replace" and (e.get("data") or {}).get("text") == "The authoritative reply after the recovery"
                   for e in sse.events), "the open run is told to replace the tick with the reply"
    finally:
        await sse.close()
    assert [m["content"] for m in await real.transcript(chat)] == [
        "reasoning only, no content deltas", "The authoritative reply after the recovery"]


async def test_a_notice_or_interim_send_never_replaces_the_tick(real, make_adapter):
    """A command/notice reply is its own message, never the turn's answer: the tick must survive."""
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))
    assert await adapter.connect() is True
    chat = (await real.post_message("tick then a notice"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    try:
        assert await adapter.send_stream_frame("", chat_id=chat, reply_to=None, turn_id="t-notice") is True
        assert await adapter.send_stream_frame("✅", finalize=True, chat_id=chat, reply_to=None, turn_id="t-notice") is True
        token = adapter._notice_send.set(True)  # what an inline slash-command reply sets
        try:
            notice = await adapter.send(chat, "Gateway status: all good", metadata={"notify": True})
        finally:
            adapter._notice_send.reset(token)
        assert notice.success
        _, body = await real.call(f"/api/agents/helper/sessions/{chat}/messages", expect=200)
        assert [m["content"] for m in body["messages"]] == ["tick then a notice", "✅", "Gateway status: all good"]
        assert not sse.ended, "a notice must not end the answer's run"
        # the real answer still replaces the tick in place
        result = await adapter.send(chat, "the real answer", metadata={"notify": True})
        assert result.success and result.message_id == body["messages"][1]["id"]
        await _finished(sse, timeout=10)
    finally:
        await sse.close()
    assert [m["content"] for m in await real.transcript(chat)] == ["tick then a notice", "the real answer", "Gateway status: all good"]


async def test_a_placeholder_with_no_recovery_stays_as_the_answer_and_ends_by_idle(brisk, make_adapter):
    """A genuine one-character "✅" reply (or an empty turn) must not be lost or hang the run."""
    adapter, events = make_adapter(token=brisk.agent_token, hub=brisk), []
    adapter.set_message_handler(_handler(events))
    assert await adapter.connect() is True
    chat = (await brisk.post_message("answer with a tick"))["session_id"]
    run = (await _poll(lambda: brisk.runs(chat)))[0]
    sse = await brisk.follow_run(run["id"])
    await wait_for(lambda: events)
    try:
        assert await adapter.send_stream_frame("", chat_id=chat, reply_to=None, turn_id="t-tick") is True  # seed
        assert await adapter.send_stream_frame("✅", finalize=True, chat_id=chat, reply_to=None, turn_id="t-tick") is True
        await _finished(sse, timeout=10)  # the hub's idle timer ends the run: no recovery is coming
        assert sse.done
    finally:
        await sse.close()
    assert [m["content"] for m in await brisk.transcript(chat)] == ["answer with a tick", "✅"]


async def test_literal_tick_final_on_a_stream_that_showed_content_is_the_answer(real, make_adapter):
    """A "✅" final after real content is an answer, not a placeholder, and is not replaced later."""
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))
    assert await adapter.connect() is True
    chat = (await real.post_message("shrink to a tick"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    try:
        assert await adapter.send_stream_frame("partial answer", chat_id=chat, reply_to=None, turn_id="t-shrink") is True
        assert await adapter.send_stream_frame("✅", finalize=True, chat_id=chat, reply_to=None, turn_id="t-shrink") is True
        await _finished(sse, timeout=10)
        assert sse.done and sse.text() == "✅"
    finally:
        await sse.close()
    assert [m["content"] for m in await real.transcript(chat)] == ["shrink to a tick", "✅"]


async def test_streamed_reply_untouched_by_the_placeholder_path(real, make_adapter):
    """Control: ordinary content snapshots and their final keep working exactly as before."""
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))
    assert await adapter.connect() is True
    chat = (await real.post_message("stream normally"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    full = "one two three four"
    try:
        consumer = GatewayStreamConsumer(adapter, chat, StreamConsumerConfig(
            edit_interval=0.01, buffer_threshold=1, cursor=""))
        runner = asyncio.create_task(consumer.run())
        for piece in ("one ", "two ", "three ", "four"):
            consumer.on_delta(piece)
            await asyncio.sleep(0.05)
        consumer.finish(full)
        await asyncio.wait_for(runner, timeout=5)
        await _finished(sse, timeout=10)
        assert sse.done and sse.text() == full
    finally:
        await sse.close()
    assert [m["content"] for m in await real.transcript(chat)] == ["stream normally", full]
