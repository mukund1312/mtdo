"""Regression tests for gh63: in-flight AI-generated DSA/coaching content must not
be silently lost (and wastefully re-billed) if the user switches profiles while a
background generation is still running.

Rather than racing real threads/timing (flaky by nature -- a real generation can
take up to 90s), these call the panel's own result-storing methods directly with a
controlled `epoch`, exactly as a background worker would after `ai_ask.ask()`
returns -- deterministic and fast, and exercises the exact guard the fix added.
"""
import os

import pytest

from mtdo import config as appconfig
from mtdo.app import LearningCoachPanel, TodoApp
from textual.screen import ModalScreen


@pytest.fixture(autouse=True)
def _clean_analytics_decision():
    """analytics.json's `decided_at` is set once, session-wide, the first time
    ANY test's TodoApp fully dismisses the first-run onboarding chain (it
    includes the one-time analytics opt-in step) -- not scoped per-profile like
    most of this suite's own data (see conftest.py). test_onboarding.py has its
    own tests that specifically assert analytics hasn't been decided yet this
    session, so this file (whose tests also run a real TodoApp through the full
    dismiss chain) must not leave that flag set behind for a test collected
    after it to trip over -- confirmed removing this fixture makes exactly that
    happen (test_onboarding.py fails only when this file runs before it)."""
    def _remove():
        if os.path.exists(appconfig.ANALYTICS_SETTINGS_PATH):
            os.remove(appconfig.ANALYTICS_SETTINGS_PATH)
    _remove()
    yield
    _remove()


async def _dismiss_first_run_prompts(pilot, app):
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


async def test_store_generated_applies_when_epoch_still_matches():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        panel = LearningCoachPanel()
        await app.mount(panel)

        block = {"text": "Two Sum"}
        panel._store_generated(block, "PROBLEM: do the thing\nHINT: think arrays", None, app._profile_epoch)

        assert "dsa_problem" in block
        assert block["dsa_problem"]["statement"]


async def test_store_generated_drops_result_from_a_stale_epoch():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        panel = LearningCoachPanel()
        await app.mount(panel)

        block = {"text": "Two Sum"}
        stale_epoch = app._profile_epoch
        app._profile_epoch += 1  # simulates a profile switch while generation was in flight

        panel._store_generated(block, "PROBLEM: do the thing\nHINT: think arrays", None, stale_epoch)

        assert "dsa_problem" not in block


async def test_store_generated_coaching_applies_when_epoch_still_matches():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        panel = LearningCoachPanel()
        await app.mount(panel)

        block = {"text": "Set up a database"}
        panel._store_generated_coaching(
            block, "===FOCUS_ON===\n- indexing\n===ASK_YOURSELF===\n- what queries run most?",
            None, app._profile_epoch,
        )

        assert block["ai_coaching"] is not False
        assert block["ai_coaching"] is not None


async def test_store_generated_coaching_drops_result_from_a_stale_epoch():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        panel = LearningCoachPanel()
        await app.mount(panel)

        block = {"text": "Set up a database"}
        stale_epoch = app._profile_epoch
        app._profile_epoch += 1

        panel._store_generated_coaching(
            block, "FOCUS ON:\n- indexing\nASK YOURSELF:\n- what queries run most?",
            None, stale_epoch,
        )

        assert "ai_coaching" not in block


async def test_switching_profiles_bumps_the_epoch():
    """The guard is only meaningful if a real profile switch actually advances the
    epoch -- confirm _switch_profile does that, not just that the field exists.
    Explicitly switches into a first profile before the one under test, so this
    doesn't depend on whatever active-profile state earlier tests in the shared
    session left behind (switching FROM None doesn't count as switching_profile)."""
    from mtdo import profiles as pf

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        slug_a, _ = pf.create_profile("gh63_epoch_test_a")
        app._switch_profile(slug_a)
        await pilot.pause()
        before = app._profile_epoch

        slug_b, _ = pf.create_profile("gh63_epoch_test_b")
        app._switch_profile(slug_b)
        await pilot.pause()

        assert app._profile_epoch == before + 1
