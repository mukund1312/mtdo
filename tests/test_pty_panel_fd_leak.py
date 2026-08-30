"""Regression test for gh65: pty_panel.py's _start_impl() used to leak master_fd if
subprocess.Popen failed to start the resolved command (e.g. it isn't on PATH) --
the failure was already caught and reported to the user by start()'s own try/except,
but the file descriptor itself was never closed on that path.

Confirms the fd is actually closed (not just that start() reports an error) by
spying on os.openpty() to capture the real fd number, then asserting os.fstat() on
it raises OSError afterward -- portable across platforms, unlike /proc/self/fd.
"""
import os

import pytest

from mtdo.app import TodoApp
from mtdo.claude_panel import ClaudePanel
from textual.screen import ModalScreen


async def _dismiss_first_run_prompts(pilot, app):
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


async def test_master_fd_is_closed_when_popen_fails_to_start(monkeypatch):
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        panel = ClaudePanel(command="/definitely/not/a/real/binary-gh65", label="fake")
        await app.mount(panel)

        captured = {}
        real_openpty = os.openpty

        def spy_openpty():
            master_fd, slave_fd = real_openpty()
            captured["master_fd"] = master_fd
            return master_fd, slave_fd

        monkeypatch.setattr(os, "openpty", spy_openpty)

        panel.start()

        assert "master_fd" in captured, "os.openpty() was never called -- test setup is wrong"
        with pytest.raises(OSError):
            os.fstat(captured["master_fd"])
        assert panel._error is not None
