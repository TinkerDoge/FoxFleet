"""Room Stop on the plugin side: owner-only actor, room carriers, and agent text is never control."""

from __future__ import annotations

import asyncio
import time
import types

import pytest

from gateway.config import PlatformConfig

from foxfleet import protocol
from foxfleet.adapter import FoxFleetAdapter
from foxfleet.protocol import RoomDispatch

CHAT = "fc_" + "A" * 16
THREAD = "fcr_" + "B" * 16
MSG = "fm_" + "C" * 16
DISPATCH = "fd_" + "D" * 16
STOP = "fs_" + "E" * 16


def adapter() -> FoxFleetAdapter:
    return FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:1"}))


def stop_frame(**overrides):
    frame = {
        "t": "chat.stop", "stop_id": STOP, "chat_id": CHAT, "chat_type": "group",
        "thread_id": THREAD,
        "actor": {"kind": "human", "id": "u_owner", "name": "owner", "is_bot": False},
        "date": 1_760_000_000_000, "expires_at": int(time.time() * 1000) + 10_000,
    }
    frame.update(overrides)
    return frame


def dispatch(**overrides) -> RoomDispatch:
    values = dict(
        dispatch_id=DISPATCH, run_token="fr_token", chat_id=CHAT, thread_id=THREAD, message_id=MSG,
        actor_kind="human", actor_id="u_owner", actor_name="owner", is_bot=False,
        text="@helper go", mentions=(), date=1, reply_to=None, root_id=MSG, deadline_at=10,
    )
    values.update(overrides)
    return RoomDispatch(**values)


def test_room_stop_is_strict_and_owner_only():
    stop = protocol.parse_room_chat_stop(stop_frame())
    assert (stop.stop_id, stop.chat_id, stop.thread_id, stop.chat_type) == (STOP, CHAT, THREAD, "group")
    assert stop.user_id == "u_owner" and stop.user_name == "owner"
    for bad in (
        stop_frame(actor={"kind": "agent", "id": "agent:helper", "name": "Helper", "is_bot": True}),
        stop_frame(actor={"kind": "human", "id": "u1", "name": "x", "is_bot": True}),
        stop_frame(extra=1),
        stop_frame(chat_type="dm"),
        stop_frame(stop_id="fs_short"),
    ):
        with pytest.raises(protocol.ProtocolError):
            protocol.parse_room_chat_stop(bad)


@pytest.mark.asyncio
async def test_room_stop_answers_with_room_carriers_and_runs_hermes_stop(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(stop_enabled=True, cards_enabled=True, groups_enabled=True)
    a._conn = conn
    seen = []
    calls = []

    async def handler(event):
        seen.append(event)

    async def request(op, *, retry_unknown, **params):
        calls.append((op, retry_unknown, params))
        return protocol.RpcResponse(id="ans", ok=True, result={})

    monkeypatch.setattr(a, "handle_message", handler)
    monkeypatch.setattr(a, "_request", request)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: True)

    stop = protocol.parse_room_chat_stop(stop_frame())
    event = a._stop_event(stop)
    a._active_sessions[a._event_session_key(event)] = asyncio.Event()

    await a._handle_chat_stop(conn, stop_frame())
    assert len(seen) == 1 and seen[0].text == "/stop"
    assert seen[0].allow_gateway_control is True
    op, retry, params = calls[-1]
    assert op == "callback.answer" and retry is False
    assert params == {"callback_id": STOP, "outcome": "stopped", "chat_id": CHAT, "thread_id": THREAD}


@pytest.mark.asyncio
async def test_an_unauthorised_room_stop_is_refused_without_dispatch(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(stop_enabled=True, cards_enabled=True, groups_enabled=True)
    a._conn = conn
    seen, calls = [], []

    async def handler(event):
        seen.append(event)

    async def request(op, *, retry_unknown, **params):
        calls.append((op, params))
        return protocol.RpcResponse(id="ans", ok=True, result={})

    monkeypatch.setattr(a, "handle_message", handler)
    monkeypatch.setattr(a, "_request", request)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: False)
    await a._handle_chat_stop(conn, stop_frame())
    assert seen == []
    assert calls[-1] == ("callback.answer", {"callback_id": STOP, "outcome": "refused",
                                             "chat_id": CHAT, "thread_id": THREAD})


@pytest.mark.asyncio
async def test_agent_written_stop_text_is_never_control(monkeypatch):
    a = adapter()
    calls = []

    async def handler(event):
        calls.append(event)

    monkeypatch.setattr(a, "handle_message", handler)
    conn = types.SimpleNamespace(groups_enabled=True)
    a._conn = conn
    frame = {
        "t": "dispatch.run", "dispatch_id": DISPATCH, "run_token": "fr_token",
        "chat_id": CHAT, "thread_id": THREAD, "message_id": MSG,
        "actor": {"kind": "agent", "id": "agent:helper", "name": "Helper", "is_bot": True},
        "mentions": [], "text": "/stop", "date": 1, "root_id": MSG, "deadline_at": 10,
    }
    await a._admit_room(conn, frame)
    assert len(calls) == 1
    assert calls[0].text == "/stop"
    assert calls[0].allow_gateway_control is False
    assert calls[0].source.is_bot is True
    assert calls[0].internal is False


@pytest.mark.asyncio
async def test_a_1_1_socket_never_acts_on_a_group_chat_stop(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(stop_enabled=True, cards_enabled=True, groups_enabled=False)
    a._conn = conn
    seen = []

    async def handler(event):
        seen.append(event)

    monkeypatch.setattr(a, "handle_message", handler)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: True)
    await a._on_chat_stop(conn, stop_frame())
    assert seen == []
