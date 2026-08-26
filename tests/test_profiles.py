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
    ProfileUnlockScreen,
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


async def test_launch_blocks_on_protected_active_profile_until_correct_password(unique_slug):
    """gh49 (further ask, after gh44/49's fix made password protection an
    explicit choice at creation): mtdo used to boot straight into whatever
    profile was last active with zero password check, even if it was
    protected -- the launch-time counterpart to the switch-time gap gh40/44/49
    already closed elsewhere. A wrong password must not unlock it; the right
    one must."""
    slug = pf.create_profile(unique_slug, password="hunter2")[0]
    pf.set_active(slug)

    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, ProfileUnlockScreen)

        for ch in "wrongpassword":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, ProfileUnlockScreen), "wrong password must not unlock"

        for ch in "hunter2":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert not isinstance(app.screen, ProfileUnlockScreen), "right password must unlock"


async def test_switching_to_protected_profile_always_reprompts_even_if_unlocked_earlier(unique_slug):
    """gh49: a tester explicitly asked for a password "each time," not just the
    first -- there used to be a cross-switch cache so unlocking a profile once
    per app run was enough for every later switch back to it. Confirms the
    cache is really gone: unlock at launch, switch away, switch back -- must
    prompt again, not silently reuse the launch password."""
    slug_a = pf.create_profile(f"{unique_slug}_a", password="hunter2")[0]
    slug_b = pf.create_profile(f"{unique_slug}_b")[0]
    pf.set_active(slug_a)

    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        for ch in "hunter2":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        app.action_open_profile_menu()
        await pilot.pause()
        btn_b = next(c for c in app.screen.profile_list.children if getattr(c, "profile_slug", None) == slug_b)
        btn_b.press()
        await pilot.pause()
        assert pf.get_active_slug() == slug_b

        app.action_open_profile_menu()
        await pilot.pause()
        btn_a = next(c for c in app.screen.profile_list.children if getattr(c, "profile_slug", None) == slug_a)
        btn_a.press()
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen), "must re-prompt even though A was already unlocked this session"


async def test_deleting_protected_profile_requires_its_password(unique_slug):
    """gh49: rename/delete used to need no authentication at all -- anyone at
    the app could permanently delete a protected profile (its encrypted files
    included) without ever knowing the password. Wrong password must block
    the delete entirely; right password must let it proceed."""
    slug_active = pf.create_profile(f"{unique_slug}_active")[0]
    slug_target = pf.create_profile(f"{unique_slug}_target", password="hunter2")[0]
    pf.set_active(slug_active)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        app.action_manage_profiles()
        await pilot.pause()
        del_btn = next(
            c for row in app.screen.rows.children for c in row.children
            if getattr(c, "profile_slug", None) == slug_target and getattr(c, "row_action", None) == "delete"
        )
        del_btn.press()
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen), "delete on a protected profile must ask for its password first"

        for ch in "wrongpassword":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert pf.get_profile(slug_target) is not None, "must not delete on a wrong password"

        app.action_manage_profiles()
        await pilot.pause()
        del_btn2 = next(
            c for row in app.screen.rows.children for c in row.children
            if getattr(c, "profile_slug", None) == slug_target and getattr(c, "row_action", None) == "delete"
        )
        del_btn2.press()
        await pilot.pause()
        for ch in "hunter2":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen), "now the existing type-the-name delete confirmation"
        for ch in f"{unique_slug}_target":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert pf.get_profile(slug_target) is None, "must delete once the right password and name are given"


async def test_forgot_password_from_lock_screen_unlocks_via_recovery_code(unique_slug):
    """Real lockout bug, found and fixed the same day ProfileUnlockScreen
    shipped: that screen blocks *before* the rest of the app mounts, so Manage
    Profiles' Reset Password -- the only place the recovery-code flow lived --
    was completely unreachable if you actually forgot the password. There was
    no way back in at all short of editing profiles/index.json by hand. Fixed
    by adding a "Forgot password?" button on the lock screen itself, wired
    through the same recovery-code flow, that unlocks straight into the app on
    a successful reset instead of making you retype the new password."""
    slug, code = pf.create_profile(unique_slug, password="original-pw")
    pf.set_active(slug)

    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, ProfileUnlockScreen)

        await pilot.press("tab")  # -> "Forgot password?" (the only other focusable widget)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)  # recovery code prompt

        for ch in code:
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)  # new password prompt
        for ch in "brand-new-pw":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)  # confirm prompt
        for ch in "brand-new-pw":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        assert not isinstance(app.screen, (ProfileUnlockScreen, TextPromptScreen)), \
            "a successful reset should unlock straight into the app"
        assert pf.check_password(slug, "brand-new-pw") is True
        assert pf.check_password(slug, "original-pw") is False


async def test_forgot_password_rejects_wrong_recovery_code_immediately(unique_slug):
    """gh51: a wrong recovery code used to only get caught at the very end of this
    flow -- after the user had already typed and confirmed a whole new password --
    which read exactly like the app "let" the change through even though the actual
    reset was always correctly rejected underneath. Fixed by validating the code
    (pf.check_recovery_code) the moment it's entered, so a wrong code never even
    reaches the "New password" prompt."""
    slug, code = pf.create_profile(unique_slug, password="original-pw")
    pf.set_active(slug)

    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert isinstance(app.screen, ProfileUnlockScreen)

        await pilot.press("tab")  # -> "Forgot password?"
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)  # recovery code prompt

        for ch in "totally-wrong-code":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, ProfileUnlockScreen), \
            "a wrong code must reject immediately, never reaching a new-password prompt"
        assert pf.check_password(slug, "original-pw") is True


async def test_manage_profiles_reset_button_says_reset_password(unique_slug):
    """The bare label "Reset" on a protected profile's row read as resetting
    the whole profile back to empty, not resetting its password -- confirms
    the disambiguated label actually ships, not just the docstring saying so."""
    slug, _ = pf.create_profile(unique_slug, password="hunter2")

    app = TodoApp()
    async with app.run_test() as pilot:
        for ch in "hunter2":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        app.action_manage_profiles()
        await pilot.pause()
        reset_btn = next(
            c for row in app.screen.rows.children for c in row.children
            if getattr(c, "profile_slug", None) == slug and getattr(c, "row_action", None) == "reset"
        )
        assert str(reset_btn.label) == "Reset Password"
