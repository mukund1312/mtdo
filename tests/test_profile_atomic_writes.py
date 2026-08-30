"""Tests for gh62: mtdo profile switch (and the two other call sites with the same
shape -- profile create --from-current, and the live TUI's own auto-save-on-switch)
used to write a profile's goals.json and state.json as two entirely separate
write_goals()/write_state() calls, with no rollback between them -- the process
dying (or the second call raising) in between left the profile with its goals
updated but state stale, a real inconsistent split-profile state.

Fixed by profiles.write_goals_and_state(): prepares both payloads (serialize +
encrypt) before touching either file, then writes each one atomically (temp file +
os.replace(), same pattern as core.py's save_state from gh59) back-to-back.
"""
import argparse
import json
import os

import pytest

from mtdo import cli
from mtdo import config as appconfig
from mtdo import profiles as pf
from mtdo.app import TodoApp
from textual.screen import ModalScreen


async def _dismiss_first_run_prompts(pilot, app):
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


# ---------------- profiles.py: the atomic-write primitives themselves ----------------

def test_atomic_write_bytes_leaves_the_original_file_untouched_on_a_mid_write_failure(tmp_path, monkeypatch):
    path = str(tmp_path / "target.json")
    with open(path, "wb") as f:
        f.write(b"ORIGINAL CONTENT")

    real_fdopen = os.fdopen

    def failing_fdopen(fd, mode):
        f = real_fdopen(fd, mode)
        f.write = lambda *a, **kw: (_ for _ in ()).throw(OSError("simulated crash mid-write"))
        return f

    monkeypatch.setattr(os, "fdopen", failing_fdopen)
    with pytest.raises(OSError):
        pf._atomic_write_bytes(path, b"NEW CONTENT")

    with open(path, "rb") as f:
        assert f.read() == b"ORIGINAL CONTENT", "a failed write must never leave the target truncated/corrupt"

    leftover_tmp = [n for n in os.listdir(tmp_path) if n != "target.json"]
    assert leftover_tmp == [], f"failed write must clean up its temp file, found: {leftover_tmp}"


def test_atomic_write_bytes_creates_the_directory_if_missing(tmp_path):
    path = str(tmp_path / "nested" / "dir" / "target.json")
    pf._atomic_write_bytes(path, b"hello")
    with open(path, "rb") as f:
        assert f.read() == b"hello"


def test_write_goals_and_state_round_trips_for_an_unprotected_profile(unique_slug):
    slug = pf.create_profile(unique_slug)[0]
    goals = {"categories": [{"name": "dsa"}]}
    state = {"_meta": {}, "2026-01-01": {"dsa": []}}

    pf.write_goals_and_state(slug, goals, state)

    assert pf.read_goals(slug) == goals
    assert pf.read_state(slug) == state


def test_protected_profile_write_goals_and_state_round_trip(unique_slug):
    slug = pf.create_profile(unique_slug, password="pw-123")[0]
    goals = {"categories": [{"name": "backend"}]}
    state = {"_meta": {}, "2026-01-01": {"backend": []}}

    pf.write_goals_and_state(slug, goals, state, password="pw-123")

    assert pf.read_goals(slug, password="pw-123") == goals
    assert pf.read_state(slug, password="pw-123") == state
    # confirm it's genuinely encrypted on disk, not plaintext with a password check
    with open(pf._goals_path(slug), "rb") as f:
        raw = f.read()
    assert b"backend" not in raw


def test_write_goals_and_state_touches_neither_file_if_serialization_fails(unique_slug):
    """If preparing either payload fails, neither file should be written at all --
    that's the whole point of preparing both up front before touching either."""
    slug = pf.create_profile(unique_slug)[0]
    pf.write_goals_and_state(slug, {"categories": []}, {"_meta": {}})  # establish a known-good baseline

    class NotSerializable:
        pass

    with pytest.raises(TypeError):
        pf.write_goals_and_state(slug, {"categories": []}, {"bad": NotSerializable()})

    # baseline must be untouched -- neither write should have started
    assert pf.read_goals(slug) == {"categories": []}
    assert pf.read_state(slug) == {"_meta": {}}


# ---------------- cli.py: cmd_profile_switch / cmd_profile_create --from-current ----------------

def _switch_args(name):
    return argparse.Namespace(name=name)


def _create_args(name, password=False, from_current=False):
    return argparse.Namespace(name=name, password=password, from_current=from_current)


def test_cmd_profile_switch_saves_both_goals_and_state_for_the_outgoing_profile(unique_slug, capsys):
    slug_a = pf.create_profile(f"{unique_slug}_a")[0]
    slug_b = pf.create_profile(f"{unique_slug}_b")[0]
    pf.set_active(slug_a)

    goals = {"categories": [{"name": "left-by-a"}]}
    state = {"_meta": {"gh62_marker": "left-by-a"}}
    with open(appconfig.GOALS_PATH, "w") as f:
        json.dump(goals, f)
    with open(appconfig.STATE_PATH, "w") as f:
        json.dump(state, f)

    cli.cmd_profile_switch(_switch_args(f"{unique_slug}_b"))
    capsys.readouterr()

    assert pf.read_goals(slug_a) == goals
    assert pf.read_state(slug_a) == state
    assert pf.get_active_slug() == slug_b


def test_cmd_profile_switch_falls_back_to_single_write_when_only_state_exists(unique_slug, capsys):
    """The active profile might not have a goals.json yet (e.g. never configured) --
    switching away must still save state on its own, not skip saving entirely or
    crash trying to combine a write with a nonexistent goals payload."""
    slug_a = pf.create_profile(f"{unique_slug}_a")[0]
    slug_b = pf.create_profile(f"{unique_slug}_b")[0]
    pf.set_active(slug_a)

    if os.path.exists(appconfig.GOALS_PATH):
        os.remove(appconfig.GOALS_PATH)
    state = {"_meta": {"gh62_marker": "state-only"}}
    with open(appconfig.STATE_PATH, "w") as f:
        json.dump(state, f)

    cli.cmd_profile_switch(_switch_args(f"{unique_slug}_b"))
    capsys.readouterr()

    assert pf.read_state(slug_a) == state
    assert pf.read_goals(slug_a) is None


def test_cmd_profile_create_from_current_adopts_both_goals_and_state_atomically(unique_slug, capsys):
    goals = {"categories": [{"name": "adopted"}]}
    state = {"_meta": {"gh62_marker": "adopted"}}
    with open(appconfig.GOALS_PATH, "w") as f:
        json.dump(goals, f)
    with open(appconfig.STATE_PATH, "w") as f:
        json.dump(state, f)

    cli.cmd_profile_create(_create_args(unique_slug, from_current=True))
    capsys.readouterr()

    profile = next(p for p in pf.list_profiles() if p["name"] == unique_slug)
    assert pf.read_goals(profile["slug"]) == goals
    assert pf.read_state(profile["slug"]) == state


# ---------------- app.py: _write_current_profile (the live TUI's own auto-save) ----------------

async def test_switching_away_in_the_live_tui_saves_both_goals_and_state(unique_slug):
    """The existing gh52 regression test only ever exercises the state-only
    fallback (no goals.json set up at all) -- this specifically covers the new
    combined write_goals_and_state() path that fires when both exist, which is
    the common case for any profile that's actually been configured. Uses
    whatever goals.json the app naturally boots with rather than fabricating one
    by hand -- config.py's real schema requirements aren't this test's concern,
    only that whatever's really there gets carried over correctly alongside state."""
    slug_a = pf.create_profile(f"{unique_slug}_a")[0]
    slug_b = pf.create_profile(f"{unique_slug}_b")[0]
    pf.set_active(slug_a)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        assert os.path.exists(appconfig.GOALS_PATH), "test assumes the app boots with a real goals.json already"
        with open(appconfig.GOALS_PATH) as f:
            goals_at_switch_time = json.load(f)

        app.state["_meta"]["gh62_marker"] = "left-by-a"
        with open(appconfig.STATE_PATH, "w") as f:
            json.dump(app.state, f)

        app.action_open_profile_menu()
        await pilot.pause()
        btn_b = next(c for c in app.screen.profile_list.children if getattr(c, "profile_slug", None) == slug_b)
        btn_b.press()
        await pilot.pause()

    assert pf.read_goals(slug_a) == goals_at_switch_time
    assert pf.read_state(slug_a)["_meta"]["gh62_marker"] == "left-by-a"
