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


# ---------------- gh62's other half: writing the INCOMING profile's data into the ----------------
# ---------------- live, unencrypted ~/.mtdo files (appconfig.GOALS_PATH/STATE_PATH) ----------------
#
# The tests above (already-merged fix, PR #67) only ever cover the OUTGOING profile's
# save-away, via profiles.write_goals_and_state(). cmd_profile_switch's other write --
# landing the profile being switched INTO into the live GOALS_PATH/STATE_PATH -- was
# still two separate, direct open(..., "w") calls, unfixed: not individually crash-safe
# (opening in "w" mode truncates immediately, before anything is even written), and with
# the same no-rollback gap between them as the original bug. Fixed via
# config.save_goals() (new) and core.save_state() (already existed, gh59) -- both atomic
# (temp file + os.replace()), called back-to-back with no other I/O in between.

def test_save_goals_leaves_the_original_file_untouched_on_a_mid_write_failure(monkeypatch):
    with open(appconfig.GOALS_PATH, "w") as f:
        json.dump({"categories": [{"name": "original"}]}, f)

    real_fdopen = os.fdopen

    def failing_fdopen(fd, mode):
        f = real_fdopen(fd, mode)
        f.write = lambda *a, **kw: (_ for _ in ()).throw(OSError("simulated crash mid-write"))
        return f

    monkeypatch.setattr(os, "fdopen", failing_fdopen)
    with pytest.raises(OSError):
        appconfig.save_goals({"categories": [{"name": "new"}]})

    with open(appconfig.GOALS_PATH) as f:
        assert json.load(f) == {"categories": [{"name": "original"}]}
    goals_dir = os.path.dirname(appconfig.GOALS_PATH)
    leftover_tmp = [n for n in os.listdir(goals_dir) if n.startswith(".goals.json.")]
    assert leftover_tmp == [], f"failed write must clean up its temp file, found: {leftover_tmp}"


def test_cmd_profile_switch_lands_the_incoming_profiles_goals_and_state_in_the_live_files(unique_slug, capsys):
    """Previously untested: the tests above only ever check what the OUTGOING
    profile ends up with, never what actually lands in the live GOALS_PATH/
    STATE_PATH for the profile being switched INTO."""
    slug_a = pf.create_profile(f"{unique_slug}_a")[0]
    slug_b = pf.create_profile(f"{unique_slug}_b")[0]
    goals_b = {"categories": [{"name": "b-goals"}]}
    state_b = {"_meta": {"gh62_marker": "b-state"}}
    pf.write_goals_and_state(slug_b, goals_b, state_b)
    pf.set_active(slug_a)

    cli.cmd_profile_switch(_switch_args(f"{unique_slug}_b"))
    capsys.readouterr()

    with open(appconfig.GOALS_PATH) as f:
        assert json.load(f) == goals_b
    with open(appconfig.STATE_PATH) as f:
        assert json.load(f) == state_b


def test_cmd_profile_switch_incoming_state_write_does_not_leave_a_truncated_file_on_failure(unique_slug, capsys, monkeypatch):
    """The actual gh62 regression this half of the fix addresses: under the old code,
    `open(appconfig.STATE_PATH, "w")` truncates the live file to empty the instant it's
    opened -- before json.dump even runs -- so ANY failure preparing the new content (not
    just a raw process kill) left state.json empty. Isolates this from the already-fixed
    outgoing-save half: profile A (the one switching away) has no live goals/state files
    of its own yet, so that step is a no-op here, and the only writes cmd_profile_switch
    does are the two INCOMING ones (goals, then state) this test targets -- forces the
    second of those (state) to fail and confirms no half-written state.json is left
    behind (there was none before)."""
    slug_a = pf.create_profile(f"{unique_slug}_a")[0]
    slug_b = pf.create_profile(f"{unique_slug}_b")[0]
    pf.write_goals_and_state(slug_b, {"categories": [{"name": "b-goals"}]}, {"_meta": {"marker": "b-state"}})
    pf.set_active(slug_a)

    for path in (appconfig.GOALS_PATH, appconfig.STATE_PATH):
        if os.path.exists(path):
            os.remove(path)

    real_fdopen = os.fdopen
    call_count = {"n": 0}

    def failing_fdopen(fd, mode):
        call_count["n"] += 1
        f = real_fdopen(fd, mode)
        if call_count["n"] == 2:  # 1st fdopen call is the incoming goals write, 2nd is state's
            f.write = lambda *a, **kw: (_ for _ in ()).throw(OSError("simulated crash mid-write"))
        return f

    monkeypatch.setattr(os, "fdopen", failing_fdopen)
    with pytest.raises(OSError):
        cli.cmd_profile_switch(_switch_args(f"{unique_slug}_b"))
    capsys.readouterr()

    assert not os.path.exists(appconfig.STATE_PATH), (
        "a failed write must never leave a truncated/empty state.json behind"
    )
    state_dir = os.path.dirname(appconfig.STATE_PATH)
    leftover_tmp = [n for n in os.listdir(state_dir) if n.startswith(".state.json.")]
    assert leftover_tmp == [], f"failed write must clean up its temp file, found: {leftover_tmp}"
    # the failed switch must not have been committed
    assert pf.get_active_slug() == slug_a


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
