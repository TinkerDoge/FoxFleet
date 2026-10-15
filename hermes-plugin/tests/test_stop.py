"""chat.stop: a transient hub Stop becomes Hermes /stop, and only then is answered."""

from __future__ import annotations

import asyncio
import time

import pytest
import pytest_asyncio

from gateway.config import PlatformConfig

from fakehub import SUBPROTOCOL_V11, FakeHub, chat, wait_for
from foxfleet import protocol as p
from foxfleet.adapter import FoxFleetAdapter

BOT = "0123456789abcdef01234567"
STOP = "fs_" + "a" * 16


def _frame(**over):
    frame = {"t": "chat.stop", "stop_id": STOP, "chat_id": chat(1),
             "user": {"id": "user_1", "name": "Ada"}, "date": 1_700_000_000_000,
             "expires_at": int(time.time() * 1000) + 10_000}
    frame.update(over)
    return frame


def test_hello_accepts_1_1_and_rejects_a_bad_feature_list():
    hello = p.parse_hello({"t": "hello", "protocol": p.PROTOCOL_V11, "bot": BOT, "resume_from": 0,
                           "latest_event_id": 0, "features": ["stop"]})
    assert hello.protocol == p.PROTOCOL_V11 and hello.features == frozenset({"stop"})
    with pytest.raises(p.ProtocolError):
        p.parse_hello({"t": "hello", "protocol": p.PROTOCOL_V11, "bot": BOT, "resume_from": 0,
                       "latest_event_id": 0, "features": ["Stop"]})


def test_chat_stop_is_transient_and_strict():
    stop = p.parse_chat_stop(_frame())
    assert (stop.stop_id, stop.chat_id, stop.user_id, stop.user_name) == (STOP, chat(1), "user_1", "Ada")
    for bad in (_frame(event_id=1), _frame(stop_id="fs_short"), _frame(user={"name": "x"}),
                _frame(extra=1), _frame(expires_at=-1)):
        with pytest.raises(p.ProtocolError):
            p.parse_chat_stop(bad)


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


async def _connect(hub, make_adapter, *, v11=True):
    hub.speak_v11 = v11
    adapter = make_adapter()
    seen = []

    async def handler(event):
        seen.append(event.text)
        return "Stopped."

    adapter.set_message_handler(handler)
    assert await adapter.connect() is True
    return adapter, seen


@pytest.mark.asyncio
async def test_active_stop_is_dispatched_once_and_the_reply_is_not_sent(hub, make_adapter):
    adapter, seen = await _connect(hub, make_adapter)
    assert adapter._conn.ws.subprotocol == SUBPROTOCOL_V11 and adapter._conn.stop_enabled
    source = adapter.build_source(chat_id=chat(1), user_id="user_1", chat_type="dm", user_name="Ada")
    adapter._active_sessions[adapter._source_session_key(source)] = asyncio.Event()
    await hub.ws.send_json(_frame())
    await wait_for(lambda: hub.stop_answers)
    assert seen == ["/stop"]
    assert hub.stop_answers[0]["outcome"] == "stopped"
    assert hub.stop_answers[0]["callback_id"] == STOP
    await asyncio.sleep(0.05)
    assert hub.ops("message.send") == []
    later = await adapter.send(chat(1), "next turn")
    assert later.success and later.message_id != "fm_suppressed000000"
    assert any(f["text"] == "next turn" for f in hub.ops("message.send"))


@pytest.mark.asyncio
async def test_an_active_stop_does_not_suppress_a_task_spawned_during_dispatch(hub, make_adapter):
    adapter, _seen = await _connect(hub, make_adapter)
    source = adapter.build_source(chat_id=chat(1), user_id="user_1", chat_type="dm", user_name="Ada")
    adapter._active_sessions[adapter._source_session_key(source)] = asyncio.Event()
    copied = []

    async def fake_handle(event):
        async def child():
            copied.append(str(event.source.chat_id) in adapter._suppress_stop_reply)
            result = await adapter.send(event.source.chat_id, "follow-up")
            copied.append(result.message_id)
        task = asyncio.create_task(child())
        await task

    adapter.handle_message = fake_handle
    await hub.ws.send_json(_frame())
    await wait_for(lambda: hub.stop_answers)
    # The one-shot is armed for the Stop reply. A task spawned during dispatch must
    # not be born unable to send; this fake handler never sends the acknowledgement,
    # so the follow-up send consumes it. The drain hooks clear a leftover before a
    # real follow-up starts. What must not happen is a ContextVar copy.
    assert copied[0] is True and copied[1] == "fm_suppressed000000"
    assert str(source.chat_id) not in adapter._suppress_stop_reply
    again = await adapter.send(chat(1), "after stop")
    assert again.message_id != "fm_suppressed000000"
    assert hub.stop_answers[0]["outcome"] == "stopped"


@pytest.mark.asyncio
async def test_a_stop_that_leaves_the_turn_running_is_refused(hub, make_adapter):
    adapter, _seen = await _connect(hub, make_adapter)
    source = adapter.build_source(chat_id=chat(1), user_id="user_1", chat_type="dm", user_name="Ada")
    key = adapter._source_session_key(source)
    adapter._active_sessions[key] = asyncio.Event()
    stuck = asyncio.get_running_loop().create_future()
    adapter._session_tasks[key] = stuck

    async def fake_handle(event):
        return None

    adapter.handle_message = fake_handle
    await hub.ws.send_json(_frame(stop_id="fs_" + "c" * 16))
    await wait_for(lambda: hub.stop_answers)
    assert hub.stop_answers[0]["outcome"] == "refused"
    stuck.cancel()


@pytest.mark.asyncio
async def test_idle_stop_answers_idle_and_still_dispatches(hub, make_adapter):
    adapter, seen = await _connect(hub, make_adapter)
    await hub.ws.send_json(_frame())
    await wait_for(lambda: hub.stop_answers)
    assert hub.stop_answers[0]["outcome"] == "idle"
    await wait_for(lambda: seen == ["/stop"])


@pytest.mark.asyncio
async def test_unauthorised_and_expired_stops_are_not_dispatched(hub, make_adapter):
    adapter, seen = await _connect(hub, make_adapter)
    adapter.set_authorization_check(lambda user_id, chat_type, chat_id, **_extra: False)
    await hub.ws.send_json(_frame())
    await wait_for(lambda: hub.stop_answers)
    assert hub.stop_answers[-1]["outcome"] == "refused" and seen == []
    await hub.ws.send_json(_frame(stop_id="fs_" + "b" * 16, expires_at=1))
    await wait_for(lambda: len(hub.stop_answers) == 2)
    assert hub.stop_answers[-1]["outcome"] == "expired" and seen == []


@pytest.mark.asyncio
async def test_a_1_0_socket_ignores_chat_stop(hub, make_adapter):
    adapter, seen = await _connect(hub, make_adapter, v11=False)
    assert adapter._conn.stop_enabled is False
    await hub.ws.send_json(_frame())
    await asyncio.sleep(0.05)
    assert hub.stop_answers == [] and seen == [] and adapter.is_connected


@pytest.mark.asyncio
async def test_a_malformed_stop_does_not_drop_the_socket(hub, make_adapter):
    adapter, seen = await _connect(hub, make_adapter)
    await hub.ws.send_json(_frame(user="nope"))
    await asyncio.sleep(0.05)
    assert adapter.is_connected and hub.stop_answers == [] and seen == []
