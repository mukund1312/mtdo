"""A plain pty-backed terminal for practicing code -- Python, Java, C, C++, or
anything else -- without leaving mtdo. Optional third column in Focus Mode's second
row, alongside the Learning Coach and the AI panel (see app.py's #coach-claude-row);
shown only if the user has turned it on with Shift+T
(config.practice_terminal_enabled() / TodoApp.action_toggle_practice_terminal).

Deliberately just a real shell (the user's own $SHELL, or bash) cd'd into
~/.mtdo/practice/, not a bespoke in-app code editor or a language-specific "run"
button: that's what a terminal already does well -- open vim/nano, write a file, then
`python3 file.py` / `javac X.java && java X` / `gcc -o a file.c && ./a`, whatever's
actually wanted -- and it means zero language-specific tooling to build or maintain,
and the user isn't limited to whatever languages mtdo happened to add support for.

All the pty/pyte machinery (scrollback, resize handling, double-Escape/F2 release,
transcript saving, the pyte parser-bug patch) comes from pty_panel.PtyPanel -- this
module only adds what's actually different: which command to run, where, and what to
show when the pane is empty.
"""
import os

from .pty_panel import PtyPanel

PRACTICE_DIR = os.path.expanduser("~/.mtdo/practice")


class PracticeTerminalPanel(PtyPanel):
    """A pty-backed terminal running a real shell, cwd'd into ~/.mtdo/practice/."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.border_title = "Practice Terminal"
        self.border_subtitle = self._idle_subtitle()

    def _resolve_command(self):
        return os.environ.get("SHELL", "/bin/bash"), None

    def _cwd(self):
        os.makedirs(PRACTICE_DIR, exist_ok=True)
        return PRACTICE_DIR

    def _idle_subtitle(self):
        return "click or T to start"

    def _empty_message(self):
        return (
            "No terminal running.\nClick to start a shell in ~/.mtdo/practice/ --"
            "\nwrite, compile, and run Python/Java/C/C++, or anything else."
        )

    def _ended_message(self):
        return "[shell exited -- click to start a new one]"
