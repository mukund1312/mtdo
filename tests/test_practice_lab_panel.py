"""Tests for PracticeLabPanel's Run/Analyze concurrency guard (gh66).

Regression coverage for a code-audit finding: action_run_code()/action_analyze_
complexity() spawned a new background thread on every invocation with no guard
against a second one firing while the first was still in flight -- both write to
the same PRACTICE_DIR file for that language, so two overlapping runs could
interleave and whichever _show_*_result callback landed last would win, showing
stale/wrong results for a run that wasn't actually the most recent one.

Uses a minimal standalone Textual App (just this one widget) rather than the full
TodoApp -- PracticeLabPanel doesn't need the board/profile/onboarding machinery for
any of what's under test here, and action_run_code/action_analyze_complexity don't
touch self.app except via call_from_thread, which a plain App provides too.
"""
import time

from textual.app import App, ComposeResult

from mtdo import code_runner
from mtdo import ai_ask
from mtdo.practice_lab_panel import PracticeLabPanel


class _PracticeLabTestApp(App):
    def compose(self) -> ComposeResult:
        self.panel = PracticeLabPanel()
        yield self.panel


async def test_double_run_does_not_start_a_second_worker_while_first_in_flight(monkeypatch):
    calls = []

    def slow_run(language, code, timeout=10):
        calls.append(1)
        time.sleep(0.3)
        return code_runner.RunResult(ok=True, output="hi", elapsed=0.3)

    monkeypatch.setattr(code_runner, "run", slow_run)

    app = _PracticeLabTestApp()
    async with app.run_test() as pilot:
        panel = app.panel
        panel.action_run_code()
        await pilot.pause()
        assert panel._run_busy is True
        assert len(calls) == 1

        # a second invocation while the first is still running must be a no-op --
        # no second background thread, no second call into code_runner.run
        panel.action_run_code()
        await pilot.pause()
        assert len(calls) == 1

        for _ in range(20):
            await pilot.pause()
            time.sleep(0.05)
            if not panel._run_busy:
                break

        assert panel._run_busy is False
        assert len(calls) == 1, "the suppressed second call must never have started a worker"


async def test_run_is_available_again_after_the_first_one_completes(monkeypatch):
    calls = []

    def fast_run(language, code, timeout=10):
        calls.append(1)
        return code_runner.RunResult(ok=True, output="hi", elapsed=0.01)

    monkeypatch.setattr(code_runner, "run", fast_run)

    app = _PracticeLabTestApp()
    async with app.run_test() as pilot:
        panel = app.panel
        panel.action_run_code()
        for _ in range(20):
            await pilot.pause()
            time.sleep(0.02)
            if not panel._run_busy:
                break
        assert len(calls) == 1

        panel.action_run_code()
        for _ in range(20):
            await pilot.pause()
            time.sleep(0.02)
            if not panel._run_busy:
                break
        assert len(calls) == 2, "the guard must not stay stuck locked after a run finishes"


async def test_run_error_path_also_clears_the_busy_flag(monkeypatch):
    def failing_run(language, code, timeout=10):
        raise RuntimeError("boom")

    monkeypatch.setattr(code_runner, "run", failing_run)

    app = _PracticeLabTestApp()
    async with app.run_test() as pilot:
        panel = app.panel
        panel.action_run_code()
        for _ in range(20):
            await pilot.pause()
            time.sleep(0.02)
            if not panel._run_busy:
                break
        assert panel._run_busy is False


async def test_double_analyze_does_not_start_a_second_worker_while_first_in_flight(monkeypatch):
    calls = []

    def slow_ask(prompt, timeout=60):
        calls.append(1)
        time.sleep(0.3)
        return "===TIME===\nBig-O: O(n)\nlinear\n\n===SPACE===\nBig-O: O(1)\nconstant\n\n", None

    monkeypatch.setattr(ai_ask, "ask", slow_ask)

    app = _PracticeLabTestApp()
    async with app.run_test() as pilot:
        panel = app.panel
        panel.editor.text = "print('hi')"
        panel.action_analyze_complexity()
        await pilot.pause()
        assert panel._analyze_busy is True
        assert len(calls) == 1

        panel.action_analyze_complexity()
        await pilot.pause()
        assert len(calls) == 1

        for _ in range(20):
            await pilot.pause()
            time.sleep(0.05)
            if not panel._analyze_busy:
                break

        assert panel._analyze_busy is False
        assert len(calls) == 1


async def test_analyze_on_empty_code_never_sets_busy_or_spawns_a_worker(monkeypatch):
    """The empty-code guard returns before spawning a thread at all -- it must not
    leave _analyze_busy stuck True with nothing ever going to clear it."""
    calls = []
    monkeypatch.setattr(ai_ask, "ask", lambda prompt, timeout=60: calls.append(1))

    app = _PracticeLabTestApp()
    async with app.run_test() as pilot:
        panel = app.panel
        panel.editor.text = "   "
        panel.action_analyze_complexity()
        await pilot.pause()
        assert panel._analyze_busy is False
        assert calls == []


async def test_run_and_analyze_guards_are_independent(monkeypatch):
    """Run and Analyze don't share a file (code_runner.run vs ai_ask.ask/explain_sql),
    so one being in flight must not block the other."""
    run_calls = []
    analyze_calls = []

    def slow_run(language, code, timeout=10):
        run_calls.append(1)
        time.sleep(0.3)
        return code_runner.RunResult(ok=True, output="hi", elapsed=0.3)

    def fast_ask(prompt, timeout=60):
        analyze_calls.append(1)
        return "===TIME===\nBig-O: O(n)\nlinear\n\n===SPACE===\nBig-O: O(1)\nconstant\n\n", None

    monkeypatch.setattr(code_runner, "run", slow_run)
    monkeypatch.setattr(ai_ask, "ask", fast_ask)

    app = _PracticeLabTestApp()
    async with app.run_test() as pilot:
        panel = app.panel
        panel.action_run_code()
        await pilot.pause()
        assert panel._run_busy is True

        panel.action_analyze_complexity()
        for _ in range(20):
            await pilot.pause()
            time.sleep(0.02)
            if not panel._analyze_busy:
                break

        assert len(analyze_calls) == 1, "Analyze must not be blocked by an in-flight Run"
        assert panel._run_busy is True, "Run should still be in flight (0.3s sleep)"

        # let the slow run finish before the test (and its App) tears down --
        # otherwise its worker thread outlives run_test()'s context and its
        # call_from_thread call fails with NoActiveAppError once torn down.
        for _ in range(20):
            await pilot.pause()
            time.sleep(0.05)
            if not panel._run_busy:
                break
