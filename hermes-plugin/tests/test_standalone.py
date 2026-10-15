"""HTTP standalone delivery and exclusive gateway socket ownership."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest
import pytest_asyncio

from gateway.config import PlatformConfig

from fakehub import FakeHub, wait_for
from foxfleet import adapter as ff
from foxfleet import protocol
from foxfleet.ownership import BotLock

pytestmark = pytest.mark.asyncio

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


@pytest_asyncio.fixture
async def hub(monkeypatch):
    server = await FakeHub().start()
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", server.token)
    yield server
    await server.stop()


def _cfg(hub):
    return PlatformConfig(enabled=True, extra={"hub_url": hub.url})


def _identity(hub) -> str:
    return f"{protocol.bot_ws_url(hub.url)}\n{hub.token}"


async def test_standalone_sender_is_registered(foxfleet_platform_entry):
    assert foxfleet_platform_entry.standalone_sender_fn is ff._standalone_send
    assert foxfleet_platform_entry.cron_deliver_env_var == "FOXFLEET_HOME_CHANNEL"


@pytest.fixture
def contender(hub):
    """A REAL separate process holding the bot lock, like a gateway of another profile or tool."""
    script = ("import sys\nfrom foxfleet.ownership import BotLock\nlock = BotLock(sys.argv[1])\n"
              "assert lock.acquire()\nprint('held', flush=True)\nsys.stdin.read()\n")
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(PLUGIN_ROOT), os.environ.get("PYTHONPATH", "")])}
    proc = subprocess.Popen([sys.executable, "-c", script, _identity(hub)], env=env, text=True,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    line = []
    reader = threading.Thread(target=lambda: line.append(proc.stdout.readline()), daemon=True)
    reader.start()
    reader.join(timeout=60)
    assert line and line[0].strip() == "held", proc.poll()
    yield proc
    proc.kill()
    proc.wait()


async def test_another_process_holding_the_bot_lock_blocks_connect_until_it_dies(hub, contender):
    adapter = ff.FoxFleetAdapter(_cfg(hub))
    assert await adapter.connect() is False
    assert adapter.fatal_error_code == "foxfleet-bot_lock" and adapter.fatal_error_retryable is True
    assert "another process on this host" in adapter.fatal_error_message
    assert hub.auth_headers == [] and hub.subprotocol_offers == []  # the loser never dials the hub
    contender.kill()  # a crash: the OS drops the flock, nothing is left stale
    contender.wait()
    try:
        assert await adapter.connect() is True
        assert len(hub.auth_headers) == 1
    finally:
        await adapter.disconnect()


async def test_bot_lock_is_exclusive_per_identity_idempotent_and_never_stores_the_token(hub):
    first, second, other = BotLock("id-one"), BotLock("id-one"), BotLock("id-two")
    assert first.acquire() is True and first.acquire() is True
    assert second.acquire() is False and other.acquire() is True
    first.release()
    first.release()
    assert second.acquire() is True
    second.release()
    other.release()
    lock_dir = Path(os.environ["HERMES_GATEWAY_LOCK_DIR"])
    files = [p for p in lock_dir.iterdir() if p.name.startswith("foxfleet-bot-") and p.suffix == ".flock"]
    assert files and all(p.read_bytes() == b"" and (p.stat().st_mode & 0o777) == 0o600 for p in files)
    assert hub.token not in "".join(p.name for p in files)


async def test_same_process_second_adapter_never_dials_and_first_keeps_its_locks(hub):
    first = ff.FoxFleetAdapter(_cfg(hub))
    second = ff.FoxFleetAdapter(_cfg(hub))
    assert await first.connect() is True
    try:
        assert await second.connect() is False
        assert second.fatal_error_code == "foxfleet-bot_lock" and len(hub.auth_headers) == 1
        assert BotLock(_identity(hub)).acquire() is False  # the loser did not disturb the winner's flock
    finally:
        await first.disconnect()
    probe = BotLock(_identity(hub))
    assert probe.acquire() is True
    probe.release()
    try:
        assert await second.connect() is True
    finally:
        await second.disconnect()


CHAT = "fc_" + "A" * 16
MID = "fm_" + "B" * 16


@pytest.fixture
def http_sender(monkeypatch):
    import httpx
    import json
    calls = []
    replies = []
    real_client = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        reply = replies.pop(0) if replies else {}
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            return reply(request)
        frame = json.loads(request.content)
        return httpx.Response(200, json={"t": "res", "id": frame["id"], "ok": True,
                                         "result": {"message_id": MID}, **reply})

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs.get("trust_env") is False
        return real_client(**kwargs, transport=httpx.MockTransport(handler))

    def no_socket(*args, **kwargs):
        pytest.fail("standalone sender must never open a WebSocket")

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setattr(ff, "_NoRedirectConnect", no_socket)
    monkeypatch.setattr(ff, "_ws_connect", no_socket)
    monkeypatch.setattr(ff, "FoxFleetAdapter", no_socket)
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", "ffb_" + "s" * 43)
    monkeypatch.delenv("FOXFLEET_HUB_URL", raising=False)
    return calls, replies


def rpc_config(url="https://fleet.example"):
    return PlatformConfig(enabled=True, extra={"hub_url": url})


async def test_http_text_and_fresh_keys(http_sender):
    import json
    calls, _ = http_sender
    for _ in range(2):
        assert await ff._standalone_send(rpc_config(), CHAT, "hello") == {"success": True, "message_id": MID}
    bodies = [json.loads(r.content) for r in calls]
    assert calls[0].url.path == "/api/bot/rpc" and calls[0].method == "POST"
    assert calls[0].headers["Authorization"] == "Bot ffb_" + "s" * 43
    assert bodies[0]["t"] == "message.send" and bodies[0]["chat_id"] == CHAT
    assert bodies[0]["text"] == "hello" and bodies[0]["idempotency_key"]
    assert bodies[0]["idempotency_key"] != bodies[1]["idempotency_key"]


@pytest.mark.parametrize("failure", ["timeout", "disconnect"])
async def test_unknown_outcome_retries_identical_body(http_sender, failure):
    import httpx
    calls, replies = http_sender
    replies.append(httpx.ReadTimeout("secret") if failure == "timeout" else httpx.ReadError("secret"))
    assert (await ff._standalone_send(rpc_config(), CHAT, "hello"))["success"]
    assert len(calls) == 2 and calls[0].content == calls[1].content


async def test_second_unknown_outcome_stops(http_sender):
    import httpx
    calls, replies = http_sender
    replies.extend([httpx.ReadTimeout("secret")] * 2)
    out = await ff._standalone_send(rpc_config(), CHAT, "hello")
    assert "error" in out and "secret" not in str(out) and len(calls) == 2


async def test_redirect_is_not_followed(http_sender):
    import httpx
    calls, replies = http_sender
    replies.append(lambda r: httpx.Response(307, headers={"Location": "https://evil.example"}))
    assert "error" in await ff._standalone_send(rpc_config(), CHAT, "hello")
    assert len(calls) == 1


async def test_http_201_is_not_delivery(http_sender):
    import httpx
    import json
    calls, replies = http_sender
    replies.append(lambda request: httpx.Response(
        201, json={"t": "res", "id": json.loads(request.content)["id"], "ok": True,
                   "result": {"message_id": MID}}))
    out = await ff._standalone_send(rpc_config(), CHAT, "hello")
    assert "error" in out and "success" not in out and len(calls) == 1


async def test_proxy_env_does_not_move_the_request(http_sender, monkeypatch):
    calls, _ = http_sender
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, "http://evil.example:8080")
    assert (await ff._standalone_send(rpc_config(), CHAT, "hello"))["success"]
    assert str(calls[0].url) == "https://fleet.example/api/bot/rpc"


@pytest.mark.parametrize("url,chat,kwargs,text", [
    ("http://fleet.example", CHAT, {}, "hello"),
    ("https://user:pass@fleet.example", CHAT, {}, "hello"),
    ("https://fleet.example?q=x", CHAT, {}, "hello"),
    ("https://fleet.example#x", CHAT, {}, "hello"),
    ("https://fleet.example", "bad", {}, "hello"),
    ("https://fleet.example", CHAT, {"thread_id": "thread"}, "hello"),
    ("https://fleet.example", CHAT, {"thread_id": ""}, "hello"),
    ("https://fleet.example", CHAT, {"media_files": ["/secret/file"]}, "hello"),
    ("https://fleet.example", CHAT, {}, " "),
    ("https://fleet.example", CHAT, {}, "a\0b"),
    ("https://fleet.example", CHAT, {}, "é" * 32769),
])
async def test_invalid_input_never_posts(http_sender, url, chat, kwargs, text):
    calls, _ = http_sender
    assert "error" in await ff._standalone_send(rpc_config(url), chat, text, **kwargs)
    assert not calls


@pytest.mark.parametrize("token", ["", "bad token", "bad\nvalue"])
async def test_bad_token_never_posts(http_sender, monkeypatch, token):
    calls, _ = http_sender
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", token)
    cfg = rpc_config()
    cfg.extra["token"] = "ffb_" + "s" * 43
    assert "error" in await ff._standalone_send(cfg, CHAT, "hello")
    assert not calls


async def test_rate_limit_wait_is_capped_once(http_sender, monkeypatch):
    calls, replies = http_sender
    waits = []
    async def sleep(seconds):
        waits.append(seconds)
    monkeypatch.setattr(ff.asyncio, "sleep", sleep)
    replies.append({"id": None, "ok": False, "error": {"code": "rate_limited", "retry_after_ms": 90000}})
    out = await ff._standalone_send(rpc_config(), CHAT, "hello")
    assert "rate_limited" in out["error"] and waits == [5] and len(calls) == 1


@pytest.mark.parametrize("reply,meaning", [
    ({"ok": False, "error": {"code": "forbidden", "message": "/secret/token"}}, "forbidden"),
    ({"result": {}}, "message id"),
    ({"result": {"message_id": "wrong"}}, "message id"),
    ({"t": "event"}, "response"),
])
async def test_failed_or_invalid_response(http_sender, reply, meaning):
    calls, replies = http_sender
    replies.append(reply)
    out = await ff._standalone_send(rpc_config(), CHAT, "hello")
    assert meaning in out["error"] and "/secret" not in str(out) and len(calls) == 1


async def test_exact_utf8_limit_and_loopback(http_sender):
    calls, _ = http_sender
    assert (await ff._standalone_send(rpc_config("http://127.0.0.1:9000"), CHAT, "é" * 32768))["success"]
    assert len(calls) == 1 and str(calls[0].url) == "http://127.0.0.1:9000/api/bot/rpc"


@pytest.mark.parametrize("hub,expected", [
    ("https://fleet.example/fleet", "https://fleet.example/fleet/api/bot/rpc"),
    ("https://fleet.example/fleet/api/bot/ws", "https://fleet.example/fleet/api/bot/rpc"),
    ("http://127.0.0.1:9000/lab/", "http://127.0.0.1:9000/lab/api/bot/rpc"),
])
async def test_hub_path_prefix_is_kept(http_sender, hub, expected):
    calls, _ = http_sender
    assert (await ff._standalone_send(rpc_config(hub), CHAT, "hello"))["success"]
    assert len(calls) == 1 and str(calls[0].url) == expected
