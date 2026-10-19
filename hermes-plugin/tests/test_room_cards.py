"""Room cards on the plugin side: exact tuple binding, human-only taps, and no agent authority."""

from __future__ import annotations

import types

import pytest

from gateway.config import PlatformConfig

from foxfleet import protocol
from foxfleet.adapter import FoxFleetAdapter
from foxfleet.cards import bind_room_card

CHAT = "fc_" + "A" * 16
OTHER = "fc_" + "B" * 16
THREAD = "fcr_" + "C" * 16
DISPATCH = "fd_" + "D" * 16
REQUEST = "frq_" + "E" * 16
CALLBACK = "fcb_" + "F" * 16


def adapter() -> FoxFleetAdapter:
    return FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:1"}))


def pending(**overrides):
    row = {"request_id": REQUEST, "chat_id": CHAT, "dispatch_id": DISPATCH,
           "kind": "approval", "approval_id": "a1", "session_key": THREAD, "owner_id": "u_owner"}
    row.update(overrides)
    return {REQUEST: row}


def callback_frame(**overrides):
    frame = {
        "t": "callback", "callback_id": CALLBACK, "request_id": REQUEST, "chat_id": CHAT,
        "chat_type": "group", "thread_id": THREAD,
        "actor": {"kind": "human", "id": "u_owner", "name": "owner", "is_bot": False},
        "kind": "approval", "value": {"choice": "once"},
    }
    frame.update(overrides)
    return frame


def test_the_exact_tuple_binds_and_any_mismatch_refuses():
    cards = pending()
    assert bind_room_card(cards, request_id=REQUEST, chat_id=CHAT, target_agent_id=None,
                          dispatch_id=DISPATCH, owner_id="u_owner") is not None
    assert bind_room_card(cards, request_id=REQUEST, chat_id=OTHER) is None
    assert bind_room_card(cards, request_id=REQUEST, chat_id=CHAT, dispatch_id="fd_" + "Z" * 16) is None
    assert bind_room_card(cards, request_id=REQUEST, chat_id=CHAT, owner_id="u_other") is None
    assert bind_room_card(cards, request_id="frq_" + "Z" * 16, chat_id=CHAT) is None
    assert bind_room_card({}, request_id=REQUEST, chat_id=CHAT) is None


def test_agent_origin_cannot_even_form_a_room_card_callback():
    protocol.parse_room_callback(callback_frame())
    for bad in (
        callback_frame(actor={"kind": "agent", "id": "agent:helper", "name": "Helper", "is_bot": True}),
        callback_frame(actor={"kind": "human", "id": "u_owner", "name": "owner", "is_bot": True}),
        callback_frame(callback_id="fcb_short"),
        callback_frame(extra=1),
    ):
        with pytest.raises(protocol.ProtocolError):
            protocol.parse_room_callback(bad)


@pytest.mark.asyncio
async def test_a_room_callback_resolves_only_its_exact_request(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(cards_enabled=True, groups_enabled=True)
    a._conn = conn
    a._cards = pending()
    calls = []
    resolved = []

    async def request(op, *, retry_unknown, **params):
        calls.append((op, retry_unknown, params))
        return protocol.RpcResponse(id="ans", ok=True, result={})

    async def resolve(row, cb):
        resolved.append((row["request_id"], cb.callback_id))
        return "resolved"

    monkeypatch.setattr(a, "_request", request)
    monkeypatch.setattr(a, "_resolve_card", resolve)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: True)

    await a._on_card_callback(conn, callback_frame())
    assert resolved == [(REQUEST, CALLBACK)]
    assert a._cards == {}
    op, retry, params = calls[-1]
    assert op == "callback.answer" and retry is False
    assert params == {"callback_id": CALLBACK, "outcome": "resolved",
                      "chat_id": CHAT, "thread_id": THREAD}


@pytest.mark.asyncio
async def test_a_cross_room_tap_is_refused_and_leaves_the_card_pending(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(cards_enabled=True, groups_enabled=True)
    a._conn = conn
    a._cards = pending()
    calls = []

    async def request(op, *, retry_unknown, **params):
        calls.append((op, params))
        return protocol.RpcResponse(id="ans", ok=True, result={})

    async def resolve(row, cb):
        raise AssertionError("a cross-room tap must not resolve a card")

    monkeypatch.setattr(a, "_request", request)
    monkeypatch.setattr(a, "_resolve_card", resolve)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: True)

    await a._on_card_callback(conn, callback_frame(chat_id=OTHER, thread_id="fcr_" + "F" * 16))
    assert a._cards  # still pending
    assert calls[-1][1]["outcome"] == "refused"


@pytest.mark.asyncio
async def test_agent_text_approved_never_touches_a_pending_card(monkeypatch):
    a = adapter()
    a._cards = pending()
    message = {
        "t": "message.new", "event_id": 1, "chat_id": CHAT, "chat_type": "group", "thread_id": THREAD,
        "message_id": "fm_" + "A" * 16,
        "actor": {"kind": "agent", "id": "agent:helper", "name": "Helper", "is_bot": True},
        "mentions": [], "text": "approved", "date": 1,
    }
    a._on_room_message(types.SimpleNamespace(groups_enabled=True), message)
    assert a._cards  # text is context, never a tap

    async def request(op, *, retry_unknown, **params):
        raise AssertionError("an agent text frame never sends callback.answer")

    monkeypatch.setattr(a, "_request", request)
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_room_callback(callback_frame(
            actor={"kind": "agent", "id": "agent:helper", "name": "Helper", "is_bot": True}))


def test_room_card_fields_carry_the_hub_card_tuple(monkeypatch):
    a = adapter()
    turn = types.SimpleNamespace(
        chat_id=CHAT, thread_id=THREAD, dispatch_id=DISPATCH, run_token="fr_token",
        owner_id="u_owner", target_agent_id="agent:helper",
    )
    monkeypatch.setattr("foxfleet.rooms.current_turn", lambda: turn)
    assert a._room_card_fields(CHAT, request_id=REQUEST) == {
        "request_id": REQUEST, "chat_id": CHAT, "dispatch_id": DISPATCH, "run_token": "fr_token",
        "owner_id": "u_owner", "target_agent_id": "agent:helper",
    }
    assert a._room_card_fields(OTHER, request_id=REQUEST) == {}


def test_parse_dispatch_carries_the_room_owner_and_target_agent():
    frame = {
        "t": "dispatch.run", "dispatch_id": DISPATCH, "run_token": "fr_token",
        "chat_id": CHAT, "thread_id": THREAD, "message_id": "fm_" + "C" * 16,
        "actor": {"kind": "human", "id": "u_owner", "name": "owner", "is_bot": False},
        "mentions": [], "text": "@helper go", "date": 1, "root_id": "fm_" + "C" * 16,
        "deadline_at": 10, "owner_id": "u_owner", "target_agent_id": "agent:helper",
    }
    dispatch = protocol.parse_dispatch(frame)
    assert dispatch.owner_id == "u_owner"
    assert dispatch.target_agent_id == "agent:helper"


@pytest.mark.asyncio
async def test_a_1_1_cards_socket_never_acts_on_a_group_callback(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(cards_enabled=True, groups_enabled=False)
    a._conn = conn
    a._cards = pending()

    async def request(op, *, retry_unknown, **params):
        raise AssertionError("a 1.1 socket must not answer a group callback")

    monkeypatch.setattr(a, "_request", request)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: True)
    await a._on_card_callback(conn, callback_frame())
    assert a._cards  # the card stays pending for a real 1.2 socket


@pytest.mark.asyncio
async def test_a_tap_naming_another_owner_is_refused(monkeypatch):
    a = adapter()
    conn = types.SimpleNamespace(cards_enabled=True, groups_enabled=True)
    a._conn = conn
    a._cards = pending(target_agent_id="agent:helper")
    calls = []

    async def request(op, *, retry_unknown, **params):
        calls.append((op, params))
        return protocol.RpcResponse(id="ans", ok=True, result={})

    async def resolve(row, cb):
        raise AssertionError("a mismatched owner must not resolve a card")

    monkeypatch.setattr(a, "_request", request)
    monkeypatch.setattr(a, "_resolve_card", resolve)
    monkeypatch.setattr(a, "_is_sender_authorized", lambda *args, **kwargs: True)
    await a._on_card_callback(conn, callback_frame(
        actor={"kind": "human", "id": "u_other", "name": "other", "is_bot": False}))
    assert a._cards
    assert calls[-1][1]["outcome"] == "refused"
