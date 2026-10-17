"""Inbound events must carry empty metadata so Hermes 0.22+ native admission accepts them.

Hermes gateway session_envelope._native_metadata only allows WhatsApp keys. Any other
metadata (including foxfleet_event_id / foxfleet_stop_id) refuses the message as
invalid_params — the chat then shows 'Hermes refused this message (invalid_params)'.
"""

from gateway.config import PlatformConfig
from gateway.session_envelope import _native_metadata

from foxfleet import protocol as p
from foxfleet.adapter import FoxFleetAdapter

CHAT = "fc_abcdefghijklmnop"
MSG = "fm_abcdefghijklmnop"


def _adapter():
    return FoxFleetAdapter(PlatformConfig(enabled=True, extra={"hub_url": "http://127.0.0.1:9"}))


def test_inbound_message_metadata_passes_hermes_native_admission():
    adapter = _adapter()
    event = adapter._build_event(p.InboundMessage(
        event_id=6, chat_id=CHAT, message_id=MSG, user_id="user_1", user_name="Ada", text="hi"))
    assert event.metadata == {}
    assert _native_metadata(event) == {}


def test_stop_event_metadata_passes_hermes_native_admission():
    adapter = _adapter()
    event = adapter._stop_event(p.ChatStop(
        stop_id="fs_" + "a" * 16, chat_id=CHAT, user_id="user_1", user_name="Ada", date=1, expires_at=2))
    assert event.metadata == {}
    assert _native_metadata(event) == {}
