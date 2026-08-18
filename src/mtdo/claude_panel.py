"""Embeds a live AI assistant session directly inside mtdo's Focus Mode, in the right
half of the row that opens up once the kanban board and stats/calendar panels are
hidden (the Learning Coach and, optionally, a practice terminal share that row too --
see app.py's #coach-claude-row). Runs the assistant in a real pty and uses pyte to
turn its raw output into a screen buffer, via the generic machinery in pty_panel.py
(also used by practice_terminal.py) -- this module only adds what's actually
AI-specific: which backend to run and what the pane looks like when it's empty.

Which assistant actually runs is decided by ai_backend.detect() on every start()
(or pinned explicitly via start_with(), which is what the backend-picker modal calls):
the `claude` CLI if it's installed, else a local Ollama model, else a minimal
API-key chat (web_chat.py), else a message explaining what to set up. The point is
that not having Claude Code installed should never force the user out of the
terminal to get help.

Lifecycle: the process is started lazily on first "C" (see TodoApp.action_toggle_claude),
persists across focus-mode toggles so you don't lose your session, and is torn down on
unmount/app exit. While the panel has keyboard focus every key is forwarded to the pty
(so `q`, `f`, etc. reach claude instead of mtdo's own bindings) -- except double-tap
Escape or F2, which release focus back to mtdo (see pty_panel.py for exactly why
those two and not, say, Ctrl+Q).
"""
from . import ai_backend
from .pty_panel import PtyPanel


class ClaudePanel(PtyPanel):
    """A pty-backed terminal widget that runs the chosen AI backend and renders its
    screen live."""

    def __init__(self, command=None, label=None, **kwargs):
        """command=None (the default) means auto-detect a backend fresh on every
        start() via ai_backend.detect() -- Claude Code, else a local Ollama model, else
        an API-key-based chat, else a message explaining what to set up. Pass an
        explicit command (and its display label) to pin one backend instead --
        see start_with(), which is what the backend-picker modal calls."""
        super().__init__(**kwargs)
        self.command = command
        self._chosen_label = label
        self.border_title = "Claude Code"
        self.border_subtitle = self._idle_subtitle()

    def start_with(self, command, label):
        """Pins the backend to run next, then starts it -- used by the backend-picker
        modal so the user's explicit choice is honored instead of auto-detection."""
        self.command = command
        self._chosen_label = label
        self.start()

    def _resolve_command(self):
        if self.command is not None:
            return self.command, self._chosen_label
        return ai_backend.detect()

    def _idle_subtitle(self):
        return "C to choose a backend"

    def _empty_message(self):
        return "No Claude Code session yet.\nPress C to start one here."

    def _ended_message(self):
        return "[session ended -- press C to start a new one]"

    def _on_empty_click(self):
        self.app.action_toggle_claude()
