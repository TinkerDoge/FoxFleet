"""The empty-finalize placeholder must never become a stored reply.

Hermes closes a native stream that accumulated no visible content with a lone "✅"
(``_accumulated or "✅"`` in stream_consumer) so the client's thinking bubble ends. The
adapter used to persist that placeholder as a real message with ``final: true``: the chat
showed a bare ✅ (the "green tick"), the hub's live run ended, and the authoritative text —
delivered moments later by the gateway's #71643 stale-finalize recovery — landed in a run
the client was no longer following, so the reply only appeared after a reload.

Swallowing the placeholder keeps the run open; the recovery send then streams the real text
into it. Everything here runs against the REAL hub and the REAL Hermes stream consumer.
"""
from __future__ import annotations

import asyncio

import pytest

from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig

from fakehub import wait_for
from realhub import skip_reason
from test_realhub import real, make_adapter, _poll, _finished, _handler  # noqa: F401  (fixtures)

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")]


async def test_placeholder_finalize_sends_nothing_and_the_recovery_reply_streams_live(real, make_adapter):
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
        # the placeholder never reaches the hub: no ✅ reply is stored
        assert await real.transcript(chat) == [{"role": "user", "content": "reasoning only, no content deltas"}]
        # the gateway's #71643 recovery then delivers the real text through send() as a notified
        # final; the run is still open, so it streams live instead of arriving only after a reload
        result = await adapter.send(chat, "The authoritative reply after the recovery", metadata={"notify": True})
        assert result.success and result.message_id
        await _finished(sse, timeout=10)
        assert sse.done and sse.text() == "The authoritative reply after the recovery"
    finally:
        await sse.close()
    assert await real.transcript(chat) == [
        {"role": "user", "content": "reasoning only, no content deltas"},
        {"role": "assistant", "content": "The authoritative reply after the recovery"}]


async def test_placeholder_swallow_is_scoped_to_streams_that_showed_nothing(real, make_adapter):
    """A real "✅" final on a stream that DID show content is an answer, not a placeholder."""
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
    assert await real.transcript(chat) == [{"role": "user", "content": "shrink to a tick"},
                                           {"role": "assistant", "content": "✅"}]


async def test_streamed_reply_untouched_by_the_swallow(real, make_adapter):
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
    assert await real.transcript(chat) == [{"role": "user", "content": "stream normally"},
                                           {"role": "assistant", "content": full}]
