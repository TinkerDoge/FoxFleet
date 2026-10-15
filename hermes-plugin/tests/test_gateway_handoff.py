"""0.3.12: the hand-off from a plugin fatal error to Hermes' own reconnect queue, through the REAL
GatewayRunner fatal handler (gateway/run_adapters.py) and backoff (gateway/run.py _reconnect_backoff).

Audit hypothesis (Soran): non-retryable plugin fatals are dropped by Hermes, so the agent (sumi) would
never reconnect. Confirmed for Hermes f9bdaa3: non-retryable -> not queued, and with no other platform
the gateway stops CLEANLY (no service restart). These tests pin which closes are handed over as
retryable and which stay final on purpose."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio

from gateway.config import GatewayConfig, PlatformConfig
from gateway.run import GatewayRunner, _reconnect_backoff

from fakehub import FakeHub, wait_for
from foxfleet.adapter import FoxFleetAdapter

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def hub():
    server = await FakeHub().start()
    yield server
    await server.stop()


@pytest_asyncio.fixture
async def made(monkeypatch, hub):
    adapters = []

    def _make():
        monkeypatch.setenv("FOXFLEET_BOT_TOKEN", hub.token)
        a = FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": hub.url}))
        a.RECONNECT_BASE_DELAY, a.RECONNECT_MAX_DELAY = 0.01, 0.05
        adapters.append(a)
        return a

    yield _make
    for a in adapters:
        await asyncio.wait_for(a.disconnect(), timeout=10)


def _runner(adapter) -> GatewayRunner:
    """Minimal real GatewayRunner (same shape as Hermes' own tests/gateway/test_platform_reconnect.py)."""
    r = object.__new__(GatewayRunner)
    r.config = GatewayConfig(platforms={adapter.platform: adapter.config})
    r._running, r._shutdown_event, r._exit_reason = True, asyncio.Event(), None
    r._exit_with_failure = r._exit_cleanly = False
    r._failed_platforms, r.adapters = {}, {adapter.platform: adapter}
    r.delivery_router = MagicMock()
    r._running_agents, r._pending_messages, r._pending_approvals = {}, {}, {}
    r._update_platform_runtime_status = MagicMock()
    r._ensure_reconnect_watcher_running = MagicMock()  # the watcher itself is Hermes' code, tested upstream
    r.stop = AsyncMock()
    adapter.set_fatal_error_handler(r._handle_adapter_fatal_error)
    return r


async def test_bot_gone_close_is_queued_for_gateway_reconnect_and_reconnects(hub, made):
    adapter = made()
    runner = _runner(adapter)
    assert await asyncio.wait_for(adapter.connect(), timeout=10)
    await hub.ws.close(code=4003, message=b"account disabled")
    await wait_for(lambda: adapter.platform in runner._failed_platforms, timeout=5)
    assert adapter.fatal_error_retryable is True
    runner.stop.assert_not_awaited()  # the gateway stays up; its watcher owns recovery
    assert [_reconnect_backoff(n) for n in (1, 2, 3, 4, 5, 6)] == [30, 60, 120, 240, 300, 300]
    # What the watcher does after the backoff: reconnect the same platform. The hub is back.
    assert await asyncio.wait_for(adapter.connect(is_reconnect=True), timeout=10) is True
    await wait_for(lambda: len(hub.auth_headers) == 2, timeout=5)


@pytest.mark.parametrize("code", [4001, 4009])
async def test_rotated_token_and_replaced_stay_final_by_design(hub, made, code):
    adapter = made()
    runner = _runner(adapter)
    assert await asyncio.wait_for(adapter.connect(), timeout=10)
    await hub.ws.close(code=code, message=b"stop")
    await wait_for(lambda: runner.stop.await_count == 1, timeout=5)
    assert adapter.platform not in runner._failed_platforms and adapter.fatal_error_retryable is False
    assert runner._exit_with_failure is False  # clean stop: an operator must fix the token / the duplicate
    await asyncio.sleep(0.2)
    assert len(hub.auth_headers) == 1  # never a retry loop


async def test_hub_restart_is_handled_inside_the_plugin_and_never_reaches_the_gateway(hub, made):
    adapter = made()
    runner = _runner(adapter)
    handed = []
    runner._handle_adapter_fatal_error = AsyncMock(side_effect=lambda a: handed.append(a))
    adapter.set_fatal_error_handler(runner._handle_adapter_fatal_error)
    assert await asyncio.wait_for(adapter.connect(), timeout=10)
    await hub.ws.close(code=1001, message=b"hub shutting down")
    await wait_for(lambda: len(hub.auth_headers) >= 2 and adapter.is_connected, timeout=5)
    assert handed == [] and runner._failed_platforms == {}
