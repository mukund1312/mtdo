"""Regression tests for gh28: the walkthrough, the automatic profile step, and the
"how do you want to build your plan" choice used to be three separate modals with no
shared sense of overall progress, each landing as an unrelated interruption. These
confirm the "Setup N of M" indicator threads correctly through every real entry point
into that sequence -- the first-run trigger (walkthrough included, 4 steps: also
covers the analytics opt-in step added afterward), a manual re-run via 'g' (no
walkthrough, 3 steps), and a standalone walkthrough replay via 'w' (not part of any
larger sequence, no label at all) -- since getting the step count wrong on any one of
these would be a worse regression than not having the indicator at all.

The analytics opt-in step (see app.py's _prompt_analytics_optin/_setup_sequence_length)
only counts toward the total while it hasn't been answered yet -- once a test (or a
real user) has gone through it once, decided_at is set and every later run of this
same sequence in the same MTDO_HOME correctly drops back to a 2/3-step total instead
of counting a step that will silently be skipped. Tests below account for that by
checking the analytics settings' decided_at state, not by hardcoding which run "should"
include it.
"""
from mtdo import config as appconfig
from mtdo import profiles as pf
from mtdo.app import (
    ChoicePickScreen,
    OnboardingScreen,
    ProfileCreateScreen,
    ProfileMenuScreen,
    TodoApp,
)
from textual.screen import ModalScreen


async def _dismiss_first_run_prompts(pilot, app):
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


async def test_first_run_sequence_labels_all_four_steps_correctly(unique_slug):
    """A genuine first run: walkthrough -> profile -> populate-method -> analytics
    opt-in, 1/4 -> 2/4 -> 3/4 -> 4/4.

    conftest.py pre-creates the "onboarded" marker once, for the whole shared
    test session, precisely so every *other* test doesn't hit this walkthrough
    -- this is the one test that actually needs a genuine first run, so it has
    to remove that marker itself and restore it afterward, or every test that
    runs later in the same session would unexpectedly start hitting the
    walkthrough too.

    Deliberately never answers the final analytics-opt-in screen (only asserts
    its label) -- that leaves analytics settings' decided_at unset afterward, so
    test_manual_replan_via_g_skips_the_walkthrough_and_labels_as_two_steps below
    is the one that actually answers it (via its own _dismiss_first_run_prompts
    sweep) and observes _setup_sequence_length() correctly drop back to 2 steps
    on its subsequent explicit re-run."""
    import os

    had_onboarded = os.path.exists(appconfig.ONBOARDED_PATH)
    if had_onboarded:
        os.remove(appconfig.ONBOARDED_PATH)
    assert appconfig.load_analytics_settings()["decided_at"] is None, (
        "this test assumes analytics hasn't been decided yet this session -- "
        "if it has, the real sequence would only be 3 steps, not 4"
    )
    try:
        app = TodoApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            assert isinstance(app.screen, OnboardingScreen)
            assert app.screen.step_label == "Setup 1 of 4"

            await pilot.press("escape")
            await pilot.pause()
            assert isinstance(app.screen, ProfileCreateScreen)
            assert app.screen.step_label == "Setup 2 of 4"

            for ch in unique_slug:
                await pilot.press(ch)
            await pilot.press("tab")
            await pilot.press("tab")
            await pilot.press("enter")
            await pilot.pause()

            assert isinstance(app.screen, ChoicePickScreen)
            assert app.screen.step_label == "Setup 3 of 4"

            await pilot.press("escape")
            await pilot.pause()
            assert isinstance(app.screen, ChoicePickScreen)
            assert app.screen.step_label == "Setup 4 of 4"
    finally:
        if had_onboarded:
            appconfig.mark_onboarded()


async def test_manual_replan_via_g_skips_the_walkthrough_and_labels_as_two_steps(unique_slug):
    """'g' (action_plan_wizard) re-runs just the profile + populate-method pair,
    never the walkthrough -- must read as 1 of 2 / 2 of 2, not carry over the
    first-run sequence's "of 3" (or "of 4" -- see module docstring).

    Reads as 2 steps rather than 3 here specifically because _dismiss_first_run_prompts
    below already answers the analytics opt-in once, earlier in this same test, as
    part of dismissing this app instance's own automatic first-run sequence --
    _setup_sequence_length() sees decided_at already set by the time action_plan_wizard()
    explicitly re-runs the sequence, and correctly stops counting that step."""
    slug, _ = pf.create_profile(unique_slug)
    pf.set_active(slug)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        app.action_plan_wizard()
        await pilot.pause()
        assert isinstance(app.screen, ProfileMenuScreen)
        assert app.screen.step_label == "Setup 1 of 2"

        await pilot.press("escape")
        await pilot.pause()
        assert isinstance(app.screen, ChoicePickScreen)
        assert app.screen.step_label == "Setup 2 of 2"


async def test_standalone_walkthrough_replay_has_no_step_label(unique_slug):
    """'w' (action_replay_walkthrough) is just the tour on its own, not part of a
    larger sequence -- must not show "Setup 1 of anything"."""
    slug, _ = pf.create_profile(unique_slug)
    pf.set_active(slug)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        app.action_replay_walkthrough()
        await pilot.pause()
        assert isinstance(app.screen, OnboardingScreen)
        assert app.screen.step_label is None
