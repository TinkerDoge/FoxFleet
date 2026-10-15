"""Ownership of one bot token: no out-of-process send (the hub keeps ONE socket per bot and closes
the older one with 4009), and a crash-safe host lock the connecting gateway must win before it dials."""

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


async def test_no_standalone_sender_is_registered_or_defined(foxfleet_platform_entry):
    assert foxfleet_platform_entry.standalone_sender_fn is None
    assert foxfleet_platform_entry.cron_deliver_env_var == "FOXFLEET_HOME_CHANNEL"
    for name in ("_standalone_send", "_await_res", "STANDALONE_RPC_TIMEOUT"):
        assert not hasattr(ff, name)


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
