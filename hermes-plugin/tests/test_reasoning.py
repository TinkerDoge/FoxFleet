"""A turn's thinking reaches the hub (0.4.2): reasoning rides on the reply, live and in history.

Hermes calls ``agent.reasoning_callback`` from the agent thread; the gateway hands it to
``FoxFleetAdapter.on_reasoning_delta`` (see gateway/platform_reasoning.py). The adapter buffers it,
flushes it onto the open reply bubble, and the hub streams grows-only deltas to the app's collapsible
block and keeps the text with the message. Everything here runs against the REAL hub.
"""
from __future__ import annotations

import asyncio

import pytest

from fakehub import wait_for
from realhub import skip_reason

from test_realhub import real, make_adapter, _poll, _finished, _handler  # noqa: F401  (fixtures)

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")]


async def test_thinking_is_streamed_live_and_kept_with_the_reply(real, make_adapter):
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))
    assert await adapter.connect() is True
    chat = (await real.post_message("think out loud"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    try:
        assert await adapter.send_stream_frame("", chat_id=chat, reply_to=None, turn_id="t-think") is True  # seed
        assert await adapter.send_stream_frame("Working on it", chat_id=chat, reply_to=None, turn_id="t-think") is True
        # the gateway's sink runs on the agent thread: call it from another thread, as Hermes does
        await asyncio.to_thread(adapter.on_reasoning_delta, chat, "Check the logs. ")
        await asyncio.sleep(0.6)  # past the 0.25 s debounce: one flush, one delta
        await asyncio.to_thread(adapter.on_reasoning_delta, chat, "Then the config.")
        await wait_for(lambda: len([e for e in sse.events if e["event"] == "foxfleet.reasoning"]) >= 2, timeout=8)
        shown = [e["data"]["text"] for e in sse.events if e["event"] == "foxfleet.reasoning"]
        assert "".join(shown) == "Check the logs. Then the config.", "the app is told the growth only"
        assert await adapter.send_stream_frame("Fixed: the port was wrong.", finalize=True,
                                               chat_id=chat, reply_to=None, turn_id="t-think") is True
        await _finished(sse, timeout=10)
        assert sse.done
    finally:
        await sse.close()
    _, body = await real.call(f"/api/agents/helper/sessions/{chat}/messages", expect=200)
    assert [m["content"] for m in body["messages"]] == ["think out loud", "Fixed: the port was wrong."]
    assert body["messages"][1]["reasoning"] == "Check the logs. Then the config.", "history carries the thinking"


async def test_a_turn_without_thinking_carries_none(real, make_adapter):
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))
    assert await adapter.connect() is True
    chat = (await real.post_message("no thinking"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    try:
        assert await adapter.send_stream_frame("", chat_id=chat, reply_to=None, turn_id="t-plain") is True
        assert await adapter.send_stream_frame("Straight answer.", finalize=True,
                                               chat_id=chat, reply_to=None, turn_id="t-plain") is True
        await _finished(sse, timeout=10)
        assert not [e for e in sse.events if e["event"] == "foxfleet.reasoning"]
    finally:
        await sse.close()
    _, body = await real.call(f"/api/agents/helper/sessions/{chat}/messages", expect=200)
    assert "reasoning" not in body["messages"][1], "no thinking, no field"
