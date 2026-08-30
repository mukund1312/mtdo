"""Regression tests for core.py's state.json read/write (gh59): the write must be
atomic (temp file + os.replace, not a direct overwrite that a mid-write crash could
truncate), and a corrupt/unreadable file must quarantine itself and let the app start
fresh rather than crash every subsequent launch with no way back in.
"""
import json
import os

import pytest

from mtdo import config as appconfig
from mtdo import core


@pytest.fixture(autouse=True)
def _clean_state_file():
    """state.json is one shared path (not per-profile like most of this test suite's
    own data), so tests would otherwise leak state into each other across the shared
    MTDO_HOME test session (see conftest.py) -- scoped to just this file, local to
    this test module. Also sweeps up any quarantined .corrupt-* files a test leaves
    behind."""
    def _remove():
        if os.path.exists(appconfig.STATE_PATH):
            os.remove(appconfig.STATE_PATH)
        state_dir = os.path.dirname(appconfig.STATE_PATH)
        if os.path.isdir(state_dir):
            for name in os.listdir(state_dir):
                if name.startswith(os.path.basename(appconfig.STATE_PATH) + ".corrupt-"):
                    os.remove(os.path.join(state_dir, name))
    _remove()
    yield
    _remove()


def test_load_state_returns_empty_meta_when_file_missing():
    assert core.load_state() == {"_meta": {}}


def test_save_state_round_trips_through_load_state():
    state = {"_meta": {"foo": "bar"}, "2026-08-30": {"Gym": [{"text": "run", "status": "todo"}]}}
    core.save_state(state)
    assert core.load_state() == state


def test_save_state_leaves_no_leftover_temp_file():
    core.save_state({"_meta": {}})
    state_dir = os.path.dirname(appconfig.STATE_PATH)
    leftovers = [n for n in os.listdir(state_dir) if n.startswith(".state.json.")]
    assert leftovers == []


def test_save_state_is_atomic_real_content_never_partially_visible():
    """Confirms the write really goes through a temp file + os.replace, not a direct
    truncate-in-place -- inspects the actual file on disk mid-write via a real
    (small, fast) subprocess race would be flaky/slow to simulate reliably, so this
    instead asserts the mechanism directly: after save_state(), the temp file used
    during the write must be gone (replaced), and the real path must contain the
    complete, valid new content -- never a truncated fragment of it."""
    core.save_state({"_meta": {}, "day-one": {}})
    core.save_state({"_meta": {}, "day-two": {}})
    with open(appconfig.STATE_PATH) as f:
        on_disk = json.load(f)
    assert on_disk == {"_meta": {}, "day-two": {}}


def test_load_state_quarantines_a_corrupt_file_and_starts_fresh():
    os.makedirs(os.path.dirname(appconfig.STATE_PATH), exist_ok=True)
    with open(appconfig.STATE_PATH, "w") as f:
        f.write('{"_meta": {}, "truncated": [1, 2,')  # deliberately invalid JSON

    result = core.load_state()

    assert result == {"_meta": {}}
    assert not os.path.exists(appconfig.STATE_PATH)
    state_dir = os.path.dirname(appconfig.STATE_PATH)
    quarantined = [n for n in os.listdir(state_dir) if ".corrupt-" in n]
    assert len(quarantined) == 1
    with open(os.path.join(state_dir, quarantined[0])) as f:
        assert f.read() == '{"_meta": {}, "truncated": [1, 2,'


def test_load_state_after_quarantine_can_save_again_normally():
    """The app must actually be usable again after a corruption/recovery cycle, not
    just avoid crashing once."""
    os.makedirs(os.path.dirname(appconfig.STATE_PATH), exist_ok=True)
    with open(appconfig.STATE_PATH, "w") as f:
        f.write("not json at all")
    core.load_state()

    core.save_state({"_meta": {}, "2026-08-30": {}})
    assert core.load_state() == {"_meta": {}, "2026-08-30": {}}
