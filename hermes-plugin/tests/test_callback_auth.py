"""Credentialed callbacks require an explicit True authorisation verdict."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from gateway.config import PlatformConfig
from foxfleet.adapter import FoxFleetAdapter


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["missing", "none", "raises", "truthy", "false"])
@pytest.mark.parametrize("kind", ["stop", "card"])
async def test_unknown_or_denied_callback_never_dispatches(mode, kind):
    adapter = FoxFleetAdapter(PlatformConfig(enabled=True))
    if mode != "missing":
        def check(*args, **kwargs):
            if mode == "raises":
                raise RuntimeError("auth unavailable")
            return {"none": None, "truthy": 1, "false": False}.get(mode)
        adapter.set_authorization_check(check)
    conn = SimpleNamespace(stop_enabled=True, cards_enabled=True)
    adapter._conn = conn
    adapter.handle_message = AsyncMock()
    adapter._answer_stop = AsyncMock()
    adapter._finish_card = AsyncMock()
    adapter._resolve_card = AsyncMock(return_value="answered")
    frame = {"chat_id": "fc_" + "a" * 16, "user": {"id": "owner", "name": "Owner"}}
    if kind == "stop":
        frame.update(t="chat.stop", stop_id="fs_" + "a" * 16, date=1,
                     expires_at=int(time.time() * 1000) + 10000)
        await adapter._on_chat_stop(conn, frame)
        adapter._answer_stop.assert_awaited_once_with(conn, frame["stop_id"], "refused")
        assert adapter._suppress_stop_reply == set()
    else:
        rid = "frq_" + "a" * 16
        frame.update(t="callback", callback_id="fcb_" + "a" * 16, request_id=rid,
                     kind="approval", value={"choice": "once"})
        pending = {"kind": "approval", "approval_id": "approval-1", "chat_id": frame["chat_id"]}
        adapter._cards[rid] = pending
        await adapter._on_card_callback(conn, frame)
        adapter._finish_card.assert_awaited_once_with(conn, frame["callback_id"], "refused")
        assert adapter._cards[rid] is pending
    adapter.handle_message.assert_not_awaited()
    adapter._resolve_card.assert_not_awaited()


@pytest.mark.asyncio
async def test_explicitly_authorised_card_resolves_exact_request():
    adapter = FoxFleetAdapter(PlatformConfig(enabled=True))
    adapter.set_authorization_check(lambda *a, **kw: True)
    conn = SimpleNamespace(cards_enabled=True)
    adapter._conn = conn
    adapter._finish_card = AsyncMock()
    adapter._resolve_card = AsyncMock(return_value="answered")
    rid = "frq_" + "a" * 16
    pending = {"kind": "approval", "approval_id": "approval-1", "chat_id": "fc_" + "a" * 16}
    adapter._cards[rid] = pending
    frame = {"t": "callback", "callback_id": "fcb_" + "a" * 16, "request_id": rid,
             "chat_id": pending["chat_id"], "user": {"id": "owner"},
             "kind": "approval", "value": {"choice": "once"}}
    await adapter._on_card_callback(conn, frame)
    adapter._resolve_card.assert_awaited_once()
    assert adapter._resolve_card.await_args.args[0] is pending
    assert rid not in adapter._cards
    adapter._finish_card.assert_awaited_once_with(conn, frame["callback_id"], "answered")
