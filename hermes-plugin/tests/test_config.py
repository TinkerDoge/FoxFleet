"""Scoped settings bridge (PlatformConfig.extra + _shared helpers) and default-deny authorization."""

from __future__ import annotations

import pytest

from gateway.config import Platform, PlatformConfig
from gateway.session import SessionSource

from foxfleet import adapter as ff

TOKEN = "ffb_" + "t" * 43


_ENV = ("FOXFLEET_BOT_TOKEN", "FOXFLEET_HUB_URL", "FOXFLEET_HOME_CHANNEL",
                 "FOXFLEET_HOME_CHANNEL_NAME", "FOXFLEET_ALLOWED_USERS", "FOXFLEET_ALLOW_ALL_USERS",
                 "GATEWAY_ALLOWED_USERS", "GATEWAY_ALLOW_ALL_USERS")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    yield
    # The YAML bridge writes os.environ by design (env > YAML); never leak that into other tests.
    import os
    for name in _ENV:
        os.environ.pop(name, None)


def test_validate_config_needs_token_and_safe_hub_url(monkeypatch):
    cfg = PlatformConfig(enabled=True, extra={"hub_url": "https://fleet.example"})
    assert ff.validate_config(cfg) is False  # no token
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", TOKEN)
    assert ff.validate_config(cfg) is True
    for url in ("http://fleet.example", "https://u:p@fleet.example", "https://fleet.example/?token=x"):
        assert ff.validate_config(PlatformConfig(enabled=True, extra={"hub_url": url})) is False
    # A token placed in YAML extra is ignored: secrets come from the profile env only.
    monkeypatch.delenv("FOXFLEET_BOT_TOKEN")
    assert ff.validate_config(PlatformConfig(enabled=True, extra={"hub_url": "https://f.example",
                                                                  "token": TOKEN})) is False


def test_env_enablement_seeds_extra_without_copying_the_token(monkeypatch):
    assert ff._env_enablement() is None
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", TOKEN)
    monkeypatch.setenv("FOXFLEET_HUB_URL", "https://fleet.example/")
    monkeypatch.setenv("FOXFLEET_HOME_CHANNEL", "chat_home")
    seed = ff._env_enablement()
    assert seed["hub_url"] == "https://fleet.example"
    assert seed["home_channel"] == {"chat_id": "chat_home", "name": "Home"}
    assert TOKEN not in repr(seed)


def test_yaml_bridge_seeds_hub_url_and_scalar_home_channel():
    seeded = ff._apply_yaml_config({}, {"hub_url": "https://fleet.example", "home_channel": "c9",
                                        "allowed_users": ["u1", "u2"]})
    assert seeded == {"hub_url": "https://fleet.example", "home_channel": "c9", "allowed_users": ["u1", "u2"]}
    import os
    assert os.environ["FOXFLEET_HUB_URL"] == "https://fleet.example"  # bridged for env-first readers
    assert ff._apply_yaml_config({}, {"home_channel": {"chat_id": "c9"}}) is None


def test_token_read_from_the_owning_profile_secret_scope(monkeypatch):
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    monkeypatch.setenv("FOXFLEET_BOT_TOKEN", "ffb_launch_profile")
    scope = set_secret_scope({"FOXFLEET_BOT_TOKEN": TOKEN})
    try:
        adapter = ff.FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "https://f.example"}))
    finally:
        reset_secret_scope(scope)
    assert adapter._token == TOKEN


def _runner():
    # GatewayRunner's authorization is GatewayAuthorizationMixin; importing gateway.run itself runs
    # hermes_bootstrap (dependency provisioning for the data root), which unit tests must not do.
    from gateway.authz_mixin import GatewayAuthorizationMixin
    runner = object.__new__(type("AuthzRunner", (GatewayAuthorizationMixin,), {}))
    runner.pairing_store = None
    return runner


def test_default_deny_until_hub_user_is_allowlisted(foxfleet_platform_entry, monkeypatch):
    assert foxfleet_platform_entry.allowed_users_env == "FOXFLEET_ALLOWED_USERS"
    source = SessionSource(platform=Platform("foxfleet"), chat_id="c1", chat_type="dm", user_id="u1",
                           user_name="Ada")
    assert _runner()._is_user_authorized(source) is False
    monkeypatch.setenv("FOXFLEET_ALLOWED_USERS", "u2,u1")
    assert _runner()._is_user_authorized(source) is True
    monkeypatch.setenv("FOXFLEET_ALLOWED_USERS", "u2")
    assert _runner()._is_user_authorized(source) is False
