"""Bind a FoxFleet approval card to one Hermes approval.

A tap must resolve that approval and no other. Matching the oldest queued approval
is not good enough: two open cards would run the wrong command.

Room cards add a second, stricter key: the owner, room, target agent, dispatch and
request id all have to name the same card. The hub is still the authority (it mints
the ids and fills the human actor); this module is the plugin-side fail-closed check.
"""

from __future__ import annotations

from typing import Any, Optional


def bind_approval(pending: list, shown_command: str, bound_ids: set[str]) -> Optional[str]:
    """The one unbound approval whose shown command equals ``shown_command``.

    ``None`` when there is no match or more than one. Callers must not guess.
    """
    if not isinstance(shown_command, str) or not shown_command:
        return None
    hits: list[str] = []
    for row in pending:
        if not isinstance(row, dict):
            continue
        rid = row.get("request_id")
        if not isinstance(rid, str) or not rid or rid in bound_ids:
            continue
        if row.get("shown") == shown_command:
            hits.append(rid)
    if len(hits) != 1:
        return None
    return hits[0]


def bind_room_card(cards: dict[str, dict], *, request_id: str, chat_id: str,
                   target_agent_id: Optional[str] = None, dispatch_id: Optional[str] = None,
                   owner_id: Optional[str] = None) -> Optional[dict]:
    """The one pending room card matching the exact tuple, or ``None``.

    ``request_id`` is an exact lookup, never "the oldest open card". Every supplied
    tuple field must match a value the caller recorded; a field the caller does not
    know (the plugin does not learn the hub account id) is not guessed. A mismatch in
    room, target agent, dispatch, owner or request refuses the tap.
    """
    if not isinstance(cards, dict) or not isinstance(request_id, str) or not request_id:
        return None
    row = cards.get(request_id)
    if not isinstance(row, dict):
        return None
    if row.get("request_id") != request_id or row.get("chat_id") != chat_id:
        return None
    expected: list[tuple[str, Any]] = [
        ("target_agent_id", target_agent_id),
        ("dispatch_id", dispatch_id),
        ("owner_id", owner_id),
    ]
    for name, value in expected:
        if value is None:
            continue
        if row.get(name) != value:
            return None
    return row
