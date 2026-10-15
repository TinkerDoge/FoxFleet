"""FoxFleet bot protocol ``foxfleet.bot/1``: frame parsing, validation and builders.

Pure module (stdlib only, no Hermes imports) so contract adjustments against the hub's
``contract/bot-api.md`` stay surgical. Everything the adapter trusts about a hub frame is checked
here BEFORE it becomes a Hermes ``MessageEvent`` or resolves an RPC.
"""

from __future__ import annotations

import ipaddress
import json
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Optional

PROTOCOL = "foxfleet.bot/1"
SUBPROTOCOL = "foxfleet.bot.v1"
BOT_ID = re.compile(r"^[0-9a-f]{24}$")
CHAT_ID = re.compile(r"^fc_[A-Za-z0-9_-]{16}$")
MESSAGE_ID = re.compile(r"^fm_[A-Za-z0-9_-]{16}$")
MAX_FRAME_BYTES = 1024 * 1024  # hub frame / aggregate message cap (1 MiB)
MAX_TEXT_BYTES = 64 * 1024  # message text cap, UTF-8 bytes, both directions


class ProtocolError(Exception):
    """A hub frame violated the protocol; ``code`` is a stable machine-readable reason."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class UnsupportedEvent(ProtocolError):
    """A well-formed durable event this adapter version deliberately does not handle (group chats,
    threads). Carries the ids needed to acknowledge it with a visible diagnostic."""

    def __init__(self, code: str, message: str, *, event_id: int, chat_id: str):
        super().__init__(code, message)
        self.event_id, self.chat_id = event_id, chat_id


def parse_frame(raw: str | bytes) -> dict[str, Any]:
    """Decode one text frame into a JSON object with a string ``t`` discriminator."""
    size = len(raw) if isinstance(raw, bytes) else len(raw.encode("utf-8", "surrogatepass"))
    if size > MAX_FRAME_BYTES:
        raise ProtocolError("frame_too_large", f"frame of {size} bytes exceeds {MAX_FRAME_BYTES}")
    try:
        frame = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProtocolError("bad_json", f"frame is not valid JSON: {exc.__class__.__name__}") from None
    if not isinstance(frame, dict):
        raise ProtocolError("bad_frame", "frame is not a JSON object")
    if not isinstance(frame.get("t"), str) or not frame["t"]:
        raise ProtocolError("bad_frame", "frame has no string 't'")
    return frame


MAX_ID_CHARS = 256  # hub-assigned ids (bot, chat, message, user) are opaque bounded strings
MAX_EVENT_ID = 2**53 - 1  # JSON-safe integer range


def _event_id(frame: dict, key: str) -> int:
    value = frame.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_EVENT_ID:
        raise ProtocolError("bad_event_id", f"{key} must be a non-negative integer")
    return value


def _ident(frame: dict, key: str, *, where: str = "") -> str:
    """Opaque hub id: a non-empty bounded string without control characters."""
    value = frame.get(key)
    if not isinstance(value, str) or not value or len(value) > MAX_ID_CHARS or not value.isprintable():
        raise ProtocolError("bad_id", f"{where}{key} must be a non-empty printable string")
    return value


def _match(frame: dict, key: str, pattern: re.Pattern, *, where: str = "") -> str:
    value = frame.get(key)
    if not isinstance(value, str) or not pattern.match(value):
        raise ProtocolError("bad_id", f"{where}{key} is not a valid FoxFleet id")
    return value


@dataclass(frozen=True)
class Hello:
    bot: str
    resume_from: int  # hub-persisted cumulative ack
    latest_event_id: int


def parse_hello(frame: dict) -> Hello:
    if frame.get("t") != "hello":
        raise ProtocolError("expected_hello", "first hub frame must be hello")
    if frame.get("protocol") != PROTOCOL:
        raise ProtocolError("version_mismatch", f"hub does not speak {PROTOCOL}")
    resume_from = _event_id(frame, "resume_from")
    latest = _event_id(frame, "latest_event_id")
    if resume_from > latest:
        raise ProtocolError("bad_event_id", "resume_from is beyond latest_event_id")
    return Hello(bot=_match(frame, "bot", BOT_ID), resume_from=resume_from, latest_event_id=latest)


def utf8_len(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def _text(value: Any, key: str = "text") -> str:
    if not isinstance(value, str):
        raise ProtocolError("bad_text", f"{key} must be a string")
    if utf8_len(value) > MAX_TEXT_BYTES:
        raise ProtocolError("text_too_large", f"{key} exceeds {MAX_TEXT_BYTES} UTF-8 bytes")
    return value


def split_text(text: str, max_bytes: int = MAX_TEXT_BYTES) -> list[str]:
    """Split ``text`` into chunks of at most ``max_bytes`` UTF-8 bytes, losslessly (joining the
    chunks restores the input), preferring the last newline inside each window; never cuts a code
    point. Callers send every chunk: nothing is truncated."""
    if utf8_len(text) <= max_bytes:
        return [text]
    chunks: list[str] = []
    rest = text
    while utf8_len(rest) > max_bytes:
        # Largest prefix (in code points) whose encoding fits.
        lo, hi = 1, len(rest)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if utf8_len(rest[:mid]) <= max_bytes:
                lo = mid
            else:
                hi = mid - 1
        cut = lo
        newline = rest.rfind("\n", 0, cut)
        if newline >= 0 and newline + 1 >= cut // 2:
            cut = newline + 1
        chunks.append(rest[:cut])
        rest = rest[cut:]
    if rest:
        chunks.append(rest)
    return chunks


@dataclass(frozen=True)
class InboundMessage:
    event_id: int
    chat_id: str
    message_id: str
    user_id: str
    user_name: str | None
    text: str
    reply_to: str | None = None
    chat_type: str = "dm"


def parse_message_new(frame: dict) -> InboundMessage:
    """Validate a hub ``message.new`` durable event. Text DMs only in v1: group chats and threads
    raise :class:`UnsupportedEvent` (well-formed, acknowledged with a diagnostic); anything malformed
    raises :class:`ProtocolError` and is never acknowledged."""
    event_id = _event_id(frame, "event_id")
    if event_id == 0:
        raise ProtocolError("bad_event_id", "event_id must be positive")
    chat_id = _match(frame, "chat_id", CHAT_ID)
    message_id = _match(frame, "message_id", MESSAGE_ID)
    user = frame.get("user")
    if not isinstance(user, dict):
        raise ProtocolError("bad_user", "user must be an object")
    user_id = _ident(user, "id", where="user.")
    name = user.get("name")
    if name is not None and (not isinstance(name, str) or len(name) > MAX_ID_CHARS):
        raise ProtocolError("bad_user", "user.name must be a bounded string")
    text = _text(frame.get("text"))
    reply_to = frame.get("reply_to")
    if reply_to is not None:
        reply_to = _match(frame, "reply_to", MESSAGE_ID)
    chat_type = frame.get("chat_type")
    if chat_type != "dm":
        raise UnsupportedEvent("unsupported_chat_type", "only direct chats are supported in v1",
                               event_id=event_id, chat_id=chat_id)
    if frame.get("thread_id") is not None:
        raise UnsupportedEvent("unsupported_thread", "threads are not supported in v1",
                               event_id=event_id, chat_id=chat_id)
    return InboundMessage(event_id=event_id, chat_id=chat_id, message_id=message_id, user_id=user_id,
                          user_name=(name or "").strip() or None, text=text, reply_to=reply_to)


# Contract error codes plus the defensive codes the adapter treats as fatal; hub-supplied codes outside
# this set are reported as "unrecognized" so hub-controlled text never reaches logs or results.
KNOWN_ERROR_CODES = frozenset({
    "invalid_request", "unsupported", "unknown_type", "bad_frame", "not_found", "forbidden", "too_large",
    "rate_limited", "idempotency_conflict", "ack_out_of_range", "internal",
    "unauthorized", "token_revoked", "version_mismatch", "unsupported_protocol", "replaced",
})
_FRAME_TYPE = re.compile(r"^[a-z][a-z0-9_.]{0,39}$")


def known_error_code(code: Any) -> str:
    return code if isinstance(code, str) and code in KNOWN_ERROR_CODES else "unrecognized"


def safe_frame_type(kind: Any) -> str:
    return kind if isinstance(kind, str) and _FRAME_TYPE.match(kind) else "?"


@dataclass(frozen=True)
class RpcResponse:
    id: str
    ok: bool
    result: dict
    error_code: str = ""
    retry_after_ms: Optional[int] = None  # hub hint on rate_limited


def parse_res(frame: dict) -> RpcResponse:
    """Validate ``{t:'res', id, ok:true, result}`` / ``{t:'res', id, ok:false, error:{code,message}}``."""
    rid = _ident(frame, "id")
    ok = frame.get("ok")
    if not isinstance(ok, bool):
        raise ProtocolError("bad_res", "res.ok must be a boolean")
    if ok:
        result = frame.get("result", {})
        if not isinstance(result, dict):
            raise ProtocolError("bad_res", "res.result must be an object")
        return RpcResponse(id=rid, ok=True, result=result)
    error = frame.get("error")
    if not isinstance(error, dict) or not isinstance(error.get("code"), str) or not error["code"]:
        raise ProtocolError("bad_res", "failed res needs error.code")
    retry = error.get("retry_after_ms")
    retry = retry if isinstance(retry, int) and not isinstance(retry, bool) and 0 < retry <= 3_600_000 else None
    return RpcResponse(id=rid, ok=False, result={}, error_code=known_error_code(error["code"]),
                       retry_after_ms=retry)


# Hub error code -> Hermes ``SendResult.error_kind`` (SEND_ERROR_KINDS). Unknown codes stay "unknown".
_ERROR_KINDS = {
    "rate_limited": "rate_limited", "not_found": "not_found", "forbidden": "forbidden",
    "unauthorized": "forbidden", "too_large": "too_long", "invalid_request": "bad_format",
}


def error_kind_for(code: str) -> str:
    return _ERROR_KINDS.get(code, "unknown")


_REQUEST_FIELDS = {
    "message.send": {"chat_id", "text", "format", "reply_to", "final", "idempotency_key"},
    "message.edit": {"chat_id", "message_id", "text", "format", "final", "idempotency_key"},
    "message.delete": {"chat_id", "message_id", "idempotency_key"},
    "chat.action": {"chat_id", "action"},
    "commands.set": {"commands"},
}


def build_request(op: str, rid: str, **params: Any) -> dict:
    """Adapter->hub request frame; ``None`` params are omitted (optional fields stay absent). Only
    fields the hub allows for ``op`` are accepted: it answers anything else with invalid_request."""
    unknown = set(params) - _REQUEST_FIELDS.get(op, set())
    if unknown:
        raise ProtocolError("bad_request", f"{op} does not take {sorted(unknown)}")
    return {"t": op, "id": rid, **{k: v for k, v in params.items() if v is not None}}


def build_ack(event_id: int) -> dict:
    return {"t": "ack", "event_id": event_id}


def encode_frame(frame: dict) -> str:
    data = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    if utf8_len(data) > MAX_FRAME_BYTES:
        raise ProtocolError("frame_too_large", "outbound frame exceeds the hub frame cap")
    return data


BOT_WS_PATH = "/api/bot/ws"
MAX_TOKEN_CHARS = 512
_SCHEMES = {"https": "wss", "wss": "wss", "http": "ws", "ws": "ws"}


def is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def bot_ws_url(hub_url: str) -> str:
    """Hub base URL (or the full socket URL) -> ``wss://host[:port][/prefix]/api/bot/ws``.

    TLS is mandatory except for loopback hosts (tests, same-host hub). URLs carrying credentials,
    a query (no query-string tokens) or a fragment are refused outright."""
    parsed = urllib.parse.urlsplit((hub_url or "").strip())
    scheme = _SCHEMES.get(parsed.scheme.lower())
    if scheme is None or not parsed.hostname:
        raise ValueError("hub_url must be an https:// (or loopback http://) URL")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise ValueError("hub_url must not embed credentials; set FOXFLEET_BOT_TOKEN instead")
    if parsed.query or parsed.fragment:
        raise ValueError("hub_url must not carry a query string or fragment")
    if scheme == "ws" and not is_loopback_host(parsed.hostname):
        raise ValueError("hub_url must use https:// unless the hub is on loopback")
    try:
        parsed.port  # noqa: B018 - validates the port
    except ValueError:
        raise ValueError("hub_url has an invalid port") from None
    path = parsed.path.rstrip("/")
    if not path.endswith(BOT_WS_PATH):
        path += BOT_WS_PATH
    return urllib.parse.urlunsplit((scheme, parsed.netloc, path, "", ""))


def check_bot_token(token: Any) -> str:
    """Return the token if it is a plausible bot token; errors never include the value."""
    if not isinstance(token, str) or not token:
        raise ValueError("FOXFLEET_BOT_TOKEN is not set")
    if len(token) > MAX_TOKEN_CHARS or not token.isascii() or not token.isprintable() or " " in token:
        raise ValueError("FOXFLEET_BOT_TOKEN is malformed (expected one printable ASCII word)")
    return token


def auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bot {token}"}


def parse_event_id(frame: dict) -> int:
    event_id = _event_id(frame, "event_id")
    if event_id == 0:
        raise ProtocolError("bad_event_id", "event_id must be positive")
    return event_id


def build_pong(ping: dict) -> dict:
    """``{t:'pong'}`` echoing a ping's ``id`` when it carried one (WS-level pings are separate)."""
    rid = ping.get("id")
    return {"t": "pong", **({"id": rid} if isinstance(rid, str) and len(rid) <= MAX_ID_CHARS else {})}
