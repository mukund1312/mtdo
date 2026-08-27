"""A self-contained "radio session" screen -- the retro-terminal internet-radio
player (station list, real audio-reactive visualizer, favorites, shuffle/
repeat) requested to sit alongside, not replace, the existing NowPlayingPanel
remote control in app.py. Extracted into its own module rather than folded
into app.py, same precedent as practice_lab_panel.py for a feature this size.

Visual design matches a specific reference mockup (a fictional "cliamp"
terminal player) the user provided, with one deliberate departure: the
mockup's "EQ [ Rock ]" row implies a genre EQ preset that actually reshapes
the sound -- discussed with the user, who chose NOT to build that (a real
audio-processing feature, not a UI concern) and instead have that row show
the same real per-band audio levels already driving the visualizer, labeled
honestly ("EQ [Live]") rather than a fake preset name. Everything else in the
mockup that had no real backing data in this app (a "SRC 1/9" source
counter, a "SPD [1x]"/bandwidth footer) was dropped rather than faked.

A full Screen (VaultScreen's pattern), not a ModalScreen or docked panel --
pushed via a keybinding/click from TodoApp, popped with q/Escape. Closing this
screen does NOT stop playback: this is meant to be a "session" you can dip in
and out of while the rest of mtdo stays usable, not something that forces you
to stay on it to keep the music going. TodoApp itself owns the one shared
`radio.RadioPlayer` instance (see app.py) and is responsible for actually
stopping it on quit -- this screen only ever reads/commands that instance,
never creates its own.
"""
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Static, ListView, ListItem, Label
from rich.text import Text

from . import config as appconfig
from . import radio

_BAR_ROWS = 6
_REPEAT_CYCLE = ["off", "all", "one"]
_VOL_BAR_WIDTH = 28
_VINYL_WIDGET_WIDTH = 18

_GREEN_BRIGHT = "#39ff8a"
_GREEN_MID = "#1f7a4d"
_GREEN_BG = "#0d2318"
_TEAL = "#3ddc97"
_ORANGE = "#ffb454"
_DIM = "#7c8c83"
_BOX_BORDER = "#1f4d33"
_PANEL_BG = "#0a0f0c"


def _fmt_mmss(seconds):
    if seconds is None:
        return "--:--"
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def _key_chip(key, label):
    """One 'key cap' hint chip -- a solid-background span faking a bordered
    key the way terminal cheat-sheets commonly do it, since Rich/Textual can
    only border a whole widget, never a span within a line of text."""
    chip = Text()
    chip.append(f" {key} ", style=f"bold black on {_TEAL}")
    chip.append(f" {label}   ", style=_DIM)
    return chip


def _eq_bands_text(levels):
    """Real per-band levels (dBFS, same data driving the visualizer) shown as
    small signed numbers -- an honest stand-in for the mockup's genre EQ
    preset readout (see module docstring): -30dBFS is an arbitrary but
    reasonable mid-loudness reference point for these stations, scaled so a
    band swinging through typical radio loudness reads roughly -9..+9,
    matching the mockup's single-digit style without claiming to be a
    calibrated meter."""
    text = Text()
    for lvl in levels:
        rel = max(-9, min(9, round((lvl + 30) / 3)))
        text.append(f"{rel:+d} ", style="white")
    return text


class StationItem(ListItem):
    # Named _build_label, not _render -- Widget itself defines a _render()
    # used internally for painting; a same-named method with a different
    # signature here silently overrides it and crashes on the next real
    # render call (confirmed by hand: a "missing 3 required positional
    # arguments" TypeError deep inside Textual's own render_content).
    def __init__(self, index, station, is_current, is_favorite):
        self.station_index = index
        super().__init__(Label(self._build_label(index, station, is_current, is_favorite)))

    def _build_label(self, index, station, is_current, is_favorite):
        marker = "▶ " if is_current else "  "
        star = " ★" if is_favorite else ""
        style = f"bold {_GREEN_BRIGHT}" if is_current else "white"
        return Text(f"{marker}{index + 1:>2}. {station['name']}{star}", style=style)


class RadioScreen(Screen):
    """`player` is the app-owned radio.RadioPlayer -- never constructed here,
    always passed in, so playback state genuinely survives this screen being
    closed and reopened (a fresh RadioPlayer would forget what was playing)."""

    BINDINGS = [
        ("escape", "close", "Back"),
        ("q", "close", "Back"),
        ("space", "toggle_pause", "Play/Pause"),
        ("f", "toggle_favorite", "Favorite"),
        ("s", "toggle_shuffle", "Shuffle"),
        ("r", "cycle_repeat", "Repeat"),
        ("n", "next_station", "Next"),
        ("p", "prev_station", "Prev"),
        ("+", "volume_up", "Vol+"),
        ("-", "volume_down", "Vol-"),
    ]

    CSS = f"""
    RadioScreen {{ layout: vertical; background: #05070a; }}
    #radio-topbar {{ dock: top; height: 1; padding: 0 2; background: #05070a; }}
    #radio-prompt {{ width: 1fr; color: {_TEAL}; }}
    #radio-tty {{ width: auto; color: {_DIM}; }}
    #radio-panel {{ margin: 1 2 1 2; border: round {_BOX_BORDER}; background: {_PANEL_BG}; padding: 0 2 1 2; height: 1fr; }}
    #radio-header-row {{ height: auto; margin-top: 1; }}
    #radio-vinyl {{ width: {_VINYL_WIDGET_WIDTH}; height: auto; margin-right: 2; }}
    #radio-info-col {{ width: 1fr; height: auto; }}
    #radio-title-row {{ height: 1; }}
    #radio-cliamp {{ width: 1fr; color: {_TEAL}; text-style: bold; }}
    #radio-playlist-tag {{ width: auto; color: {_DIM}; }}
    #radio-now {{ color: white; text-style: bold; height: 1; margin-top: 1; }}
    #radio-time-row {{ height: 1; margin-bottom: 1; }}
    #radio-time {{ width: 1fr; color: {_DIM}; }}
    #radio-state {{ width: auto; color: {_DIM}; }}
    #radio-visualizer {{ height: {_BAR_ROWS}; background: {_GREEN_BG}; margin-bottom: 1; }}
    #radio-stream-divider {{ color: {_ORANGE}; text-align: center; height: 1; margin-bottom: 1; }}
    #radio-eq {{ height: 1; }}
    #radio-vol {{ height: 1; margin-bottom: 1; }}
    #radio-playlist-header {{ color: {_ORANGE}; height: 1; }}
    #radio-list {{ height: 1fr; background: {_PANEL_BG}; border: none; }}
    #radio-help {{ dock: bottom; height: 1; margin: 0 0 1 2; }}
    """

    def __init__(self, player):
        super().__init__()
        self.player = player
        radio_state = appconfig.load_radio_state()
        self.favorites = set(radio_state["favorites"])
        self.shuffle = radio_state["shuffle"]
        self.repeat = radio_state["repeat"]
        self.vinyl_widget = None
        self._vinyl_frames = None
        self._vinyl_frame_index = 0
        self._last_paused = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="radio-topbar"):
            prompt = Text()
            prompt.append("$ ", style="bold white")
            prompt.append("cliamp ", style=f"bold {_TEAL}")
            prompt.append("--provider radio", style=_DIM)
            yield Static(prompt, id="radio-prompt")
            self.topbar_state = Static("■  tty1", id="radio-tty")
            yield self.topbar_state
        with Vertical(id="radio-panel"):
            with Horizontal(id="radio-header-row"):
                if radio.has_vinyl_support():
                    # HalfcellImage specifically, not AutoImage -- confirmed
                    # by hand this renders correctly (real color, no garbled
                    # output) on any terminal, since it's plain Unicode half-
                    # block characters + ANSI color, no Kitty/iTerm2/Sixel
                    # graphics protocol support required. AutoImage would
                    # look sharper on a terminal that does support one of
                    # those, but there's no way to verify that actually
                    # renders correctly for everyone from this environment,
                    # and a broken/blank image would be a worse outcome than
                    # a slightly-blockier-but-guaranteed-working one.
                    from textual_image.widget import HalfcellImage
                    self.vinyl_widget = HalfcellImage(id="radio-vinyl")
                    yield self.vinyl_widget
                with Vertical(id="radio-info-col"):
                    with Horizontal(id="radio-title-row"):
                        yield Static("C L I A M P", id="radio-cliamp")
                        yield Static("[Playlist]", id="radio-playlist-tag")
                    self.now_line = Static("♪ Nothing playing -- Enter to start a station", id="radio-now")
                    yield self.now_line
                    with Horizontal(id="radio-time-row"):
                        self.time_line = Static("--:-- / LIVE", id="radio-time")
                        yield self.time_line
                        self.state_line = Static("■ Stopped", id="radio-state")
                        yield self.state_line
            self.visualizer = Static("", id="radio-visualizer")
            yield self.visualizer
            self.stream_divider = Static("", id="radio-stream-divider")
            yield self.stream_divider
            self.eq_line = Static("", id="radio-eq")
            yield self.eq_line
            self.vol_line = Static("", id="radio-vol")
            yield self.vol_line
            self.playlist_header = Static("", id="radio-playlist-header")
            yield self.playlist_header
            self.list_view = ListView(id="radio-list")
            yield self.list_view
        self.help_line = Static("", id="radio-help")
        yield self.help_line

    def on_mount(self):
        self._rebuild_list()
        self._render_help()
        self.list_view.focus()
        self._update_status()
        self._redraw_visualizer()
        # Two separate intervals, deliberately different rates: the visualizer
        # only reads an in-memory, lock-protected list (radio.get_levels()) --
        # cheap, redrawn fast for smoothness. The status line queries mpv over
        # its IPC socket (is_paused/get_position/get_volume) -- a real, if
        # normally fast, blocking round trip on Textual's own event-loop
        # thread, so it runs far less often to keep worst-case UI stall low
        # if mpv is ever slow to respond.
        self.set_interval(1 / 12, self._redraw_visualizer)
        self.set_interval(0.5, self._update_status)
        if self.vinyl_widget is not None:
            self._load_vinyl_frames()

    def _load_vinyl_frames(self):
        try:
            self._vinyl_frames = radio.extract_vinyl_frames()
        except RuntimeError:
            # Extraction genuinely failed (corrupt asset, ffmpeg misbehaving)
            # -- has_vinyl_support() already confirmed the happy path should
            # work, so this is a real, if rare, failure. Drop the widget
            # rather than leave a broken/blank image box sitting in the
            # layout for the rest of the session.
            self.vinyl_widget.remove()
            self.vinyl_widget = None
            return
        self.vinyl_widget.image = self._vinyl_frames[0]
        self.set_interval(1 / radio._VINYL_FPS, self._advance_vinyl)

    def _advance_vinyl(self):
        """Only actually spins while a station is genuinely playing --
        freezes in place on pause (like a real turntable's needle stopping
        where it is, not resetting), and parks back on frame 0 once nothing
        is playing at all. Reads self._last_paused (cached by _update_status)
        rather than querying the mpv IPC socket itself -- see that method's
        comment for why this ticks too often for a fresh round trip each
        time."""
        if not self._vinyl_frames:
            return
        if not self.player.is_playing():
            self._vinyl_frame_index = 0
        elif not self._last_paused:
            self._vinyl_frame_index = (self._vinyl_frame_index + 1) % len(self._vinyl_frames)
        self.vinyl_widget.image = self._vinyl_frames[self._vinyl_frame_index]

    def _render_help(self):
        text = Text()
        for key, label in (
            ("↑↓", "Scroll"), ("Enter", "Play"), ("Spc", "Pause"), ("f", "Fav"),
            ("s", "Shuffle"), ("r", "Repeat"), ("n/p", "Station"), ("+/-", "Vol"), ("q", "Back"),
        ):
            text.append(_key_chip(key, label))
        self.help_line.update(text)

    def _save_state(self):
        appconfig.save_radio_state({
            "favorites": sorted(self.favorites),
            "last_station": self.player.current_station() and self.player.station_index,
            "shuffle": self.shuffle,
            "repeat": self.repeat,
        })

    def _rebuild_list(self):
        prev_index = self.list_view.index or 0
        self.list_view.clear()
        current = self.player.station_index
        items = [
            StationItem(i, station, i == current, i in self.favorites)
            for i, station in enumerate(radio.STATIONS)
        ]
        self.list_view.extend(items)
        self.list_view.index = min(prev_index, len(items) - 1)
        self._render_playlist_header()

    def _render_playlist_header(self):
        current = self.player.station_index
        position = f"{current + 1}/{len(radio.STATIONS)}" if current is not None else f"-/{len(radio.STATIONS)}"
        shuffle_label = "On" if self.shuffle else "Off"
        text = Text("▸─ Playlist ── ", style=_ORANGE)
        text.append(f"[Shuffle: {shuffle_label}] ", style="white")
        text.append(f"[Repeat: {self.repeat.title()}] ", style="white")
        text.append(f"[{position}] ", style="white")
        text.append("──", style=_ORANGE)
        self.playlist_header.update(text)

    def _update_status(self):
        station = self.player.current_station()
        playing = self.player.is_playing()
        paused = playing and self.player.is_paused()
        # Cached for _advance_vinyl, which ticks at _VINYL_FPS (8/sec) --
        # querying mpv's IPC socket for is_paused() that often, instead of
        # reusing this slower (0.5/sec) poll's already-fetched value, would
        # reintroduce the same "frequent blocking round trip on Textual's
        # event-loop thread" concern this method's own docstring note above
        # already exists to avoid.
        self._last_paused = paused

        if station is None:
            self.now_line.update("♪ Nothing playing -- Enter to start a station")
            self.time_line.update("--:-- / LIVE")
            self.state_line.update(Text("■ Stopped  (Enter to play)", style=_DIM))
            self.stream_divider.update(Text("── STOPPED ──", style=_ORANGE))
            self.topbar_state.update(Text("■  tty1", style=_DIM))
        else:
            self.now_line.update(f"♪ {station['name']}")
            pos = _fmt_mmss(self.player.get_position()) if playing else "--:--"
            self.time_line.update(f"{pos} / LIVE")
            if paused:
                self.state_line.update(Text("❚❚ Paused  (Space to resume)", style=_DIM))
                self.stream_divider.update(Text("── PAUSED ──", style=_ORANGE))
                self.topbar_state.update(Text("❚❚  tty1", style=_TEAL))
            else:
                self.state_line.update(Text("▶ Playing  (Space to pause)", style=_DIM))
                self.stream_divider.update(Text("── STREAMING ──", style=_ORANGE))
                self.topbar_state.update(Text("▶  tty1", style=_GREEN_BRIGHT))

        eq = Text("EQ ", style="white")
        eq.append("[Live] ", style=_ORANGE)
        eq.append_text(_eq_bands_text(self.player.get_levels()))
        self.eq_line.update(eq)

        vol = self.player.get_volume() if playing else None
        vol_pct = vol if vol is not None else 100.0
        filled = round(vol_pct / 100 * _VOL_BAR_WIDTH)
        bar = Text("VOL ", style="white")
        bar.append("▮" * filled, style=_GREEN_BRIGHT)
        bar.append("·" * (_VOL_BAR_WIDTH - filled), style=_GREEN_MID)
        bar.append(f" {vol_pct:.0f}%", style=_DIM)
        self.vol_line.update(bar)

    def _redraw_visualizer(self):
        self.visualizer.update(self._render_visualizer())

    def _render_visualizer(self):
        levels = self.player.get_levels()
        heights = []
        for level in levels:
            norm = max(0.0, min(1.0, (level + 60.0) / 60.0))
            heights.append(round(norm * _BAR_ROWS))
        text = Text()
        col_width = 3
        for row in range(_BAR_ROWS - 1, -1, -1):
            for height in heights:
                if height > row:
                    text.append("█" * col_width, style=_GREEN_BRIGHT)
                else:
                    text.append("░" * col_width, style=_GREEN_MID)
            text.append("\n")
        return text

    # -- actions --------------------------------------------------------

    def action_close(self):
        self.app.pop_screen()

    def on_list_view_selected(self, event: ListView.Selected):
        """Enter on the focused list -- NOT a Screen-level "enter" binding:
        ListView itself already binds Enter (to emit this exact message) and
        a focused widget's own bindings take priority over an ancestor
        Screen's for the same key, so a same-named Screen binding here would
        simply never fire (confirmed by hand -- the intended play-on-Enter
        silently did nothing until this was the actual handler)."""
        if isinstance(event.item, StationItem):
            self._play(event.item.station_index)

    def _play(self, index):
        try:
            self.player.start(index)
        except RuntimeError as exc:
            self.now_line.update(str(exc))
            return
        self._rebuild_list()
        self._save_state()
        self._update_status()

    def action_toggle_pause(self):
        if self.player.is_playing():
            self.player.toggle_pause()
            self._update_status()

    def action_toggle_favorite(self):
        if self.list_view.index is None:
            return
        item = self.list_view.children[self.list_view.index]
        if not isinstance(item, StationItem):
            return
        if item.station_index in self.favorites:
            self.favorites.discard(item.station_index)
        else:
            self.favorites.add(item.station_index)
        self._rebuild_list()
        self._save_state()

    def action_toggle_shuffle(self):
        self.shuffle = not self.shuffle
        self._render_playlist_header()
        self._save_state()

    def action_cycle_repeat(self):
        current = _REPEAT_CYCLE.index(self.repeat)
        self.repeat = _REPEAT_CYCLE[(current + 1) % len(_REPEAT_CYCLE)]
        self._render_playlist_header()
        self._save_state()

    def action_next_station(self):
        self._advance(1)

    def action_prev_station(self):
        self._advance(-1)

    def action_volume_up(self):
        if self.player.is_playing():
            self.player.set_volume(5)
            self._update_status()

    def action_volume_down(self):
        if self.player.is_playing():
            self.player.set_volume(-5)
            self._update_status()

    def _advance(self, direction):
        if self.repeat == "one" or self.player.station_index is None:
            return
        n = len(radio.STATIONS)
        if self.shuffle:
            import random
            choices = [i for i in range(n) if i != self.player.station_index]
            next_index = random.choice(choices) if choices else self.player.station_index
        else:
            next_index = (self.player.station_index + direction) % n
        self._play(next_index)
