"""The plugin-registered room handoff tool: payload, context, and visible unavailability."""

from __future__ import annotations

import json

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.base import SendResult

from foxfleet import protocol, rooms
from foxfleet.adapter import FoxFleetAdapter
from foxfleet.protocol import RpcResponse

CHAT = "fc_" + "A" * 16
THREAD = "fcr_" + "B" * 16
SOURCE = "fm_" + "C" * 16


def turn(request=None, source_message_id=SOURCE) -> rooms.RoomTurn:
    return rooms.RoomTurn(chat_id=CHAT, thread_id=THREAD, dispatch_id="fd_" + "D" * 16,
                          run_token="fr_attempt", source_message_id=source_message_id, request=request)


def test_frame_carries_the_frozen_fields_and_the_bound_attempt():
    frame = rooms.handoff_frame(turn(), target_agent_id="reviewer", text="check this",
                                idempotency_key="h:1")
    assert frame["t"] == "handoff.request"
    assert frame["chat_id"] == CHAT and frame["thread_id"] == THREAD
    assert frame["source_message_id"] == SOURCE and frame["target_agent_id"] == "agent:reviewer"
    assert frame["text"] == "check this" and frame["idempotency_key"] == "h:1"
    assert frame["dispatch_id"] == "fd_" + "D" * 16 and frame["run_token"] == "fr_attempt"
    with pytest.raises(protocol.ProtocolError):
        rooms.handoff_frame(turn(), target_agent_id="not an agent", text="x")
    with pytest.raises(protocol.ProtocolError):
        rooms.handoff_frame(turn(source_message_id=None), target_agent_id="agent:reviewer", text="x")


@pytest.mark.asyncio
async def test_tool_calls_the_hub_with_the_room_scoped_payload():
    calls = []

    async def request(op, **params):
        calls.append((op, params))
        return RpcResponse(id="handoff", ok=True, result={"pending": True, "target_agent_id": "agent:reviewer"})

    result = await rooms.handoff(
        {"target_agent_id": "reviewer", "text": "verify", "idempotency_key": "k1"},
        turn=turn(request), request=request)
    assert result["ok"] is True and result["pending"] is True
    op, params = calls[0]
    assert op == "handoff.request"
    assert params == {"chat_id": CHAT, "thread_id": THREAD, "source_message_id": SOURCE,
                      "target_agent_id": "agent:reviewer", "text": "verify", "idempotency_key": "k1",
                      "dispatch_id": "fd_" + "D" * 16, "run_token": "fr_attempt"}


@pytest.mark.asyncio
async def test_no_room_context_is_a_visible_unsupported_error_not_a_json_instruction():
    result = await rooms.handoff({"target_agent_id": "agent:reviewer", "text": "x"})
    assert result["ok"] is False and result["error"] == "group_not_available"
    encoded = await rooms._tool_handler({"target_agent_id": "agent:reviewer", "text": "x"})
    parsed = json.loads(encoded)
    assert parsed["error"] == "group_not_available"


class FakeCtx:
    def __init__(self):
        self.tools = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)


def test_tool_registration_is_feature_detected_and_names_the_bot_env_default():
    ctx = FakeCtx()
    assert rooms.register(ctx) is True
    tool = ctx.tools[0]
    assert tool["name"] == rooms.TOOL_NAME and tool["toolset"] == rooms.TOOLSET and tool["is_async"] is True
    assert tool["schema"]["parameters"]["required"] == ["target_agent_id", "text"]
    assert rooms.register(object()) is False


@pytest.mark.asyncio
async def test_adapter_room_request_and_send_ignore_hub_thread_metadata(monkeypatch):
    seen = []

    async def request(op, *, retry_unknown, **params):
        seen.append((op, retry_unknown, params))
        return RpcResponse(id="r1", ok=True, result={"message_id": SOURCE})

    adapter = FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:1"}))
    monkeypatch.setattr(adapter, "_request", request)
    res = await adapter._room_request("chat.get", chat_id=CHAT, thread_id=THREAD)
    assert res.ok is True
    assert seen[-1] == ("chat.get", True, {"chat_id": CHAT, "thread_id": THREAD})

    sent = await adapter.send(CHAT, "hello", metadata={"thread_id": THREAD})
    assert isinstance(sent, SendResult) and sent.success is True
    op, retry, params = seen[-1]
    assert op == "message.send" and retry is True
    assert params["chat_id"] == CHAT and "thread_id" not in params


@pytest.mark.asyncio
async def test_two_real_adapters_review_in_one_room_and_keep_dms_and_other_rooms_separate(monkeypatch):
    """The isolated two-runtime gate: real hub process, two real FoxFleetAdapter sockets, fake model handlers."""
    from realhub import RealHub, make_data_dir, remove_data_dir, skip_reason

    reason = skip_reason()
    if reason:
        pytest.skip(reason)
    hub = RealHub(make_data_dir())
    adapters = []
    await hub.start()
    try:
        await hub.setup_owner()
        tokens = {}
        for name in ("helper", "reviewer"):
            assert (await hub.call("/api/connections", {"kind": "hermes", "connection": "bot", "name": name}, expect=201))[0] == 201
            _, body = await hub.call(f"/api/agents/{name}/bot-token", {}, expect=201)
            tokens[name] = body["token"]
        _, main = await hub.call("/api/conversations", {"title": "Review", "member_ids": ["helper", "reviewer"]}, expect=201)
        _, other = await hub.call("/api/conversations", {"title": "Other", "member_ids": ["helper"]}, expect=201)

        seen = {"helper": [], "reviewer": []}

        async def helper_model(event):
            seen["helper"].append(event)
            if event.source.chat_type != "group":
                return
            await rooms.handoff({"target_agent_id": "agent:reviewer",
                                 "text": "Please verify the patch."})
            await adapter_helper.send(event.source.chat_id, "Handing this over.",
                                      metadata={"thread_id": event.source.thread_id, "notify": True})

        async def reviewer_model(event):
            seen["reviewer"].append(event)
            if event.source.chat_type != "group":
                return
            await adapter_reviewer.send(event.source.chat_id, "Verified: looks correct.",
                                        metadata={"thread_id": event.source.thread_id, "notify": True})

        def make(token):
            monkeypatch.setenv("FOXFLEET_BOT_TOKEN", token)
            a = FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": hub.base}))
            a.RECONNECT_BASE_DELAY = 0.01
            a.RECONNECT_MAX_DELAY = 0.05
            adapters.append(a)
            return a

        adapter_helper, adapter_reviewer = make(tokens["helper"]), make(tokens["reviewer"])
        adapter_helper.set_message_handler(helper_model)
        adapter_reviewer.set_message_handler(reviewer_model)
        assert await adapter_helper.connect() is True
        assert await adapter_reviewer.connect() is True

        text = "@helper please review"
        mention = {"kind": "agent", "id": "agent:helper", "offset": 0, "length": 7}
        assert (await hub.call(f"/api/conversations/{main['id']}/messages",
                               {"text": text, "mentions": [mention]}, expect=202))[0] == 202

        async def wait_for(pred, timeout=10.0):
            import asyncio, time as _time
            end = _time.monotonic() + timeout
            while _time.monotonic() < end:
                if pred():
                    return True
                await asyncio.sleep(0.05)
            return False

        assert await wait_for(lambda: len(seen["reviewer"]) >= 1), seen
        assert await wait_for(lambda: len([m for m in seen["helper"] if m.source.chat_type == "group"]) >= 1)
        helper_turn = next(m for m in seen["helper"] if m.source.chat_type == "group")
        reviewer_turn = seen["reviewer"][0]
        assert helper_turn.source.chat_id == main["id"]
        assert helper_turn.source.thread_id == "fcr_" + main["id"][3:]
        assert reviewer_turn.source.chat_id == main["id"]
        assert reviewer_turn.source.is_bot is True and reviewer_turn.user_id == "agent:helper"

        # A DM to the same agent and a second room are different sessions and do not appear as this room turn.
        dm = await hub.post_message("direct question")
        assert await wait_for(lambda: any(m.source.chat_type == "dm" for m in seen["helper"]))
        dm_turn = next(m for m in seen["helper"] if m.source.chat_type == "dm")
        assert dm_turn.source.chat_id != helper_turn.source.chat_id
        assert adapter_helper._event_session_key(dm_turn) != adapter_helper._event_session_key(helper_turn)

        assert (await hub.call(f"/api/conversations/{other['id']}/messages",
                               {"text": "@helper other room", "mentions": [mention]}, expect=202))[0] == 202
        assert await wait_for(lambda: any(m.source.chat_id == other["id"] for m in seen["helper"]))
        other_turn = next(m for m in seen["helper"] if m.source.chat_id == other["id"])
        assert other_turn.source.thread_id == "fcr_" + other["id"][3:]
        assert adapter_helper._event_session_key(other_turn) != adapter_helper._event_session_key(helper_turn)
    finally:
        for a in adapters:
            await a.disconnect()
        await hub.stop()
        remove_data_dir(hub.dir)


def test_platform_registration_names_allow_bots_only_when_the_host_supports_it():
    from foxfleet.adapter import register

    class PlatformCtx(FakeCtx):
        def register_platform(self, **kwargs):
            self.platform = kwargs

    ctx = PlatformCtx()
    register(ctx)
    assert ctx.platform["name"] == "foxfleet"
    from dataclasses import fields
    from gateway.platform_registry import PlatformEntry
    if any(f.name == "allow_bots_env" for f in fields(PlatformEntry)):
        assert ctx.platform["allow_bots_env"] == "FOXFLEET_ALLOW_BOTS"
    assert [t["name"] for t in ctx.tools] == [rooms.TOOL_NAME]


@pytest.mark.asyncio
async def test_room_send_and_final_edit_carry_the_bound_attempt(monkeypatch):
    seen = []

    async def request(op, *, retry_unknown, **params):
        seen.append((op, params))
        return RpcResponse(id="r1", ok=True, result={"message_id": SOURCE})

    adapter = FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:1"}))
    monkeypatch.setattr(adapter, "_request", request)
    bound = turn(request)
    with rooms.bind_turn(bound):
        sent = await adapter.send(CHAT, "first draft")
        edited = await adapter.edit_message(CHAT, SOURCE, "final draft", finalize=True)
    assert isinstance(sent, SendResult) and sent.success is True
    assert isinstance(edited, SendResult) and edited.success is True
    op, params = seen[0]
    assert op == "message.send"
    assert params["dispatch_id"] == bound.dispatch_id and params["run_token"] == bound.run_token
    op, params = seen[1]
    assert op == "message.edit"
    assert params["dispatch_id"] == bound.dispatch_id and params["run_token"] == bound.run_token
    assert params["final"] is True
