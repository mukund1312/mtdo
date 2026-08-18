"""Embeds a live AI assistant session directly inside mtdo's Focus Mode, in the right
half of the row that opens up once the kanban board and stats/calendar panels are
hidden (the left half is the Learning Coach). Runs the assistant in a real pty and
uses pyte to turn its raw output into a screen buffer this widget renders each frame.
Built by hand rather than pulling in the `textual-terminal` package because that
package's internals only work against Textual ~0.70 and break on the current Textual
(8.x) that the rest of this app already relies on.

Which assistant actually runs is decided by ai_backend.detect() on every start(): the
`claude` CLI if it's installed, else a local Ollama model if one's pulled, else a
minimal API-key chat (web_chat.py) if ANTHROPIC_API_KEY/OPENAI_API_KEY is set, else a
message explaining what to set up. The point is that not having Claude Code installed
should never force the user out of the terminal to get help.

Spawns the child via os.openpty() + subprocess.Popen (with preexec_fn=os.setsid),
*not* pty.fork()/os.fork(). Textual runs its own background input-reader thread, so
this process is multithreaded by the time a session starts -- raw fork() of a
multithreaded process is a well-known source of intermittent deadlocks/crashes on
macOS (only the calling thread survives into the child; locks held by other threads at
fork time stay locked forever). subprocess.Popen's C-level fork+exec path is written to
be async-signal-safe between fork and exec and avoids that hazard entirely.

Every method that touches the pty, the subprocess, or pyte's parser is wrapped so a
failure can't crash the whole mtdo app: it's logged to ~/.mtdo/error.log (see
errorlog.py) and surfaced as a short message in the pane instead.

Lifecycle: the process is started lazily on first "C" (see TodoApp.action_toggle_claude),
persists across focus-mode toggles so you don't lose your session, and is torn down on
unmount/app exit. While the panel has keyboard focus every key is forwarded to the pty
(so `q`, `f`, etc. reach claude instead of mtdo's own bindings) -- except double-tap
Escape (press Escape twice within ~0.6s), which always releases focus back to mtdo. A
single Escape still forwards to claude normally (it's claude's own cancel key). Two
keys were tried and rejected for this: F2 doesn't reach the terminal on most laptop
keyboards unless Fn is held (the top row defaults to media keys), and Ctrl+Q turned out
to be a Textual built-in *priority* binding for "quit the whole app" -- priority
bindings intercept before a focused widget's on_key ever runs, so it silently killed
mtdo instead of releasing focus. F2 is still accepted too, for anyone on a keyboard
that does send real F-keys.
"""
import fcntl
import os
import shlex
import signal
import struct
import subprocess
import termios
import threading
import time

import pyte
from rich.style import Style
from rich.text import Text
from textual import events
from textual.widget import Widget

from . import ai_backend
from .errorlog import LOG_PATH, log

_NAMED_COLORS = {
    "black": "black", "red": "red", "green": "green", "brown": "yellow",
    "blue": "blue", "magenta": "magenta", "cyan": "cyan", "white": "white",
    "brightblack": "bright_black", "brightred": "bright_red", "brightgreen": "bright_green",
    "brightbrown": "bright_yellow", "brightblue": "bright_blue", "brightmagenta": "bright_magenta",
    "brightcyan": "bright_cyan", "brightwhite": "bright_white",
}

_SPECIAL_KEY_BYTES = {
    "enter": b"\r", "escape": b"\x1b", "tab": b"\t", "shift+tab": b"\x1b[Z",
    "backspace": b"\x7f", "delete": b"\x1b[3~", "space": b" ",
    "up": b"\x1b[A", "down": b"\x1b[B", "right": b"\x1b[C", "left": b"\x1b[D",
    "home": b"\x1b[H", "end": b"\x1b[F",
    "pageup": b"\x1b[5~", "pagedown": b"\x1b[6~", "insert": b"\x1b[2~",
    "f1": b"\x1bOP", "f3": b"\x1b[13~", "f4": b"\x1b[14~", "f5": b"\x1b[15~",
    "f6": b"\x1b[17~", "f7": b"\x1b[18~", "f8": b"\x1b[19~",
    "f9": b"\x1b[20~", "f10": b"\x1b[21~", "f11": b"\x1b[23~", "f12": b"\x1b[24~",
}

_RELEASE_KEYS = {"f2"}
_DOUBLE_ESCAPE_WINDOW = 0.6  # seconds


_SCROLLBACK_LINES = 2000


class _PatchedScreen(pyte.HistoryScreen):
    """pyte.HistoryScreen instead of plain pyte.Screen for scrollback (prev_page() /
    next_page(), wired to the mouse wheel below) -- they mutate self.buffer in place,
    so the existing per-cell render loop needs no changes to show scrolled content.
    Also two fixes over stock pyte 0.8.2:

    1. Screen.report_device_status() doesn't accept the `private` kwarg that
       streams.py always passes for DEC-private CSI sequences (e.g. `CSI ? 6 n`).
       Any app that sends one throws mid-parse, and _read_loop_impl's per-chunk
       try/except then silently drops the *rest* of that read() chunk -- not a rare
       edge case, claude's Ink-based UI sends these routinely, so a session could
       look like it "just stops updating" for no visible reason.
    2. write_process_input() is pyte's hook for terminal -> app replies (device
       status / cursor position reports) but does nothing by default. Wired here to
       actually write back into the pty, like a real terminal would, in case
       anything running in the pane blocks waiting on one.
    """

    def __init__(self, *args, on_reply=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._on_reply = on_reply

    def report_device_status(self, mode, **kwargs):
        try:
            super().report_device_status(mode)
        except Exception:
            pass

    def write_process_input(self, data):
        if self._on_reply:
            self._on_reply(data)


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

    def __init__(self, command=None, label=None, **kwargs):
        """command=None (the default) means auto-detect a backend fresh on every
        start() via ai_backend.detect() -- Claude Code, else a local Ollama model, else
        an API-key-based chat, else a message explaining what to set up. Pass an
        explicit command (and its display label) to pin one backend instead --
        see start_with(), which is what the backend-picker modal calls."""
        super().__init__(**kwargs)
        self.command = command
        self._chosen_label = label
        self._master_fd = None
        self._pid = None
        self._proc = None
        self._screen = None
        self._stream = None
        self._pty_running = False
        self._ended = False
        self._error = None
        self._last_escape_at = 0.0
        self.border_title = "Claude Code"
        self.border_subtitle = "C to choose a backend"

    @property
    def is_running(self):
        return self._pty_running

    # -- process lifecycle -------------------------------------------------

    def start_with(self, command, label):
        """Pins the backend to run next, then starts it -- used by the backend-picker
        modal so the user's explicit choice is honored instead of auto-detection."""
        self.command = command
        self._chosen_label = label
        self.start()

    def start(self):
        """Spawns the assistant in a fresh pty sized to the widget's current content
        area. No-op if a session is already running."""
        if self._pty_running:
            return
        try:
            self._start_impl()
        except Exception:
            log.exception("ClaudePanel.start failed")
            self._error = f"Couldn't start the AI panel -- see {LOG_PATH}"
            self._ended = True
            self._pty_running = False
            self.refresh()

    def _start_impl(self):
        if self.command is not None:
            command, label = self.command, self._chosen_label
        else:
            command, label = ai_backend.detect()
        if command is None:
            self._error = label  # detect() returns the explanation as the label slot
            self._ended = True
            self.refresh()
            return

        cols, rows = self._pty_size()
        self._screen = _PatchedScreen(cols, rows, history=_SCROLLBACK_LINES, on_reply=self._write_reply)
        self._stream = pyte.ByteStream(self._screen)
        self._ended = False
        self._error = None
        master_fd, slave_fd = os.openpty()
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        try:
            proc = subprocess.Popen(
                shlex.split(command),
                stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                preexec_fn=os.setsid,
                env=env,
                close_fds=True,
            )
        finally:
            os.close(slave_fd)
        self._proc = proc
        self._pid = proc.pid
        self._master_fd = master_fd
        self._pty_running = True
        self.border_title = label or "Claude Code"
        self.border_subtitle = "Esc Esc (or F2) to leave"
        threading.Thread(target=self._read_loop, daemon=True).start()
        self.refresh()

    def stop(self):
        try:
            self._stop_impl()
        except Exception:
            log.exception("ClaudePanel.stop failed")

    def _stop_impl(self):
        self._pty_running = False
        self.border_subtitle = "C to choose a backend"
        if self._pid is not None:
            try:
                os.killpg(os.getpgid(self._pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            self._pid = None
        self._proc = None
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

    def _write_reply(self, data):
        if self._master_fd is None:
            return
        try:
            os.write(self._master_fd, data.encode())
        except OSError:
            pass

    def _read_loop(self):
        try:
            self._read_loop_impl()
        except Exception:
            log.exception("ClaudePanel reader thread crashed")
        self._pty_running = False
        self._ended = True
        try:
            self.app.call_from_thread(self._mark_ended)
        except Exception:
            pass

    def _mark_ended(self):
        self.border_subtitle = "C to choose a backend"
        self.refresh()

    def _read_loop_impl(self):
        while self._pty_running:
            try:
                data = os.read(self._master_fd, 4096)
            except OSError as e:
                log.info("ClaudePanel read loop ending: %s", e)
                break
            if not data:
                exit_code = self._proc.poll() if self._proc else None
                log.info("ClaudePanel read loop got EOF, subprocess exit code: %s", exit_code)
                break
            try:
                self._stream.feed(data)
            except Exception:
                log.exception("pyte failed to parse %d bytes of claude output -- skipping", len(data))
                continue
            self.app.call_from_thread(self.refresh)

    def on_resize(self, event: events.Resize) -> None:
        # Hiding the pane (leaving Focus Mode) still fires a resize down to a
        # degenerate content_size (0, 0) -- forwarding that to the real pty as a
        # winsize change reliably makes claude's own UI exit outright. There's also
        # nothing to redraw for an invisible pane, so skip entirely while hidden.
        if self._screen is None or not self.display:
            return
        self._sync_pty_size()

    def on_show(self) -> None:
        # The pane's on-screen dimensions can drift while hidden (other panels
        # resizing, a terminal window resize) without any resize event reaching us,
        # since we skip those while hidden -- catch up now that we're visible again.
        self._sync_pty_size()

    def _sync_pty_size(self):
        if self._screen is None:
            return
        try:
            cols, rows = self._pty_size()
            self._screen.resize(rows, cols)
            self._set_pty_size(cols, rows)
        except Exception:
            log.exception("ClaudePanel resize failed")

    # -- input ----------------------------------------------------------------

    def on_click(self, event) -> None:
        """Mouse-click parity with pressing C -- if there's no session yet, clicking
        the empty pane opens the same backend picker; if one's running but this pane
        doesn't have focus, clicking it focuses it (so you can start typing right
        away) instead of requiring the keyboard every time."""
        try:
            if self._pty_running:
                if not self.has_focus:
                    self.focus()
            else:
                self.app.action_toggle_claude()
        except Exception:
            log.exception("ClaudePanel on_click failed")

    def on_mouse_scroll_up(self, event) -> None:
        # Scroll into history -- doesn't need keyboard focus, same as scrolling any
        # other pane with the wheel/trackpad.
        if self._screen is not None:
            self._screen.prev_page()
            self.refresh()
        event.stop()

    def on_mouse_scroll_down(self, event) -> None:
        if self._screen is not None:
            self._screen.next_page()
            self.refresh()
        event.stop()

    def on_key(self, event: events.Key) -> None:
        try:
            self._on_key_impl(event)
        except Exception:
            log.exception("ClaudePanel on_key failed for key=%r", getattr(event, "key", None))
            event.stop()

    def _on_key_impl(self, event: events.Key) -> None:
        if not self._pty_running or self._master_fd is None:
            # Nothing running to forward keys to -- don't swallow them. If this empty
            # pane ever ends up with focus (a stray click, Tab-cycling) without this
            # check, every keypress including C itself would get silently consumed
            # here and never reach TodoApp's own "C" binding, with zero visible
            # feedback -- looks exactly like "pressing C does nothing."
            return
        if event.key in _RELEASE_KEYS:
            self.blur()
            event.stop()
            return
        if event.key == "escape":
            now = time.monotonic()
            if now - self._last_escape_at < _DOUBLE_ESCAPE_WINDOW:
                self._last_escape_at = 0.0
                self.blur()
                event.stop()
                return
            self._last_escape_at = now
        event.stop()
        data = self._encode_key(event)
        if data:
            try:
                os.write(self._master_fd, data)
            except OSError as e:
                log.info("ClaudePanel write failed (session probably ended): %s", e)

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
        try:
            return self._render_impl()
        except Exception:
            log.exception("ClaudePanel render failed")
            return Text(f"Render error -- see {LOG_PATH}", style="bold red")

    def _render_impl(self):
        if self._error:
            return Text(self._error, style="bold red", justify="center")
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
        if self._ended and not self._error:
            out.append("\n\n[session ended -- press C to start a new one]", style="dim italic yellow")
        return out
