"""Room turn context and the plugin-registered handoff facility (foxfleet.bot/1.2).

The adapter binds one :class:`RoomTurn` around an admitted dispatch. The tool never invents an inbound
message and never asks the model to emit JSON into the room: it is an ordinary Hermes tool whose handler
calls the authenticated hub socket. When the negotiated protocol has no groups the tool answers with a
visible ``group_not_available`` error instead of silently falling back to a DM.
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Optional

from . import protocol

TOOL_NAME = "foxfleet_handoff"
TOOLSET = "foxfleet"
_AGENT = re.compile(r"^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_IDEM = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
MAX_TEXT_BYTES = 65536

HANDOFF_SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Hand this room turn to another agent in the same FoxFleet room. Use only when the other agent "
        "can finish the work; the room, dispatch and source message are bound by the transport."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "target_agent_id": {"type": "string", "description": "Agent id, e.g. agent:researcher"},
            "text": {"type": "string", "description": "Instruction for the target agent (1-65536 bytes)"},
            "idempotency_key": {"type": "string", "description": "Optional stable key for a retried handoff"},
        },
        "required": ["target_agent_id", "text"],
        "additionalProperties": False,
    },
}


@dataclass(frozen=True)
class RoomTurn:
    """One admitted room dispatch, as the tool needs to see it.

    ``dispatch_id`` and ``run_token`` identify the exact live attempt. Every room output frame carries both
    so the hub can fail closed instead of binding a delayed frame to a newer turn in the same room.
    """
    chat_id: str
    thread_id: str
    dispatch_id: str
    run_token: str
    source_message_id: Optional[str] = None
    request: Optional[Callable[..., Any]] = None
    owner_id: Optional[str] = None
    target_agent_id: Optional[str] = None

    @property
    def attempt(self) -> dict[str, str]:
        return {"dispatch_id": self.dispatch_id, "run_token": self.run_token}


_current: ContextVar[Optional[RoomTurn]] = ContextVar("foxfleet_room_turn", default=None)


def current_turn() -> Optional[RoomTurn]:
    return _current.get()


def set_turn(turn: Optional[RoomTurn]):
    return _current.set(turn)


def reset_turn(token) -> None:
    _current.reset(token)


@contextmanager
def bind_turn(turn: Optional[RoomTurn]) -> Iterator[Optional[RoomTurn]]:
    token = set_turn(turn)
    try:
        yield turn
    finally:
        reset_turn(token)


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": code, "message": message}


def _agent_ref(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    ref = value if value.startswith("agent:") else "agent:" + value
    return ref if _AGENT.match(ref) else None


def handoff_frame(turn: RoomTurn, *, target_agent_id: str, text: str,
                  source_message_id: Optional[str] = None,
                  idempotency_key: Optional[str] = None) -> dict[str, Any]:
    """The contract frame for one handoff, bound to the exact dispatch attempt."""
    target = _agent_ref(target_agent_id)
    if target is None:
        raise protocol.ProtocolError("invalid_request", "target_agent_id must be agent:<id>")
    if not isinstance(text, str) or not text.strip() or protocol.utf8_len(text) > MAX_TEXT_BYTES:
        raise protocol.ProtocolError("invalid_request", "text must be 1 to 65536 UTF-8 bytes")
    source = source_message_id or turn.source_message_id
    if not isinstance(source, str) or not protocol.MESSAGE_ID.match(source):
        raise protocol.ProtocolError("invalid_request", "a committed source message is required")
    if idempotency_key is not None and (not isinstance(idempotency_key, str) or not _IDEM.match(idempotency_key)):
        raise protocol.ProtocolError("invalid_request", "invalid idempotency_key")
    return protocol.build_request(
        "handoff.request", "handoff", chat_id=turn.chat_id, thread_id=turn.thread_id,
        source_message_id=source, target_agent_id=target, text=text,
        idempotency_key=idempotency_key,
        dispatch_id=turn.dispatch_id, run_token=turn.run_token,
    )


async def handoff(args: dict[str, Any], *, turn: Optional[RoomTurn] = None,
                  request: Optional[Callable[..., Any]] = None) -> dict[str, Any]:
    """Run the handoff tool. Returns a result dict; unavailable groups are a visible unsupported error."""
    turn = turn or current_turn()
    if turn is None:
        return _error("group_not_available", "Handoff is only available inside a FoxFleet room turn")
    call = request or turn.request
    if call is None:
        return _error("group_not_available", "The FoxFleet room transport is not connected")
    frame = handoff_frame(
        turn,
        target_agent_id=args.get("target_agent_id", ""),
        text=args.get("text", ""),
        source_message_id=args.get("source_message_id"),
        idempotency_key=args.get("idempotency_key"),
    )
    params = {k: v for k, v in frame.items() if k not in ("t", "id")}
    try:
        res = await call("handoff.request", **params)
    except Exception:
        return _error("group_not_available", "The FoxFleet hub did not accept the handoff request")
    if not getattr(res, "ok", False):
        code = getattr(res, "error_code", "") or "unsupported"
        return _error(code, "The hub refused the handoff")
    result = dict(getattr(res, "result", {}) or {})
    result["ok"] = True
    return result


async def _tool_handler(args: dict[str, Any]) -> str:
    """Hermes tool entry point: always returns a bounded JSON string, never raises into the prompt."""
    try:
        result = await handoff(dict(args or {}))
    except protocol.ProtocolError as exc:
        result = _error(exc.code, str(exc))
    except Exception:
        result = _error("group_not_available", "Handoff is unavailable for this turn")
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def register(ctx: Any) -> bool:
    """Register the room-scoped tool when the host plugin API exposes ``register_tool``."""
    if not hasattr(ctx, "register_tool"):
        return False
    ctx.register_tool(
        name=TOOL_NAME, toolset=TOOLSET, schema=HANDOFF_SCHEMA, handler=_tool_handler,
        description=HANDOFF_SCHEMA["description"], emoji="\U0001f500", is_async=True,
    )
    return True
