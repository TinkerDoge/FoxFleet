"""FoxFleet hub platform adapter (text v1, negotiated HTTP media in v1.1).

The gateway dials OUT to the hub's ``/api/bot/ws`` with ``Authorization: Bot <token>``. Hub users
chat with this agent as DMs; the hub authenticates the humans, Hermes still authorizes them
(``FOXFLEET_ALLOWED_USERS`` / pairing, default deny).

Settings (per profile): ``platforms.foxfleet.extra.hub_url`` / ``home_channel`` in config.yaml
(env ``FOXFLEET_HUB_URL`` / ``FOXFLEET_HOME_CHANNEL`` win), secret ``FOXFLEET_BOT_TOKEN`` from the
profile's ``.env`` read through the scoped secret reader, never ``os.getenv``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import itertools
import json
import logging
import random
import re
import secrets
import sys
import time
import traceback
import weakref
from collections import OrderedDict
from dataclasses import dataclass, field
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import (
    apply_yaml_bridge as _apply_yaml_bridge,
    env_is_connected as _env_is_connected,
    extra_or_secret as _extra_or_secret,
    get_scoped_secret as _get_scoped_secret,
    seed_extra_from_env as _seed_extra_from_env,
)
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator
from hermes_constants import get_hermes_home
from utils import atomic_json_write, read_json_or_empty

from . import protocol
from .ownership import BotLock

logger = logging.getLogger(__name__)
_WS_LOGGER = logging.getLogger(f"{__name__}.ws")


PLATFORM_NAME = "foxfleet"
PLUGIN_VERSION = "0.1.0"
TOKEN_ENV = "FOXFLEET_BOT_TOKEN"
HUB_URL_ENV = "FOXFLEET_HUB_URL"
HOME_ENV = "FOXFLEET_HOME_CHANNEL"
ALLOWED_USERS_ENV = "FOXFLEET_ALLOWED_USERS"
ALLOW_ALL_ENV = "FOXFLEET_ALLOW_ALL_USERS"

try:
    from websockets.asyncio.client import connect as _ws_connect
    from websockets.exceptions import ConnectionClosed, InvalidStatus
    from websockets.frames import Frame as _WsFrame
    WEBSOCKETS_AVAILABLE = True
except ImportError:  # pragma: no cover - websockets ships with Hermes
    WEBSOCKETS_AVAILABLE = False
    _ws_connect = object  # type: ignore[assignment,misc]

    class ConnectionClosed(Exception):  # type: ignore[no-redef]
        rcvd = None

    class InvalidStatus(Exception):  # type: ignore[no-redef]
        response = None

    class _WsFrame:  # type: ignore[no-redef]
        pass


_WS_WITHHELD = "foxfleet: websocket log record withheld (contained the bot credential)"
# Sent (once, replying to that message) when Hermes' busy path returned True during a drain without an
# acceptance receipt: the message may or may not have been applied, so it is never replayed.
ADMISSION_UNCERTAIN_NOTICE = ("⚠️ FoxFleet could not confirm that this message was processed (the gateway "
                              "was restarting). If you do not get an answer to it, please send it again.")
# Sent once after a restart for a message the gateway had accepted (and FoxFleet acknowledged) but
# whose handler was still held behind a drain when that gateway stopped.
UNPROCESSED_NOTICE = ("⚠️ This message was not processed because the gateway restarted before it ran. "
                      "Please send it again.")
_UNICODE_ESCAPE = re.compile(r"\\+u([0-9a-fA-F]{4})")


class _ConnLogger(logging.LoggerAdapter):
    """Logger handed to websockets for ONE connection. websockets logs whole frames and request
    headers at DEBUG; here frame payloads are never rendered, the Authorization header is redacted,
    and any other record that still carries this connection's token (raw or JSON-escaped) is dropped."""

    def __init__(self, logger: logging.Logger, token: str):
        super().__init__(logger, {})
        self._token = token

    def _carries_token(self, text: str) -> bool:
        if not self._token:
            return False
        unescaped = _UNICODE_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text)
        return self._token in text or self._token in unescaped

    def log(self, level, msg, *args, **kwargs):  # type: ignore[override]
        if not self.isEnabledFor(level):
            return
        exc_info = kwargs.pop("exc_info", None)
        direction = msg[:1] if isinstance(msg, str) else ""
        if msg in ("< %s", "> %s") and args and isinstance(args[0], _WsFrame):
            frame = args[0]
            rendered = f"{direction} {frame.opcode.name} frame ({len(frame.data)} bytes, payload withheld)"
        elif msg in ("< %s: %s", "> %s: %s") and len(args) == 2 and str(args[0]).lower() == "authorization":
            rendered = f"{direction} {args[0]}: <redacted>"
        else:
            try:
                rendered = str(msg) % args if args else str(msg)
            except Exception:
                rendered = str(msg)
            if exc_info:
                rendered += "\n" + "".join(traceback.format_exception(*(
                    sys.exc_info() if exc_info is True else
                    exc_info if isinstance(exc_info, tuple) else
                    (type(exc_info), exc_info, exc_info.__traceback__))))
            if self._carries_token(rendered):
                rendered = _WS_WITHHELD
        self.logger.log(level, "%s", rendered)

PLATFORM_HINT = (
    "You are chatting through FoxFleet, the user's self-hosted chat hub (web and Android apps). "
    "Markdown renders. Each message may hold up to 64 KiB; longer replies are split into several "
    "messages. You can send images and files (up to 25 MiB each; plain text, HTML, SVG and "
    "executables are refused, so put those in the message or a code block) and the user can send "
    "you up to four images per message. Voice and video are delivered as file attachments, not "
    "as a voice bubble or player. Approvals, confirmations and clarifying questions appear as "
    "tappable cards; there are no other custom buttons, reactions or threads, so offer choices "
    "as a short list the user can answer in text."
)


def check_requirements() -> bool:
    """Passive dependency probe (no installs): the websockets client is importable."""
    return WEBSOCKETS_AVAILABLE


def _hub_url(extra: Optional[dict]) -> str:
    return str(_extra_or_secret(extra or {}, "hub_url", HUB_URL_ENV, "") or "").strip()


def _bot_token(config: Any) -> str:
    """The profile-scoped bot token: env secret first, then the generic ``PlatformConfig.token``.
    ``extra`` is never consulted, so the token never lives in a YAML ``extra`` block."""
    token = _get_scoped_secret(TOKEN_ENV, None)
    if token is None or not str(token).strip():
        token = getattr(config, "token", None)
    return str(token or "").strip()


def validate_config(config: Any) -> bool:
    """A usable hub URL (TLS unless loopback, no embedded credentials) and a well-formed token."""
    try:
        protocol.bot_ws_url(_hub_url(getattr(config, "extra", None)))
        protocol.check_bot_token(_bot_token(config))
    except ValueError as exc:
        logger.warning("FoxFleet: %s", exc)
        return False
    return True


_token_is_set = _env_is_connected(TOKEN_ENV)


def is_connected(config: Any) -> bool:
    """Configured for status/setup displays: token in the profile env and a hub URL."""
    return bool(_hub_url(getattr(config, "extra", None))) and _token_is_set(config)


def _env_enablement() -> Optional[dict]:
    """Seed ``PlatformConfig.extra`` from the profile env before construction; ``None`` without a
    token. The token itself is deliberately NOT copied into ``extra``."""
    if not str(_get_scoped_secret(TOKEN_ENV, "") or "").strip():
        return None
    return _seed_extra_from_env(((HUB_URL_ENV, "hub_url", lambda v: v.rstrip("/")),), home_env=HOME_ENV)


_YAML_BRIDGE = (("hub_url", HUB_URL_ENV, "str"), ("allowed_users", ALLOWED_USERS_ENV, "csv"))


def _apply_yaml_config(yaml_cfg: dict, platform_cfg: dict) -> Optional[dict]:
    """config.yaml ``platforms.foxfleet`` keys -> env (env wins, skipped under a multiplexed
    secondary profile) + ``extra``. A scalar ``home_channel`` bridges to FOXFLEET_HOME_CHANNEL."""
    seeded = dict(_apply_yaml_bridge(platform_cfg, _YAML_BRIDGE) or {})
    home = platform_cfg.get("home_channel")
    if isinstance(home, (str, int)) and not isinstance(home, bool) and str(home).strip():
        seeded.update(_apply_yaml_bridge({"home_channel": str(home).strip()},
                                         (("home_channel", HOME_ENV, "str"),)) or {})
    return seeded or None


class _FatalConnect(Exception):
    """Connection refused in a way retrying cannot fix by itself (or must not fight over)."""

    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


class _OutcomeUnknown(Exception):
    """A request may have reached the hub but no response arrived (connection lost / timeout)."""


class _BadResponse(Exception):
    """The hub answered with a malformed ``res``: outcome unknown, and not worth auto-retrying."""


class _FatalFrame(Exception):
    """A hub frame that must end this connection for good (no reconnect), without acknowledging."""

    def __init__(self, code: str, message: str, close_code: int = 1000):
        super().__init__(message)
        self.code, self.message, self.close_code = code, message, close_code


class _NotSent(Exception):
    """No live connection: the request never left this process."""


class _Conn:
    """One authenticated socket. Every queued event and pending RPC remembers its _Conn, so work
    from a replaced socket can never ack on, or tear down, its successor."""

    def __init__(self, ws: Any, hello: protocol.Hello, generation: int):
        self.ws, self.hello, self.generation = ws, hello, generation
        self.opened_at = time.monotonic()
        self.last_event_id = hello.resume_from
        self.overflowed = False  # intake paused: dispatch queue was full
        self.abandoned = False  # an admission failed: stop dispatching this socket's events
        self.close_reason: Optional[tuple[str, str]] = None  # (code, message) for fatal closes
        self.media_enabled = False
        self.stop_enabled = False  # set from the negotiated hello; a 1.0 socket never interrupts
        self.cards_enabled = False


class _NoRedirectConnect(_ws_connect):  # type: ignore[misc,valid-type]
    """websockets follows redirects (cross-origin too) re-sending ``additional_headers``; a hub
    redirect must never carry the bot token anywhere, so redirects are refused."""

    def process_redirect(self, exc: Exception) -> Exception:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if isinstance(exc, InvalidStatus) and isinstance(status, int) and 300 <= status < 400:
            return _FatalConnect("foxfleet_redirect", f"hub answered the bot socket with a redirect "
                                 f"(HTTP {status}); configure the final hub URL", retryable=False)
        return exc


# Close codes / hub error codes that must stop reconnecting (contract/bot-api.md).
_FATAL_CLOSE = {
    1008: ("foxfleet_policy", "hub closed the bot socket for a policy violation"),
    4001: ("foxfleet_auth_rejected", "bot token rotated or revoked"),
    4003: ("foxfleet_bot_gone", "bot agent deleted, owner removed or disabled, or bot API off"),
    4009: ("foxfleet_replaced", "another connection with this bot token replaced this one; "
                                "not fighting it"),
}
# Fatal for THIS plugin (its own 1 s..60 s loop stops), but handed to the Hermes gateway as
# RETRYABLE so its reconnect queue (30 s, 60 s, ... capped at 300 s, run.py _reconnect_backoff) tries
# again. Hermes drops non-retryable fatals for good and, when FoxFleet is the profile's only platform,
# stops the gateway cleanly (no service restart): a disabled-then-re-enabled account, a bot API flag
# flipped off and on (rollback), or a one-off policy close would otherwise leave the agent offline
# until someone restarts it. 4001 (token rotated/revoked) and 4009 (replaced) stay final: retrying
# cannot fix a stale token, and a replaced connection must not fight its successor.
_GATEWAY_RETRYABLE = {"foxfleet_bot_gone", "foxfleet_policy"}
_FATAL_HUB_ERRORS = {"unauthorized": "foxfleet_auth_rejected", "token_revoked": "foxfleet_auth_rejected",
                     "forbidden": "foxfleet_auth_rejected", "version_mismatch": "foxfleet_protocol",
                     "unsupported_protocol": "foxfleet_protocol", "replaced": "foxfleet_replaced"}
_TRANSIENT_RPC_CODES = {"rate_limited"}


# Process-local owners keyed by lock identity: Hermes' scoped lock lets the SAME PID re-acquire,
# so two adapters in one process (multiplexed profiles sharing a token) need this extra guard.
_LOCAL_OWNERS: dict[str, "weakref.ReferenceType[FoxFleetAdapter]"] = {}


def _jittered(delay: float) -> float:
    return delay * (0.5 + random.random() / 2)


# Hermes' finalize placeholder for a native stream that accumulated no visible content
# (stream_consumer's `_accumulated or "✅"`): a bubble close, never a reply the user should see.
_EMPTY_FINALIZE_PLACEHOLDER = "✅"

@dataclass
class _Stream:
    chunks: list[tuple[str, str]] = field(default_factory=list)  # only this turn's (id, text)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    finalized: bool = False
    # (text, reply_to, final) of a chunk send whose outcome is unknown: it may exist at the hub.
    # Replayed verbatim (same idempotency key) before anything else, so it never becomes an orphan.
    unconfirmed: Optional[tuple[str, Optional[str], bool, str]] = None
    reply_to: Optional[str] = None
    # The authoritative final this turn still owes after its final frame failed (Hermes then
    # leaves native mode and re-sends exactly this text via send()/edit_message()).
    owed: Optional[str] = None
    owed_at: float = 0.0
    handed_off: bool = False
    # Hermes closed this stream with the empty-finalize placeholder: the tick is on the hub but
    # the turn is not finished. A later send() with real text edits that message in place.
    placeholder: bool = False
    placeholder_at: float = 0.0
    touched: float = field(default_factory=time.monotonic)

    def text(self) -> str:
        return "".join(t for _, t in self.chunks)

    def ids(self) -> list[str]:
        return [mid for mid, _ in self.chunks]


class FoxFleetAdapter(BasePlatformAdapter):
    """Hermes gateway adapter for the FoxFleet hub bot WebSocket (text DMs)."""

    MAX_MESSAGE_LENGTH = protocol.MAX_TEXT_BYTES  # measured by message_len_fn (UTF-8 bytes)
    supports_code_blocks = True
    splits_long_messages = True
    REQUIRES_EDIT_FINALIZE = True  # explicit edit callers can complete a reply
    # Hermes' supported cumulative-frame extension preserves turn-final semantics;
    # edit-transport finalize=True also seals overflow heads and is NOT turn completion.
    SUPPORTS_NATIVE_STREAMING = True
    MAX_STREAMS = 256
    HANDOFF_TTL = 3600.0  # how long a failed turn final may still be completed in place
    # How long an empty-stream placeholder tick may still be replaced by the turn's real text.
    # The gateway's stale-finalize recovery sends it seconds later; a long, generous window costs
    # nothing because only the chat's NEWEST stream can match, so a later turn cannot hijack it.
    PLACEHOLDER_TTL = 300.0
    # A cancelled native turn never sends its final frame. When the cache is full, a turn idle this
    # long is treated as abandoned (evicted) instead of refusing native streaming to new turns.
    STREAM_IDLE_EVICT = 1800.0
    FINAL_RATE_LIMIT_RETRIES = 5  # a rate-limited turn final waits for the hub's bucket
    RATE_LIMIT_BACKOFF = 0.5
    MAX_RATE_LIMIT_WAIT = 10.0

    # Tunables (class attributes so tests can shrink them).
    DISPATCH_QUEUE_SIZE = 256
    MAX_PENDING_RPCS = 256
    RPC_TIMEOUT = 15.0
    TYPING_TIMEOUT = 3.0
    OPEN_TIMEOUT = 15.0
    HELLO_TIMEOUT = 10.0
    RECONNECT_BASE_DELAY = 1.0
    RECONNECT_MAX_DELAY = 60.0
    STABLE_CONNECTION_SECONDS = 10.0
    SEND_RECONNECT_WAIT = 20.0
    MAX_SEND_ATTEMPTS = 3
    UNKNOWN_OUTCOME_TTL = 300.0
    MAX_UNKNOWN_OUTCOMES = 256
    MAX_RECENT_SENT = 2048
    MAX_CHAT_CACHE = 1024
    MAX_COMMANDS = 100
    MAX_UNPROCESSED = 64
    RELEASE_RETRY_BASE = 0.1
    RELEASE_RETRY_MAX = 5.0

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        extra = config.extra or {}
        self._hub_url = _hub_url(extra)
        self._token = _bot_token(config)
        self._conn: Optional[_Conn] = None
        self._bot_lock: Optional[BotLock] = None
        self._generation = 0
        self._connected = asyncio.Event()
        self._closing = False
        self._pending: dict[str, tuple[asyncio.Future, _Conn]] = {}
        self._cards: dict[str, dict] = {}
        self._cards_by_clarify: dict[str, str] = {}
        self._answered_callbacks: OrderedDict[str, str] = OrderedDict()
        self._card_instance = secrets.token_hex(8)
        self._rpc_counter = itertools.count(1)
        self._queue: Optional[asyncio.Queue] = None
        self._supervisor_task: Optional[asyncio.Task] = None
        self._dispatcher_task: Optional[asyncio.Task] = None
        self._side_tasks: set[asyncio.Task] = set()
        # Held as an attribute so the runner's reconnect carries live ids into the rebuilt adapter.
        self._dedup = MessageDeduplicator(max_size=2000, ttl_seconds=600)
        self._admitted = 0  # highest contiguous admitted event id (persisted per hub+bot)
        self._state_path: Optional[Path] = None
        self._bot_id: Optional[str] = None
        self._recent_sent: OrderedDict[str, None] = OrderedDict()
        self._chat_names: OrderedDict[str, str] = OrderedDict()
        self._unknown_outcomes: OrderedDict[str, tuple[str, float]] = OrderedDict()
        self._streams: OrderedDict[tuple[str, str], _Stream] = OrderedDict()
        # Accepted+acked messages whose handler is held behind a drain, persisted so a gateway that
        # stops before running them leaves a record; the next connect sends UNPROCESSED_NOTICE.
        self._unprocessed: OrderedDict[str, tuple[str, str]] = OrderedDict()
        self._held_live: set[str] = set()
        self._released_pending_save: set[str] = set()
        self._flush_lock = asyncio.Lock()
        self._notice_send: ContextVar[bool] = ContextVar("foxfleet_notice_send", default=False)
        # Chat ids whose next send() is the Stop acknowledgement. A set, not a ContextVar:
        # Hermes copies context into the drain task, and that copy was swallowing the next reply.
        self._suppress_stop_reply: set[str] = set()
        self._busy_drain_seen: ContextVar[Optional[list[bool]]] = ContextVar("foxfleet_busy_drain", default=None)

    # -- identity / helpers ----------------------------------------------
    @property
    def name(self) -> str:
        return "FoxFleet"

    @property
    def bot_id(self) -> Optional[str]:
        return self._bot_id

    @property
    def message_len_fn(self):
        return protocol.utf8_len

    def _redact(self, text: Any) -> str:
        text = str(text)
        return text.replace(self._token, "<redacted>") if self._token else text

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._side_tasks.add(task)
        task.add_done_callback(self._side_tasks.discard)
        return task

    # -- lifecycle -------------------------------------------------------
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if self._conn is not None and self._running:
            return True
        try:
            url = protocol.bot_ws_url(self._hub_url)
            protocol.check_bot_token(self._token)
        except ValueError as exc:
            self._set_fatal_error("foxfleet_config", str(exc), retryable=False)
            return False
        if not WEBSOCKETS_AVAILABLE:
            self._set_fatal_error("foxfleet_deps", "websockets is not installed", retryable=False)
            return False
        self._ws_url = url
        await self._stop_tasks()  # a fatal stop leaves the dispatcher behind; never run two
        if not self._claim_ownership(f"{url}\n{self._token}"):
            return False
        self._closing = False
        try:
            conn = await self._open()
        except _FatalConnect as exc:
            self._release_ownership()
            self._set_fatal_error(exc.code, exc.message, retryable=exc.retryable)
            logger.error("FoxFleet: %s", exc.message)
            return False
        except Exception as exc:
            self._release_ownership()
            message = f"could not reach the hub: {self._redact(exc.__class__.__name__)}"
            self._set_fatal_error("foxfleet_connect_failed", message, retryable=True)
            logger.warning("FoxFleet: %s (%s)", message, self._redact(exc))
            return False
        self._queue = asyncio.Queue(maxsize=self.DISPATCH_QUEUE_SIZE)
        self._install(conn)
        self._dispatcher_task = asyncio.create_task(self._dispatch_loop())
        self._supervisor_task = asyncio.create_task(self._supervise(conn))
        self._mark_connected()
        self._wire_plugin_handlers(None)
        self._spawn(self._sync_commands())
        self._spawn(self._flush_unprocessed())
        logger.info("FoxFleet: connected as bot %s (resume from event %d)", conn.hello.bot,
                    conn.hello.resume_from)
        return True

    async def _stop_tasks(self) -> None:
        tasks = [t for t in (self._supervisor_task, self._dispatcher_task, *self._side_tasks)
                 if t is not None and t is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._supervisor_task = self._dispatcher_task = None

    async def disconnect(self) -> None:
        self._closing = True
        await self._stop_tasks()
        conn, self._conn = self._conn, None
        self._connected.clear()
        if conn is not None:
            self._fail_pending(conn)
            with contextlib.suppress(Exception):
                await conn.ws.close(code=1000, reason="bot disconnect")
        if self._queue is not None:  # undelivered events stay unacked: the hub replays them
            while not self._queue.empty():
                self._queue.get_nowait()
                self._queue.task_done()
        with contextlib.suppress(Exception):
            self._release_ownership()
        self._mark_disconnected()

    def _claim_ownership(self, identity: str) -> bool:
        key = hashlib.sha256(identity.encode()).hexdigest()
        holder = _LOCAL_OWNERS.get(key)
        holder = holder() if holder is not None else None
        if holder is not None and holder is not self:
            message = "FoxFleet bot token already in use by another adapter in this gateway process"
            logger.error("FoxFleet: %s", message)
            self._set_fatal_error("foxfleet-bot_lock", message, retryable=True)
            return False
        if not self._acquire_platform_lock("foxfleet-bot", identity, "FoxFleet bot token"):
            return False
        bot_lock = self._bot_lock or BotLock(identity)
        try:
            held = bot_lock.acquire()
            message = "FoxFleet bot token already in use by another process on this host"
        except OSError as exc:
            held, message = False, f"could not take the FoxFleet bot lock: {exc.__class__.__name__}"
        if not held:
            self._release_platform_lock()
            logger.error("FoxFleet: %s", message)
            self._set_fatal_error("foxfleet-bot_lock", message, retryable=True)
            return False
        self._bot_lock = bot_lock
        _LOCAL_OWNERS[key] = weakref.ref(self)
        self._owner_key = key
        return True

    def _release_ownership(self) -> None:
        key = getattr(self, "_owner_key", None)
        if key is not None:
            holder = _LOCAL_OWNERS.get(key)
            if holder is not None and holder() is self:
                del _LOCAL_OWNERS[key]
            self._owner_key = None
        if self._bot_lock is not None:
            self._bot_lock.release()
            self._bot_lock = None
        self._release_platform_lock()

    async def _open(self) -> _Conn:
        """Open + authenticate one socket and read the hub hello."""
        try:
            ws = await _NoRedirectConnect(
                self._ws_url, additional_headers=protocol.auth_header(self._token),
                user_agent_header=f"hermes-foxfleet/{PLUGIN_VERSION}", compression=None,
                open_timeout=self.OPEN_TIMEOUT, max_size=protocol.MAX_FRAME_BYTES, max_queue=64,
                ping_interval=20, ping_timeout=20, close_timeout=5, logger=_ConnLogger(_WS_LOGGER, self._token),
                subprotocols=list(protocol.OFFERED_SUBPROTOCOLS), proxy=None)
        except _FatalConnect:
            raise
        except InvalidStatus as exc:
            status = exc.response.status_code
            if status in (401, 403):
                raise _FatalConnect("foxfleet_auth_rejected",
                                    f"hub rejected the bot token (HTTP {status})") from None
            if status in (400, 426):
                raise _FatalConnect("foxfleet_protocol", f"hub refused the bot socket (HTTP {status})") from None
            raise _FatalConnect("foxfleet_hub_unavailable", f"hub bot socket unavailable (HTTP {status})",
                                retryable=True) from None
        if ws.subprotocol not in protocol.OFFERED_SUBPROTOCOLS:
            with contextlib.suppress(Exception):
                await ws.close(code=1002, reason="subprotocol")
            raise _FatalConnect("foxfleet_protocol", "hub did not select an offered foxfleet subprotocol")
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=self.HELLO_TIMEOUT)
            hello = protocol.parse_hello(protocol.parse_frame(raw))
            negotiated_v11 = ws.subprotocol == protocol.SUBPROTOCOL_V11
            if negotiated_v11 != (hello.protocol == protocol.PROTOCOL_V11):
                raise protocol.ProtocolError("version_mismatch", "hello protocol does not match the selected subprotocol")
        except protocol.ProtocolError as exc:
            await ws.close(code=1002, reason="bad hello")
            raise _FatalConnect("foxfleet_protocol", f"bad hub hello: {exc}",
                                retryable=exc.code != "version_mismatch") from None
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd is not None else None
            fatal = _FATAL_CLOSE.get(code)
            if fatal:
                raise _FatalConnect(*fatal, retryable=fatal[0] in _GATEWAY_RETRYABLE) from None
            raise
        except BaseException:
            with contextlib.suppress(Exception):
                await ws.close()
            raise
        if self._bot_id is not None and hello.bot != self._bot_id:
            await ws.close(code=1000)
            raise _FatalConnect("foxfleet_identity_changed", "the bot token now belongs to a different bot")
        self._generation += 1
        conn = _Conn(ws, hello, self._generation)
        conn.stop_enabled = ws.subprotocol == protocol.SUBPROTOCOL_V11 and "stop" in hello.features
        conn.media_enabled = ws.subprotocol == protocol.SUBPROTOCOL_V11 and "media" in hello.features
        conn.cards_enabled = ws.subprotocol == protocol.SUBPROTOCOL_V11 and "cards" in hello.features
        self._bot_id = hello.bot
        self._load_state(hello)
        return conn

    def _install(self, conn: _Conn) -> None:
        self._conn = conn
        self._connected.set()

    async def _supervise(self, conn: _Conn) -> None:
        """Own the live socket: read until it drops, then reconnect with backoff + jitter."""
        delay = self.RECONNECT_BASE_DELAY
        while not self._closing:
            await self._read_loop(conn)
            self._lost(conn)
            if self._closing:
                return
            if conn.close_reason is not None:
                await self._fatal(*conn.close_reason)
                return
            if time.monotonic() - conn.opened_at >= self.STABLE_CONNECTION_SECONDS and not conn.abandoned:
                delay = self.RECONNECT_BASE_DELAY
            while not self._closing:
                await asyncio.sleep(_jittered(delay))
                delay = min(delay * 2, self.RECONNECT_MAX_DELAY)
                try:
                    conn = await self._open()
                except _FatalConnect as exc:
                    if not exc.retryable:
                        await self._fatal(exc.code, exc.message)
                        return
                    logger.warning("FoxFleet: reconnect failed: %s", exc.message)
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("FoxFleet: reconnect failed: %s", self._redact(exc.__class__.__name__))
                    continue
                self._install(conn)
                self._mark_connected()
                self._spawn(self._sync_commands())
                self._spawn(self._flush_unprocessed())
                logger.info("FoxFleet: reconnected (resume from event %d)", conn.hello.resume_from)
                break

    async def _fatal(self, code: str, message: str) -> None:
        retryable = code in _GATEWAY_RETRYABLE
        logger.error("FoxFleet: %s; %s", message,
                     "handing over to the gateway reconnect queue" if retryable else "not reconnecting")
        with contextlib.suppress(Exception):
            self._release_ownership()
        self._set_fatal_error(code, message, retryable=retryable)
        await self._notify_fatal_error()

    def _lost(self, conn: _Conn) -> None:
        if self._conn is conn:
            self._conn = None
            self._connected.clear()
            if not self._closing and conn.close_reason is None:
                self._mark_degraded()  # status: "retrying" until the socket is back
        self._fail_pending(conn)

    def _fail_pending(self, conn: _Conn) -> None:
        for rid, (future, owner) in list(self._pending.items()):
            if owner is conn and not future.done():
                future.set_exception(_OutcomeUnknown("connection lost before the hub answered"))

    # -- inbound ---------------------------------------------------------
    async def _read_loop(self, conn: _Conn) -> None:
        try:
            async for raw in conn.ws:
                if isinstance(raw, bytes):
                    logger.warning("FoxFleet: binary frame from hub; resyncing")
                    await conn.ws.close(code=1003, reason="text frames only")
                    return
                try:
                    frame = protocol.parse_frame(raw)
                    await self._on_frame(conn, frame)
                except _FatalFrame as exc:
                    conn.close_reason = (exc.code, exc.message)
                    conn.abandoned = True
                    await conn.ws.close(code=exc.close_code, reason="fatal hub frame")
                    return
                except protocol.ProtocolError as exc:
                    logger.error("FoxFleet: hub protocol violation (%s): %s; reconnecting without "
                                 "acknowledging", exc.code, exc)
                    conn.abandoned = True
                    await conn.ws.close(code=1002, reason="protocol error")
                    return
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd is not None else None
            if code in _FATAL_CLOSE and conn.close_reason is None and not self._closing:
                conn.close_reason = _FATAL_CLOSE[code]
            logger.info("FoxFleet: socket closed (code %s)", code)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("FoxFleet: socket error: %s", self._redact(exc))
        finally:
            if conn.ws.close_code is None:
                with contextlib.suppress(Exception):
                    await conn.ws.close()
            if conn.close_reason is None and conn.ws.close_code in _FATAL_CLOSE and not self._closing:
                conn.close_reason = _FATAL_CLOSE[conn.ws.close_code]

    async def _on_frame(self, conn: _Conn, frame: dict) -> None:
        kind = frame["t"]
        if kind == "res":
            self._resolve(frame)
        elif kind == "message.new":
            self._enqueue_message(conn, frame)
        elif kind == "ping":
            await self._send_frame(conn, protocol.build_pong(frame))
        elif kind == "replay.gap":
            raise _FatalFrame("foxfleet_protocol", "hub reported a replay gap, which foxfleet.bot/1 "
                              "does not support; stopping without acknowledging past it", 1002)
        elif kind == "chat.stop":
            # Off the reader: the answer's res, and any /stop reply, must be readable while we wait.
            self._spawn(self._on_chat_stop(conn, frame))
        elif kind == "callback":
            self._spawn(self._on_card_callback(conn, frame))
        elif kind == "error":
            code = str(frame.get("code") or "")
            logger.warning("FoxFleet: hub error %s", protocol.known_error_code(code))
            if code in _FATAL_HUB_ERRORS:
                raise _FatalFrame(_FATAL_HUB_ERRORS[code], f"hub error: {code}")
        elif kind == "hello":
            raise protocol.ProtocolError("unexpected_hello", "hello after handshake")
        elif "event_id" in frame:
            # Unknown durable event (a later protocol extension): processed-as-ignored IN ORDER so the
            # cumulative ack can move past it.
            event_id = protocol.parse_event_id(frame)
            self._enqueue(conn, ("skip", event_id, f"unsupported event type {protocol.safe_frame_type(kind)!r}"), event_id)
        else:
            logger.debug("FoxFleet: ignoring hub frame type %r", protocol.safe_frame_type(kind))

    async def _on_chat_stop(self, conn: _Conn, frame: dict) -> None:
        """Feed a transient hub Stop through Hermes' own /stop path, then answer once.

        The frame is never acknowledged. An expired or unauthorised stop is not dispatched,
        so it cannot kill a later turn. The Stop acknowledgement is one discarded send for that
        chat, consumed before Hermes spawns a follow-up, so the next reply is not dropped. A stop
        is confirmed only if the turn that was running is actually gone.
        """
        if not getattr(conn, "stop_enabled", False):
            logger.debug("FoxFleet: ignoring chat.stop; stop was not negotiated")
            return
        await self._handle_chat_stop(conn, frame)

    async def _handle_chat_stop(self, conn: _Conn, frame: dict) -> None:
        try:
            stop = protocol.parse_chat_stop(frame)
        except protocol.ProtocolError as exc:
            logger.warning("FoxFleet: ignoring malformed chat.stop (%s)", exc.code)
            return
        if time.time() * 1000 > stop.expires_at:
            await self._answer_stop(conn, stop.stop_id, "expired")
            return
        if self._is_sender_authorized(stop.user_id, "dm", stop.chat_id) is not True:
            await self._answer_stop(conn, stop.stop_id, "refused")
            return
        event = self._stop_event(stop)
        session_key = self._event_session_key(event)
        was_active = session_key in self._active_sessions
        task_before = self._session_tasks.get(session_key)
        # One discarded send for this chat. Not a ContextVar: the idle /stop task and the
        # follow-up it spawns would both copy that flag and drop the next reply.
        self._suppress_stop_reply.add(str(event.source.chat_id))
        try:
            await self.handle_message(event)
        except Exception:
            logger.exception("FoxFleet: /stop dispatch failed")
            self._suppress_stop_reply.discard(str(event.source.chat_id))
            await self._answer_stop(conn, stop.stop_id, "refused")
            return
        # handle_message swallows a failed /stop and restores the running turn.
        if was_active and task_before is not None and not task_before.done():
            logger.warning("FoxFleet: /stop left the running turn in place; not confirming")
            self._suppress_stop_reply.discard(str(event.source.chat_id))
            await self._answer_stop(conn, stop.stop_id, "refused")
            return
        await self._answer_stop(conn, stop.stop_id, "stopped" if was_active else "idle")

    def _stop_event(self, stop: protocol.ChatStop) -> MessageEvent:
        source = self.build_source(chat_id=stop.chat_id, chat_name=stop.user_name or stop.chat_id,
                                   chat_type="dm", user_id=stop.user_id, user_name=stop.user_name)
        return MessageEvent(text="/stop", message_type=MessageType.TEXT, source=source,
                            user_id=stop.user_id, user_name=stop.user_name, reply_expected=False)

    async def _answer_stop(self, conn: _Conn, stop_id: str, outcome: str) -> None:
        if self._conn is not conn or outcome not in protocol.STOP_OUTCOMES:
            return
        try:
            await self._request("callback.answer", retry_unknown=False, callback_id=stop_id, outcome=outcome)
        except Exception as exc:
            logger.warning("FoxFleet: stop answer %s was not confirmed (%s)", outcome, type(exc).__name__)

    def _cards_on(self) -> bool:
        conn = self._conn
        return bool(conn is not None and getattr(conn, "cards_enabled", False))

    @staticmethod
    def _clip(text: Any, n: int = 2000) -> str:
        cleaned = "".join(ch for ch in str(text or "") if ch in "\n\t" or (32 <= ord(ch) != 127))
        return cleaned[:n]

    async def _send_card(self, *, chat_id: str, kind: str, **fields: Any) -> Optional[str]:
        """Mint one card. None means the hub did not accept it; the caller falls back to text."""
        if not self._cards_on() or not protocol.CHAT_ID.match(str(chat_id or "")):
            return None
        key = f"card.{kind}.{secrets.token_hex(8)}"
        try:
            res = await self._request("card.send", retry_unknown=True, chat_id=str(chat_id), kind=kind,
                                      instance=self._card_instance, idempotency_key=key, **fields)
        except Exception as exc:
            logger.warning("FoxFleet: card.send failed (%s)", type(exc).__name__)
            return None
        if not res.ok:
            return None
        request_id = res.result.get("request_id")
        if not isinstance(request_id, str) or protocol.CARD_REQUEST_ID.match(request_id) is None:
            return None
        return request_id

    async def _send_exec_approval_prompt(self, prompt) -> SendResult:
        description = self._clip(getattr(prompt, "description", "")) or "Approval required"
        command = self._clip(getattr(prompt, "command", "")) or None
        session_key = str(getattr(prompt, "session_key", ""))
        approval_id = self._approval_id_for(session_key, str(getattr(prompt, "command", "")))
        if not approval_id:
            return SendResult(success=False, error="approval not uniquely bound")
        request_id = await self._send_card(chat_id=str(getattr(prompt, "chat_id", "")), kind="approval",
                                           command=command, description=description)
        if not request_id:
            return SendResult(success=False, error="cards not available")
        self._cards[request_id] = {"kind": "approval", "session_key": session_key, "approval_id": approval_id,
                                   "chat_id": str(getattr(prompt, "chat_id", ""))}
        return SendResult(success=True, message_id=request_id)

    def _approval_id_for(self, session_key: str, shown_command: str) -> Optional[str]:
        """The Hermes approval this card is for. None unless exactly one unbound pending approval matches."""
        if not session_key or not shown_command:
            return None
        try:
            from gateway.run import _redact_approval_command
            from tools.approval import list_gateway_approvals
            from .cards import bind_approval
        except Exception:
            logger.warning("FoxFleet: cannot bind an approval card", exc_info=True)
            return None
        bound = {str(c.get("approval_id")) for c in self._cards.values() if c.get("approval_id")}
        rows = [{"request_id": row.get("request_id"), "shown": _redact_approval_command(row.get("command"))}
                for row in list_gateway_approvals(session_key)]
        return bind_approval(rows, shown_command, bound)

    async def send_slash_confirm(self, chat_id: str, title: str, message: str, session_key: str, confirm_id: str,
                                 metadata: Optional[dict[str, Any]] = None) -> SendResult:
        description = self._clip(f"{title}\n\n{message}".strip()) or "Confirm"
        request_id = await self._send_card(chat_id=chat_id, kind="confirm", description=description)
        if not request_id:
            return SendResult(success=False, error="cards not available")
        self._cards[request_id] = {"kind": "confirm", "session_key": str(session_key), "confirm_id": str(confirm_id),
                                   "chat_id": str(chat_id)}
        return SendResult(success=True, message_id=request_id)

    async def send_clarify(self, chat_id: str, question: str, choices: Optional[list], clarify_id: str,
                           session_key: str, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        if not choices or not self._cards_on():
            return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata=metadata)
        multi = False
        try:
            from tools import clarify_gateway as _cg
            with _cg._lock:
                multi = bool(getattr(_cg._entries.get(clarify_id), "multi_select", False))
        except Exception:
            multi = False
        clean = [self._clip(c, 200) for c in choices if self._clip(c, 200)][:50]
        if not clean:
            return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata=metadata)
        request_id = await self._send_card(
            chat_id=chat_id, kind="clarify",
            questions=[{"id": "q0", "question": self._clip(question) or "Choose", "choices": clean, "multi_select": multi}])
        if not request_id:
            return await super().send_clarify(chat_id, question, choices, clarify_id, session_key, metadata=metadata)
        self._cards[request_id] = {"kind": "clarify", "clarify_id": str(clarify_id), "session_key": str(session_key),
                                   "chat_id": str(chat_id)}
        self._cards_by_clarify[str(clarify_id)] = request_id
        return SendResult(success=True, message_id=request_id)

    async def retire_clarify_card(self, clarify_id: str, notice: str = "") -> None:
        request_id = self._cards_by_clarify.pop(str(clarify_id), None)
        if request_id:
            self._cards.pop(request_id, None)
        if not request_id or not self._cards_on() or protocol.CARD_REQUEST_ID.match(request_id) is None:
            return
        try:
            await self._request("card.close", retry_unknown=True, request_id=request_id, reason="closed")
        except Exception:
            logger.debug("FoxFleet: card.close failed", exc_info=True)

    async def _on_card_callback(self, conn: _Conn, frame: dict) -> None:
        if not getattr(conn, "cards_enabled", False) or self._conn is not conn:
            return
        try:
            cb = protocol.parse_callback(frame)
        except protocol.ProtocolError as exc:
            logger.warning("FoxFleet: ignoring malformed callback (%s)", exc.code)
            return
        prior = self._answered_callbacks.get(cb.callback_id)
        if prior:
            await self._answer_card(conn, cb.callback_id, prior)
            return
        if self._is_sender_authorized(cb.user_id, "dm", cb.chat_id) is not True:
            await self._finish_card(conn, cb.callback_id, "refused")
            return
        pending = self._cards.pop(cb.request_id, None)
        if pending is None:
            await self._finish_card(conn, cb.callback_id, "expired")
            return
        self._cards_by_clarify.pop(str(pending.get("clarify_id") or ""), None)
        await self._finish_card(conn, cb.callback_id, await self._resolve_card(pending, cb))

    async def _resolve_card(self, pending: dict, cb: protocol.CardCallback) -> str:
        try:
            if cb.kind == "approval" and pending.get("kind") == "approval":
                choice = cb.value.get("choice")
                approval_id = pending.get("approval_id")
                if choice not in ("once", "deny") or not isinstance(approval_id, str) or not approval_id:
                    return "refused"
                from tools.approval import resolve_gateway_approval
                # request_id is the only authority. Omitting it pops the oldest approval in the session.
                return "resolved" if resolve_gateway_approval(str(pending.get("session_key") or ""), choice, request_id=approval_id) else "expired"
            if cb.kind == "confirm" and pending.get("kind") == "confirm":
                raw = cb.value.get("choice")
                choice = "once" if raw == "once" else "cancel" if raw == "deny" else None
                if choice is None:
                    return "refused"
                from tools import slash_confirm
                await slash_confirm.resolve(str(pending.get("session_key") or ""), str(pending.get("confirm_id") or ""), choice)
                return "resolved"
            if cb.kind == "clarify" and pending.get("kind") == "clarify":
                answers = cb.value.get("answers")
                text = str(next(iter(answers.values()), ""))[:2000] if isinstance(answers, dict) else ""
                from tools.clarify_gateway import resolve_gateway_clarify
                return "resolved" if resolve_gateway_clarify(str(pending.get("clarify_id") or ""), text) else "expired"
        except Exception:
            logger.warning("FoxFleet: card resolve failed", exc_info=True)
            return "refused"
        return "refused"

    async def _finish_card(self, conn: _Conn, callback_id: str, outcome: str) -> None:
        self._answered_callbacks[callback_id] = outcome
        while len(self._answered_callbacks) > 256:
            self._answered_callbacks.popitem(last=False)
        await self._answer_card(conn, callback_id, outcome)

    async def _answer_card(self, conn: _Conn, callback_id: str, outcome: str) -> None:
        if self._conn is not conn or outcome not in ("resolved", "expired", "refused"):
            return
        try:
            await self._request("callback.answer", retry_unknown=False, callback_id=callback_id, outcome=outcome)
        except Exception as exc:
            logger.warning("FoxFleet: card answer %s was not confirmed (%s)", outcome, type(exc).__name__)

    def _enqueue_message(self, conn: _Conn, frame: dict) -> None:
        try:
            msg = protocol.parse_message_new(frame)
            if msg.media and not conn.media_enabled:
                raise protocol.ProtocolError("unsupported_media", "media was not negotiated")
        except protocol.UnsupportedEvent as exc:
            self._enqueue(conn, ("unsupported", exc.event_id, exc), exc.event_id)
            return
        self._enqueue(conn, ("message", msg.event_id, msg), msg.event_id)

    def _enqueue(self, conn: _Conn, item: tuple, event_id: int) -> None:
        if conn.overflowed or conn.abandoned:
            return  # paused: these events stay unacked and are replayed after the resync
        if event_id <= conn.last_event_id:
            return  # the hub repeated an event on this socket
        if event_id != conn.last_event_id + 1:
            raise protocol.ProtocolError("event_gap", "durable events must arrive in strict sequence")
        assert self._queue is not None
        try:
            self._queue.put_nowait((conn, *item))
        except asyncio.QueueFull:
            conn.overflowed = True
            logger.warning("FoxFleet: dispatch queue full at event %d; pausing intake and resyncing "
                           "from the last ack (nothing is acknowledged or dropped)", event_id)
            self._spawn(self._resync_after_drain(conn))
            return
        conn.last_event_id = event_id

    async def _resync_after_drain(self, conn: _Conn) -> None:
        assert self._queue is not None
        await self._queue.join()
        if self._conn is conn:
            await conn.ws.close(code=1000, reason="resync")

    async def _dispatch_loop(self) -> None:
        """Admit events in order, one at a time, off the socket reader (a slow handler or an inline
        command that calls send() never blocks the reader that resolves RPC responses)."""
        assert self._queue is not None
        while True:
            conn, kind, event_id, payload = await self._queue.get()
            try:
                if conn.abandoned:
                    continue
                if kind == "message":
                    await self._admit(conn, payload)
                elif kind == "unsupported":
                    logger.warning("FoxFleet: event %d in chat %s not handled (%s): %s; this adapter "
                                   "serves text DMs only", event_id, payload.chat_id, payload.code, payload)
                    await self._advance(conn, event_id)
                else:
                    logger.info("FoxFleet: event %d skipped: %s", event_id, payload)
                    await self._advance(conn, event_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("FoxFleet: dispatch of event %d failed", event_id)
                conn.abandoned = True
                self._spawn(self._close_quietly(conn))
            finally:
                self._queue.task_done()

    async def _wait_for_gateway_admission(self, event: MessageEvent) -> None:
        """Keep ordinary work at the hub while the runner drains. No rejection side effects,
        ACK, dedup mark or socket churn; disconnect cancels this wait. Commands still use
        the runner's control path. The ordered dispatcher intentionally backpressures later events.
        """
        if event.is_command():
            return
        warned = False
        while self._runner_draining():
            if not warned:
                logger.info("FoxFleet: gateway draining; retaining inbound work without acknowledging")
                warned = True
            await asyncio.sleep(0.1)

    def _runner_draining(self) -> bool:
        runner = self.gateway_runner
        return runner is not None and (getattr(runner, "_draining", False)
                                       or getattr(runner, "_external_drain_active", False))

    def set_message_handler(self, handler) -> None:
        # A drain may start after BasePlatformAdapter spawned/accepted the task, before
        # its handler runs. Keep that already accepted task, rather than consume a notice.
        # The hub event is already ACKed, so a held task is recorded on disk until it runs.
        if handler is not None:
            inner = handler

            async def retained(event: MessageEvent):
                held = None
                if not event.is_command() and self._runner_draining():
                    held = await self._hold_unprocessed(event)
                try:
                    await self._wait_for_gateway_admission(event)
                except asyncio.CancelledError:
                    # The gateway cancelled this held task (drain-timeout shutdown): it will never
                    # run here. Drop ONLY the live marker so a flush can notice it; keep the record.
                    if held is not None:
                        self._held_live.discard(held)
                        self._spawn(self._flush_unprocessed())
                    raise
                if held is not None:
                    await self._release_unprocessed(held)
                return await inner(event)

            handler = retained
        super().set_message_handler(handler)

    async def _admit(self, conn: _Conn, msg: protocol.InboundMessage) -> None:
        if conn.abandoned:
            return
        key = f"{msg.chat_id}\x1f{msg.message_id}"
        if msg.event_id <= self._admitted or self._dedup.contains(key):
            await self._advance(conn, msg.event_id)  # replay of an admitted event: re-ack only
            return
        if msg.user_id == self._bot_id or msg.message_id in self._recent_sent:
            logger.debug("FoxFleet: ignoring echo of this bot's own message %s", msg.message_id)
            await self._advance(conn, msg.event_id)
            return
        self._remember(self._chat_names, msg.chat_id, msg.user_name or msg.chat_id, self.MAX_CHAT_CACHE)
        event = self._build_event(msg)
        if msg.media:
            event.media_urls = await self._download_media(conn, msg.media)
            event.media_types = [m["mime"] for m in msg.media]
            event.message_type = MessageType.PHOTO if all(m["kind"] == "image" for m in msg.media) else MessageType.DOCUMENT
        await self._wait_for_gateway_admission(event)
        if conn.abandoned:
            return
        admitted = False
        try:
            await self.handle_message(event)
            if self._message_handler is not None:
                admitted = (event._gateway_accepted is True
                            or getattr(event, "_foxfleet_receipt", False) is True
                            or getattr(event.source, "profile_route_rejected", False) is True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("FoxFleet: gateway raised while admitting event %d", msg.event_id)
        if not admitted:
            if getattr(event, "_foxfleet_admission_uncertain", False):
                # Busy True during a drain without a receipt: the callback may have steered or
                # answered before drain flipped, or only emitted a rejection notice. Replaying could
                # duplicate those effects, so the event is resolved at most once (persisted floor +
                # ack + dedup), the user gets ONE explicit notice for it, and the channel continues.
                logger.warning("FoxFleet: event %d raced a gateway drain without an acceptance receipt; "
                               "resolving it once with a resend notice (never replayed)", msg.event_id)
                await self._advance(conn, msg.event_id)
                if msg.event_id <= self._admitted:
                    # Mark only after the floor persisted: a failed persist must let the hub's
                    # replay reach this branch again, or the notice would never be sent.
                    self._dedup.is_duplicate(key)
                    self._spawn(self._notify_admission_uncertain(msg))
                return
            logger.warning("FoxFleet: event %d was not admitted by the gateway; not acknowledging it "
                           "(the hub will redeliver after reconnect)", msg.event_id)
            conn.abandoned = True
            self._spawn(self._close_quietly(conn))
            return
        self._dedup.is_duplicate(key)  # mark only after admission
        await self._advance(conn, msg.event_id)

    async def _notify_admission_uncertain(self, msg: protocol.InboundMessage) -> None:
        key = self._notice_key("uncertain", msg.chat_id, msg.message_id)
        result = await self._send_notice(chat_id=msg.chat_id, text=ADMISSION_UNCERTAIN_NOTICE,
                                         reply_to=msg.message_id, key=key)
        if not result.success and result.retryable:
            await asyncio.sleep(0.5)
            result = await self._send_notice(chat_id=msg.chat_id, text=ADMISSION_UNCERTAIN_NOTICE,
                                             reply_to=msg.message_id, key=key)
        if not result.success:
            logger.error("FoxFleet: could not deliver the resend notice for message %s in chat %s: %s",
                         msg.message_id, msg.chat_id, result.error)

    async def _hold_unprocessed(self, event: MessageEvent) -> Optional[str]:
        chat_id, message_id = str(event.source.chat_id or ""), str(event.message_id or "")
        if not (protocol.CHAT_ID.match(chat_id) and protocol.MESSAGE_ID.match(message_id)):
            return None
        key = f"{chat_id}\x1f{message_id}"
        self._held_live.add(key)
        self._remember(self._unprocessed, key, (chat_id, message_id), self.MAX_UNPROCESSED)
        if not self._save_state():
            await asyncio.sleep(0.05)  # one quick retry (non-blocking): a lost record means a silently lost message
            if not self._save_state():
                logger.error("FoxFleet: could not persist the held-message record for %s in %s; "
                             "retrying in the background (a crash before it lands loses its notice)",
                             message_id, chat_id)
                self._spawn(self._persist_state_retry())
        return key

    async def _release_unprocessed(self, key: str) -> None:
        self._held_live.discard(key)
        if self._unprocessed.pop(key, None) is None or self._save_state():
            return
        # The handler is about to run but the disk still lists the message as held. A crash before
        # the removal lands would send a FALSE "not processed, please resend" notice after restart,
        # so retry once now (same as _hold_unprocessed) and then in the background with backoff,
        # instead of waiting for the next flush (which only happens on a reconnect). Non-blocking.
        await asyncio.sleep(0.05)
        if self._save_state():
            return
        self._released_pending_save.add(key)
        logger.error("FoxFleet: processed %s but could not persist the removal; retrying in the background", key)
        self._spawn(self._persist_released())

    async def _persist_state_retry(self) -> None:
        delay = self.RELEASE_RETRY_BASE
        while not self._closing:
            await asyncio.sleep(delay)
            if self._save_state():
                return
            delay = min(delay * 2, self.RELEASE_RETRY_MAX)

    async def _persist_released(self) -> None:
        delay = self.RELEASE_RETRY_BASE
        while self._released_pending_save and not self._closing:
            await asyncio.sleep(delay)
            if self._save_state():
                self._released_pending_save.clear()
                return
            delay = min(delay * 2, self.RELEASE_RETRY_MAX)

    async def _send_notice(self, *, chat_id: str, text: str, reply_to: Optional[str], key: str) -> SendResult:
        """A short notice with a DETERMINISTIC idempotency key: the hub collapses any repeat
        (overlapping flushes, a restart after a failed state save) into the one delivered message."""
        token = self._notice_send.set(True)  # a notice: never ends another live answer
        try:
            return await self._send_chunk(chat_id, text, reply_to, final=False, key=key)
        finally:
            self._notice_send.reset(token)

    def _notice_key(self, kind: str, chat_id: str, message_id: str) -> str:
        """Hub idempotency keys reject '_'; chat and message ids contain it."""
        safe = f"{chat_id}-{message_id}".replace("_", "-")
        return f"notice-{kind}-{safe}"

    async def _flush_unprocessed(self) -> None:
        """Previous gateway stopped while these accepted+ACKed messages waited behind a drain.
        Single-flight: a flush started during another waits, then drains anything still listed."""
        async with self._flush_lock:
            if self._released_pending_save:
                if self._save_state():
                    self._released_pending_save.clear()
            for key, (chat_id, message_id) in list(self._unprocessed.items()):
                if key in self._held_live or key in self._released_pending_save:
                    continue  # still waiting in this process, or already processed
                result = await self._send_notice(chat_id=chat_id, text=UNPROCESSED_NOTICE,
                                                 reply_to=message_id,
                                                 key=self._notice_key("unprocessed", chat_id, message_id))
                if result.success or result.error_kind == "not_found":
                    self._unprocessed.pop(key, None)
                    if not self._save_state():
                        # Kept in memory with the same deterministic key: a later resend replays
                        # harmlessly at the hub instead of duplicating the notice.
                        logger.error("FoxFleet: notice for %s delivered but not persisted; will re-confirm", key)
                else:
                    logger.error("FoxFleet: could not deliver the not-processed notice for message %s in "
                                 "chat %s: %s", message_id, chat_id, result.error)

    async def _dispatch_inline_reply(self, event: MessageEvent, *, log_cmd: Optional[str] = None) -> None:
        from hermes_cli.commands import is_interrupt_then_dispatch
        # /status and other bypass replies belong beside the running answer, not
        # instead of it. /stop, /new and /reset deliberately terminate that answer.
        token = self._notice_send.set(not is_interrupt_then_dispatch(event.get_command()))
        try:
            await super()._dispatch_inline_reply(event, log_cmd=log_cmd)
            event._foxfleet_receipt = True
        finally:
            self._notice_send.reset(token)

    def _spawn_drain_task(self, pending_event, session_key: str, delay: float = 0.0) -> None:
        """A follow-up must not inherit a Stop acknowledgement that was never sent."""
        chat_id = str(getattr(getattr(pending_event, "source", None), "chat_id", "") or "")
        self._suppress_stop_reply.discard(chat_id)
        super()._spawn_drain_task(pending_event, session_key, delay=delay)

    async def _drain_pending_after_session_command(self, session_key: str, command_guard) -> None:
        pending = self._pending_messages.get(session_key)
        if pending is not None:
            self._suppress_stop_reply.discard(str(getattr(getattr(pending, "source", None), "chat_id", "") or ""))
        await super()._drain_pending_after_session_command(session_key, command_guard)

    def set_busy_session_handler(self, handler) -> None:
        if handler is not None:
            inner = handler

            async def stamped(event: MessageEvent, session_key: str) -> bool:
                await self._wait_for_gateway_admission(event)
                token = self._notice_send.set(True)
                drain_seen = [False]
                trace_token = self._busy_drain_seen.set(drain_seen)
                try:
                    handled = await inner(event, session_key)
                finally:
                    self._notice_send.reset(token)
                    self._busy_drain_seen.reset(trace_token)
                if handled is True:
                    runner = self.gateway_runner
                    draining = runner is not None and (
                        getattr(runner, "_draining", False) or getattr(runner, "_external_drain_active", False))
                    if (draining or drain_seen[0]) and event._gateway_accepted is not True:
                        event._foxfleet_admission_uncertain = True
                    else:
                        event._foxfleet_receipt = True
                return handled

            handler = stamped
        super().set_busy_session_handler(handler)

    async def _queue_text_debounce(self, session_key: str, event: MessageEvent) -> None:
        started = time.monotonic()
        await super()._queue_text_debounce(session_key, event)
        state = self._text_debounce_store().get(session_key)
        if state is not None and (state.event is event or state.last_ts >= started):
            event._foxfleet_receipt = True

    def _build_event(self, msg: protocol.InboundMessage) -> MessageEvent:
        source = self.build_source(chat_id=msg.chat_id, chat_name=msg.user_name or msg.chat_id,
                                   chat_type="dm", user_id=msg.user_id, user_name=msg.user_name,
                                   message_id=msg.message_id)
        # Hermes 0.22+ native admission only allows WhatsApp metadata keys; any other
        # key (including a foxfleet event id) refuses the message as invalid_params.
        return MessageEvent(
            text=msg.text, message_type=MessageType.TEXT, source=source, user_id=msg.user_id,
            user_name=msg.user_name, message_id=msg.message_id, reply_to_message_id=msg.reply_to,
            reply_to_is_own_message=bool(msg.reply_to and msg.reply_to in self._recent_sent),
            reply_expected=True)

    async def _advance(self, conn: _Conn, event_id: int) -> None:
        """Persist the contiguous admitted floor, then ack it on the socket that delivered it."""
        if conn.abandoned:
            return
        if event_id > self._admitted + 1:
            raise protocol.ProtocolError("ack_gap", "event would acknowledge past an unadmitted event")
        if event_id == self._admitted + 1:
            previous, self._admitted = self._admitted, event_id
            if not self._save_state():
                self._admitted = previous
                conn.abandoned = True
                self._spawn(self._close_quietly(conn))
                return
        if conn is self._conn:
            await self._send_frame(conn, protocol.build_ack(event_id))

    async def _close_quietly(self, conn: _Conn) -> None:
        with contextlib.suppress(Exception):
            await conn.ws.close(code=1000, reason="resync")

    # -- local state (per hub + bot, under the profile's HERMES_HOME) ----
    def _load_state(self, hello: protocol.Hello) -> None:
        digest = hashlib.sha256(f"{self._ws_url}\n{hello.bot}".encode()).hexdigest()[:24]
        self._state_path = get_hermes_home() / "platforms" / "foxfleet" / f"state-{digest}.json"
        stored = read_json_or_empty(self._state_path)
        local = stored.get("admitted") if stored.get("bot") == hello.bot else None
        local = local if isinstance(local, int) and not isinstance(local, bool) and local >= 0 else 0
        if local > hello.latest_event_id:
            logger.warning("FoxFleet: local admitted floor %d is beyond the hub's latest event %d "
                           "(hub store reset?); trusting the hub", local, hello.latest_event_id)
            local = 0
        if hello.resume_from > local:
            if local:
                logger.warning("FoxFleet: hub ack %d is ahead of this profile's admitted floor %d; "
                               "events in between were acknowledged elsewhere", hello.resume_from, local)
            local = hello.resume_from
        self._admitted = max(self._admitted, local) if self._admitted <= hello.latest_event_id else local
        entries = stored.get("unprocessed") if stored.get("bot") == hello.bot else None
        for entry in entries if isinstance(entries, list) else []:
            if (isinstance(entry, list) and len(entry) == 2 and all(isinstance(v, str) for v in entry)
                    and protocol.CHAT_ID.match(entry[0]) and protocol.MESSAGE_ID.match(entry[1])):
                self._remember(self._unprocessed, f"{entry[0]}\x1f{entry[1]}", (entry[0], entry[1]),
                               self.MAX_UNPROCESSED)

    def _save_state(self) -> bool:
        if self._state_path is None:
            return True
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            state: dict[str, Any] = {"version": 1, "bot": self._bot_id, "admitted": self._admitted}
            if self._unprocessed:
                state["unprocessed"] = [list(v) for v in self._unprocessed.values()]
            atomic_json_write(self._state_path, state, mode=0o600)
        except OSError as exc:
            logger.warning("FoxFleet: could not persist the admitted floor (%s); not acknowledging, "
                           "will resync", exc)
            return False
        return True

    # -- RPC -------------------------------------------------------------
    async def _send_frame(self, conn: _Conn, frame: dict) -> bool:
        try:
            await conn.ws.send(protocol.encode_frame(frame))
            return True
        except Exception as exc:
            logger.debug("FoxFleet: frame %s not sent: %s", frame.get("t"), self._redact(exc))
            return False

    def _resolve(self, frame: dict) -> None:
        try:
            res = protocol.parse_res(frame)
        except protocol.ProtocolError as exc:
            rid = frame.get("id")
            entry = self._pending.get(rid) if isinstance(rid, str) else None
            if entry is not None and not entry[0].done():
                entry[0].set_exception(exc)
            logger.warning("FoxFleet: malformed res frame (%s)", exc.code)
            return
        entry = self._pending.get(res.id)
        if entry is None:
            logger.debug("FoxFleet: res for unknown/expired request id")
            return
        if not entry[0].done():
            entry[0].set_result(res)

    async def _rpc(self, op: str, *, timeout: float, **params: Any) -> protocol.RpcResponse:
        conn = self._conn
        if conn is None or self._closing:
            raise _NotSent("not connected to the hub")
        if len(self._pending) >= self.MAX_PENDING_RPCS:
            raise _NotSent("too many requests in flight")
        rid = f"r{next(self._rpc_counter)}.{secrets.token_hex(4)}"
        if params.get("media") is not None and not conn.media_enabled:
            raise _NotSent("media was not negotiated")
        data = protocol.encode_frame(protocol.build_request(op, rid, **params))
        future = asyncio.get_running_loop().create_future()
        self._pending[rid] = (future, conn)
        try:
            try:
                await conn.ws.send(data)
            except Exception as exc:
                raise _OutcomeUnknown(f"send failed: {exc.__class__.__name__}") from None
            try:
                return await asyncio.wait_for(future, timeout=timeout)
            except TimeoutError:
                raise _OutcomeUnknown("hub did not answer in time") from None
            except protocol.ProtocolError as exc:
                raise _BadResponse(f"malformed hub response ({exc.code})") from None
        finally:
            self._pending.pop(rid, None)

    async def _wait_connected(self, timeout: float) -> None:
        if self._conn is not None:
            return
        if self._closing:
            raise _NotSent("adapter is shutting down")
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=timeout)
        except TimeoutError:
            raise _NotSent("hub connection not available") from None

    async def _request(self, op: str, *, retry_unknown: bool, **params: Any) -> protocol.RpcResponse:
        """RPC with reconnect-wait. ``retry_unknown`` resends after an unknown outcome; only for
        requests that are idempotent hub-side (same idempotency key / same edit)."""
        last: Exception = _NotSent("no attempt made")
        unknown: Optional[_OutcomeUnknown] = None
        for _attempt in range(self.MAX_SEND_ATTEMPTS):
            try:
                await self._wait_connected(self.SEND_RECONNECT_WAIT)
                return await self._rpc(op, timeout=self.RPC_TIMEOUT, **params)
            except _NotSent as exc:
                last = exc
                if self._closing:
                    break
            except _OutcomeUnknown as exc:
                last = unknown = exc
                if not retry_unknown:
                    break
        # Once any attempt may have reached the hub, the outcome stays unknown (keeps the key).
        raise unknown or last

    # -- outbound --------------------------------------------------------
    def supports_native_streaming(self, **kwargs) -> bool:
        return True

    async def send_stream_frame(self, content: str, *, finalize: bool = False,
                                chat_id: str, reply_to: Optional[str] = None,
                                turn_id: str) -> bool:
        """Cumulative snapshots from the REAL consumer, keyed by its explicit turn id.

        The consumer's native path passes finalize only for true completion (not byte
        overflow/tool segments). Keep per-turn message ids; never edit a chat's last message.
        Split losslessly here instead of adopting the edit consumer's chunk-seal finalize.
        """
        key = (str(chat_id), str(turn_id))
        state = self._streams.get(key)
        if state is None:
            if len(self._streams) >= self.MAX_STREAMS:
                victim = self._evictable_stream()
                if victim is None:
                    logger.warning("FoxFleet: %d active streams; turn uses send/edit", len(self._streams))
                    return False  # never evict a live turn's edit targets
                del self._streams[victim]
            state = self._streams[key] = _Stream(reply_to=reply_to)
        state.touched = time.monotonic()
        async with state.lock:
            text = _clean_text(content)
            if state.finalized:
                return finalize and text == state.text()
            if not text.strip():
                return True  # seed/typing is not a persisted message
            if (finalize and text.strip() == _EMPTY_FINALIZE_PLACEHOLDER
                    and not state.chunks and state.unconfirmed is None):
                # Hermes closes a native stream that never showed content with a lone placeholder
                # ("_accumulated or ✅", stream_consumer). It may be exactly that — a bubble close
                # whose real text arrives moments later by the gateway's #71643 stale-finalize
                # recovery — or it may be the agent's actual one-character reply ("✅"); the frame
                # alone cannot tell them apart, and answering True while sending nothing would make
                # Hermes suppress the recovery (the reply would vanish).
                # So store the tick but do NOT finalize the turn: the reply run stays open, and when
                # the authoritative text arrives, send() edits this message in place and ends the
                # turn with it. If nothing arrives, the hub's own idle timer ends the run and the
                # tick simply stays as the reply, which is exactly what it was.
                if await self._push_snapshot(state, str(chat_id), text, reply_to, False) is None:
                    state.placeholder, state.placeholder_at = True, time.monotonic()
                    return True
                return False  # not delivered: Hermes rolls back and re-sends through send()
            pushed = (await self._push_final(state, str(chat_id), text, reply_to) if finalize
                      else await self._push_snapshot(state, str(chat_id), text, reply_to, False) is None)
            if pushed:
                state.finalized = bool(finalize)
                return True
            if not finalize:
                # A False here makes Hermes leave native mode, "close" the stream with a
                # finalize frame and continue on send/edit: the hub run would end mid-turn and
                # the edit transport would open a second message/run. Interim frames are
                # cumulative snapshots, so the next frame (or the final) re-syncs from the
                # confirmed chunks instead.
                logger.warning("FoxFleet: interim stream frame for chat %s not delivered; the next "
                               "snapshot re-syncs the same messages", chat_id)
                return True
            # The true final failed. Hermes now rolls back its delivery flags, sends a best-effort
            # finalize frame (this method again) and re-sends the same text through send(); both
            # complete THIS turn's messages (see _owed_stream) instead of opening a second reply.
            state.owed, state.owed_at, state.handed_off = text, time.monotonic(), True
            logger.error("FoxFleet: final stream frame for chat %s not confirmed by the hub; the "
                         "fallback completes the same messages", chat_id)
            return False

    def _evictable_stream(self) -> Optional[tuple[str, str]]:
        completed = next((k for k, s in self._streams.items() if s.finalized and s.owed is None), None)
        if completed is not None:
            return completed
        now = time.monotonic()
        idle = [(s.touched, k) for k, s in self._streams.items() if not s.lock.locked()
                and now - s.touched >= self.STREAM_IDLE_EVICT
                and (s.owed is None or now - s.owed_at > self.HANDOFF_TTL)]
        return min(idle)[1] if idle else None

    def _owed_stream(self, chat_id: str, text: str) -> Optional[_Stream]:
        """The handed-off turn in ``chat_id`` that still owes exactly ``text`` as its final."""
        now = time.monotonic()
        for (chat, _turn), state in reversed(self._streams.items()):
            if (chat == chat_id and state.owed is not None and state.owed == text
                    and now - state.owed_at <= self.HANDOFF_TTL):
                return state
        return None

    def _pending_placeholder(self, chat_id: str) -> Optional[_Stream]:
        """The newest stream in ``chat_id``, when it is still waiting on its placeholder's real text.

        Only the newest stream can match: once a later turn seeds a stream for the same chat, an old
        tick can never be mistaken for that turn's reply target.
        """
        newest = None
        for (chat, _turn), state in self._streams.items():
            if chat == chat_id and (newest is None or state.touched >= newest.touched):
                newest = state
        if (newest is None or not newest.placeholder or newest.finalized
                or time.monotonic() - newest.placeholder_at > self.PLACEHOLDER_TTL):
            return None
        return newest

    async def _complete_placeholder(self, state: _Stream, chat_id: str, text: str) -> SendResult:
        """Replace the stored tick with the turn's real answer and end the turn with it."""
        async with state.lock:
            state.placeholder = False
            if not state.finalized:
                if not await self._push_final(state, chat_id, text, state.reply_to):
                    state.placeholder = True
                    return SendResult(success=False,
                                      error="FoxFleet: the reply replacing the placeholder was not confirmed by the hub",
                                      error_kind="transient", retryable=True)
                state.finalized = True
            ids = state.ids()
        logger.info("FoxFleet: replaced the empty-stream placeholder in chat %s with the reply", chat_id)
        return SendResult(success=True, message_id=ids[-1], continuation_message_ids=tuple(ids[:-1]),
                          raw_response={"message_ids": ids} if len(ids) > 1 else None)

    async def _complete_owed(self, state: _Stream, chat_id: str, text: str) -> SendResult:
        async with state.lock:
            if not state.finalized:
                if not await self._push_final(state, chat_id, text, state.reply_to):
                    logger.error("FoxFleet: final answer for chat %s still not delivered; the chat "
                                 "keeps the last confirmed snapshot", chat_id)
                    return SendResult(success=False, error="FoxFleet: final answer not confirmed by the hub",
                                      error_kind="transient", retryable=True)
                state.finalized = True
            state.owed = None
            ids = state.ids()
        logger.info("FoxFleet: completed the failed stream final for chat %s in place", chat_id)
        return SendResult(success=True, message_id=ids[-1], continuation_message_ids=tuple(ids[:-1]),
                          raw_response={"message_ids": ids} if len(ids) > 1 else None)

    async def _push_final(self, state: _Stream, chat_id: str, text: str, reply_to: Optional[str]) -> bool:
        """The turn final, waiting out a rate limit (the hub changes nothing on rate_limited)."""
        failure = await self._push_snapshot(state, chat_id, text, reply_to, True)
        for attempt in range(self.FINAL_RATE_LIMIT_RETRIES):
            if failure is None or failure.error_kind != "rate_limited":
                break
            delay = failure.retry_after or self.RATE_LIMIT_BACKOFF * 2 ** attempt
            await asyncio.sleep(min(max(delay, 0.05), self.MAX_RATE_LIMIT_WAIT))
            failure = await self._push_snapshot(state, chat_id, text, reply_to, True)
        return failure is None

    async def _push_snapshot(self, state: _Stream, chat_id: str, text: str, reply_to: Optional[str],
                             finalize: bool) -> Optional[SendResult]:
        """Make this turn's hub messages show ``text``; only confirmed (id, text) pairs are kept.
        Returns None on success, else the failing result."""
        if state.unconfirmed is not None:
            sent, sent_reply_to, sent_final, sent_key = state.unconfirmed
            result = await self._send_chunk(chat_id, sent, sent_reply_to, final=sent_final, key=sent_key)
            if not result.success or not result.message_id:
                return result
            state.chunks.append((result.message_id, sent))
            state.unconfirmed = None
        chunks = protocol.split_text(text)
        # A corrected authoritative final may be shorter than the live preview.
        while len(state.chunks) > len(chunks):
            result = await self._delete_chunk(chat_id, state.chunks[-1][0])
            if not result.success:
                return result
            state.chunks.pop()
        for index, chunk in enumerate(chunks):
            final = finalize and index == len(chunks) - 1
            if index < len(state.chunks):
                mid, previous = state.chunks[index]
                if previous == chunk and not final:
                    continue
                result = await self._edit(chat_id, mid, chunk, finalize=final)
            else:
                chunk_reply_to = reply_to if index == 0 else None
                result = await self._send_chunk(chat_id, chunk, chunk_reply_to, final=final)
                unknown = self._unknown_outcomes.get(self._fingerprint(chat_id, chunk, chunk_reply_to, final))
                if not result.success and unknown is not None:
                    state.unconfirmed = (chunk, chunk_reply_to, final, unknown[0])
            if not result.success or not result.message_id:
                return result
            item = (result.message_id, chunk)
            if index < len(state.chunks):
                state.chunks[index] = item
            else:
                state.chunks.append(item)
        return None

    async def _delete_chunk(self, chat_id: str, message_id: str) -> SendResult:
        """Delete a stream chunk; ``not_found`` means a lost-response delete already landed."""
        try:
            res = await self._request("message.delete", retry_unknown=True, chat_id=chat_id,
                                      message_id=message_id)
        except (_OutcomeUnknown, _NotSent) as exc:
            return SendResult(success=False, error=f"FoxFleet: {exc}", error_kind="transient", retryable=True)
        except _BadResponse as exc:
            return SendResult(success=False, error=f"FoxFleet: {exc}", error_kind="unknown")
        if res.ok or res.error_code == "not_found":
            return SendResult(success=True, message_id=message_id)
        return self._error_result(res)

    def _media_connection(self) -> _Conn:
        conn = self._conn
        if conn is None or not conn.media_enabled:
            raise ValueError("FoxFleet hub has not negotiated media")
        return conn

    def _media_http_base(self) -> str:
        from urllib.parse import urlsplit, urlunsplit
        url = urlsplit(self._ws_url)
        return urlunsplit(("https" if url.scheme == "wss" else "http", url.netloc,
                           url.path.removesuffix("/api/bot/ws"), "", ""))

    async def _upload_media(self, chat_id: str, file_path: str, conn: _Conn,
                            file_name: Optional[str] = None) -> str:
        import httpx
        from urllib.parse import quote
        from gateway.platforms.base import validate_media_delivery_path
        checked = validate_media_delivery_path(file_path)
        if not checked:
            raise ValueError("FoxFleet media path was not accepted for delivery")
        path = Path(checked)
        size = path.stat().st_size
        cap = conn.hello.max_media_bytes
        if not path.is_file() or size < 1 or size > cap:
            raise ValueError("FoxFleet media exceeds the hub byte limit or is not a file")

        async def chunks():
            total = 0
            with path.open("rb") as handle:
                while chunk := await asyncio.to_thread(handle.read, 64 * 1024):
                    total += len(chunk)
                    if total > cap:
                        raise ValueError("FoxFleet media exceeds the hub byte limit")
                    yield chunk

        async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as client:
            async with client.stream("POST", self._media_http_base() + "/api/bot/media",
                    headers={**protocol.auth_header(self._token), "Content-Type": "application/octet-stream",
                             "Content-Length": str(size), "X-Foxfleet-Chat": str(chat_id),
                             "X-Foxfleet-Name": quote(file_name or path.name, safe="")}, content=chunks()) as response:
                if response.status_code != 201:
                    raise ValueError("FoxFleet media upload failed")
                payload = bytearray()
                async for chunk in response.aiter_bytes():
                    payload.extend(chunk)
                    if len(payload) > 8192:
                        raise ValueError("Invalid media upload response")
        media = json.loads(payload)
        mid = media.get("media_id", media.get("id"))
        if not isinstance(mid, str) or not re.fullmatch(r"fbm_[A-Za-z0-9_-]{24}", mid):
            raise ValueError("Invalid media upload id")
        return mid

    async def _send_media_files(self, chat_id: str, paths: list[str], caption=None,
                                reply_to=None, metadata=None, file_name=None) -> SendResult:
        try:
            conn = self._media_connection()
            if not 1 <= len(paths) <= 10 or (metadata or {}).get("thread_id"):
                raise ValueError("FoxFleet media requires 1–10 files in a direct chat")
            ids = [await self._upload_media(str(chat_id), p, conn, file_name) for p in paths]
            if self._conn is not conn:
                raise ValueError("FoxFleet connection changed during upload")
            res = await self._request("message.send", retry_unknown=True, chat_id=str(chat_id),
                                      text=_clean_text(caption), media=ids, format="markdown",
                                      reply_to=reply_to, idempotency_key=secrets.token_hex(16))
            if not res.ok:
                return self._error_result(res)
            mid = res.result.get("message_id")
            if not isinstance(mid, str) or not protocol.MESSAGE_ID.fullmatch(mid):
                raise ValueError("FoxFleet did not confirm media delivery")
            self._remember(self._recent_sent, mid, None, self.MAX_RECENT_SENT)
            return SendResult(success=True, message_id=mid)
        except Exception as exc:
            # Paths, URLs and credentials are never echoed in delivery errors.
            logger.warning("FoxFleet media delivery failed (%s)", type(exc).__name__)
            return SendResult(success=False, error="FoxFleet media delivery failed", error_kind="unknown")

    async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None,
                              metadata=None, **kwargs) -> SendResult:
        return await self._send_media_files(chat_id, [image_path], caption, reply_to, metadata)

    async def send_document(self, chat_id, file_path, caption=None, file_name=None,
                            reply_to=None, metadata=None, **kwargs) -> SendResult:
        return await self._send_media_files(chat_id, [file_path], caption, reply_to, metadata, file_name)

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None,
                         metadata=None, **kwargs) -> SendResult:
        return await self._send_media_files(chat_id, [audio_path], caption, reply_to, metadata)

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None,
                         metadata=None, **kwargs) -> SendResult:
        return await self._send_media_files(chat_id, [video_path], caption, reply_to, metadata)

    async def _image_path(self, url: str) -> str:
        self._media_connection()  # no downloads for an old or featureless hello
        if url.startswith("file://"):
            from urllib.request import url2pathname
            from gateway.platforms.base import validate_media_delivery_path
            checked = validate_media_delivery_path(url2pathname(url[7:]))
            if not checked:
                raise ValueError("FoxFleet media path was not accepted for delivery")
            return checked
        if url.startswith(("https://", "http://")):
            from gateway.platforms.base import cache_image_from_url
            return await cache_image_from_url(url)
        return url

    async def send_image(self, chat_id, image_url, caption=None, reply_to=None,
                         metadata=None) -> SendResult:
        try:
            path = await self._image_path(image_url)
        except Exception:
            return SendResult(success=False, error="FoxFleet could not cache the image", error_kind="unknown")
        return await self._send_media_files(chat_id, [path], caption, reply_to, metadata)

    async def send_animation(self, chat_id, animation_url, caption=None, reply_to=None,
                             metadata=None) -> SendResult:
        return await self.send_image(chat_id, animation_url, caption, reply_to, metadata)

    async def send_multiple_images(self, chat_id, images, metadata=None, human_delay=0.0) -> SendResult:
        try:
            self._media_connection()
            if not 1 <= len(images) <= 10:
                raise ValueError("FoxFleet accepts 1–10 images")
            paths = [await self._image_path(url) for url, _alt in images]
        except Exception:
            return SendResult(success=False, error="FoxFleet could not cache the images", error_kind="unknown")
        caption = "\n".join(alt for _url, alt in images if alt)
        return await self._send_media_files(chat_id, paths, caption, metadata=metadata)

    async def _download_media(self, conn: _Conn, attachments: tuple[dict, ...]) -> list[str]:
        import httpx
        from gateway.platforms.base import cache_image_from_bytes_async
        if not conn.media_enabled:
            raise ValueError("FoxFleet media was not negotiated")
        paths = []
        async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as client:
            for item in attachments:
                if item["kind"] != "image" or not re.fullmatch(r"fbm_[A-Za-z0-9_-]{24}", item["id"]):
                    raise ValueError("Unsupported inbound media")
                cap = min(conn.hello.max_media_bytes, item["size"])
                async with client.stream("GET", self._media_http_base() + "/api/bot/media/" + item["id"],
                                         headers=protocol.auth_header(self._token)) as response:
                    if response.status_code != 200 or int(response.headers.get("content-length", 0)) > cap:
                        raise ValueError("FoxFleet media download failed")
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > cap:
                            raise ValueError("Inbound media exceeds the byte limit")
                if len(data) != item["size"]:
                    raise ValueError("Incomplete inbound media")
                paths.append(await cache_image_from_bytes_async(bytes(data), Path(item["name"]).suffix))
        return paths

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> SendResult:
        if str(chat_id) in self._suppress_stop_reply:
            self._suppress_stop_reply.discard(str(chat_id))
            return SendResult(success=True, message_id="fm_suppressed000000")
        trace = self._busy_drain_seen.get()
        runner = self.gateway_runner
        if trace is not None and runner is not None and (
                getattr(runner, "_draining", False) or getattr(runner, "_external_drain_active", False)):
            trace[0] = True  # remember a drain notice even if drain clears during its RPC
        if (metadata or {}).get("thread_id"):
            return SendResult(success=False, error="FoxFleet v1 has no threads; send to the chat id",
                              error_kind="not_found")
        text = _clean_text(content)
        if not text.strip():
            return _blank_result()
        meta = metadata or {}
        pending = self._pending_placeholder(str(chat_id))
        if pending is not None:
            return await self._complete_placeholder(pending, str(chat_id), text)
        owed = None if (self._notice_send.get() or meta.get("_interim_send")) else self._owed_stream(str(chat_id), text)
        if owed is not None:
            return await self._complete_owed(owed, str(chat_id), text)
        notified = (meta.get("notify") is True and not meta.get("_interim_send")
                    and not meta.get("expect_edits") and not self._notice_send.get())
        ids: list[str] = []
        chunks = protocol.split_text(text)
        for index, chunk in enumerate(chunks):
            result = await self._send_chunk(str(chat_id), chunk, reply_to if index == 0 else None,
                                            final=notified and index == len(chunks) - 1)
            if not result.success:
                if ids:  # partial delivery: never resend the visible head
                    return SendResult(success=False, message_id=ids[-1], error=result.error,
                                      error_kind=result.error_kind, continuation_message_ids=tuple(ids[:-1]),
                                      raw_response={"partial_overflow": True, "message_ids": list(ids)})
                return result
            ids.append(result.message_id)
        return SendResult(success=True, message_id=ids[-1], continuation_message_ids=tuple(ids[:-1]),
                          raw_response={"message_ids": list(ids)} if len(ids) > 1 else None)

    async def _send_chunk(self, chat_id: str, text: str, reply_to: Optional[str], *,
                          final: bool = False, key: Optional[str] = None) -> SendResult:
        fingerprint = self._fingerprint(chat_id, text, reply_to, final)
        reused = self._take_unknown_outcome(fingerprint) or key
        key = reused or secrets.token_hex(16)
        try:
            res = await self._request("message.send", retry_unknown=True, chat_id=chat_id, text=text,
                                      format="markdown", reply_to=reply_to, final=final,
                                      idempotency_key=key)
        except _OutcomeUnknown as exc:
            # Same content retried later (e.g. by _send_with_retry) reuses this key: the hub dedupes.
            self._remember_unknown(fingerprint, key)
            return SendResult(success=False, error=f"FoxFleet hub did not confirm delivery: {exc}",
                              error_kind="transient", retryable=True)
        except _NotSent as exc:
            if reused:  # this replay never left, but the earlier attempt's outcome is still unknown
                self._remember_unknown(fingerprint, key)
            return SendResult(success=False, error=f"FoxFleet: {exc}", error_kind="transient", retryable=True)
        except _BadResponse as exc:
            self._remember_unknown(fingerprint, key)
            return SendResult(success=False, error=f"FoxFleet: {exc}", error_kind="unknown")
        if not res.ok:
            if res.error_code == "internal" or reused:
                self._remember_unknown(fingerprint, key)
            return self._error_result(res)
        message_id = res.result.get("message_id")
        if not isinstance(message_id, str) or not protocol.MESSAGE_ID.match(message_id):
            self._remember_unknown(fingerprint, key)
            return SendResult(success=False, error="FoxFleet hub returned no valid message_id",
                              error_kind="unknown")
        self._remember(self._recent_sent, message_id, None, self.MAX_RECENT_SENT)
        return SendResult(success=True, message_id=message_id)

    @staticmethod
    def _fingerprint(chat_id: str, text: str, reply_to: Optional[str], final: bool) -> str:
        return hashlib.sha256(json.dumps([chat_id, text, reply_to, final]).encode()).hexdigest()

    def _remember_unknown(self, fingerprint: str, key: str) -> None:
        self._remember(self._unknown_outcomes, fingerprint, (key, time.monotonic()), self.MAX_UNKNOWN_OUTCOMES)

    def _take_unknown_outcome(self, fingerprint: str) -> Optional[str]:
        entry = self._unknown_outcomes.pop(fingerprint, None)
        if entry is None or time.monotonic() - entry[1] > self.UNKNOWN_OUTCOME_TTL:
            return None
        return entry[0]

    @staticmethod
    def _remember(store: OrderedDict, key: str, value: Any, limit: int) -> None:
        store[key] = value
        store.move_to_end(key)
        while len(store) > limit:
            store.popitem(last=False)

    @staticmethod
    def _error_result(res: protocol.RpcResponse) -> SendResult:
        return SendResult(success=False, error=f"FoxFleet hub error {res.error_code}",
                          error_kind=protocol.error_kind_for(res.error_code),
                          retryable=res.error_code in _TRANSIENT_RPC_CODES,
                          retry_after=res.retry_after_ms / 1000 if res.retry_after_ms else None)

    async def edit_message(self, chat_id: str, message_id: str, content: str, *,
                           finalize: bool = False) -> SendResult:
        content = _clean_text(content)
        if not content.strip():
            return _blank_result()
        chat_id, message_id = str(chat_id), str(message_id)
        for (chat, _turn), state in reversed(self._streams.items()):
            # Hermes' edit-transport finalize after a handed-off final targets the id send()
            # returned with the whole text: it is that turn's (possibly multi-message) reply.
            if chat == chat_id and state.handed_off and message_id in state.ids():
                if state.finalized and content == state.text():
                    return SendResult(success=True, message_id=message_id)
                if state.owed is not None and content == state.owed:
                    return await self._complete_owed(state, chat_id, content)
                break
        return await self._edit(chat_id, message_id, content, finalize=finalize)

    async def _edit(self, chat_id: str, message_id: str, content: str, *, finalize: bool) -> SendResult:
        if protocol.utf8_len(content) > protocol.MAX_TEXT_BYTES:
            return SendResult(success=False, error="edit exceeds the 64 KiB FoxFleet message cap",
                              error_kind="too_long")
        try:  # an edit to the same text is idempotent, so an unknown outcome may be retried
            res = await self._request("message.edit", retry_unknown=True, chat_id=str(chat_id),
                                      message_id=str(message_id), text=content, format="markdown",
                                      final=bool(finalize))
        except (_OutcomeUnknown, _NotSent) as exc:
            return SendResult(success=False, error=f"FoxFleet: {exc}", error_kind="transient", retryable=True)
        except _BadResponse as exc:
            return SendResult(success=False, error=f"FoxFleet: {exc}", error_kind="unknown")
        if not res.ok:
            return self._error_result(res)
        return SendResult(success=True, message_id=str(message_id))

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        try:
            res = await self._request("message.delete", retry_unknown=True, chat_id=str(chat_id),
                                      message_id=str(message_id))
        except (_OutcomeUnknown, _NotSent, _BadResponse):
            return False
        return res.ok

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """Transient typing indicator; best effort, never blocks a turn on a slow hub."""
        if self._conn is None:
            return
        with contextlib.suppress(_OutcomeUnknown, _NotSent, _BadResponse):
            await self._rpc("chat.action", timeout=self.TYPING_TIMEOUT, chat_id=str(chat_id), action="typing")

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        chat_id = str(chat_id)
        return {"name": self._chat_names.get(chat_id, chat_id), "type": "dm", "chat_id": chat_id}

    # -- commands.set ----------------------------------------------------
    async def _sync_commands(self) -> None:
        commands = build_command_catalog(self.MAX_COMMANDS)
        if not commands:
            return
        try:
            res = await self._rpc("commands.set", timeout=self.RPC_TIMEOUT, commands=commands)
        except (_OutcomeUnknown, _NotSent, _BadResponse) as exc:
            logger.info("FoxFleet: commands.set not confirmed: %s", exc)
            return
        if not res.ok:
            logger.warning("FoxFleet: hub refused commands.set: %s", res.error_code)


_COMMAND_NAME_RE = re.compile(r"^[a-z0-9_]{1,32}$")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def _clean_text(content: Optional[str]) -> str:
    return (content or "").replace("\0", "")


def _blank_result() -> SendResult:
    return SendResult(success=False, error="FoxFleet cannot send an empty message", error_kind="bad_format")


def build_command_catalog(limit: int = 100) -> list[dict]:
    """Live slash-command catalog for hub autocomplete, from Hermes' COMMAND_REGISTRY (plus plugin
    commands): only commands the gateway would actually run (not ``cli_only`` unless config-gated
    on). Entries are ``{name, description}`` only, names ``[a-z0-9_]{1,32}``: a hyphenated registry
    name is published with underscores only when Hermes resolves that spelling back to the same
    command. Autocomplete only; the commands still arrive as plain text and the gateway decides."""
    try:
        from hermes_cli import commands as hermes_commands
    except Exception:
        return []
    gate = getattr(hermes_commands, "_is_gateway_available", None)
    try:
        overrides = hermes_commands._resolve_config_gates() if gate else None
    except Exception:
        overrides = set()
    catalog: list[dict] = []
    seen: set[str] = set()

    def add(name: str, description: str) -> None:
        if name in seen or not _COMMAND_NAME_RE.match(name) or len(catalog) >= limit:
            return
        text = _CONTROL_CHARS_RE.sub("", description or "").strip()[:256].strip() or name
        seen.add(name)
        catalog.append({"name": name, "description": text})

    for cmd in getattr(hermes_commands, "COMMAND_REGISTRY", []):
        try:
            available = gate(cmd, overrides) if gate else not cmd.cli_only
        except Exception:
            available = not getattr(cmd, "cli_only", False)
        if not available:
            continue
        name = cmd.name
        if "-" in name:
            mapped = name.replace("-", "_")
            if hermes_commands.resolve_command(mapped) is not cmd:
                continue
            name = mapped
        add(name, cmd.describe() if hasattr(cmd, "describe") else cmd.description)
    iter_plugins = getattr(hermes_commands, "_iter_plugin_command_entries", None)
    if iter_plugins is not None:
        with contextlib.suppress(Exception):
            for name, description, _args in iter_plugins():
                add(name, description)
    return catalog


async def _standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None,
                           force_document=False) -> dict:
    """Text-only HTTP delivery, independent of the gateway's receive socket and locks."""
    import httpx
    from urllib.parse import urlsplit, urlunsplit

    if not isinstance(chat_id, str) or re.fullmatch(r"fc_[A-Za-z0-9_-]{16}", chat_id) is None:
        return {"error": "FoxFleet: invalid chat id"}
    if thread_id is not None:
        return {"error": "FoxFleet: threads are unsupported"}
    if media_files or force_document:
        return {"error": "FoxFleet: standalone media delivery is unsupported"}
    if not isinstance(message, str) or "\0" in message:
        return {"error": "FoxFleet: invalid text"}
    text = _clean_text(message)
    try:
        if not text.strip() or len(text.encode("utf-8")) > 65536:
            return {"error": "FoxFleet: text must contain 1 to 65536 UTF-8 bytes"}
        ws = urlsplit(protocol.bot_ws_url(_hub_url(getattr(pconfig, "extra", None))))
        prefix = ws.path.removesuffix(protocol.BOT_WS_PATH)
        url = urlunsplit(("https" if ws.scheme == "wss" else "http", ws.netloc,
                          prefix + "/api/bot/rpc", "", ""))
        token = protocol.check_bot_token(_bot_token(pconfig))
        key = secrets.token_hex(16)
        frame = protocol.build_request("message.send", key, chat_id=chat_id, text=text,
                                       format="markdown", final=True, idempotency_key=key)
        body = protocol.encode_frame(frame).encode("utf-8")
    except (ValueError, TypeError, protocol.ProtocolError):
        return {"error": "FoxFleet: invalid hub URL, token or text configuration"}
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client:
            for attempt in range(2):
                try:
                    response = await client.post(url, content=body, headers={
                        **protocol.auth_header(token), "Content-Type": "application/json"})
                except httpx.TransportError:
                    if attempt == 0:
                        continue
                    return {"error": "FoxFleet: delivery outcome unknown after one retry"}
                if response.status_code != 200:
                    return {"error": "FoxFleet: HTTP delivery refused"}
                try:
                    envelope = response.json()
                    if not isinstance(envelope, dict) or envelope.get("t") != "res":
                        return {"error": "FoxFleet: invalid delivery response"}
                    # The hub rate limiter runs before reading the request id.
                    if envelope.get("id") is None and envelope.get("ok") is False:
                        envelope = {**envelope, "id": key}
                    result = protocol.parse_res(envelope)
                except (ValueError, TypeError, protocol.ProtocolError):
                    return {"error": "FoxFleet: invalid delivery response"}
                if result.id not in (key, None) or (result.ok and result.id != key):
                    return {"error": "FoxFleet: invalid delivery response"}
                if not result.ok:
                    kind = protocol.error_kind_for(result.error_code)
                    if kind == "rate_limited":
                        retry = envelope.get("error", {}).get("retry_after_ms")
                        if isinstance(retry, int) and not isinstance(retry, bool) and retry > 0:
                            await asyncio.sleep(min(retry, 5000) / 1000)
                    return {"error": "FoxFleet: delivery failed (" + kind + ")"}
                mid = result.result.get("message_id")
                if not isinstance(mid, str) or re.fullmatch(r"fm_[A-Za-z0-9_-]{16}", mid) is None:
                    return {"error": "FoxFleet: delivery response has no valid message id"}
                return {"success": True, "message_id": mid}
    except Exception:
        # Never surface exception strings: HTTP errors may contain URLs or credentials.
        return {"error": "FoxFleet: HTTP delivery failed"}


def register(ctx) -> None:
    """Plugin entry point (``ctx.register_platform``); zero Hermes core edits."""
    ctx.register_platform(
        name=PLATFORM_NAME, label="FoxFleet", adapter_factory=lambda cfg: FoxFleetAdapter(cfg),
        check_fn=check_requirements, validate_config=validate_config, is_connected=is_connected,
        required_env=[TOKEN_ENV], install_hint="websockets ships with Hermes; reinstall Hermes if missing",
        env_enablement_fn=_env_enablement, apply_yaml_config_fn=_apply_yaml_config,
        cron_deliver_env_var=HOME_ENV, standalone_sender_fn=_standalone_send,
        allowed_users_env=ALLOWED_USERS_ENV, allow_all_env=ALLOW_ALL_ENV,
        emoji="🦊", platform_hint=PLATFORM_HINT,
    )
