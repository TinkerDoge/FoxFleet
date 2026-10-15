"""Adapter <-> loopback fake hub over a real WebSocket (real BasePlatformAdapter subclass)."""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from gateway.config import PlatformConfig

from fakehub import BOT_ID, FakeHub, TOKEN, bot_msg, chat, human_msg, wait_for
from foxfleet.adapter import FoxFleetAdapter

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def hub():
    server = await FakeHub().start()
    yield server
    await server.stop()


@pytest_asyncio.fixture
async def make_adapter(monkeypatch, hub):
    made = []

    def _make(**extra):
        monkeypatch.setenv("FOXFLEET_BOT_TOKEN", hub.token)
        adapter = FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": hub.url, **extra}))
        adapter.RECONNECT_BASE_DELAY = 0.01
        adapter.RECONNECT_MAX_DELAY = 0.05
        made.append(adapter)
        return adapter

    yield _make
    for adapter in made:
        await adapter.disconnect()


async def test_connect_authenticates_with_bot_header_and_reads_hello(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    try:
        assert adapter.is_connected is True
        assert hub.auth_headers == [f"Bot {TOKEN}"] and hub.query_strings == [""]
        assert adapter.bot_id == BOT_ID
    finally:
        await adapter.disconnect()
    assert adapter.is_connected is False
    await wait_for(lambda: hub.ws.closed)


async def test_token_never_logged_even_at_debug(hub, make_adapter, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    adapter = make_adapter()
    assert await adapter.connect() is True
    await adapter.disconnect()
    assert "Authorization" in caplog.text  # the handshake WAS logged ...
    assert TOKEN not in caplog.text  # ... with the bot token redacted


def _escaped(text: str) -> str:
    return "".join(f"\\u{ord(c):04x}" for c in text)


def _assert_no_token(caplog, *texts):
    escaped = _escaped(TOKEN)
    blob = "\n".join([caplog.text, *[str(t) for t in texts]])
    for needle in (TOKEN, escaped, TOKEN[:20], escaped[:60]):
        assert needle not in blob
    assert any("Authorization" in line and "<redacted>" in line for line in caplog.text.splitlines())


def _debug_logs(caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="foxfleet")


@pytest.mark.parametrize("field", ["protocol", "bot"])
async def test_hostile_hello_values_never_reach_logs_or_fatal_messages(hub, make_adapter, caplog, field):
    _debug_logs(caplog)
    setattr(hub, "protocol" if field == "protocol" else "bot_id", TOKEN)
    adapter = make_adapter()
    assert await adapter.connect() is False
    assert adapter.fatal_error_code == "foxfleet_protocol"
    _assert_no_token(caplog, adapter.fatal_error_message)


async def test_hostile_rpc_errors_never_reach_logs_or_send_results(hub, make_adapter, caplog):
    _debug_logs(caplog)
    adapter = make_adapter()
    assert await adapter.connect() is True
    results = []
    for code in (TOKEN, "rate_limited", "internal"):
        hub.rpc_override = lambda f, code=code: hub.error(f["id"], code, f"detail {TOKEN} and {_escaped(TOKEN)}")
        results.append(await adapter.send(chat(1), f"x {code[:4]}"))
    assert all(not r.success for r in results)
    assert results[0].error == "FoxFleet hub error unrecognized"
    assert results[1].error == "FoxFleet hub error rate_limited"
    _assert_no_token(caplog, *[(r.error, r.raw_response) for r in results], adapter.fatal_error_message)


async def test_hostile_inbound_error_frames_and_escaped_tokens_are_never_logged(hub, make_adapter, caplog):
    _debug_logs(caplog)
    adapter = make_adapter()
    assert await adapter.connect() is True
    await hub.ws.send_json({"t": "error", "code": TOKEN, "message": f"oops {TOKEN}"})
    await hub.ws.send_str('{"t":"error","code":"internal","message":"' + _escaped(TOKEN) + '"}')
    await hub.ws.send_str('{"t":"' + _escaped(TOKEN) + '"}')
    await hub.ws.send_json({"t": "ping", "id": "p2"})
    await wait_for(lambda: hub.ops("pong"))
    assert adapter.is_connected
    _assert_no_token(caplog, adapter.fatal_error_message)


async def test_bad_token_fails_fast_without_retry_and_releases_lock(hub, make_adapter):
    adapter = make_adapter()
    hub.token = "ffb_other"  # the hub no longer accepts the adapter's token
    assert await adapter.connect() is False
    assert adapter.fatal_error_code == "foxfleet_auth_rejected"
    assert adapter.fatal_error_retryable is False
    await asyncio.sleep(0.1)
    assert len(hub.auth_headers) == 1  # no reconnect loop against a rejected token
    hub.token = TOKEN  # lock was released: a correctly configured adapter can take the bot
    assert await make_adapter().connect() is True


async def test_protocol_version_mismatch_is_fatal(hub, make_adapter):
    hub.protocol = "foxfleet.bot/2"
    adapter = make_adapter()
    assert await adapter.connect() is False
    assert (adapter.fatal_error_code, adapter.fatal_error_retryable) == ("foxfleet_protocol", False)


@pytest.mark.parametrize("code,expected", [(4001, "foxfleet_auth_rejected"), (4003, "foxfleet_bot_gone"),
                                           (4009, "foxfleet_replaced")])
async def test_real_hub_close_codes_mid_session_are_fatal_and_not_retried(hub, make_adapter, code, expected):
    adapter = make_adapter()
    fatal = []
    adapter.set_fatal_error_handler(lambda a: fatal.append(a.fatal_error_code))
    assert await adapter.connect() is True
    await hub.ws.close(code=code, message=b"hub says stop")
    await wait_for(lambda: fatal)
    assert fatal == [expected] and adapter.is_connected is False and adapter.fatal_error_retryable is False
    await asyncio.sleep(0.15)
    assert len(hub.auth_headers) == 1


async def test_connect_offers_the_bot_subprotocol_and_requires_the_echo(hub, make_adapter):
    from fakehub import SUBPROTOCOL
    adapter = make_adapter()
    assert await adapter.connect() is True
    assert hub.subprotocol_offers == [SUBPROTOCOL] and adapter._conn.ws.subprotocol == SUBPROTOCOL
    await adapter.disconnect()
    hub.echo_subprotocol = False  # hub accepts the upgrade but never selects foxfleet.bot.v1
    other = make_adapter()
    assert await other.connect() is False
    assert hub.subprotocol_offers[-1] == SUBPROTOCOL  # it was offered, the missing echo is what fails
    assert (other.fatal_error_code, other.fatal_error_retryable) == ("foxfleet_protocol", False)
    await asyncio.sleep(0.1)
    assert len(hub.subprotocol_offers) == 2  # no retry


async def test_idempotency_keys_stay_in_the_hub_alphabet(hub, make_adapter):
    import re
    adapter = make_adapter()
    assert await adapter.connect() is True
    for i in range(60):
        assert (await adapter.send(chat(1), f"m{i}")).success
    keys = [f["idempotency_key"] for f in hub.ops("message.send")]
    assert len(set(keys)) == 60 and all(re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", k) for k in keys)
    assert all(re.fullmatch(r"[0-9a-f]{32}", k) for k in keys)


async def test_commands_set_sends_only_name_and_description_with_valid_names(hub, make_adapter, monkeypatch):
    from hermes_cli import commands as hc
    noisy = hc.CommandDef("fox_noisy", "ctl\x07\x00 chars\n" + "x" * 400, "Info")
    unmappable = hc.CommandDef("fox-unmapped", "no underscore alias resolves", "Info")
    monkeypatch.setattr(hc, "COMMAND_REGISTRY", [*hc.COMMAND_REGISTRY, noisy, unmappable])
    monkeypatch.setattr(hc, "_iter_plugin_command_entries",
                        lambda: [("plug_ok", "plugin ok", ""), ("Plug-Bad", "bad", "")])
    adapter = make_adapter()
    assert await adapter.connect() is True
    await wait_for(lambda: hub.commands)
    assert hub.ops("commands.set") and not any(f.get("t") == "error" for f in hub.frames)
    by_name = {c["name"]: c for c in hub.commands}
    assert all(set(c) == {"name", "description"} for c in hub.commands) and len(hub.commands) <= 100
    assert {"new", "stop", "status", "reload_mcp", "plug_ok"} <= by_name.keys()
    assert "reload-mcp" not in by_name and "fox-unmapped" not in by_name and "Plug-Bad" not in by_name
    assert "ctl chars" in by_name["fox_noisy"]["description"].replace("  ", " ")
    assert 0 < len(by_name["fox_noisy"]["description"]) <= 256
    assert not any(ord(ch) < 32 or ord(ch) == 127 for c in hub.commands for ch in c["description"])
    cli_only = {c.name for c in hc.COMMAND_REGISTRY if c.cli_only and not c.gateway_config_gate}
    assert cli_only and not cli_only & by_name.keys()
    await hub.ws.close(code=1011)
    await wait_for(lambda: len(hub.ops("commands.set")) == 2)  # re-published after reconnect


async def test_edit_finalize_flag_is_sent_explicitly(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    sent = await adapter.send(chat(1), "draft")
    assert (await adapter.edit_message(chat(1), sent.message_id, "draft 2", finalize=False)).success
    assert (await adapter.edit_message(chat(1), sent.message_id, "draft 2", finalize=True)).success
    assert [f["final"] for f in hub.ops("message.edit")] == [False, True]


async def test_adapter_requires_the_finalize_edit_like_telegram():
    assert FoxFleetAdapter.REQUIRES_EDIT_FINALIZE is True


@pytest.mark.parametrize("metadata,expected", [
    ({"notify": True}, [False, False, True]),
    ({"notify": True, "expect_edits": True}, [False, False, False]),
    ({"notify": True, "_interim_send": True}, [False, False, False]),
    ({"notify": False}, [False, False, False]),
    (None, [False, False, False]),
], ids=["notify-final", "stream-first-send", "interim", "notify-false", "no-metadata"])
async def test_send_final_flag_only_on_last_chunk_of_a_notified_final(hub, make_adapter, metadata, expected):
    adapter = make_adapter()
    assert await adapter.connect() is True
    content = ("x" * 1023 + "\n") * 140  # three chunks of <= 64 KiB
    assert (await adapter.send(chat(1), content, metadata=metadata)).success
    frames = hub.ops("message.send")
    assert len(frames) == len(expected) and [f["final"] for f in frames] == expected
    assert all(type(f["final"]) is bool for f in frames)


async def test_blank_content_is_refused_locally_and_nul_is_stripped(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    for blank in ("", "   \n\t", "\x00\x00"):
        result = await adapter.send(chat(1), blank)
        assert (result.success, result.error_kind) == (False, "bad_format")
    assert hub.ops("message.send") == []
    assert (await adapter.send(chat(1), "a\x00b\x00")).success
    assert hub.ops("message.send")[0]["text"] == "ab"
    edited = await adapter.edit_message(chat(1), bot_msg(1), "  ")
    assert (edited.success, edited.error_kind) == (False, "bad_format") and hub.ops("message.edit") == []


async def test_second_adapter_with_same_token_is_locked_out(hub, make_adapter, hermes_home):
    import os
    lock_dir = os.environ["HERMES_GATEWAY_LOCK_DIR"]
    first = make_adapter()
    assert await first.connect() is True
    assert any(n.startswith("foxfleet-bot-") and n.endswith(".lock") for n in os.listdir(lock_dir))  # Hermes scoped lock
    second = make_adapter()  # same process (e.g. two multiplexed profiles sharing one token)
    assert await second.connect() is False
    assert second.fatal_error_code == "foxfleet-bot_lock"
    assert len(hub.auth_headers) == 1  # the loser never touched the hub
    await first.disconnect()
    assert not any(n.endswith(".lock") for n in os.listdir(lock_dir))  # the .flock file legitimately stays
    assert await second.connect() is True


def _recording_handler(events, reply=None):
    async def handler(event):
        events.append(event)
        return reply
    return handler


async def test_inbound_message_maps_source_and_acks_only_after_admission(hub, make_adapter):
    from gateway.config import Platform
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    await hub.push(chat_id=chat(7), text="hi fox", user_id="user_9", user_name="Ada", reply_to=bot_msg(0))
    await wait_for(lambda: hub.acks)
    assert hub.acks == [1]
    await wait_for(lambda: events)
    event = events[0]
    assert event.text == "hi fox" and event.message_id == human_msg(1) and event.reply_to_message_id == bot_msg(0)
    src = event.source
    assert (src.platform, src.chat_id, src.chat_type, src.user_id, src.user_name) == (
        Platform("foxfleet"), chat(7), "dm", "user_9", "Ada")
    assert await adapter.get_chat_info(chat(7)) == {"name": "Ada", "type": "dm", "chat_id": chat(7)}


async def test_slash_commands_reach_the_gateway_as_plain_text(hub, make_adapter):
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    await hub.push(text="/status")
    await wait_for(lambda: events)
    assert events[0].text == "/status" and events[0].get_command() == "status"
    await wait_for(lambda: hub.acks == [1])


async def test_no_gateway_admission_means_no_ack_and_no_dedupe_mark(hub, make_adapter):
    adapter = make_adapter()  # no message handler installed: handle_message drops the event
    assert await adapter.connect() is True
    await hub.push(text="lost?")
    await wait_for(lambda: len(hub.auth_headers) >= 2)  # resync: reconnect, hub replays from ack 0
    assert hub.acks == [] and hub.acked == 0
    events = []
    adapter.set_message_handler(_recording_handler(events))
    await wait_for(lambda: events, timeout=5)  # replayed and now admitted exactly once
    await wait_for(lambda: hub.acked == 1)
    assert [e.text for e in events] == ["lost?"]


async def test_failed_admission_then_queued_skip_never_advances_the_floor(hub, make_adapter):
    import json
    adapter = make_adapter()  # no handler: event 1 cannot be admitted
    gate = asyncio.Event()
    real_handle = adapter.handle_message

    async def slow_handle(event):
        await gate.wait()
        await real_handle(event)

    adapter.handle_message = slow_handle
    assert await adapter.connect() is True
    await hub.push(text="must not be lost")  # event 1
    hub.events.append({"t": "x.future", "event_id": 2})
    await hub.ws.send_json(hub.events[-1])  # event 2: unknown durable frame, queued behind event 1
    await wait_for(lambda: adapter._queue.qsize() == 1)  # event 1 held in admission, event 2 queued
    gate.set()
    await wait_for(lambda: len(hub.connections) >= 2)  # failed admission resynced
    assert hub.acks == [] and adapter._admitted == 0
    if adapter._state_path.exists():
        assert json.loads(adapter._state_path.read_text())["admitted"] == 0
    events = []
    adapter.set_message_handler(_recording_handler(events))
    await wait_for(lambda: hub.acked == 2, timeout=5)
    assert [e.text for e in events] == ["must not be lost"] and hub.acks == [1, 2]


async def test_handler_send_while_busy_does_not_deadlock_the_reader(hub, make_adapter):
    """FAKE MODEL (controlled, no provider): turn 1 blocks like a long agent run; a /status arriving
    meanwhile is dispatched INLINE by the real base busy path, and its handler awaits send() — which
    needs the socket reader to deliver the res frame while the dispatcher is still inside admission."""
    adapter = make_adapter()
    release = asyncio.Event()
    seen = []

    async def handler(event):
        seen.append(event.text)
        if event.text == "long task":
            await release.wait()
            return "FAKE MODEL: long task done"
        result = await adapter.send(event.source.chat_id, "FAKE MODEL: status ok")
        assert result.success and result.message_id
        return None

    adapter.set_message_handler(handler)
    assert await adapter.connect() is True
    await hub.push(text="long task")
    await wait_for(lambda: seen == ["long task"])
    await hub.push(text="/status")
    await wait_for(lambda: any(f["text"] == "FAKE MODEL: status ok" for f in hub.ops("message.send")), timeout=5)
    await wait_for(lambda: hub.acked == 2)
    release.set()
    await wait_for(lambda: any(f["text"] == "FAKE MODEL: long task done" for f in hub.ops("message.send")),
                   timeout=5)


async def _start_long_task(hub, adapter, handler_for_other):
    release = asyncio.Event()
    seen = []

    async def handler(event):
        seen.append(event.text)
        if event.text == "long task":
            await release.wait()
            return None
        return await handler_for_other(event)

    adapter.set_message_handler(handler)
    assert await adapter.connect() is True
    await hub.push(text="long task")
    await wait_for(lambda: seen == ["long task"])
    await wait_for(lambda: hub.acked == 1)
    return release, seen


async def test_failed_inline_command_while_busy_is_not_acked_and_is_redelivered(hub, make_adapter):
    adapter = make_adapter()
    attempts = []

    async def other(event):
        attempts.append(event.text)
        if len(attempts) == 1:
            raise RuntimeError("inline command blew up")
        return None

    release, seen = await _start_long_task(hub, adapter, other)
    await hub.push(text="/status")
    await wait_for(lambda: len(hub.connections) >= 2)  # base swallowed the error: only the receipt tells
    await wait_for(lambda: hub.acked == 2, timeout=5)  # redelivered, handled, now acked
    assert attempts == ["/status", "/status"] and hub.acks == [1, 2]
    assert hub.ack_conns == [0, 1]  # event 2 was never acked on the socket where it failed
    release.set()


async def test_busy_text_in_queue_mode_is_acked_only_once_held_in_the_debounce_buffer(hub, make_adapter):
    adapter = make_adapter()
    adapter._busy_text_mode = "queue"
    adapter._busy_text_debounce_seconds = 30.0
    release, seen = await _start_long_task(hub, adapter, lambda e: asyncio.sleep(0))
    key = adapter._event_session_key(_probe_event(adapter))
    await hub.push(text="follow-up while busy")
    await wait_for(lambda: hub.acked == 2)
    assert adapter._text_debounce_store().get(key) is not None
    release.set()


def _probe_event(adapter):
    from gateway.platforms.event import MessageEvent, MessageType
    source = adapter.build_source(chat_id=chat(1), chat_name="x", chat_type="dm", user_id="user_1")
    return MessageEvent(text="x", message_type=MessageType.TEXT, source=source)


async def test_runner_busy_handler_receipt_is_required_not_the_busy_snapshot(hub, make_adapter):
    adapter = make_adapter()
    verdicts = []

    async def runner_busy(event, session_key):
        verdicts.append(event.text)
        return True  # the runner stored / answered it

    release, seen = await _start_long_task(hub, adapter, lambda e: asyncio.sleep(0))
    adapter.set_busy_session_handler(runner_busy)
    await hub.push(text="steer please")
    await wait_for(lambda: hub.acked == 2)
    assert verdicts == ["steer please"] and hub.acks == [1, 2]
    release.set()


async def test_busy_state_alone_is_not_a_receipt(hub, make_adapter):
    """A busy session whose handling raised before any queueing must not be acknowledged."""
    adapter = make_adapter()
    release, seen = await _start_long_task(hub, adapter, lambda e: asyncio.sleep(0))
    real_inline = adapter._dispatch_inline_reply
    calls = []

    async def no_receipt(event, **kwargs):  # the reply path returns without raising or stamping
        calls.append(event.text)
        return None

    adapter._dispatch_inline_reply = no_receipt
    await hub.push(text="/status")
    await wait_for(lambda: len(hub.connections) >= 2)
    assert hub.acks == [1]  # no receipt, so never acked while the patch is active
    adapter._dispatch_inline_reply = real_inline
    await wait_for(lambda: hub.acked == 2, timeout=5)
    assert hub.acks == [1, 2] and len(calls) >= 1 and hub.ack_conns[0] == 0 and hub.ack_conns[1] >= 1
    release.set()


async def test_reconnect_replay_of_admitted_event_is_reacked_not_redispatched(hub, make_adapter):
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    await hub.push(text="one")
    await wait_for(lambda: hub.acked == 1)
    hub.acked = 0  # the hub lost the persisted ack (e.g. crashed before fsync) ...
    await hub.ws.close(code=1011, message=b"hub restart")
    await wait_for(lambda: len(hub.connections) == 2 and hub.acks.count(1) == 2)  # ... replay re-acked
    await hub.push(text="two")
    await wait_for(lambda: hub.acked == 2)
    await asyncio.sleep(0.05)
    assert [e.text for e in events] == ["one", "two"]


async def test_restart_uses_persisted_admitted_floor_against_a_lagging_hub(hub, make_adapter):
    first = make_adapter()
    events = []
    first.set_message_handler(_recording_handler(events))
    assert await first.connect() is True
    await hub.push(text="before restart")
    await wait_for(lambda: hub.acked == 1)
    await first.disconnect()
    hub.acked = 0  # ack never became durable hub-side
    second = make_adapter()  # new process: empty dedupe cache, same HERMES_HOME state file
    second.set_message_handler(_recording_handler(events))
    assert await second.connect() is True
    await wait_for(lambda: hub.acked == 1)
    await asyncio.sleep(0.05)
    assert [e.text for e in events] == ["before restart"]


async def test_admission_finishing_after_socket_replacement_acks_only_on_the_new_socket(hub, make_adapter):
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    gate = asyncio.Event()
    real_handle = adapter.handle_message

    async def slow_handle(event):  # wraps the REAL base handle_message
        await gate.wait()
        await real_handle(event)

    adapter.handle_message = slow_handle
    assert await adapter.connect() is True
    await hub.push(text="slow")
    await asyncio.sleep(0.05)
    await hub.ws.close(code=1011)
    await wait_for(lambda: len(hub.connections) == 2)
    gate.set()  # admission of the OLD socket's copy completes now; the replay is a duplicate
    await wait_for(lambda: hub.acked == 1)
    await asyncio.sleep(0.05)
    assert set(hub.ack_conns) == {1} and [e.text for e in events] == ["slow"]


async def test_unpersistable_floor_is_never_acked_and_recovers_by_replay(hub, make_adapter, monkeypatch, caplog):
    import errno
    import logging
    from foxfleet import adapter as ff
    caplog.set_level(logging.WARNING)
    real_write = ff.atomic_json_write
    failing = {"on": True}

    def flaky_write(*args, **kwargs):
        if failing["on"]:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_write(*args, **kwargs)

    monkeypatch.setattr(ff, "atomic_json_write", flaky_write)
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    await hub.push(text="durable please")
    await wait_for(lambda: len(hub.connections) >= 2)  # not persisted: socket resynced
    assert hub.acks == [] and adapter._admitted == 0
    assert "could not persist the admitted floor" in caplog.text
    failing["on"] = False
    await wait_for(lambda: hub.acked == 1, timeout=5)
    assert [e.text for e in events] == ["durable please"] and adapter._admitted == 1
    assert set(hub.ack_conns) <= set(range(1, len(hub.connections)))  # never acked on the failing socket


async def test_send_edit_delete_typing_return_hub_ids_and_match_signatures(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    sent = await adapter.send(chat(1), "**hi**", reply_to=human_msg(1))
    assert (sent.success, sent.message_id, sent.continuation_message_ids) == (True, bot_msg(1), ())
    frame = hub.ops("message.send")[0]
    assert {k: frame[k] for k in ("chat_id", "text", "format", "reply_to")} == {
        "chat_id": chat(1), "text": "**hi**", "format": "markdown", "reply_to": human_msg(1)}
    assert frame["idempotency_key"] and frame["id"]
    edited = await adapter.edit_message(chat(1), bot_msg(1), "**hi** there", finalize=True)
    assert (edited.success, edited.message_id) == (True, bot_msg(1)) and hub.sent[bot_msg(1)]["text"] == "**hi** there"
    missing = await adapter.edit_message(chat(1), human_msg(99), "x")
    assert (missing.success, missing.error_kind) == (False, "not_found")
    assert await adapter.delete_message(chat(1), bot_msg(1)) is True and hub.sent[bot_msg(1)]["deleted"]
    assert await adapter.delete_message(chat(2), bot_msg(1)) is False  # hub refuses: not this chat
    assert await adapter.send_typing(chat(1)) is None
    assert hub.ops("chat.action")[0]["action"] == "typing"


async def test_long_text_split_by_utf8_bytes_without_loss(hub, make_adapter):
    from foxfleet import protocol
    adapter = make_adapter()
    assert await adapter.connect() is True
    content = "\U0001F98A fox line\n" * 6000  # ~90 KB of UTF-8
    result = await adapter.send(chat(1), content)
    texts = [f["text"] for f in hub.ops("message.send")]
    assert len(texts) == 2 and "".join(texts) == content
    assert all(protocol.utf8_len(t) <= protocol.MAX_TEXT_BYTES for t in texts)
    assert result.success and result.message_id == bot_msg(2) and result.continuation_message_ids == (bot_msg(1),)
    keys = {f["idempotency_key"] for f in hub.ops("message.send")}
    assert len(keys) == 2  # each chunk is its own logical message


async def test_unsupported_thread_and_oversized_edit_are_refused_explicitly(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    threaded = await adapter.send(chat(1), "x", metadata={"thread_id": "t1"})
    assert threaded.success is False and "thread" in threaded.error
    big = await adapter.edit_message(chat(1), bot_msg(1), "a" * (64 * 1024 + 1))
    assert (big.success, big.error_kind) == (False, "too_long")
    assert hub.ops("message.send") == [] and hub.ops("message.edit") == []


async def test_rpc_errors_map_to_send_result_kinds(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    hub.rpc_override = lambda f: hub.error(f["id"], "rate_limited", "slow down")
    limited = await adapter.send(chat(1), "x")
    assert (limited.success, limited.error_kind, limited.retryable) == (False, "rate_limited", True)
    hub.rpc_override = lambda f: hub.error(f["id"], "forbidden", "not your chat")
    refused = await adapter.send(chat(1), "x")
    assert (refused.success, refused.error_kind, refused.retryable) == (False, "forbidden", False)


async def test_unknown_res_ids_ignored_and_malformed_res_fails_only_its_request(hub, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True

    async def stray_then_real(frame):
        await hub.ws.send_json(hub.ok("not-a-request", message_id="evil"))
        return NotImplemented  # then the default (real) response
    hub.rpc_override = stray_then_real
    ok = await adapter.send(chat(1), "a")
    assert (ok.success, ok.message_id) == (True, bot_msg(1))
    hub.rpc_override = lambda f: {"t": "res", "id": f["id"], "ok": "maybe"}
    bad = await adapter.send(chat(1), "b")
    assert bad.success is False and bad.retryable is False
    hub.rpc_override = lambda f: hub.ok(f["id"])  # ok but no message_id
    assert (await adapter.send(chat(1), "c")).success is False
    assert adapter.is_connected and adapter._pending == {}


async def test_malformed_or_oversized_hub_frames_resync_without_ack(hub, make_adapter):
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    await hub.send_raw("{not json")
    await wait_for(lambda: len(hub.connections) == 2)
    await hub.ws.send_str('{"t":"message.new","pad":"' + "a" * (1024 * 1024) + '"}')
    await wait_for(lambda: len(hub.connections) == 3)
    await hub.push(text="after resync")
    await wait_for(lambda: hub.acked == 1)
    assert [e.text for e in events] == ["after resync"] and hub.acks == [1]


@pytest.mark.parametrize("answer", [
    lambda hub, f: hub.ok(f["id"]),
    lambda hub, f: hub.ok(f["id"], message_id="bad id"),
    lambda hub, f: hub.error(f["id"], "internal", "boom"),
], ids=["no-message-id", "malformed-message-id", "internal-error"])
async def test_unknown_outcome_keeps_the_idempotency_key_for_the_caller_retry(hub, make_adapter, answer):
    adapter = make_adapter()
    assert await adapter.connect() is True
    hub.rpc_override = lambda f: answer(hub, f)
    first = await adapter.send(chat(1), "maybe created", reply_to=human_msg(3))
    assert first.success is False and first.error_kind == "unknown"
    again = await adapter.send(chat(1), "maybe created", reply_to=human_msg(3))
    assert again.success is False
    other = await adapter.send(chat(1), "different text")
    frames = hub.ops("message.send")
    assert frames[0]["idempotency_key"] == frames[1]["idempotency_key"] != frames[2]["idempotency_key"]


def _lose_first_response(hub, *, close=False):
    """Hub CREATES the message, then the response is lost (dropped, or the socket dies)."""
    state = {"dropped": 0}

    async def override(frame):
        if frame["t"] != "message.send" or state["dropped"]:
            return NotImplemented
        state["dropped"] += 1
        hub.default_res(frame)
        if close:
            await hub.ws.close(code=1011)
        return None
    hub.rpc_override = override
    return state


@pytest.mark.parametrize("close", [False, True], ids=["timeout", "socket-drop"])
async def test_response_loss_retry_reuses_idempotency_key(hub, make_adapter, close):
    adapter = make_adapter()
    adapter.RPC_TIMEOUT = 0.2
    assert await adapter.connect() is True
    _lose_first_response(hub, close=close)
    result = await adapter.send(chat(1), "exactly once")
    frames = hub.ops("message.send")
    assert len(frames) == 2 and frames[0]["idempotency_key"] == frames[1]["idempotency_key"]
    assert frames[0]["id"] != frames[1]["id"]  # fresh request id, same idempotency key
    assert (result.success, result.message_id) == (True, bot_msg(1)) and len(hub.sent) == 1


async def test_caller_retry_after_unknown_outcome_reuses_key_only_for_same_content(hub, make_adapter):
    adapter = make_adapter()
    adapter.RPC_TIMEOUT = 0.2
    adapter.MAX_SEND_ATTEMPTS = 1
    assert await adapter.connect() is True
    _lose_first_response(hub)
    first = await adapter.send(chat(1), "hello")
    assert (first.success, first.retryable, first.error_kind) == (False, True, "transient")
    again = await adapter.send(chat(1), "hello")  # e.g. base _send_with_retry
    assert (again.success, again.message_id) == (True, bot_msg(1)) and len(hub.sent) == 1
    other = await adapter.send(chat(1), "hello")  # a NEW identical message after success
    assert other.message_id == bot_msg(2)
    keys = [f["idempotency_key"] for f in hub.ops("message.send")]
    assert keys[0] == keys[1] != keys[2]


async def test_full_dispatch_queue_pauses_and_resyncs_without_dropping(hub, make_adapter):
    adapter = make_adapter()
    adapter.DISPATCH_QUEUE_SIZE = 2
    events = []
    adapter.set_message_handler(_recording_handler(events))
    gate = asyncio.Event()
    real_handle = adapter.handle_message

    async def slow_handle(event):  # a stalled gateway; wraps the REAL handle_message
        await gate.wait()
        await real_handle(event)

    adapter.handle_message = slow_handle
    assert await adapter.connect() is True
    for i in range(6):
        await hub.push(text=f"m{i + 1}", chat_id=chat(i))  # distinct chats: no busy merging
    await asyncio.sleep(0.1)
    assert hub.acks == []  # nothing acknowledged while stalled
    gate.set()
    await wait_for(lambda: hub.acked == 6, timeout=8)
    assert len(hub.connections) >= 2  # overflow forced a resync from the cumulative ack
    assert sorted(e.text for e in events) == [f"m{i}" for i in range(1, 7)]
    assert len(events) == 6 and hub.acks == sorted(hub.acks)


async def test_inflight_requests_and_caches_are_bounded(hub, make_adapter):
    adapter = make_adapter()
    adapter.MAX_PENDING_RPCS = 1
    adapter.RPC_TIMEOUT = 0.3
    adapter.MAX_SEND_ATTEMPTS = 1
    adapter.MAX_CHAT_CACHE = 2
    adapter.set_message_handler(_recording_handler([]))
    assert await adapter.connect() is True
    await wait_for(lambda: hub.commands)  # connect-time commands.set settled
    hub.rpc_override = lambda f: None  # hub never answers
    first = asyncio.create_task(adapter.send(chat(1), "a"))
    await asyncio.sleep(0.05)
    second = await adapter.send(chat(1), "b")
    assert second.success is False and "too many" in second.error
    assert (await first).success is False and adapter._pending == {}
    hub.rpc_override = None
    for i in range(4):
        await hub.push(chat_id=chat(i))
    await wait_for(lambda: hub.acked == 4)
    assert len(adapter._chat_names) == 2


async def test_unsupported_echo_unknown_events_are_acked_in_order_but_never_prompts(hub, make_adapter, caplog):
    import logging
    caplog.set_level(logging.INFO)
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    sent = await adapter.send(chat(1), "my own reply")
    await hub.push(chat_type="group", text="group msg")                 # 1 unsupported
    await hub.push(thread_id="t9", text="thread msg")                   # 2 unsupported
    await hub.push(user_id=hub.bot_id, text="self echo by user id")      # 3 echo
    await hub.push(text="echo by message id", message_id=sent.message_id)  # 4 echo
    hub.events.append({"t": "message.reaction", "event_id": 5})        # 5 future extension
    await hub.ws.send_json(hub.events[-1])
    await hub.push(text="real prompt")                                  # 6
    await wait_for(lambda: hub.acked == 6)
    assert [e.text for e in events] == ["real prompt"] and hub.acks == [1, 2, 3, 4, 5, 6]
    assert "not handled" in caplog.text and "unsupported_chat_type" in caplog.text


@pytest.mark.parametrize("order", [(2,), (2, 1)], ids=["skips-ahead", "inverted"])
async def test_event_sequence_gap_or_inversion_faults_without_acking_past_it(hub, make_adapter, order, caplog):
    import logging
    caplog.set_level(logging.ERROR)
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    assert await adapter.connect() is True
    frames = {1: await hub.push(text="first", send=False), 2: await hub.push(text="second", chat_id=chat(2), send=False)}
    for n in order:  # the hub log is intact; this one SOCKET delivers event 2 before 1
        await hub.ws.send_json(frames[n])
    await wait_for(lambda: len(hub.connections) == 2)
    assert hub.connections[0].close_code == 1002 and 0 not in hub.ack_conns
    assert "event_gap" in caplog.text
    await wait_for(lambda: hub.acked == 2, timeout=5)  # reconnect replays 1, 2 in order
    assert hub.acks == [1, 2] and set(hub.ack_conns) == {1}
    assert [e.text for e in events] == ["first", "second"]


async def test_duplicate_of_a_queued_event_on_one_socket_is_ignored(hub, make_adapter):
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    gate = asyncio.Event()
    real_handle = adapter.handle_message

    async def slow_handle(event):
        await gate.wait()
        await real_handle(event)

    adapter.handle_message = slow_handle
    assert await adapter.connect() is True
    first = await hub.push(text="once")
    await hub.ws.send_json(first)
    await wait_for(lambda: adapter._conn.last_event_id == 1)
    gate.set()
    await wait_for(lambda: hub.acks)
    await asyncio.sleep(0.05)
    assert [e.text for e in events] == ["once"] and hub.acks == [1] and len(hub.connections) == 1


async def test_replay_gap_fails_closed_and_ping_is_still_answered(hub, make_adapter, caplog):
    import logging
    caplog.set_level(logging.WARNING)
    adapter = make_adapter()
    fatal = []
    adapter.set_fatal_error_handler(lambda a: fatal.append((a.fatal_error_code, a.fatal_error_retryable)))
    assert await adapter.connect() is True
    await hub.ws.send_json({"t": "ping", "id": "p1"})
    await wait_for(lambda: hub.ops("pong"))
    assert hub.ops("pong") == [{"t": "pong", "id": "p1"}]
    await hub.ws.send_json({"t": "replay.gap", "from_event_id": 3, "to_event_id": 9, "count": 7})
    await hub.push(text="after the gap")
    await wait_for(lambda: fatal)
    assert fatal == [("foxfleet_protocol", False)] and adapter.is_connected is False
    assert "replay gap" in adapter.fatal_error_message and hub.acks == []
    assert not hasattr(adapter, "last_gap")
    await wait_for(lambda: hub.connections[0].closed)
    await asyncio.sleep(0.15)
    assert len(hub.auth_headers) == 1


@pytest.mark.parametrize("code,expected", [("unauthorized", "foxfleet_auth_rejected"),
                                           ("replaced", "foxfleet_replaced")])
async def test_fatal_error_frame_closes_the_socket_without_waiting_for_the_hub(hub, make_adapter, code, expected):
    adapter = make_adapter()
    events = []
    adapter.set_message_handler(_recording_handler(events))
    fatal = []
    adapter.set_fatal_error_handler(lambda a: fatal.append(a.fatal_error_code))
    assert await adapter.connect() is True
    first = hub.ws
    await first.send_json({"t": "error", "code": code, "message": "hub says stop"})
    await hub.push(text="queued right behind the error")  # hub keeps the socket open and keeps talking
    await wait_for(lambda: fatal, timeout=2)
    assert fatal == [expected] and adapter.is_connected is False
    await wait_for(lambda: first.closed, timeout=2)  # the adapter, not the hub, closed it
    await asyncio.sleep(0.15)
    assert events == [] and hub.acks == [] and len(hub.auth_headers) == 1 and fatal == [expected]


async def test_disconnect_resolves_pending_rpcs_cancels_tasks_and_releases_lock(hub, make_adapter):
    import os
    adapter = make_adapter()
    assert await adapter.connect() is True
    await wait_for(lambda: hub.commands)
    hub.rpc_override = lambda f: None
    pending = asyncio.create_task(adapter.send(chat(1), "never answered"))
    await wait_for(lambda: adapter._pending)
    tasks = [adapter._supervisor_task, adapter._dispatcher_task]
    await asyncio.wait_for(adapter.disconnect(), timeout=2)
    result = await asyncio.wait_for(pending, timeout=2)
    assert result.success is False and adapter._pending == {}
    assert all(t.done() for t in tasks) and not adapter._side_tasks
    assert not [n for n in os.listdir(os.environ["HERMES_GATEWAY_LOCK_DIR"]) if n.endswith(".lock")]
    assert adapter.is_connected is False


async def test_disconnect_interrupts_reconnect_backoff(hub, make_adapter):
    adapter = make_adapter()
    adapter.RECONNECT_BASE_DELAY = adapter.RECONNECT_MAX_DELAY = 30.0  # would sleep for long
    assert await adapter.connect() is True
    hub.reject_status = 503
    await hub.ws.close(code=1011)
    await asyncio.sleep(0.05)
    await asyncio.wait_for(adapter.disconnect(), timeout=2)
    assert adapter._supervisor_task is None


async def test_unknown_outcome_is_not_downgraded_to_not_sent_when_reconnect_fails(hub, make_adapter):
    adapter = make_adapter()
    adapter.SEND_RECONNECT_WAIT = 0.2
    adapter.RECONNECT_BASE_DELAY = adapter.RECONNECT_MAX_DELAY = 0.5
    assert await adapter.connect() is True
    await wait_for(lambda: hub.commands)
    _lose_first_response(hub, close=True)  # created hub-side, then the socket dies ...
    hub.reject_status = 503  # ... and the hub stays down past the send's reconnect wait
    first = await adapter.send(chat(1), "maybe delivered")
    assert first.success is False and first.retryable is True
    hub.reject_status = None
    await wait_for(lambda: adapter._conn is not None, timeout=5)
    again = await adapter.send(chat(1), "maybe delivered")
    assert (again.success, again.message_id) == (True, bot_msg(1)) and len(hub.sent) == 1


async def test_real_gateway_stream_consumer_streams_by_send_then_edit(hub, make_adapter):
    """FAKE MODEL deltas (controlled) driven through Hermes' real GatewayStreamConsumer."""
    from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
    adapter = make_adapter()
    assert await adapter.connect() is True
    consumer = GatewayStreamConsumer(adapter, chat(1), StreamConsumerConfig(
        edit_interval=0.01, buffer_threshold=1, cursor=""))
    runner = asyncio.create_task(consumer.run())
    for piece in ("FAKE MODEL: ", "streaming ", "works", " fine."):
        consumer.on_delta(piece)
        await asyncio.sleep(0.05)
    consumer.finish("FAKE MODEL: streaming works fine.")
    await asyncio.wait_for(runner, timeout=5)
    live = [m for m in hub.sent.values() if not m["deleted"]]
    assert [m["text"] for m in live] == ["FAKE MODEL: streaming works fine."]
    assert hub.ops("message.edit")  # progressive edits, not one bubble per delta
    assert hub.finals[-1] is True  # the finalize edit ends the user's live run view


async def test_reconnect_after_fatal_stop_does_not_leak_the_old_dispatcher(hub, make_adapter):
    adapter = make_adapter()
    fatal = []
    adapter.set_fatal_error_handler(lambda a: fatal.append(a.fatal_error_code))
    assert await adapter.connect() is True
    old_dispatcher = adapter._dispatcher_task
    await hub.ws.close(code=4009)  # replaced: fatal, supervisor stops
    await wait_for(lambda: fatal)
    assert await adapter.connect() is True  # runner retries without an explicit disconnect()
    await asyncio.sleep(0)
    assert old_dispatcher.done() and adapter._dispatcher_task is not old_dispatcher


async def test_runtime_status_shows_retrying_during_reconnect_then_connected(hub, make_adapter):
    adapter = make_adapter()
    states = []
    real = adapter._write_runtime_status_safe

    def spy(context, **kwargs):
        states.append(kwargs.get("platform_state"))
        return real(context, **kwargs)

    adapter._write_runtime_status_safe = spy
    assert await adapter.connect() is True
    assert states[-1] == "connected"
    hub.reject_status = 503
    await hub.ws.close(code=1011)
    await wait_for(lambda: states[-1] == "retrying")
    hub.reject_status = None
    await wait_for(lambda: states[-1] == "connected" and len(hub.connections) == 2, timeout=5)
