"""Bind a FoxFleet approval card to one Hermes approval.

A tap must resolve that approval and no other. Matching the oldest queued approval
is not good enough: two open cards would run the wrong command.
"""

from __future__ import annotations

from typing import Optional


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
