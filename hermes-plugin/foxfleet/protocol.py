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
PROTOCOL_V11 = "foxfleet.bot/1.1"
PROTOCOL_V12 = "foxfleet.bot/1.2"
SUBPROTOCOL = "foxfleet.bot.v1"
SUBPROTOCOL_V11 = "foxfleet.bot.v1.1"
SUBPROTOCOL_V12 = "foxfleet.bot.v1.2"
OFFERED_SUBPROTOCOLS = (SUBPROTOCOL_V12, SUBPROTOCOL_V11, SUBPROTOCOL)
ACCEPTED_PROTOCOLS = frozenset({PROTOCOL, PROTOCOL_V11, PROTOCOL_V12})
ROOM_FEATURES = ("stop", "cards", "media", "groups")
STOP_ID = re.compile(r"^fs_[A-Za-z0-9_-]{16}$")
STOP_OUTCOMES = frozenset({"stopped", "idle", "refused", "expired"})
_FEATURE = re.compile(r"^[a-z]{1,32}$")
BOT_ID = re.compile(r"^[0-9a-f]{24}$")
CHAT_ID = re.compile(r"^fc_[A-Za-z0-9_-]{16}$")
THREAD_ID = re.compile(r"^fcr_[A-Za-z0-9_-]{16}$")
MESSAGE_ID = re.compile(r"^fm_[A-Za-z0-9_-]{16}$")
DISPATCH_ID = re.compile(r"^fd_[A-Za-z0-9_-]{16}$")
AGENT_REF = re.compile(r"^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_MENTIONS = 64
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
    protocol: str = PROTOCOL
    features: frozenset[str] = frozenset()
    max_media_bytes: int = 25 * 1024 * 1024


def _features(value: Any) -> frozenset[str]:
    if value is None:
        return frozenset()
    if not isinstance(value, list) or len(value) > 8:
        raise ProtocolError("bad_hello", "features must be a list of at most 8 names")
    names = []
    for item in value:
        if not isinstance(item, str) or not _FEATURE.match(item):
            raise ProtocolError("bad_hello", "feature names are lowercase words")
        names.append(item)
    return frozenset(names)


def parse_hello(frame: dict) -> Hello:
    if frame.get("t") != "hello":
        raise ProtocolError("expected_hello", "first hub frame must be hello")
    protocol = frame.get("protocol")
    if protocol not in ACCEPTED_PROTOCOLS:
        raise ProtocolError("version_mismatch", f"hub does not speak {PROTOCOL} or {PROTOCOL_V11}")
    resume_from = _event_id(frame, "resume_from")
    latest = _event_id(frame, "latest_event_id")
    if resume_from > latest:
        raise ProtocolError("bad_event_id", "resume_from is beyond latest_event_id")
    limits = frame.get("limits", {})
    if not isinstance(limits, dict):
        raise ProtocolError("bad_hello", "limits must be an object")
    max_media = limits.get("max_media_bytes", 25 * 1024 * 1024)
    if isinstance(max_media, bool) or not isinstance(max_media, int) or not 0 < max_media <= 1024 * 1024 * 1024:
        raise ProtocolError("bad_hello", "invalid media byte limit")
    return Hello(bot=_match(frame, "bot", BOT_ID), resume_from=resume_from, latest_event_id=latest,
                 protocol=protocol, features=_features(frame.get("features")), max_media_bytes=max_media)


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
    media: tuple[dict, ...] = ()
    thread_id: str | None = None
    actor_kind: str = "human"
    is_bot: bool = False
    mentions: tuple[dict, ...] = ()


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
    media = frame.get("media", [])
    if not isinstance(media, list) or len(media) > 10:
        raise ProtocolError("bad_media", "invalid attachment list")
    attachments = []
    for item in media:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not re.fullmatch(r"fbm_[A-Za-z0-9_-]{24}", item["id"])
                or item.get("kind") not in ("image", "audio", "video", "file")
                or not isinstance(item.get("mime"), str) or len(item["mime"]) > 100
                or not isinstance(item.get("name"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", item["name"])
                or isinstance(item.get("size"), bool) or not isinstance(item.get("size"), int)
                or item["size"] < 1 or item["size"] > 1024 * 1024 * 1024):
            raise ProtocolError("bad_media", "invalid attachment metadata")
        attachments.append({k: item[k] for k in ("id", "kind", "mime", "name", "size")})
    return InboundMessage(event_id=event_id, chat_id=chat_id, message_id=message_id, user_id=user_id,
                          user_name=(name or "").strip() or None, text=text, reply_to=reply_to, media=tuple(attachments))

def _utf16_units(text: str) -> bytes:
    return text.encode("utf-16-le", "surrogatepass")


def _utf16_len(text: str) -> int:
    return len(_utf16_units(text)) // 2


def _parse_mentions(value: Any, text: str) -> tuple[dict, ...]:
    """1.2 mentions use UTF-16 code-unit spans (JS string indices), never UTF-8 bytes."""
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > MAX_MENTIONS:
        raise ProtocolError("bad_mentions", "mentions is an array of at most 64 entries")
    units = _utf16_units(text)
    total = len(units) // 2
    spans: list[tuple[int, int]] = []
    out: list[dict] = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {"kind", "id", "offset", "length"}:
            raise ProtocolError("bad_mentions", "invalid mention")
        if item.get("kind") != "agent" or not isinstance(item.get("id"), str) or not AGENT_REF.match(item["id"]):
            raise ProtocolError("bad_mentions", "mention ids are agent:<id>")
        offset, length = item.get("offset"), item.get("length")
        if (isinstance(offset, bool) or isinstance(length, bool) or not isinstance(offset, int)
                or not isinstance(length, int) or offset < 0 or not 1 <= length <= 256 or offset + length > total):
            raise ProtocolError("bad_mentions", "mention span is out of range")
        start = int.from_bytes(units[offset * 2:offset * 2 + 2], "little")
        end = int.from_bytes(units[(offset + length - 1) * 2:(offset + length - 1) * 2 + 2], "little")
        if 0xDC00 <= start <= 0xDFFF or 0xD800 <= end <= 0xDBFF:
            raise ProtocolError("bad_mentions", "mention span splits a surrogate pair")
        spans.append((offset, offset + length))
        out.append({"kind": "agent", "id": item["id"], "offset": offset, "length": length})
    spans.sort()
    for left, right in zip(spans, spans[1:]):
        if right[0] < left[1]:
            raise ProtocolError("bad_mentions", "mention spans overlap")
    return tuple(out)


def _parse_actor(value: Any) -> tuple[str, str, str, bool]:
    if not isinstance(value, dict) or set(value) != {"kind", "id", "name", "is_bot"}:
        raise ProtocolError("bad_actor", "actor must be an object")
    kind, ident, name, is_bot = value.get("kind"), value.get("id"), value.get("name"), value.get("is_bot")
    if kind not in ("human", "agent") or not isinstance(is_bot, bool):
        raise ProtocolError("bad_actor", "actor kind is human or agent")
    if not isinstance(ident, str) or not isinstance(name, str) or not name or len(name) > 256 or not name.isprintable():
        raise ProtocolError("bad_actor", "actor name is 1 to 256 printable characters")
    if kind == "agent":
        if is_bot is not True or not AGENT_REF.match(ident):
            raise ProtocolError("bad_actor", "an agent actor is agent:<id> and is_bot")
    elif is_bot is not False or ident.startswith("agent:") or not ident or len(ident) > 128:
        raise ProtocolError("bad_actor", "a human actor has a hub account id and is not a bot")
    return kind, ident, name, is_bot


def parse_room_message_new(frame: dict) -> InboundMessage:
    """A foxfleet.bot/1.2 room message: room ids, actor kind and UTF-16 mentions are frame fields."""
    if frame.get("t") != "message.new":
        raise ProtocolError("bad_frame", "not a message.new")
    allowed = {"t", "event_id", "chat_id", "chat_type", "thread_id", "message_id", "actor", "mentions", "text", "date", "reply_to"}
    if set(frame) - allowed:
        raise ProtocolError("bad_frame", "unexpected room message field")
    if frame.get("chat_type") != "group":
        raise ProtocolError("bad_frame", "not a room message")
    event_id = _event_id(frame, "event_id")
    if event_id == 0:
        raise ProtocolError("bad_event_id", "event_id must be positive")
    chat_id = _match(frame, "chat_id", CHAT_ID)
    thread_id = _match(frame, "thread_id", THREAD_ID)
    message_id = _match(frame, "message_id", MESSAGE_ID)
    text = _text(frame.get("text"))
    if not text:
        raise ProtocolError("bad_text", "text must be non-empty")
    _, user_id, user_name, is_bot = _parse_actor(frame.get("actor"))
    kind = frame["actor"]["kind"]
    mentions = _parse_mentions(frame.get("mentions"), text)
    reply_to = frame.get("reply_to")
    if reply_to is not None:
        reply_to = _match(frame, "reply_to", MESSAGE_ID)
    date = frame.get("date")
    if isinstance(date, bool) or not isinstance(date, int) or date < 0:
        raise ProtocolError("bad_frame", "date must be a non-negative integer")
    return InboundMessage(event_id=event_id, chat_id=chat_id, message_id=message_id, user_id=user_id,
                          user_name=user_name, text=text, reply_to=reply_to, chat_type="group",
                          thread_id=thread_id, actor_kind=kind, is_bot=is_bot, mentions=mentions)


@dataclass(frozen=True)
class RoomDispatch:
    """The transient hub->bot binding for one room turn (dispatch offer/run)."""
    dispatch_id: str
    run_token: str
    chat_id: str
    thread_id: str
    message_id: str
    actor_kind: str
    actor_id: str
    actor_name: str
    is_bot: bool
    text: str
    mentions: tuple[dict, ...]
    date: int
    reply_to: str | None = None
    root_id: str | None = None
    deadline_at: int | None = None
    owner_id: str | None = None
    target_agent_id: str | None = None


def parse_dispatch(frame: dict) -> RoomDispatch:
    if frame.get("t") != "dispatch.run":
        raise ProtocolError("bad_frame", "not a dispatch.run")
    allowed = {"t", "dispatch_id", "run_token", "chat_id", "thread_id", "message_id", "actor", "mentions",
               "text", "date", "reply_to", "root_id", "deadline_at", "owner_id", "target_agent_id"}
    if set(frame) - allowed:
        raise ProtocolError("bad_frame", "unexpected dispatch field")
    dispatch_id = _match(frame, "dispatch_id", DISPATCH_ID)
    thread_id = _match(frame, "thread_id", THREAD_ID)
    chat_id = _match(frame, "chat_id", CHAT_ID)
    message_id = _match(frame, "message_id", MESSAGE_ID)
    token = frame.get("run_token")
    if not isinstance(token, str) or not token or len(token) > MAX_ID_CHARS or not token.isprintable():
        raise ProtocolError("bad_frame", "run_token must be a bounded string")
    text = _text(frame.get("text"))
    if not text:
        raise ProtocolError("bad_text", "text must be non-empty")
    kind, user_id, user_name, is_bot = _parse_actor(frame.get("actor"))
    mentions = _parse_mentions(frame.get("mentions"), text)
    date = frame.get("date")
    if isinstance(date, bool) or not isinstance(date, int) or date < 0:
        raise ProtocolError("bad_frame", "date must be a non-negative integer")
    reply_to = frame.get("reply_to")
    if reply_to is not None:
        reply_to = _match(frame, "reply_to", MESSAGE_ID)
    root_id = frame.get("root_id")
    if root_id is not None:
        root_id = _match(frame, "root_id", MESSAGE_ID)
    deadline = frame.get("deadline_at")
    if deadline is not None and (isinstance(deadline, bool) or not isinstance(deadline, int) or deadline < 0):
        raise ProtocolError("bad_frame", "deadline_at must be a non-negative integer")
    owner_id = frame.get("owner_id")
    if owner_id is not None:
        owner_id = _ident(frame, "owner_id")
    target_agent_id = frame.get("target_agent_id")
    if target_agent_id is not None:
        target_agent_id = _match(frame, "target_agent_id", AGENT_REF)
    return RoomDispatch(dispatch_id=dispatch_id, run_token=token, chat_id=chat_id, thread_id=thread_id,
                        message_id=message_id, actor_kind=kind, actor_id=user_id, actor_name=user_name,
                        is_bot=is_bot, text=text, mentions=mentions, date=date, reply_to=reply_to,
                        root_id=root_id, deadline_at=deadline, owner_id=owner_id,
                        target_agent_id=target_agent_id)


@dataclass(frozen=True)
class ChatStop:
    """A transient hub stop. It has no event id and must never be acknowledged or replayed."""

    stop_id: str
    chat_id: str
    user_id: str
    user_name: str | None
    date: int
    expires_at: int
    thread_id: str | None = None
    chat_type: str = "dm"


def parse_chat_stop(frame: dict) -> ChatStop:
    if frame.get("t") != "chat.stop":
        raise ProtocolError("bad_frame", "not a chat.stop")
    if "event_id" in frame:
        raise ProtocolError("bad_frame", "chat.stop is transient and has no event_id")
    extra = set(frame) - {"t", "stop_id", "chat_id", "user", "date", "expires_at"}
    if extra:
        raise ProtocolError("bad_frame", "unexpected chat.stop field")
    user = frame.get("user")
    if not isinstance(user, dict):
        raise ProtocolError("bad_user", "user must be an object")
    name = user.get("name")
    if name is not None and (not isinstance(name, str) or len(name) > MAX_ID_CHARS or "\0" in name):
        raise ProtocolError("bad_user", "user.name must be a bounded string")
    return ChatStop(stop_id=_match(frame, "stop_id", STOP_ID), chat_id=_match(frame, "chat_id", CHAT_ID),
                    user_id=_ident(user, "id", where="user."), user_name=(name or "").strip() or None,
                    date=_event_id(frame, "date"), expires_at=_event_id(frame, "expires_at"))


CARD_CALLBACK_ID = re.compile(r"^fcb_[A-Za-z0-9_-]{16}$")
CARD_REQUEST_ID = re.compile(r"^frq_[A-Za-z0-9_-]{16}$")
CARD_KINDS = frozenset({"approval", "confirm", "clarify"})


@dataclass(frozen=True)
class CardCallback:
    callback_id: str
    request_id: str
    chat_id: str
    user_id: str
    user_name: Optional[str]
    kind: str
    value: dict
    thread_id: str | None = None
    chat_type: str = "dm"


def parse_callback(frame: dict) -> CardCallback:
    """A card answer. Not a transcript event: it has no ``event_id`` and must not be acknowledged."""
    if frame.get("t") != "callback":
        raise ProtocolError("bad_frame", "not a callback")
    if "event_id" in frame:
        raise ProtocolError("bad_frame", "callback is not a message event")
    extra = set(frame) - {"t", "callback_id", "request_id", "chat_id", "user", "kind", "value"}
    if extra:
        raise ProtocolError("bad_frame", "unexpected callback field")
    kind = frame.get("kind")
    if kind not in CARD_KINDS:
        raise ProtocolError("bad_frame", "unknown card kind")
    value = frame.get("value")
    if not isinstance(value, dict) or len(value) > 8:
        raise ProtocolError("bad_frame", "callback value must be a small object")
    user = frame.get("user")
    if not isinstance(user, dict):
        raise ProtocolError("bad_user", "user must be an object")
    name = user.get("name")
    if name is not None and (not isinstance(name, str) or len(name) > MAX_ID_CHARS or "\0" in name):
        raise ProtocolError("bad_user", "user.name must be a bounded string")
    return CardCallback(callback_id=_match(frame, "callback_id", CARD_CALLBACK_ID),
                        request_id=_match(frame, "request_id", CARD_REQUEST_ID),
                        chat_id=_match(frame, "chat_id", CHAT_ID),
                        user_id=_ident(user, "id", where="user."), user_name=(name or "").strip() or None,
                        kind=kind, value=value)


def parse_room_chat_stop(frame: dict) -> ChatStop:
    """A 1.2 room stop: the authenticated human actor and room carriers replace `user`."""
    if frame.get("t") != "chat.stop":
        raise ProtocolError("bad_frame", "not a chat.stop")
    allowed = {"t", "stop_id", "chat_id", "chat_type", "thread_id", "actor", "date", "expires_at"}
    if set(frame) != allowed:
        raise ProtocolError("bad_frame", "unexpected room chat.stop field")
    if frame.get("chat_type") != "group":
        raise ProtocolError("bad_frame", "room chat.stop is chat_type group")
    kind, user_id, user_name, is_bot = _parse_actor(frame.get("actor"))
    if kind != "human" or is_bot:
        raise ProtocolError("bad_user", "stop is owner-only")
    return ChatStop(stop_id=_match(frame, "stop_id", STOP_ID), chat_id=_match(frame, "chat_id", CHAT_ID),
                    user_id=user_id, user_name=user_name, date=_event_id(frame, "date"),
                    expires_at=_event_id(frame, "expires_at"),
                    thread_id=_match(frame, "thread_id", THREAD_ID), chat_type="group")


def parse_room_callback(frame: dict) -> CardCallback:
    if frame.get("t") != "callback":
        raise ProtocolError("bad_frame", "not a callback")
    allowed = {"t", "callback_id", "request_id", "chat_id", "chat_type", "thread_id", "actor", "kind", "value"}
    if set(frame) != allowed:
        raise ProtocolError("bad_frame", "unexpected room callback field")
    kind, user_id, user_name, is_bot = _parse_actor(frame.get("actor"))
    if kind != "human" or is_bot:
        raise ProtocolError("bad_user", "a card tap is human")
    card_kind = frame.get("kind")
    value = frame.get("value")
    if card_kind not in CARD_KINDS or not isinstance(value, dict) or len(value) > 8:
        raise ProtocolError("bad_frame", "invalid card callback")
    return CardCallback(callback_id=_match(frame, "callback_id", CARD_CALLBACK_ID),
                        request_id=_match(frame, "request_id", CARD_REQUEST_ID),
                        chat_id=_match(frame, "chat_id", CHAT_ID), user_id=user_id, user_name=user_name,
                        kind=card_kind, value=value,
                        thread_id=_match(frame, "thread_id", THREAD_ID), chat_type="group")


# Contract error codes plus the defensive codes the adapter treats as fatal; hub-supplied codes outside
# this set are reported as "unrecognized" so hub-controlled text never reaches logs or results.
KNOWN_ERROR_CODES = frozenset({
    "invalid_request", "unsupported", "unknown_type", "bad_frame", "not_found", "forbidden", "too_large",
    "rate_limited", "idempotency_conflict", "ack_out_of_range", "internal",
    "unauthorized", "token_revoked", "version_mismatch", "unsupported_protocol", "replaced",
    "conversation_not_found", "not_conversation_owner", "actor_forbidden", "owner_only",
    "group_not_available", "handoff_limit", "handoff_expired", "handoff_not_found", "handoff_self",
    "handoff_not_final", "dispatch_not_running", "dispatch_stale", "dispatch_finalized",
    "dispatch_context_required", "mentions_invalid", "unknown_mention", "cross_room_reply", "reply_not_found",
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
    "message.send": {"chat_id", "text", "format", "reply_to", "final", "idempotency_key", "media", "reasoning", "mentions", "dispatch_id", "run_token"},
    "message.edit": {"chat_id", "message_id", "text", "format", "final", "idempotency_key", "reasoning", "mentions", "dispatch_id", "run_token"},
    "message.delete": {"chat_id", "message_id", "idempotency_key"},
    "chat.action": {"chat_id", "action"},
    "commands.set": {"commands"},
    "models.set": {"providers"},
    "callback.answer": {"callback_id", "chat_id", "thread_id", "outcome"},
    "card.send": {"chat_id", "kind", "instance", "card_key", "ttl_ms", "idempotency_key", "command", "description", "questions", "actor_kind"},
    "card.close": {"request_id", "all_except_instance", "reason", "actor_kind"},
    "handoff.request": {"chat_id", "thread_id", "source_message_id", "target_agent_id", "text", "idempotency_key", "dispatch_id", "run_token"},
    "chat.get": {"chat_id", "thread_id"},
    "chat.cancel": {"chat_id", "thread_id", "dispatch_id"},
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
