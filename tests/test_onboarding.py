"""Regression tests for gh28: the walkthrough, the automatic profile step, and the
"how do you want to build your plan" choice used to be three separate modals with no
shared sense of overall progress, each landing as an unrelated interruption. These
confirm the "Setup N of M" indicator threads correctly through every real entry point
into that sequence -- the first-run trigger (walkthrough included, 3 steps), a manual
re-run via 'g' (no walkthrough, 2 steps), and a standalone walkthrough replay via 'w'
(not part of any larger sequence, no label at all) -- since getting the step count
wrong on any one of these would be a worse regression than not having the indicator
at all.
"""
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


async def test_first_run_sequence_labels_all_three_steps_correctly(unique_slug):
    """A genuine first run: walkthrough -> profile -> populate-method, 1/3 -> 2/3 -> 3/3.

    conftest.py pre-creates the "onboarded" marker once, for the whole shared
    test session, precisely so every *other* test doesn't hit this walkthrough
    -- this is the one test that actually needs a genuine first run, so it has
    to remove that marker itself and restore it afterward, or every test that
    runs later in the same session would unexpectedly start hitting the
    walkthrough too."""
    import os
    from mtdo import config as appconfig

    had_onboarded = os.path.exists(appconfig.ONBOARDED_PATH)
    if had_onboarded:
        os.remove(appconfig.ONBOARDED_PATH)
    try:
        app = TodoApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            assert isinstance(app.screen, OnboardingScreen)
            assert app.screen.step_label == "Setup 1 of 3"

            await pilot.press("escape")
            await pilot.pause()
            assert isinstance(app.screen, ProfileCreateScreen)
            assert app.screen.step_label == "Setup 2 of 3"

            for ch in unique_slug:
                await pilot.press(ch)
            await pilot.press("tab")
            await pilot.press("tab")
            await pilot.press("enter")
            await pilot.pause()

            assert isinstance(app.screen, ChoicePickScreen)
            assert app.screen.step_label == "Setup 3 of 3"
    finally:
        if had_onboarded:
            appconfig.mark_onboarded()


async def test_manual_replan_via_g_skips_the_walkthrough_and_labels_as_two_steps(unique_slug):
    """'g' (action_plan_wizard) re-runs just the profile + populate-method pair,
    never the walkthrough -- must read as 1 of 2 / 2 of 2, not carry over the
    first-run sequence's "of 3"."""
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
