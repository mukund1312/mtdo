"""Embeds a live `claude` (Claude Code CLI) session directly inside mtdo's Focus Mode,
in the space that opens up in the bottom-right column once the kanban board and
stats/calendar panels are hidden. Runs `claude` in a real pty (so it behaves exactly
like it does in a normal terminal -- colors, its own TUI, everything) and uses pyte to
turn the pty's raw output into a screen buffer this widget renders each frame. Built by
hand rather than pulling in the `textual-terminal` package because that package's
internals only work against Textual ~0.70 and break on the current Textual (8.x) that
the rest of this app already relies on.

Lifecycle: the process is started lazily on first "C" (see TodoApp.action_toggle_claude),
persists across focus-mode toggles so you don't lose your session, and is torn down on
unmount/app exit. While the panel has keyboard focus every key is forwarded to the pty
(so `q`, `f`, etc. reach claude instead of mtdo's own bindings) except F2, which always
releases focus back to mtdo.
"""
import fcntl
import os
import pty
import shlex
import signal
import struct
import termios
import threading

import pyte
from rich.style import Style
from rich.text import Text
from textual import events
from textual.widget import Widget

_NAMED_COLORS = {
    "black": "black", "red": "red", "green": "green", "brown": "yellow",
    "blue": "blue", "magenta": "magenta", "cyan": "cyan", "white": "white",
    "brightblack": "bright_black", "brightred": "bright_red", "brightgreen": "bright_green",
    "brightbrown": "bright_yellow", "brightblue": "bright_blue", "brightmagenta": "bright_magenta",
    "brightcyan": "bright_cyan", "brightwhite": "bright_white",
}

_SPECIAL_KEY_BYTES = {
    "enter": b"\r", "escape": b"\x1b", "tab": b"\t", "shift+tab": b"\x1b[Z",
    "backspace": b"\x7f", "delete": b"\x1b[3~",
    "up": b"\x1b[A", "down": b"\x1b[B", "right": b"\x1b[C", "left": b"\x1b[D",
    "home": b"\x1b[H", "end": b"\x1b[F",
    "pageup": b"\x1b[5~", "pagedown": b"\x1b[6~", "insert": b"\x1b[2~",
    "f1": b"\x1bOP", "f3": b"\x1b[13~", "f4": b"\x1b[14~", "f5": b"\x1b[15~",
    "f6": b"\x1b[17~", "f7": b"\x1b[18~", "f8": b"\x1b[19~",
    "f9": b"\x1b[20~", "f10": b"\x1b[21~", "f11": b"\x1b[23~", "f12": b"\x1b[24~",
}


def _rich_color(name):
    if not name or name == "default":
        return None
    if len(name) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in name):
        return f"#{name}"
    return _NAMED_COLORS.get(name, name)


def _char_style(char, cursor_here):
    reverse = char.reverse != cursor_here  # cursor cell is drawn reversed too
    fg, bg = _rich_color(char.fg), _rich_color(char.bg)
    if reverse:
        fg, bg = bg, fg
    return Style(
        color=fg, bgcolor=bg, bold=char.bold, italic=char.italics,
        underline=char.underscore, strike=char.strikethrough,
    )


class ClaudePanel(Widget):
    """A pty-backed terminal widget that runs `claude` and renders its screen live."""

    can_focus = True

    DEFAULT_CSS = """
    ClaudePanel {
        height: 1fr;
        border: round grey;
        background: $surface;
    }
    ClaudePanel:focus {
        border: round green;
    }
    """

    def __init__(self, command="claude", **kwargs):
        super().__init__(**kwargs)
        self.command = command
        self._master_fd = None
        self._pid = None
        self._screen = None
        self._stream = None
        self._pty_running = False
        self._ended = False
        self.border_title = "Claude Code"
        self.border_subtitle = "C to start · F2 to leave"

    # -- process lifecycle -------------------------------------------------

    def start(self):
        """Spawns `claude` in a fresh pty sized to the widget's current content area.
        No-op if a session is already running."""
        if self._pty_running:
            return
        cols, rows = self._pty_size()
        self._screen = pyte.Screen(cols, rows)
        self._stream = pyte.ByteStream(self._screen)
        self._ended = False
        pid, master_fd = pty.fork()
        if pid == 0:
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            try:
                os.execvpe(shlex.split(self.command)[0], shlex.split(self.command), env)
            finally:
                os._exit(1)  # exec failed -- never fall back into the parent's code
        self._pid = pid
        self._master_fd = master_fd
        self._set_pty_size(cols, rows)
        self._pty_running = True
        threading.Thread(target=self._read_loop, daemon=True).start()
        self.refresh()

    def stop(self):
        self._pty_running = False
        if self._pid is not None:
            try:
                os.killpg(os.getpgid(self._pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            self._pid = None
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None

    def on_unmount(self):
        self.stop()

    # -- pty plumbing --------------------------------------------------------

    def _pty_size(self):
        w, h = self.content_size
        return max(w, 10), max(h, 4)

    def _set_pty_size(self, cols, rows):
        if self._master_fd is None:
            return
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    def _read_loop(self):
        while self._pty_running:
            try:
                data = os.read(self._master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            self._stream.feed(data)
            try:
                self.app.call_from_thread(self.refresh)
            except Exception:
                break
        self._pty_running = False
        self._ended = True
        try:
            self.app.call_from_thread(self.refresh)
        except Exception:
            pass

    def on_resize(self, event: events.Resize) -> None:
        if self._screen is None:
            return
        cols, rows = self._pty_size()
        self._screen.resize(rows, cols)
        self._set_pty_size(cols, rows)

    # -- input ----------------------------------------------------------------

    def on_key(self, event: events.Key) -> None:
        if event.key == "f2":
            self.blur()
            event.stop()
            return
        event.stop()
        if not self._pty_running or self._master_fd is None:
            return
        data = self._encode_key(event)
        if data:
            try:
                os.write(self._master_fd, data)
            except OSError:
                pass

    def _encode_key(self, event: events.Key):
        if event.key in _SPECIAL_KEY_BYTES:
            return _SPECIAL_KEY_BYTES[event.key]
        if event.key.startswith("ctrl+") and len(event.key) == 6 and event.key[5].isalpha():
            return bytes([ord(event.key[5].lower()) - ord("a") + 1])
        if event.character and event.character.isprintable():
            return event.character.encode("utf-8")
        return None

    # -- rendering --------------------------------------------------------------

    def render(self):
        if self._screen is None:
            return Text(
                "No Claude Code session yet.\nPress C to start one here.",
                style="dim italic", justify="center",
            )
        cursor = self._screen.cursor
        show_cursor = self.has_focus and not cursor.hidden
        out = Text()
        for y in range(self._screen.lines):
            if y:
                out.append("\n")
            row = self._screen.buffer[y]
            run_text, run_style = "", None
            for x in range(self._screen.columns):
                char = row[x]
                style = _char_style(char, show_cursor and y == cursor.y and x == cursor.x)
                if style == run_style:
                    run_text += char.data
                else:
                    if run_text:
                        out.append(run_text, style=run_style)
                    run_text, run_style = char.data, style
            if run_text:
                out.append(run_text, style=run_style)
        if self._ended:
            out.append("\n\n[session ended -- press C to start a new one]", style="dim italic yellow")
        return out
