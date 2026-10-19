"""Disposable loopback FoxFleet hub speaking foxfleet.bot/1 over a real aiohttp WebSocket.

FAKE HUB TRANSPORT for adapter tests only: it models the contract the adapter relies on (Bot-token
auth, hello, durable message.new replay from the cumulative ack, res frames, idempotency keys).
It is not Devin's hub and proves nothing about it. Wire shapes (subprotocol, id grammar, field
allow-lists, close codes) mirror contract/bot-api.md as read from the real hub sources.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Callable, Optional

from aiohttp import WSMsgType, web

PROTOCOL = "foxfleet.bot/1"
PROTOCOL_V11 = "foxfleet.bot/1.1"
SUBPROTOCOL = "foxfleet.bot.v1"
SUBPROTOCOL_V11 = "foxfleet.bot.v1.1"
SUBPROTOCOL_V12 = "foxfleet.bot.v1.2"
TOKEN = "ffb_" + "T" * 43
BOT_ID = "0123456789abcdef01234567"

_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_KEY = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_CHAT_ID = re.compile(r"^fc_[A-Za-z0-9_-]{16}$")
_MESSAGE_ID = re.compile(r"^fm_[A-Za-z0-9_-]{16}$")
_COMMAND_NAME = re.compile(r"^[a-z0-9_]{1,32}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_FIELDS = {
    "message.send": {"chat_id", "text", "format", "reply_to", "final", "idempotency_key"},
    "message.edit": {"chat_id", "message_id", "text", "format", "final", "idempotency_key"},
    "message.delete": {"chat_id", "message_id", "idempotency_key"},
    "chat.action": {"chat_id", "action"},
    "commands.set": {"commands"},
    "models.set": {"providers"},
    "callback.answer": {"callback_id", "outcome"},
    "ack": {"event_id"}, "ping": set(), "pong": set(),
}


def chat(n: int = 1) -> str:
    return f"fc_{n:016d}"


def bot_msg(n: int) -> str:
    return f"fm_b{n:015d}"


def human_msg(n: int) -> str:
    return f"fm_h{n:015d}"


def _invalid(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def _ref(value: Any, pattern: re.Pattern, name: str) -> Optional[dict]:
    if not isinstance(value, str):
        return _invalid("invalid_request", f"{name} must be a string")
    return None if pattern.match(value) else _invalid("not_found", f"Unknown {name}")


def _text(value: Any) -> Optional[dict]:
    if not isinstance(value, str) or not value or "\0" in value:
        return _invalid("invalid_request", "text must be a non-empty string without NUL")
    if len(value.encode()) > 65536:
        return _invalid("too_large", "text is over 65536 bytes")
    return None


def validate_request(frame: dict) -> Optional[dict]:
    """The real hub's field validation (bot-protocol.js): None when valid, else {code, message}."""
    kind = frame.get("t")
    if kind not in _FIELDS:
        return _invalid("unknown_type", "Unknown frame type")
    extra = next((k for k in frame if k not in ("t", "id") and k not in _FIELDS[kind]), None)
    if extra is not None:
        return _invalid("invalid_request", f"Unknown field {extra}")
    if "id" in frame and not (isinstance(frame["id"], str) and _REQUEST_ID.match(frame["id"])):
        return _invalid("invalid_request", "Invalid request id")
    if "id" not in frame and kind not in ("ack", "ping", "pong"):
        return _invalid("invalid_request", "Requests carry an id")
    if kind == "ack":
        ok = isinstance(frame.get("event_id"), int) and not isinstance(frame.get("event_id"), bool)
        return None if ok and frame["event_id"] >= 0 else _invalid("invalid_request", "event_id must be a non-negative integer")
    error = None
    if "idempotency_key" in frame and not (isinstance(frame["idempotency_key"], str) and _KEY.match(frame["idempotency_key"])):
        return _invalid("invalid_request", "Invalid idempotency_key")
    if kind not in ("commands.set", "models.set", "callback.answer"):
        error = _ref(frame.get("chat_id"), _CHAT_ID, "chat_id")
    if error:
        return error
    if kind in ("message.edit", "message.delete"):
        error = _ref(frame.get("message_id"), _MESSAGE_ID, "message_id")
    if error:
        return error
    if kind in ("message.send", "message.edit"):
        error = _text(frame.get("text"))
        if error:
            return error
        if frame.get("format", "markdown") not in ("markdown", "text"):
            return _invalid("invalid_request", "format is markdown or text")
        if not isinstance(frame.get("final", False), bool):
            return _invalid("invalid_request", "final must be a boolean")
        if kind == "message.send" and "reply_to" in frame:
            return _ref(frame["reply_to"], _MESSAGE_ID, "reply_to")
    if kind == "chat.action":
        if not isinstance(frame.get("action"), str):
            return _invalid("invalid_request", "action is required")
        if frame["action"] != "typing":
            return _invalid("unsupported", "Only the typing action is supported")
    if kind == "commands.set":
        commands = frame.get("commands")
        if not isinstance(commands, list) or len(commands) > 100:
            return _invalid("invalid_request", "commands is a list of at most 100 entries")
        seen: set = set()
        for entry in commands:
            if not isinstance(entry, dict) or set(entry) - {"name", "description"}:
                return _invalid("invalid_request", "Each command has a name and a description")
            name, description = entry.get("name"), entry.get("description")
            if not isinstance(name, str) or not _COMMAND_NAME.match(name) or name in seen:
                return _invalid("invalid_request", "Command names are unique, lowercase letters, digits or _")
            if not isinstance(description, str) or not 1 <= len(description) <= 256 or _CONTROL.search(description):
                return _invalid("invalid_request", "Command descriptions are 1 to 256 characters without control characters")
            seen.add(name)
    return None


class FakeHub:
    def __init__(self, *, token: str = TOKEN, bot_id: str = BOT_ID, protocol: str = PROTOCOL):
        self.token, self.bot_id, self.protocol = token, bot_id, protocol
        self.reject_status: Optional[int] = None  # HTTP status to refuse the upgrade with
        self.close_after_hello: Optional[int] = None  # WS close code sent right after hello
        self.echo_subprotocol = True  # False: accept the upgrade but omit the Sec-WebSocket-Protocol echo
        self.speak_v11 = False  # True: echo foxfleet.bot.v1.1 and advertise the stop feature
        self.subprotocol_offers: list[str] = []  # offered subprotocols, comma-joined, per attempt
        self.auth_headers: list[str] = []
        self.query_strings: list[str] = []
        self.connections: list[web.WebSocketResponse] = []
        self.frames: list[dict] = []  # every frame received from the adapter, in order
        self.acks: list[int] = []
        self.ack_conns: list[int] = []  # index into self.connections of the socket each ack used
        self.acked = 0  # hub-persisted cumulative ack
        self.events: list[dict] = []  # durable event log
        self.sent: dict[str, dict] = {}  # message_id -> bot message
        self.idempotency: dict[str, tuple[str, str]] = {}  # key -> (fingerprint, message_id)
        self.finals: list[bool] = []  # `final` of every accepted send/edit, in order
        self.stop_answers: list[dict] = []
        self.commands: Optional[list] = None
        self.rpc_override: Optional[Callable[[dict], Any]] = None  # frame -> res dict | None (drop)
        self._next_message = 0
        self._runner: Optional[web.AppRunner] = None
        self.url = ""

    # -- lifecycle -------------------------------------------------------
    async def start(self) -> "FakeHub":
        app = web.Application()
        app.router.add_get("/api/bot/ws", self._ws_handler)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        return self

    async def stop(self) -> None:
        for ws in list(self.connections):
            if not ws.closed:
                await ws.close()
        if self._runner is not None:
            await self._runner.cleanup()

    # -- server side -----------------------------------------------------
    @property
    def ws(self) -> Optional[web.WebSocketResponse]:
        return self.connections[-1] if self.connections else None

    async def _ws_handler(self, request: web.Request):
        auth = request.headers.get("Authorization", "")
        self.auth_headers.append(auth)
        self.query_strings.append(request.query_string)
        if self.reject_status is not None:
            return web.Response(status=self.reject_status, text="refused")
        offered = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if p.strip()]
        self.subprotocol_offers.append(",".join(offered))
        if SUBPROTOCOL not in offered and SUBPROTOCOL_V11 not in offered:
            return web.Response(status=400, text="subprotocol foxfleet.bot.v1 required")
        selected = SUBPROTOCOL_V11 if self.speak_v11 and SUBPROTOCOL_V11 in offered else SUBPROTOCOL
        if selected not in offered:
            return web.Response(status=400, text="offered subprotocol not spoken by this hub")
        if auth != f"Bot {self.token}":
            return web.Response(status=401, text="bad token")
        ws = web.WebSocketResponse(max_msg_size=1024 * 1024, autoping=True,
                                   protocols=(selected,) if self.echo_subprotocol else ())
        await ws.prepare(request)
        previous = [c for c in self.connections if not c.closed]
        self.connections.append(ws)
        for old in previous:  # one connection per bot: the newest wins
            await old.close(code=4009, message=b"replaced")
        latest = self.events[-1]["event_id"] if self.events else 0
        hello_protocol = PROTOCOL_V11 if selected == SUBPROTOCOL_V11 else self.protocol
        hello = {"t": "hello", "protocol": hello_protocol, "bot": self.bot_id,
                 "resume_from": self.acked, "latest_event_id": latest}
        if selected == SUBPROTOCOL_V11:
            hello["features"] = ["stop"]
        await ws.send_json(hello)
        if self.close_after_hello is not None:
            await ws.close(code=self.close_after_hello, message=b"closing")
            return ws
        for event in self.events:
            if event["event_id"] > self.acked:
                await ws.send_json(event)
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            frame = json.loads(msg.data)
            self.frames.append(frame)
            if frame.get("t") == "ack":
                self.ack_conns.append(self.connections.index(ws))
            await self._on_frame(ws, frame)
        return ws

    async def _on_frame(self, ws: web.WebSocketResponse, frame: dict) -> None:
        kind = frame.get("t")
        invalid = validate_request(frame)
        if invalid is not None:
            if isinstance(frame.get("id"), str) and _REQUEST_ID.match(frame["id"]):
                await ws.send_json(self.error(frame["id"], invalid["code"], invalid["message"]))
            else:
                await ws.send_json({"t": "error", **invalid})
            return
        if kind == "ack":
            self.acks.append(frame["event_id"])
            self.acked = max(self.acked, frame["event_id"])
            return
        if kind in ("ping", "pong"):
            return
        if self.rpc_override is not None:
            res = self.rpc_override(frame)
            if asyncio.iscoroutine(res):
                res = await res
            if res is None:
                return  # simulated response loss
            if res is not NotImplemented:
                await ws.send_json(res)
                return
        await ws.send_json(self.default_res(frame))

    def default_res(self, frame: dict) -> dict:
        rid, kind = frame["id"], frame["t"]
        if kind == "message.send":
            key = frame.get("idempotency_key")
            fingerprint = json.dumps({k: frame.get(k) for k in ("chat_id", "text", "reply_to", "format")},
                                     sort_keys=True)
            if key and key in self.idempotency:
                seen_fp, mid = self.idempotency[key]
                if seen_fp != fingerprint:
                    return self.error(rid, "idempotency_conflict", "key reused with different payload")
                return self.ok(rid, message_id=mid)
            self._next_message += 1
            mid = bot_msg(self._next_message)
            self.finals.append(frame.get("final", False))
            self.sent[mid] = {"chat_id": frame["chat_id"], "text": frame["text"], "deleted": False}
            if key:
                self.idempotency[key] = (fingerprint, mid)
            return self.ok(rid, message_id=mid)
        if kind in ("message.edit", "message.delete"):
            target = self.sent.get(frame.get("message_id"))
            if target is None or target["chat_id"] != frame.get("chat_id"):
                return self.error(rid, "not_found", "no such bot message in this chat")
            if kind == "message.edit":
                self.finals.append(frame.get("final", False))
                target["text"] = frame["text"]
            else:
                target["deleted"] = True
            return self.ok(rid, message_id=frame["message_id"])
        if kind == "chat.action":
            return self.ok(rid)
        if kind == "commands.set":
            self.commands = frame.get("commands")
            return self.ok(rid)
        if kind == "models.set":
            self.models = frame.get("providers")
            return self.ok(rid)
        if kind == "callback.answer":
            self.stop_answers.append(frame)
            return self.ok(rid)
        return self.error(rid, "unknown_type", f"unsupported op {kind}")

    @staticmethod
    def ok(rid: str, **result: Any) -> dict:
        return {"t": "res", "id": rid, "ok": True, "result": result}

    @staticmethod
    def error(rid: str, code: str, message: str) -> dict:
        return {"t": "res", "id": rid, "ok": False, "error": {"code": code, "message": message}}

    # -- test helpers ----------------------------------------------------
    async def push(self, *, chat_id: str = chat(1), text: str = "hello", user_id: str = "user_1",
                   user_name: str = "Ada", send: bool = True, **extra: Any) -> dict:
        event_id = (self.events[-1]["event_id"] if self.events else 0) + 1
        event = {"t": "message.new", "event_id": event_id, "chat_id": chat_id, "chat_type": "dm",
                 "message_id": human_msg(event_id), "user": {"id": user_id, "name": user_name}, "text": text,
                 **extra}
        self.events.append(event)
        if send and self.ws is not None and not self.ws.closed:
            await self.ws.send_json(event)
        return event

    async def send_raw(self, data: str) -> None:
        await self.ws.send_str(data)

    def ops(self, kind: str) -> list[dict]:
        return [f for f in self.frames if f.get("t") == kind]


async def wait_for(predicate: Callable[[], Any], timeout: float = 5.0, interval: float = 0.01) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError("condition not met within %.1fs" % timeout)
        await asyncio.sleep(interval)
