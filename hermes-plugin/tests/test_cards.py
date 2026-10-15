"""A card tap binds to one approval. Two pending approvals must not cross."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from foxfleet.cards import bind_approval


def test_one_match_binds_and_two_matches_do_not():
    pending = [
        {"request_id": "a1", "shown": "rm build"},
        {"request_id": "a2", "shown": "deploy prod"},
    ]
    assert bind_approval(pending, "deploy prod", set()) == "a2"
    assert bind_approval(pending, "rm build", {"a1"}) is None
    assert bind_approval(pending, "rm build", set()) == "a1"
    both = [{"request_id": "a1", "shown": "rm build"}, {"request_id": "a2", "shown": "rm build"}]
    assert bind_approval(both, "rm build", set()) is None
    assert bind_approval(pending, "", set()) is None
    assert bind_approval(pending, "missing", set()) is None
