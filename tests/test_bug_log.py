"""Regression tests for bug_log.py's bugs.json read/write (gh60): the write must be
atomic (temp file + os.replace, not a direct overwrite that a mid-write crash could
truncate), and a corrupt/unreadable file must quarantine itself and let new bugs still
be logged rather than silently treating the whole log as empty.

BUGS_PATH is a fixed real path under ~/.mtdo-sandbox (deliberately NOT scoped to the
MTDO_HOME test sandbox -- see bug_log.py's own module docstring for why), so every test
here monkeypatches bug_log.BUGS_PATH to a throwaway temp file first. Never touch the
real path -- see the project's own "never bulk-delete/overwrite real sandbox data"
lesson (a prior real data-loss incident).
"""
import json
import os

import pytest

from mtdo import bug_log


@pytest.fixture(autouse=True)
def _isolated_bugs_path(monkeypatch, tmp_path):
    monkeypatch.setattr(bug_log, "BUGS_PATH", str(tmp_path / "bugs.json"))
    yield


def test_load_returns_empty_list_when_file_missing():
    assert bug_log._load() == []


def test_add_bug_round_trips_and_assigns_incrementing_ids():
    first = bug_log.add_bug("first bug")
    second = bug_log.add_bug("second bug")
    bugs = bug_log.list_bugs()
    assert [b["id"] for b in bugs] == [first, second]
    assert bugs[0]["text"] == "first bug"
    assert bugs[0]["status"] == "pending"


def test_save_leaves_no_leftover_temp_file():
    bug_log.add_bug("a bug")
    bugs_dir = os.path.dirname(bug_log.BUGS_PATH)
    leftovers = [n for n in os.listdir(bugs_dir) if n.startswith(".bugs.json.")]
    assert leftovers == []


def test_save_is_atomic_real_content_never_partially_visible():
    bug_log.add_bug("one")
    bug_log.add_bug("two")
    with open(bug_log.BUGS_PATH) as f:
        on_disk = json.load(f)
    assert [b["text"] for b in on_disk] == ["one", "two"]


def test_load_quarantines_a_corrupt_file_and_starts_fresh():
    os.makedirs(os.path.dirname(bug_log.BUGS_PATH), exist_ok=True)
    with open(bug_log.BUGS_PATH, "w") as f:
        f.write('[{"id": 1, "text": "truncated mid')  # deliberately invalid JSON

    result = bug_log._load()

    assert result == []
    assert not os.path.exists(bug_log.BUGS_PATH)
    bugs_dir = os.path.dirname(bug_log.BUGS_PATH)
    quarantined = [n for n in os.listdir(bugs_dir) if ".corrupt-" in n]
    assert len(quarantined) == 1
    with open(os.path.join(bugs_dir, quarantined[0])) as f:
        assert f.read() == '[{"id": 1, "text": "truncated mid'


def test_new_bugs_can_still_be_logged_after_a_corruption_recovery():
    """The whole point of this module is capturing a bug right before a crash --
    it must actually be usable again after a corruption/recovery cycle, not just
    avoid crashing once."""
    os.makedirs(os.path.dirname(bug_log.BUGS_PATH), exist_ok=True)
    with open(bug_log.BUGS_PATH, "w") as f:
        f.write("not json at all")

    bug_id = bug_log.add_bug("logged right after recovery")

    assert bug_id == 1
    bugs = bug_log.list_bugs()
    assert len(bugs) == 1
    assert bugs[0]["text"] == "logged right after recovery"


def test_mark_fixed_updates_status_and_persists():
    bug_id = bug_log.add_bug("needs fixing")
    assert bug_log.mark_fixed(bug_id, "fixed it") is True
    bugs = bug_log.list_bugs()
    assert bugs[0]["status"] == "fixed"
    assert bugs[0]["fix_note"] == "fixed it"
    assert bugs[0]["fixed_at"] is not None


def test_mark_fixed_returns_false_for_unknown_id():
    assert bug_log.mark_fixed(999) is False
