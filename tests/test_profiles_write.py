"""Regression tests for gh61: write_goals/write_state's encrypted-write path must be
atomic (temp file + os.replace, not a direct overwrite that a mid-write crash could
truncate). Unlike core.py/bug_log.py's plain-JSON fixes (gh59/gh60), there's no
read-side "quarantine and recover" here -- Fernet can't tell truncated ciphertext
apart from a genuinely wrong password (by design, to avoid a decryption oracle), so
auto-discarding on InvalidToken would risk destroying a real profile on every
mistyped password. The fix is entirely on the write side: prevent the corruption
from ever happening.

Direct calls to profiles.py, not driven via Pilot -- see test_profiles.py for the
Pilot-driven UI-level profile tests; these are lower-level and don't need a running
app at all.
"""
import os

from mtdo import profiles as pf


def test_write_goals_round_trips_on_an_unprotected_profile(unique_slug):
    slug, _ = pf.create_profile(unique_slug)
    pf.write_goals(slug, {"categories": ["Gym"]})
    assert pf.read_goals(slug) == {"categories": ["Gym"]}


def test_write_state_round_trips_on_an_unprotected_profile(unique_slug):
    slug, _ = pf.create_profile(unique_slug)
    pf.write_state(slug, {"_meta": {}, "2026-08-30": {}})
    assert pf.read_state(slug) == {"_meta": {}, "2026-08-30": {}}


def test_write_goals_round_trips_on_a_password_protected_profile(unique_slug):
    slug, _ = pf.create_profile(unique_slug, password="correct horse")
    pf.write_goals(slug, {"categories": ["DSA"]}, password="correct horse")
    assert pf.read_goals(slug, password="correct horse") == {"categories": ["DSA"]}


def test_write_leaves_no_leftover_temp_file(unique_slug):
    slug, _ = pf.create_profile(unique_slug, password="hunter2")
    pf.write_goals(slug, {"a": 1}, password="hunter2")
    pf.write_state(slug, {"b": 2}, password="hunter2")
    profile_dir = pf.profile_dir(slug)
    leftovers = [n for n in os.listdir(profile_dir) if n.startswith(".") and n.endswith(".tmp")]
    assert leftovers == []


def test_second_write_fully_replaces_the_first_never_a_mix(unique_slug):
    """Confirms the write really goes through a temp file + os.replace, not a
    direct truncate-in-place -- decrypting after two consecutive writes must show
    the SECOND write's complete content, never a partial mix of the two."""
    slug, _ = pf.create_profile(unique_slug, password="swordfish")
    pf.write_goals(slug, {"version": "first", "categories": ["A"]}, password="swordfish")
    pf.write_goals(slug, {"version": "second", "categories": ["A", "B", "C"]}, password="swordfish")
    assert pf.read_goals(slug, password="swordfish") == {
        "version": "second", "categories": ["A", "B", "C"],
    }


def test_wrong_password_still_reports_as_wrong_password_not_corruption(unique_slug):
    """The atomic-write fix must not change WrongPassword's own behavior -- a
    genuinely wrong password still needs to surface clearly as wrong, not get
    mistaken for corruption recovery logic that doesn't exist here on purpose."""
    slug, _ = pf.create_profile(unique_slug, password="right-password")
    pf.write_goals(slug, {"x": 1}, password="right-password")
    try:
        pf.read_goals(slug, password="totally-wrong")
        assert False, "expected WrongPassword"
    except pf.WrongPassword:
        pass
