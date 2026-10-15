"""Plugin discovery through the REAL Hermes PluginManager in a disposable HERMES_HOME."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

PLUGIN_SRC = Path(__file__).resolve().parents[1] / "foxfleet"


@pytest.fixture(scope="module")
def registered_entry(hermes_home):
    target = hermes_home / "plugins" / "foxfleet"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(PLUGIN_SRC, target, ignore=shutil.ignore_patterns("__pycache__"))
    (hermes_home / "config.yaml").write_text(yaml.safe_dump({"plugins": {"enabled": ["foxfleet"]}}))
    from hermes_cli.plugins import PluginManager
    from gateway.platform_registry import platform_registry
    manager = PluginManager()
    manager.discover_and_load(force=True)
    entry = platform_registry.get("foxfleet")
    yield entry
    platform_registry.unregister("foxfleet", scope=platform_registry.current_scope_key())
    shutil.rmtree(target, ignore_errors=True)
    (hermes_home / "config.yaml").unlink(missing_ok=True)


def test_manifest_declares_platform_kind():
    manifest = yaml.safe_load((PLUGIN_SRC / "plugin.yaml").read_text())
    assert manifest["kind"] == "platform" and manifest["name"] == "foxfleet"
    env_names = {e["name"] for e in manifest["requires_env"] + manifest["optional_env"]}
    assert {"FOXFLEET_BOT_TOKEN", "FOXFLEET_HUB_URL", "FOXFLEET_ALLOWED_USERS",
            "FOXFLEET_HOME_CHANNEL"} <= env_names
    assert next(e for e in manifest["requires_env"] if e["name"] == "FOXFLEET_BOT_TOKEN")["password"] is True


def test_real_plugin_manager_registers_foxfleet_platform(registered_entry):
    entry = registered_entry
    assert entry is not None and entry.name == "foxfleet" and entry.source == "plugin"
    assert entry.allowed_users_env == "FOXFLEET_ALLOWED_USERS"
    assert entry.cron_deliver_env_var == "FOXFLEET_HOME_CHANNEL"
    assert entry.trusted_inbound is False
    assert "FoxFleet" in entry.platform_hint
    for hook in (entry.env_enablement_fn, entry.validate_config, entry.is_connected,
                 entry.apply_yaml_config_fn, entry.check_fn):
        assert callable(hook)
    assert entry.standalone_sender_fn is None
    assert entry.check_fn() is True


def test_registry_builds_a_real_base_platform_adapter(registered_entry, monkeypatch):
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", "ffb_test")
    from gateway.config import Platform, PlatformConfig
    from gateway.platform_registry import platform_registry
    from gateway.platforms.base import BasePlatformAdapter
    cfg = PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:9"})
    adapter = platform_registry.create_adapter("foxfleet", cfg)
    assert isinstance(adapter, BasePlatformAdapter)
    assert adapter.platform is Platform("foxfleet")
    assert adapter.authorization_is_upstream is False


def test_real_gateway_config_loader_enables_and_bridges_settings(tmp_path):
    """load_gateway_config() in a child process with its own disposable HERMES_HOME (the YAML bridge
    writes os.environ by design, so it must not run in the test process)."""
    import json
    import os
    import subprocess
    import sys
    home = tmp_path / "home"
    shutil.copytree(PLUGIN_SRC, home / "plugins" / "foxfleet", ignore=shutil.ignore_patterns("__pycache__"))
    (home / "config.yaml").write_text(yaml.safe_dump({
        "plugins": {"enabled": ["foxfleet"]},
        "foxfleet": {"hub_url": "https://fleet.example", "home_channel": "chat_home"}}))
    script = (
        "import json\n"
        "from hermes_cli.plugins import PluginManager; PluginManager().discover_and_load(force=True)\n"
        "from gateway.config import load_gateway_config, Platform\n"
        "p = load_gateway_config().platforms.get(Platform('foxfleet'))\n"
        "print('RESULT' + json.dumps({'enabled': p.enabled, 'extra': p.extra,"
        " 'home': p.home_channel.chat_id if p.home_channel else None}))\n")
    env = {k: v for k, v in os.environ.items() if not k.startswith("FOXFLEET_")}
    env.update(HERMES_HOME=str(home), FOXFLEET_BOT_TOKEN="ffb_cfgprobe", PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=120)
    line = next((l for l in done.stdout.splitlines() if l.startswith("RESULT")), None)
    assert line, done.stderr[-2000:]
    result = json.loads(line[len("RESULT"):])
    assert result["enabled"] is True and result["home"] == "chat_home"
    assert result["extra"]["hub_url"] == "https://fleet.example"
    assert "ffb_cfgprobe" not in json.dumps(result)  # the token never lands in extra
