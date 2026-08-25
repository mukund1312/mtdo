"""Regression tests for real bugs found (and fixed) during interactive testing
of the profiles feature -- see .claude/PROGRESS.md for the session-by-session
detail on each. Each of these reproduced a genuine crash or silent failure
before its fix landed; they exist so the same class of bug can't ship again
unnoticed on a future PR.

Driven via Textual's Pilot with real key dispatch (pilot.press), not direct
method calls on screens/widgets -- a few of these bugs (the modal-chain
callback getting silently dropped, in particular) only reproduce on the real
event-dispatch path, not when a test calls a handler directly.
"""
import json
import os

from mtdo import profiles as pf
from mtdo.app import (
    ClockHeader,
    ProfileCreateScreen,
    ProfileManageScreen,
    ProfileMenuScreen,
    RecoveryCodeScreen,
    TextPromptScreen,
    ToastLine,
    TodoApp,
)
from textual.screen import ModalScreen


async def _dismiss_first_run_prompts(pilot, app):
    """Every fresh MTDO_HOME hits a chain of first-run modals on mount: the feature
    walkthrough, then (2026-08-25, gh48) an automatic Profiles step
    (ProfileCreateScreen if no profile exists yet, ProfileMenuScreen if one already
    does -- see the `pf.create_profile`/`pf.set_active` calls some tests make before
    constructing TodoApp), then "how do you want to build your plan"
    (ChoicePickScreen). Escape cancels every one of these in turn (see the on_key
    additions added alongside gh48 -- the profile screens didn't support Escape at
    all before that), so just keep pressing it until nothing modal is left on top,
    rather than hard-coding the exact chain (which has already changed shape once,
    see the removed name-prompt/persona-picker steps from gh47)."""
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


async def test_profile_menu_opens_without_crashing_when_profile_exists(unique_slug):
    """BadIdentifier crash: profile-select button ids used to embed the slug via
    a ':' separator (e.g. "profile-select:janhvi"), which isn't a legal Textual
    widget id -- ProfileMenuScreen crashed on_mount as soon as any profile
    existed, before a click was even possible."""
    slug, _ = pf.create_profile(unique_slug)
    pf.set_active(slug)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        await pilot.press("U")
        await pilot.pause()
        assert isinstance(app.screen, ProfileMenuScreen)

        btn = next(
            c for c in app.screen.profile_list.children
            if getattr(c, "profile_slug", None) == slug
        )
        assert unique_slug in str(btn.label)


async def test_creating_profile_updates_header_immediately(unique_slug):
    """The real bug: ProfileMenuScreen dismisses itself then immediately pushes
    ProfileCreateScreen in the same handler. Textual delivers a dismissed
    screen's result via requester.call_next(...), where requester is whatever
    screen was active when the *next* modal was pushed -- still the
    just-dismissed screen, whose message pump stops processing once torn
    down. The callback was silently dropped: the dialog closed but the
    profile was never actually created. Fixed by TodoApp._push_modal, which
    pins the requester to the App itself."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        await pilot.press("U")
        await pilot.pause()
        await pilot.press("enter")  # "Add Profile" is default-focused
        await pilot.pause()
        assert isinstance(app.screen, ProfileCreateScreen)

        for ch in unique_slug:
            await pilot.press(ch)
        await pilot.press("tab")
        await pilot.press("tab")
        await pilot.press("enter")
        await pilot.pause()

        assert pf.get_active_slug() is not None
        profile = pf.get_profile(pf.get_active_slug())
        assert profile["name"] == unique_slug

        header = app.query_one(ClockHeader).content.plain
        assert f"Hello, {unique_slug}" in header


async def test_creating_profile_with_password_shows_recovery_code(unique_slug):
    """gh44/gh49: password protection used to be a single skippable text field --
    both bugs were testers surprised, later, that an unprotected profile never
    prompted for a password on switch. ProfileCreateScreen now makes it an
    explicit Yes/No choice; this exercises the "Yes" path end to end through
    real key dispatch, confirming the profile actually ends up protected and
    RecoveryCodeScreen shows a real code before the app proceeds."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        app.action_create_profile()
        await pilot.pause()
        assert isinstance(app.screen, ProfileCreateScreen)

        for ch in unique_slug:
            await pilot.press(ch)
        await pilot.press("tab")  # -> "Yes, set a password"
        await pilot.press("enter")
        await pilot.pause()

        for ch in "abc123":
            await pilot.press(ch)
        await pilot.press("tab")
        for ch in "abc123":
            await pilot.press(ch)
        await pilot.press("tab")  # -> Save
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, RecoveryCodeScreen)
        assert len(app.screen.recovery_code) > 0
        await pilot.press("enter")  # acknowledge
        await pilot.pause()

        slug = pf.get_active_slug()
        profile = pf.get_profile(slug)
        assert profile["name"] == unique_slug
        assert profile["protected"] is True


async def test_creating_profile_mismatched_passwords_does_not_create_it(unique_slug):
    """A real failure mode this UI can hit that the old single-field version
    couldn't: a typo in the confirm field. Must toast and let the user retry,
    not silently create the profile with one of the two typed values, and not
    crash."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        app.action_create_profile()
        await pilot.pause()
        for ch in unique_slug:
            await pilot.press(ch)
        await pilot.press("tab")
        await pilot.press("enter")  # Yes
        await pilot.pause()

        for ch in "firstpass":
            await pilot.press(ch)
        await pilot.press("tab")
        for ch in "secondpass":
            await pilot.press(ch)
        await pilot.press("tab")
        await pilot.press("enter")  # Save, but mismatched
        await pilot.pause()

        assert isinstance(app.screen, ProfileCreateScreen)
        toast_text = app.query_one(ToastLine).content.plain
        assert "match" in toast_text.lower()
        assert not any(p["name"] == unique_slug for p in pf.list_profiles())
        await pilot.press("escape")


async def test_manage_profiles_rename_flow_works(unique_slug):
    """Same modal-chaining bug as above, reached via a different screen
    (ProfileManageScreen's Rename button)."""
    slug, _ = pf.create_profile(unique_slug)
    pf.set_active(slug)
    new_name = f"{unique_slug}_renamed"

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        await pilot.press("U")
        await pilot.pause()
        await pilot.press("tab")  # Add Profile -> Manage Profiles
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, ProfileManageScreen)

        rename_btn = next(
            c for row in app.screen.rows.children for c in row.children
            if getattr(c, "profile_slug", None) == slug and getattr(c, "row_action", None) == "rename"
        )
        rename_btn.press()
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)

        # clear the pre-filled name, type the new one
        for _ in unique_slug:
            await pilot.press("backspace")
        for ch in new_name:
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        assert pf.get_profile(slug)["name"] == new_name


async def test_add_field_bootstraps_missing_goals_json(unique_slug):
    """A profile with no goals set has no goals.json (TodoApp._switch_profile
    deletes it in that case, correctly -- a profile's goals are its own).
    add_category_to_goals() used to require the file to already exist and
    raised FileNotFoundError otherwise -- but a brand-new profile always
    starts goals-less, and Add Field is often the first thing you'd do with
    one, so that was a dead end every time."""
    from mtdo import config as appconfig

    slug, _ = pf.create_profile(unique_slug)
    pf.set_active(slug)
    assert not os.path.exists(appconfig.GOALS_PATH)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        assert not os.path.exists(appconfig.GOALS_PATH)

        await pilot.press("A")  # Add Field
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)
        for ch in "networking":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)  # display-label prompt
        await pilot.press("enter")  # accept the pre-filled default
        await pilot.pause()

        assert os.path.exists(appconfig.GOALS_PATH)
        toast_text = app.query_one(ToastLine).content.plain
        assert "no goals.json" not in toast_text.lower()
        assert "Added field: networking" in toast_text

        with open(appconfig.GOALS_PATH) as f:
            goals = json.load(f)
        assert any(c["name"] == "networking" for c in goals["categories"])
