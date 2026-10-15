"""Integration of the real FoxFleetAdapter with the REAL FoxFleet hub module over a real WebSocket.

The hub is the read-only Devin workspace's own server code (createHub), run in a child Node process on an
ephemeral loopback port with a throwaway data directory. Every inbound message is answered by a
DETERMINISTIC TEST HANDLER (no LLM/provider). This proves the real socket/wire contract of the adapter
against the real hub module. It does NOT prove a production gateway, a live channel, or model behaviour.
"""

from __future__ import annotations

import asyncio
import re
import time

import pytest
import pytest_asyncio
import websockets

from gateway.config import PlatformConfig

from fakehub import wait_for
from foxfleet import protocol
from foxfleet.adapter import FoxFleetAdapter, build_command_catalog
from realhub import AGENT, RealHub, make_data_dir, remove_data_dir, skip_reason

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")]

REPLY = "DETERMINISTIC TEST HANDLER (no LLM/provider): fox reply"


@pytest_asyncio.fixture
async def real():
    # Other modules (lifecycle, stream fallback) borrow this fixture: skip there too, instead of
    # erroring with an empty node path, when the real-hub variables are not set.
    if skip_reason() is not None:
        pytest.skip(skip_reason())
    data_dir = make_data_dir()
    hub = RealHub(data_dir)
    try:
        await hub.start()
        await hub.setup_owner()
        await hub.create_agent()
        yield hub
    finally:
        await hub.stop()
        remove_data_dir(data_dir)


@pytest_asyncio.fixture
async def make_adapter(monkeypatch, real):
    made = []

    def _make(token=None, hub=None):
        monkeypatch.setenv("FOXFLEET_BOT_TOKEN", token or real.agent_token)
        adapter = FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": (hub or real).base}))
        adapter.RECONNECT_BASE_DELAY = 0.05
        adapter.RECONNECT_MAX_DELAY = 0.2
        made.append(adapter)
        return adapter

    yield _make
    for adapter in made:
        await adapter.disconnect()


def _handler(events, reply=None):
    async def handler(event):
        events.append(event)
        return reply
    return handler


async def _poll(fetch, predicate=bool, timeout=10.0):
    deadline = time.monotonic() + timeout
    while True:
        value = await fetch()
        if predicate(value):
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"condition not met within {timeout}s; last={value!r}")
        await asyncio.sleep(0.05)


async def _finished(sse, timeout=10.0):
    await wait_for(lambda: sse.ended, timeout=timeout)


def _fatal_recorder(adapter):
    fatal = []
    adapter.set_fatal_error_handler(lambda a: fatal.append((a.fatal_error_code, a.fatal_error_retryable)))
    return fatal


async def test_round_trip_user_message_to_reply_with_run_ended_by_final(real, make_adapter):
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events, REPLY))
    assert await adapter.connect() is True
    _, auth = await real.call("/api/auth", expect=200)
    body = await real.post_message("hello fox")
    chat = body["session_id"]
    assert body["bot"] == {"online": True}
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    try:
        await _finished(sse, timeout=10)  # final:true ends the run; the hub's idle end would take 30s
        assert sse.done and "".join(sse.deltas()) == REPLY
    finally:
        await sse.close()
    assert len(events) == 1 and re.fullmatch(r"fc_[A-Za-z0-9_-]{16}", events[0].source.chat_id)
    assert events[0].text == "hello fox" and events[0].source.user_id == auth["user"]["id"]
    assert await real.transcript(chat) == [{"role": "user", "content": "hello fox"},
                                           {"role": "assistant", "content": REPLY}]
    assert len(await real.runs(chat)) == 1
    await wait_for(lambda: real.store()["acked"] == 1)
    assert real.store()["events"] == []


async def test_stream_consumer_send_then_edit_ends_the_run_without_a_phantom_run(real, make_adapter):
    from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))  # DETERMINISTIC TEST HANDLER (no LLM/provider): no reply
    assert await adapter.connect() is True
    chat = (await real.post_message("stream please"))["session_id"]
    run = (await _poll(lambda: real.runs(chat)))[0]
    sse = await real.follow_run(run["id"])
    await wait_for(lambda: events)
    full = "DETERMINISTIC TEST HANDLER (no LLM/provider): streaming works fine."
    try:
        consumer = GatewayStreamConsumer(adapter, chat, StreamConsumerConfig(
            edit_interval=0.01, buffer_threshold=1, cursor=""))
        runner = asyncio.create_task(consumer.run())
        for piece in ("DETERMINISTIC TEST HANDLER ", "(no LLM/provider): ", "streaming works", " fine."):
            consumer.on_delta(piece)
            await asyncio.sleep(0.05)
        consumer.finish(full)
        await asyncio.wait_for(runner, timeout=5)
        await _finished(sse, timeout=10)
        assert sse.done and sse.text() == full
    finally:
        await sse.close()
    assert await real.transcript(chat) == [{"role": "user", "content": "stream please"},
                                           {"role": "assistant", "content": full}]
    await asyncio.sleep(0.5)  # a late redundant finalize edit must not open a new run
    runs = await real.runs(chat)
    assert len(runs) == 1 and runs[0]["state"] == "done"


async def test_offline_message_is_replayed_once_after_hub_restart_and_not_redelivered(real, make_adapter):
    events = []
    posted = await real.post_message("sent while the bot was offline")
    assert posted["bot"] == {"online": False}
    await real.restart()
    first = make_adapter()
    first.set_message_handler(_handler(events, REPLY))
    assert await first.connect() is True
    await wait_for(lambda: events)
    await wait_for(lambda: real.store()["acked"] == 1)
    assert [e.text for e in events] == ["sent while the bot was offline"]
    await first.disconnect()
    await real.restart()
    second = make_adapter()
    second.set_message_handler(_handler(events, REPLY))
    assert await second.connect() is True
    await asyncio.sleep(1.0)
    assert len(events) == 1 and real.store()["acked"] == 1


async def test_published_commands_match_the_local_catalog_exactly(real, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    expected = build_command_catalog(adapter.MAX_COMMANDS)
    assert expected and len(expected) <= 100 and "status" in {c["name"] for c in expected}

    async def mine():
        body = await real.commands()
        assert body["source"] == "bot"
        return [c for c in body["commands"] if c.get("handler") == "chat"]

    got = await _poll(mine, lambda cmds: len(cmds) == len(expected))
    assert [(c["name"], c["description"]) for c in got] == [(c["name"], c["description"]) for c in expected]
    assert all(re.fullmatch(r"[a-z0-9_]{1,32}", c["name"]) for c in got)


async def test_token_rotation_is_fatal_without_reconnecting_and_new_token_gets_the_message(real, make_adapter, monkeypatch):
    old, events = make_adapter(), []
    fatal = _fatal_recorder(old)
    assert await old.connect() is True
    generation = old._generation
    new_token = await real.rotate_token()
    await wait_for(lambda: fatal, timeout=5)
    assert fatal == [("foxfleet_auth_rejected", False)] and old.is_connected is False
    await asyncio.sleep(1.0)
    assert old._generation == generation and len(fatal) == 1
    await real.post_message("posted while nobody was connected")
    fresh = make_adapter(token=new_token)
    fresh.set_message_handler(_handler(events, REPLY))
    assert await fresh.connect() is True
    await wait_for(lambda: events)
    assert events[0].text == "posted while nobody was connected"


async def test_agent_deletion_is_fatal_bot_gone_without_reconnecting(real, make_adapter):
    adapter = make_adapter()
    fatal = _fatal_recorder(adapter)
    assert await adapter.connect() is True
    generation = adapter._generation
    await real.delete_agent()
    await wait_for(lambda: fatal, timeout=5)
    # 0.3.12: handed to the gateway as retryable (its 30 s..300 s queue), never retried by the plugin.
    assert fatal == [("foxfleet_bot_gone", True)] and adapter.is_connected is False
    await asyncio.sleep(1.0)
    assert adapter._generation == generation and len(fatal) == 1
    # What the gateway's queued retry then sees for a deleted agent: a final auth refusal, no loop.
    assert await adapter.connect(is_reconnect=True) is False
    assert (adapter.fatal_error_code, adapter.fatal_error_retryable) == ("foxfleet_auth_rejected", False)


async def test_newer_connection_replaces_the_adapter_which_does_not_fight_back(real, make_adapter):
    adapter = make_adapter()
    fatal = _fatal_recorder(adapter)
    assert await adapter.connect() is True
    generation = adapter._generation
    url = protocol.bot_ws_url(real.base)
    async with websockets.connect(url, additional_headers={"Authorization": f"Bot {real.agent_token}"},
                                  subprotocols=[protocol.SUBPROTOCOL]) as raw:
        assert raw.subprotocol == protocol.SUBPROTOCOL
        assert '"hello"' in await asyncio.wait_for(raw.recv(), timeout=5)
        await wait_for(lambda: fatal, timeout=5)
        assert fatal == [("foxfleet_replaced", False)] and adapter.is_connected is False
        await asyncio.sleep(1.0)
        assert raw.close_code is None  # no takeover loop: the newer connection is left alone
        assert adapter._generation == generation and len(fatal) == 1


async def test_hub_errors_map_to_send_result_kinds_and_blank_never_reaches_the_hub(real, make_adapter):
    adapter, events = make_adapter(), []
    adapter.set_message_handler(_handler(events))  # DETERMINISTIC TEST HANDLER (no LLM/provider): no reply
    assert await adapter.connect() is True
    posted = await real.post_message("anchor")
    chat, user_message = posted["session_id"], posted["message"]["id"]
    await wait_for(lambda: events)
    unknown = await adapter.send("fc_" + "A" * 16, "nobody home")
    assert (unknown.success, unknown.error_kind) == (False, "not_found")
    forbidden = await adapter.edit_message(chat, user_message, "rewrite the user's words")
    assert (forbidden.success, forbidden.error_kind) == (False, "forbidden")
    before = await real.transcript(chat)
    blank = await adapter.send(chat, "  \n\t ")
    assert (blank.success, blank.error_kind) == (False, "bad_format")
    assert await real.transcript(chat) == before == [{"role": "user", "content": "anchor"}]
