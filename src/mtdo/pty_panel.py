"""The generic pty-backed terminal widget behind the AI panel (claude_panel.py) --
originally extracted so it could be shared with a second pty-backed subclass (a plain
practice terminal, since retired in favor of practice_lab_panel.PracticeLabPanel,
which is a normal Textual widget with a real editor, not a pty). Kept as its own
module rather than folded back into claude_panel.py: it's still where every pty/pyte
bug this app has hit and fixed by hand lives -- pyte 0.8.2's report_device_status()
signature bug, the resize-while-hidden-kills-the-child bug, a naming collision with
Textual's own internal MessagePump._running, the Ctrl+Q priority-binding trap, and the
too-tight double-Escape timing window -- none of which is specific to running
`claude`, and a future second pty-backed panel should get all of it for free again.

Subclasses (currently just ClaudePanel) provide only what's actually different: which
command to run and what to show when the pane is idle. See the hook methods below
(_resolve_command, _idle_subtitle, _running_subtitle, _empty_message, _on_empty_click,
_cwd) -- everything else (spawning via os.openpty() + subprocess.Popen with
preexec_fn=os.setsid rather than pty.fork()/os.fork(), since Textual's own background
input thread makes raw fork() of a multithreaded process a real deadlock risk on
macOS; the read loop; scrollback via pyte.HistoryScreen and the mouse wheel; resize
handling; double-Escape/F2 release; key forwarding; rendering; transcript saving) is
generic pty-terminal behavior.
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

from . import config as appconfig
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
_DOUBLE_ESCAPE_WINDOW = 1.2  # seconds -- see _on_key_impl for why this got bumped up
_SCROLLBACK_LINES = 2000
TRANSCRIPT_DIR = os.path.join(appconfig.APP_DIR, "transcripts")


class _PatchedScreen(pyte.HistoryScreen):
    """pyte.HistoryScreen instead of plain pyte.Screen for scrollback (prev_page() /
    next_page(), wired to the mouse wheel below) -- they mutate self.buffer in place,
    so the render loop needs no changes to show scrolled content. Also two fixes over
    stock pyte 0.8.2:

    1. Screen.report_device_status() doesn't accept the `private` kwarg that
       streams.py always passes for DEC-private CSI sequences (e.g. `CSI ? 6 n`).
       Any app that sends one throws mid-parse, and the read loop's per-chunk
       try/except then silently drops the *rest* of that read() chunk -- not a rare
       edge case, Ink-based UIs (claude's included) send these routinely, so a
       session could look like it "just stops updating" for no visible reason.
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


class PtyPanel(Widget):
    """Generic pty-backed terminal. Subclasses must implement _resolve_command();
    everything else below has a sensible default and can be overridden as needed."""

    can_focus = True

    DEFAULT_CSS = """
    PtyPanel {
        height: 1fr;
        border: round grey;
        background: $surface;
    }
    PtyPanel:focus {
        border: round green;
    }
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._master_fd = None
        self._pid = None
        self._proc = None
        self._screen = None
        self._stream = None
        self._pty_running = False
        self._ended = False
        self._error = None
        self._last_escape_at = 0.0

    @property
    def is_running(self):
        return self._pty_running

    # -- hooks for subclasses -------------------------------------------------

    def _resolve_command(self):
        """Returns (command, label). If command is None, `label` is shown in the pane
        instead of starting anything (e.g. "nothing usable found, here's what to set
        up")."""
        raise NotImplementedError

    def _cwd(self):
        return None

    def _idle_subtitle(self):
        return ""

    def _running_subtitle(self):
        return "Esc Esc (or F2) to leave"

    def _escape_again_subtitle(self):
        return "Esc again to leave"

    def _empty_message(self):
        return "Nothing running.\nClick to start."

    def _ended_message(self):
        return "[session ended]"

    def _on_empty_click(self):
        self.start()

    # -- process lifecycle -------------------------------------------------

    def start(self):
        """Spawns the resolved command in a fresh pty sized to the widget's current
        content area. No-op if a session is already running."""
        if self._pty_running:
            return
        try:
            self._start_impl()
        except Exception:
            log.exception("%s.start failed", type(self).__name__)
            self._error = f"Couldn't start -- see {LOG_PATH}"
            self._ended = True
            self._pty_running = False
            self.refresh()

    def _start_impl(self):
        command, label = self._resolve_command()
        if command is None:
            self._error = label  # the "no command" case uses this slot for the message
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
                cwd=self._cwd(),
                close_fds=True,
            )
        finally:
            os.close(slave_fd)
        self._proc = proc
        self._pid = proc.pid
        self._master_fd = master_fd
        self._pty_running = True
        if label:
            self.border_title = label
        self.border_subtitle = self._running_subtitle()
        threading.Thread(target=self._read_loop, daemon=True).start()
        self.refresh()

    def stop(self):
        try:
            self._stop_impl()
        except Exception:
            log.exception("%s.stop failed", type(self).__name__)

    def _stop_impl(self):
        self._pty_running = False
        self.border_subtitle = self._idle_subtitle()
        self._terminate_process()
        self._pid = None
        self._proc = None
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None

    def _terminate_process(self):
        """SIGTERM first, but escalates to SIGKILL if that doesn't actually work --
        confirmed by hand that an interactive shell can just survive SIGTERM with no
        custom handler involved (default disposition should terminate it, and
        doesn't here). This matters beyond just "did it die": closing the pty master
        fd below while the background read thread is still blocked on it, because
        the child never actually exited, can itself hang indefinitely -- also
        verified by hand, in a plain script with no Textual/asyncio involved at all.
        Guaranteeing the child is dead first lets that blocked read unblock via EOF
        on its own before _stop_impl ever reaches close()."""
        if self._pid is None:
            return
        try:
            pgid = os.getpgid(self._pid)
        except ProcessLookupError:
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            return
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            if self._proc is None or self._proc.poll() is not None:
                return
            time.sleep(0.05)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

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

    def send_text(self, text, submit=True, submit_delay=0.4, flatten=True):
        """Writes `text` into the pty, as if typed -- used to prime a freshly-started
        (or just-refocused) AI session with context (app.TodoApp._prime_ai_context_if_needed)
        and to hand it code for review (practice_lab_panel.PracticeLabPanel.action_evaluate_code)
        without the user having to type or press Enter themselves.

        Enter is sent as its own SEPARATE write, submit_delay seconds later, rather
        than one atomic write ending in "\\r" -- confirmed by hand that the atomic
        version leaves the text sitting typed in the input box without actually
        submitting: an interactive CLI's raw-mode keypress handler (Claude Code's
        Ink-based UI included) can attach asynchronously on startup and either miss a
        same-chunk trailing "\\r" outright, or not yet distinguish "still typing"
        from "submit" within one burst. Splitting the two, with a real pause between
        them, mirrors how a human actually types (type, brief pause, press Enter) and
        is reliably recognized as submit where the atomic version often silently
        wasn't. Pass submit=False to just fill the input box without sending Enter.

        flatten=True (the default) replaces embedded newlines with a literal "\\n"
        (backslash-n, two visible characters, not an actual line break) before
        sending: a pty in canonical/line-buffered mode releases each raw newline to
        the child as its own submitted line, so for a plain readline-based REPL
        (Ollama's/web_chat's input() loop, e.g.) an un-flattened multi-line message
        would arrive as several premature partial sends instead of one. A literal
        "\\n" marker keeps the message on one line (safe to submit whole) while still
        showing where each line break was, unlike collapsing to a bare space, which
        loses that structure entirely. Pass flatten=False for a backend confirmed
        raw-mode (see ai_backend.supports_raw_multiline_paste) or any payload where
        real line breaks matter more than one-shot-submit safety -- code, where even
        a "\\n" marker would break the content itself (Python indentation, e.g.), so
        callers there choose real newlines and accept the same multi-line-paste
        behavior a human would get pasting that same code into any of these backends
        directly. No-op if nothing's running."""
        if not self._pty_running or self._master_fd is None:
            return
        payload = text.replace("\n", "\\n") if flatten else text
        try:
            os.write(self._master_fd, payload.encode("utf-8"))
        except OSError:
            return
        if submit:
            self.set_timer(submit_delay, self._send_enter)

    def _send_enter(self):
        if not self._pty_running or self._master_fd is None:
            return
        try:
            os.write(self._master_fd, b"\r")
        except OSError:
            pass

    def send_text_when_idle(self, text, max_wait=12.0, poll_interval=0.3, **send_kwargs):
        """Like send_text, but waits for the pty's visible output to stop changing
        before sending, instead of firing after a fixed delay chosen by the caller.

        A fixed delay (this used to be a flat 2.0s before a freshly-started AI
        session got its context primer) is a guess about how long the backend takes
        to boot -- and confirmed in practice to be too short often enough to matter:
        Claude Code's actual startup time varies a lot (auth checks, MCP server
        startup, ...), and _pty_running goes True the instant the subprocess is
        spawned, long before its own raw-mode input handler is actually attached and
        listening. Text written before that handler attaches can be silently
        dropped entirely, not just left unsubmitted -- which is exactly why the
        primer sometimes never reached the assistant at all, not just arrived
        un-sent (see send_text's docstring for that separate, already-fixed half of
        this).

        Polls the rendered screen buffer every poll_interval seconds; once two
        consecutive snapshots are identical (nothing animating/loading anymore --
        a generic readiness signal that doesn't need to know any one backend's
        specific banner text), sends immediately. Gives up waiting and sends anyway
        after max_wait seconds, so a backend that keeps redrawing (a spinner, e.g.)
        doesn't mean the primer never goes out at all."""
        self._wait_for_idle_then_send(text, send_kwargs, elapsed=0.0, last_snapshot=None,
                                       max_wait=max_wait, poll_interval=poll_interval)

    def _wait_for_idle_then_send(self, text, send_kwargs, elapsed, last_snapshot, max_wait, poll_interval):
        if not self._pty_running:
            return
        snapshot = self._screen_snapshot()
        if (snapshot and snapshot == last_snapshot) or elapsed >= max_wait:
            self.send_text(text, **send_kwargs)
            return
        self.set_timer(
            poll_interval,
            lambda: self._wait_for_idle_then_send(
                text, send_kwargs, elapsed + poll_interval, snapshot, max_wait, poll_interval,
            ),
        )

    def _screen_snapshot(self):
        if self._screen is None:
            return ""
        rows = (self._screen.buffer[y] for y in range(self._screen.lines))
        return "\n".join("".join(row[x].data for x in range(self._screen.columns)) for row in rows)

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
            log.exception("%s reader thread crashed", type(self).__name__)
        self._pty_running = False
        self._ended = True
        try:
            self.app.call_from_thread(self._mark_ended)
        except Exception:
            pass

    def _mark_ended(self):
        self.border_subtitle = self._idle_subtitle()
        self.refresh()

    def _read_loop_impl(self):
        name = type(self).__name__
        while self._pty_running:
            try:
                data = os.read(self._master_fd, 4096)
            except OSError as e:
                log.info("%s read loop ending: %s", name, e)
                break
            if not data:
                exit_code = self._proc.poll() if self._proc else None
                log.info("%s read loop got EOF, subprocess exit code: %s", name, exit_code)
                break
            try:
                self._stream.feed(data)
            except Exception:
                log.exception("%s: pyte failed to parse %d bytes of output -- skipping", name, len(data))
                continue
            self.app.call_from_thread(self.refresh)

    def on_resize(self, event: events.Resize) -> None:
        # Hiding the pane (leaving Focus Mode, or the practice terminal being toggled
        # off) still fires a resize down to a degenerate content_size (0, 0) --
        # forwarding that to the real pty as a winsize change reliably makes an
        # interactive child exit outright (confirmed by hand with claude's own UI).
        # There's also nothing to redraw for an invisible pane, so skip while hidden.
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
            log.exception("%s resize failed", type(self).__name__)

    # -- input ----------------------------------------------------------------

    def on_click(self, event) -> None:
        """Mouse-click parity with the keyboard path -- clicking an empty pane starts
        it (or, for the AI panel, opens the backend picker); clicking a running pane
        that doesn't have focus focuses it, so you can start typing right away."""
        try:
            if self._pty_running:
                if not self.has_focus:
                    self.focus()
            else:
                self._on_empty_click()
        except Exception:
            log.exception("%s on_click failed", type(self).__name__)

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

    def save_transcript(self):
        """Dumps everything currently captured (scrollback + visible screen, in
        order) to a timestamped plain-text file under ~/.mtdo/transcripts/ and
        returns its path. Raises if there's nothing to save (no screen yet) -- the
        caller decides how to tell the user."""
        if self._screen is None:
            raise RuntimeError("no session to save a transcript from")
        text = self._transcript_text()
        os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
        path = os.path.join(TRANSCRIPT_DIR, f"{time.strftime('%Y%m%d_%H%M%S')}.txt")
        with open(path, "w") as f:
            f.write(text)
        return path

    def _transcript_text(self):
        screen = self._screen
        rows = list(screen.history.top)
        rows += [screen.buffer[y] for y in range(screen.lines)]
        rows += list(screen.history.bottom)
        lines = []
        for row in rows:
            line = "".join(row[x].data for x in range(screen.columns))
            lines.append(line.rstrip())
        # Collapse runs of blank lines left by the pty's own redraws -- otherwise a
        # short session produces a mostly-empty multi-thousand-line file.
        collapsed = []
        for line in lines:
            if line == "" and collapsed and collapsed[-1] == "":
                continue
            collapsed.append(line)
        return "\n".join(collapsed).strip() + "\n"

    def on_key(self, event: events.Key) -> None:
        try:
            self._on_key_impl(event)
        except Exception:
            log.exception("%s on_key failed for key=%r", type(self).__name__, getattr(event, "key", None))
            event.stop()

    def _on_key_impl(self, event: events.Key) -> None:
        if not self._pty_running or self._master_fd is None:
            # Nothing running to forward keys to -- don't swallow them. If this empty
            # pane ever ends up with focus (a stray click, Tab-cycling) without this
            # check, every keypress would get silently consumed here and never reach
            # mtdo's own bindings, with zero visible feedback.
            return
        if event.key in _RELEASE_KEYS:
            self.blur()
            event.stop()
            return
        if event.key == "escape":
            now = time.monotonic()
            if now - self._last_escape_at < _DOUBLE_ESCAPE_WINDOW:
                self._last_escape_at = 0.0
                self.border_subtitle = self._running_subtitle()
                self.blur()
                event.stop()
                return
            # A lone Escape does nothing visible in most CLIs (readline/getpass
            # prompts included), so without a cue here, someone pressing Escape,
            # seeing nothing happen, and then pausing before trying again easily
            # misses the window -- each single Escape just looks like it did nothing.
            self._last_escape_at = now
            self.border_subtitle = self._escape_again_subtitle()
            self.refresh()
        elif self._last_escape_at:
            self._last_escape_at = 0.0
            self.border_subtitle = self._running_subtitle()
            self.refresh()
        event.stop()
        data = self._encode_key(event)
        if data:
            try:
                os.write(self._master_fd, data)
            except OSError as e:
                log.info("%s write failed (session probably ended): %s", type(self).__name__, e)

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
            log.exception("%s render failed", type(self).__name__)
            return Text(f"Render error -- see {LOG_PATH}", style="bold red")

    def _render_impl(self):
        if self._error:
            return Text(self._error, style="bold red", justify="center")
        if self._screen is None:
            return Text(self._empty_message(), style="dim italic", justify="center")
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
            out.append(f"\n\n{self._ended_message()}", style="dim italic yellow")
        return out
