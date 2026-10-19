"""foxfleet.bot/1.2 room parsing and the session identity it produces."""

from __future__ import annotations

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.event import MessageEvent

from foxfleet import protocol
from foxfleet.adapter import FoxFleetAdapter
from foxfleet.protocol import RoomDispatch

CHAT_A = "fc_" + "A" * 16
CHAT_B = "fc_" + "B" * 16
THREAD_A = "fcr_" + "A" * 16
THREAD_B = "fcr_" + "B" * 16
MSG = "fm_" + "C" * 16
DISPATCH = "fd_" + "D" * 16


def adapter() -> FoxFleetAdapter:
    return FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:1"}))


def dispatch(chat_id=CHAT_A, thread_id=THREAD_A, **overrides) -> RoomDispatch:
    values = dict(
        dispatch_id=DISPATCH, run_token="fr_token", chat_id=chat_id, thread_id=thread_id,
        message_id=MSG, actor_kind="human", actor_id="u1", actor_name="owner", is_bot=False,
        text="@helper review", mentions=(), date=1, reply_to=None, root_id=MSG, deadline_at=10,
    )
    values.update(overrides)
    return RoomDispatch(**values)


def room_frame(chat_id=CHAT_A, thread_id=THREAD_A, **overrides) -> dict:
    frame = {
        "t": "message.new", "event_id": 1, "chat_id": chat_id, "chat_type": "group",
        "thread_id": thread_id, "message_id": MSG,
        "actor": {"kind": "human", "id": "u1", "name": "owner", "is_bot": False},
        "mentions": [], "text": "hello room", "date": 1,
    }
    frame.update(overrides)
    return frame


def test_parse_room_message_carries_actor_kind_thread_and_utf16_mentions():
    text = "hi 🤖 @robot"
    units = text.encode("utf-16-le")
    offset = len(units) // 2 - len("@robot".encode("utf-16-le")) // 2
    frame = room_frame(text=text, mentions=[{"kind": "agent", "id": "agent:robot", "offset": offset, "length": 6}])
    msg = protocol.parse_room_message_new(frame)
    assert (msg.chat_type, msg.thread_id, msg.actor_kind, msg.is_bot) == ("group", THREAD_A, "human", False)
    assert msg.mentions[0]["id"] == "agent:robot"
    span = units[msg.mentions[0]["offset"] * 2:(msg.mentions[0]["offset"] + 6) * 2].decode("utf-16-le")
    assert span == "@robot"

    bad = dict(frame)
    bad["mentions"] = [{"kind": "agent", "id": "agent:robot", "offset": 3, "length": 1}]
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_room_message_new(bad)


def test_two_rooms_and_a_dm_have_distinct_session_keys():
    a = adapter()
    room_a = a._build_room_event(dispatch())
    room_b = a._build_room_event(dispatch(chat_id=CHAT_B, thread_id=THREAD_B))
    dm_source = a.build_source(chat_id="fc_" + "E" * 16, chat_type="dm", user_id="u1", user_name="owner")
    dm = MessageEvent(text="direct", source=dm_source, user_id="u1", user_name="owner", reply_expected=True)
    keys = {a._event_session_key(room_a), a._event_session_key(room_b), a._event_session_key(dm)}
    assert len(keys) == 3
    assert room_a.source.chat_type == "group" and room_a.source.thread_id == THREAD_A
    assert room_b.source.thread_id == THREAD_B


def test_agent_origin_is_bot_and_never_control_or_trusted():
    a = adapter()
    event = a._build_room_event(dispatch(actor_kind="agent", actor_id="agent:helper",
                                         actor_name="Helper", is_bot=True, text="handoff text"))
    assert event.source.is_bot is True
    assert event.user_id == "agent:helper"
    assert event.allow_gateway_control is False
    assert event.internal is False
    assert event.metadata == {}
    assert event.reply_expected is True


@pytest.mark.asyncio
async def test_passive_room_message_is_not_a_turn_even_when_it_mentions_this_agent(monkeypatch):
    a = adapter()
    calls = []

    async def record(event):
        calls.append(event)

    monkeypatch.setattr(a, "handle_message", record)
    frame = room_frame(text="hi @helper",
                       mentions=[{"kind": "agent", "id": "agent:helper", "offset": 3, "length": 7}])
    a._on_room_message(type("C", (), {"groups_enabled": True})(), frame)
    assert calls == []
    assert a._room_chats[CHAT_A] == THREAD_A


@pytest.mark.asyncio
async def test_dispatch_run_admits_exactly_one_room_turn_with_the_bound_source(monkeypatch):
    a = adapter()
    calls = []

    async def record(event):
        calls.append(event)

    monkeypatch.setattr(a, "handle_message", record)
    conn = type("C", (), {"groups_enabled": True})()
    a._conn = conn
    frame = {
        "t": "dispatch.run", "dispatch_id": DISPATCH, "run_token": "fr_token",
        "chat_id": CHAT_A, "thread_id": THREAD_A, "message_id": MSG,
        "actor": {"kind": "human", "id": "u1", "name": "owner", "is_bot": False},
        "mentions": [], "text": "please review", "date": 1, "root_id": MSG, "deadline_at": 10,
    }
    await a._admit_room(conn, frame)
    await a._admit_room(conn, frame)  # the same attempt replayed on reconnect is ignored
    assert len(calls) == 1
    event = calls[0]
    assert event.source.chat_type == "group"
    assert event.source.thread_id == THREAD_A
    assert event.source.chat_id == CHAT_A
    assert event.text == "please review"


@pytest.mark.asyncio
async def test_room_member_frames_track_room_identity_and_membership():
    a = adapter()
    conn = type("C", (), {"groups_enabled": True})()
    join = {
        "t": "chat.member", "event_id": 46, "chat_id": CHAT_A, "chat_type": "group",
        "thread_id": THREAD_A, "action": "join",
        "actor": {"kind": "human", "id": "u1", "name": "owner", "is_bot": False},
        "member": {"kind": "agent", "id": "agent:helper", "name": "Helper", "is_bot": True},
        "date": 1,
    }
    a._on_room_member(conn, join)
    assert a._room_chats[CHAT_A] == THREAD_A
    assert a._room_members[CHAT_A] == {"agent:helper": "Helper"}
    info = await a.get_chat_info(CHAT_A)
    assert info["type"] == "group"

    a._on_room_member(conn, {**join, "event_id": 47, "action": "leave"})
    assert a._room_members[CHAT_A] == {}

    a._on_room_member(conn, {**join, "action": "unknown"})
    assert a._room_members[CHAT_A] == {}


@pytest.mark.asyncio
async def test_room_member_frames_are_ignored_on_a_1_1_socket():
    a = adapter()
    calls = []
    conn = type("C", (), {"groups_enabled": False})()
    a._on_room_member(conn, {"t": "chat.member", "event_id": 46})
    assert a._room_members == {}
