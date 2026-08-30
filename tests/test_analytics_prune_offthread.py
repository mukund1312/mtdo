"""Regression test for gh71: _finish_startup() must not block the main/event-loop
thread on analytics.prune_older_than() (a DELETE + VACUUM against events.db,
which rebuilds the whole file and scales with its size).

Confirmed by recording every threading.Thread(...) construction app.py makes
during the app's own real (single) startup sequence, and checking one of them
targets analytics.prune_older_than with the right kwargs -- rather than calling
_finish_startup() a second time by hand, which turned out to be unsafe (it
re-triggers profile-bootstrap modal logic that assumes it only ever runs once,
crashing on an unrelated NoMatches error).

Dismissing the first-run chain below (as with any test that does this -- see
tests/test_profile_switch_generation_epoch.py's own docstring for the gh63
incident) can complete the one-time analytics opt-in step, which
test_onboarding.py's tests assert hasn't happened yet this session. This file
sorts before test_onboarding.py alphabetically, so the cleanup fixture below
is required, not optional -- confirmed by removing it and re-running the full
suite: test_onboarding.py fails without it."""
import os
import threading

import pytest

from mtdo import analytics
from mtdo import config as appconfig
from mtdo.app import TodoApp
from textual.screen import ModalScreen


@pytest.fixture(autouse=True)
def _clean_analytics_decision():
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


async def test_finish_startup_prunes_analytics_off_the_main_thread(monkeypatch):
    recorded = []
    real_thread_cls = threading.Thread

    class RecordingThread(real_thread_cls):
        def __init__(self, *args, target=None, kwargs=None, **rest):
            if target is analytics.prune_older_than:
                recorded.append(kwargs or {})
            super().__init__(*args, target=target, kwargs=kwargs, **rest)

    monkeypatch.setattr("mtdo.app.threading.Thread", RecordingThread)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.pause()

    assert len(recorded) == 1, "expected exactly one background thread targeting prune_older_than"
    assert recorded[0] == {"days": 180}
