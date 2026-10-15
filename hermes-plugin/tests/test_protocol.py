"""Pure protocol framing/validation (foxfleet/protocol.py); no Hermes imports needed."""

from __future__ import annotations

import json

import pytest

from foxfleet import protocol as p


def test_parse_frame_rejects_non_json_non_object_and_oversize():
    assert p.parse_frame('{"t":"ping"}') == {"t": "ping"}
    for bad in ("not json", "[1,2]", '{"no_t":1}', '{"t":5}'):
        with pytest.raises(p.ProtocolError):
            p.parse_frame(bad)
    with pytest.raises(p.ProtocolError) as err:
        p.parse_frame(json.dumps({"t": "x", "pad": "a" * p.MAX_FRAME_BYTES}))
    assert err.value.code == "frame_too_large"


BOT = "0123456789abcdef01234567"
CHAT = "fc_AbCdEf0123456789"
MSG = "fm_AbCdEf0123456789"


def test_hello_requires_exact_protocol_and_sane_event_ids():
    hello = p.parse_hello({"t": "hello", "protocol": "foxfleet.bot/1", "bot": BOT,
                           "resume_from": 3, "latest_event_id": 7})
    assert (hello.bot, hello.resume_from, hello.latest_event_id) == (BOT, 3, 7)
    with pytest.raises(p.ProtocolError) as err:
        p.parse_hello({"t": "hello", "protocol": "foxfleet.bot/2", "bot": BOT, "resume_from": 0,
                       "latest_event_id": 0})
    assert err.value.code == "version_mismatch"
    for bad in ({"resume_from": -1}, {"resume_from": True}, {"resume_from": 9},
                {"bot": ""}, {"latest_event_id": "7"}, {"bot": "bot_1"}, {"bot": BOT.upper()},
                {"bot": BOT[:-1]}, {"bot": BOT + "0"}):
        frame = {"t": "hello", "protocol": p.PROTOCOL, "bot": BOT, "resume_from": 0,
                 "latest_event_id": 8, **bad}
        with pytest.raises(p.ProtocolError):
            p.parse_hello(frame)


def _msg(**over):
    frame = {"t": "message.new", "event_id": 5, "chat_id": CHAT, "chat_type": "dm", "message_id": MSG,
             "user": {"id": "u1", "name": "Ada"}, "text": "hi"}
    frame.update(over)
    return frame


def test_message_new_validated_into_typed_inbound():
    msg = p.parse_message_new(_msg(reply_to=MSG[:-1] + "0"))
    assert (msg.event_id, msg.chat_id, msg.message_id, msg.user_id, msg.user_name, msg.text,
            msg.reply_to) == (5, CHAT, MSG, "u1", "Ada", "hi", MSG[:-1] + "0")
    assert p.parse_message_new(_msg(user={"id": "u1"})).user_name is None
    # 64 KiB is measured in UTF-8 BYTES: 30k three-byte chars (90 KB) is over the cap.
    for bad in (_msg(text=None), _msg(text="€" * 30_000), _msg(user={"name": "x"}),
                _msg(chat_id=""), _msg(message_id="a\nb"), _msg(event_id=-2), _msg(user="u1"),
                _msg(reply_to=7), _msg(chat_id="c1"), _msg(chat_id="fc_short"), _msg(chat_id="fc_" + "a" * 17),
                _msg(message_id="m1"), _msg(message_id="fc_AbCdEf0123456789"), _msg(reply_to="hm1"),
                _msg(chat_id="fc_AbCdEf012345678!")):
        with pytest.raises(p.ProtocolError):
            p.parse_message_new(bad)


def test_group_and_thread_events_are_explicitly_unsupported_not_malformed():
    for frame in (_msg(chat_type="group"), _msg(thread_id="t1")):
        with pytest.raises(p.UnsupportedEvent) as err:
            p.parse_message_new(frame)
        assert err.value.event_id == 5 and err.value.chat_id == CHAT
    assert p.parse_message_new(_msg(thread_id=None)).chat_id == CHAT


def test_res_frames_validated_and_errors_bounded():
    ok = p.parse_res({"t": "res", "id": "r1", "ok": True, "result": {"message_id": "m9"}})
    assert (ok.id, ok.ok, ok.result) == ("r1", True, {"message_id": "m9"})
    err = p.parse_res({"t": "res", "id": "r2", "ok": False,
                       "error": {"code": "forbidden", "message": "x" * 5000}})
    assert (err.ok, err.error_code) == (False, "forbidden") and not hasattr(err, "error_message")
    odd = p.parse_res({"t": "res", "id": "r3", "ok": False, "error": {"code": "ffb_secret", "message": "m"}})
    assert odd.error_code == "unrecognized"
    for bad in ({"t": "res", "ok": True}, {"t": "res", "id": "r", "ok": "yes"},
                {"t": "res", "id": "r", "ok": False}, {"t": "res", "id": "r", "ok": True, "result": []}):
        with pytest.raises(p.ProtocolError):
            p.parse_res(bad)
    assert p.error_kind_for("rate_limited") == "rate_limited"
    assert p.error_kind_for("not_found") == "not_found"
    assert p.error_kind_for("weird") == "unknown"


def test_request_builders_match_contract_and_cap_outbound_frames():
    frame = p.build_request("message.send", "r1", chat_id="c1", text="hi", format="markdown",
                            reply_to=None, idempotency_key="k1")
    assert frame == {"t": "message.send", "id": "r1", "chat_id": "c1", "text": "hi",
                     "format": "markdown", "idempotency_key": "k1"}
    assert p.build_ack(9) == {"t": "ack", "event_id": 9}
    assert json.loads(p.encode_frame(frame)) == frame
    with pytest.raises(p.ProtocolError):
        p.encode_frame({"t": "message.send", "text": "a" * p.MAX_FRAME_BYTES})


def test_hub_url_requires_tls_off_loopback_and_rejects_embedded_credentials():
    assert p.bot_ws_url("https://fleet.example") == "wss://fleet.example/api/bot/ws"
    assert p.bot_ws_url("https://fleet.example/hub/") == "wss://fleet.example/hub/api/bot/ws"
    assert p.bot_ws_url("wss://fleet.example/api/bot/ws") == "wss://fleet.example/api/bot/ws"
    assert p.bot_ws_url("http://127.0.0.1:3080") == "ws://127.0.0.1:3080/api/bot/ws"
    assert p.bot_ws_url("ws://[::1]:9/") == "ws://[::1]:9/api/bot/ws"
    assert p.bot_ws_url("http://localhost:1") == "ws://localhost:1/api/bot/ws"
    for bad in ("http://fleet.example", "ws://10.0.0.5:3080", "https://user:pw@fleet.example",
                "https://fleet.example/?token=ffb_x", "https://fleet.example/#t", "ftp://fleet.example",
                "", "https://", "http://127.0.0.1.evil.example"):
        with pytest.raises(ValueError):
            p.bot_ws_url(bad)


def test_bot_token_shape_checked_without_echoing_secret():
    assert p.check_bot_token("ffb_" + "A" * 43) == "ffb_" + "A" * 43
    for bad in ("", "ffb_ has space", "ffb_\nx", "x" * 600, None):
        with pytest.raises(ValueError) as err:
            p.check_bot_token(bad)
        assert "has space" not in str(err.value)
    assert p.auth_header("ffb_abc") == {"Authorization": "Bot ffb_abc"}


def test_split_text_is_lossless_and_byte_bounded():
    assert p.split_text("hello", 10) == ["hello"]
    text = ("line €\U0001F98A\n" * 9000) + "tail"
    chunks = p.split_text(text, p.MAX_TEXT_BYTES)
    assert len(chunks) > 1 and "".join(chunks) == text
    assert all(0 < p.utf8_len(c) <= p.MAX_TEXT_BYTES for c in chunks)
    assert all(c.endswith("\n") for c in chunks[:-1])  # prefers line boundaries
    no_newlines = "\U0001F98A" * 50
    parts = p.split_text(no_newlines, 9)
    assert "".join(parts) == no_newlines and all(p.utf8_len(c) <= 9 for c in parts)
