"""Test isolation for the FoxFleet Hermes platform plugin.

Runs BEFORE any Hermes module is imported: points HERMES_HOME, the scoped-lock dir and XDG state at
a disposable directory and strips every FOXFLEET_* variable, so no live profile config, token,
lock or .env is ever read or written.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

TEST_NODE = os.environ.get("FOXFLEET_TEST_NODE", "")
TEST_HUB_SERVER = os.environ.get("FOXFLEET_TEST_HUB_SERVER", "")

for _name in list(os.environ):
    if _name.startswith("FOXFLEET_"):
        del os.environ[_name]

_TEST_HOME = Path(tempfile.mkdtemp(prefix="foxfleet-hermes-home-"))
_live_root = Path.home().resolve() / ".hermes"
assert not str(_TEST_HOME.resolve()).startswith(str(_live_root) + os.sep + "profiles"), _TEST_HOME
os.environ["HERMES_HOME"] = str(_TEST_HOME)
os.environ["HERMES_GATEWAY_LOCK_DIR"] = str(_TEST_HOME / "locks")
os.environ["XDG_STATE_HOME"] = str(_TEST_HOME / "xdg-state")

import pytest  # noqa: E402


@pytest.fixture(scope="session")
def hermes_home() -> Path:
    return _TEST_HOME


def pytest_sessionfinish(session, exitstatus):
    # Runtime status persists on a worker thread; finish its queued writes before
    # removing the isolated home (otherwise a successful suite emits an ENOENT warning).
    from gateway.status import flush_runtime_status
    flush_runtime_status(timeout=5.0)
    shutil.rmtree(_TEST_HOME, ignore_errors=True)


class _RegistryCtx:
    """Forwards our real ``register(ctx)`` kwargs into a process-global PlatformEntry, so adapters
    constructed directly in tests resolve ``Platform("foxfleet")`` exactly as after plugin load."""

    def register_platform(self, name, label, adapter_factory, check_fn, validate_config=None,
                          required_env=None, install_hint="", **kwargs):
        from gateway.platform_registry import PlatformEntry, platform_registry
        platform_registry.register(PlatformEntry(
            name=name, label=label, adapter_factory=adapter_factory, check_fn=check_fn,
            validate_config=validate_config, required_env=required_env or [], install_hint=install_hint,
            source="builtin", **kwargs), scope=None)


@pytest.fixture(scope="session", autouse=True)
def foxfleet_platform_entry():
    from foxfleet.adapter import register
    from gateway.platform_registry import platform_registry
    register(_RegistryCtx())
    yield platform_registry.get("foxfleet")
