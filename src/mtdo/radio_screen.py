"""A self-contained "radio session" screen -- the retro-terminal internet-radio
player (station list, real audio-reactive visualizer, favorites, shuffle/
repeat) requested to sit alongside, not replace, the existing NowPlayingPanel
remote control in app.py. Extracted into its own module rather than folded
into app.py, same precedent as practice_lab_panel.py for a feature this size.

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

_NEON = ["#ff2d95", "#ff8c00", "#ffe135", "#39ff14", "#00fff5", "#7c5cff"]
_BAR_ROWS = 5
_REPEAT_CYCLE = ["off", "all", "one"]


def _fmt_mmss(seconds):
    if seconds is None:
        return "--:--"
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


class StationItem(ListItem):
    # Named _build_label, not _render -- Widget itself defines a _render()
    # used internally for painting; a same-named method with a different
    # signature here silently overrides it and crashes on the next real
    # render call (confirmed by hand: a "missing 3 required positional
    # arguments" TypeError deep inside Textual's own render_content).
    def __init__(self, index, station, is_current, is_favorite):
        self.station_index = index
        super().__init__(Label(self._build_label(station, is_current, is_favorite)))

    def _build_label(self, station, is_current, is_favorite):
        marker = "▶ " if is_current else "  "
        star = " ★" if is_favorite else ""
        style = "bold #39ff14" if is_current else "white"
        return Text(f"{marker}{station['name']}{star}", style=style)


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
    ]

    CSS = """
    RadioScreen { layout: vertical; background: #060812; }
    #radio-header { dock: top; height: 5; border: round #ff2d95; padding: 0 1; background: #0a0d1a; }
    #radio-title { text-style: bold; color: #00fff5; }
    #radio-now { color: #ffe135; }
    #radio-status { color: #7c5cff; }
    #radio-visualizer { dock: top; height: 7; border: round #7c5cff; padding: 0 1; background: #0a0d1a; }
    #radio-body { height: 1fr; }
    #radio-list { width: 1fr; border: round #00fff5; padding: 0 1; background: #0a0d1a; }
    #radio-help { height: 1; dock: bottom; padding: 0 1; color: #7c5cff; }
    """

    def __init__(self, player):
        super().__init__()
        self.player = player
        radio_state = appconfig.load_radio_state()
        self.favorites = set(radio_state["favorites"])
        self.shuffle = radio_state["shuffle"]
        self.repeat = radio_state["repeat"]

    def compose(self) -> ComposeResult:
        with Vertical(id="radio-header"):
            yield Static("◆ M T D O   R A D I O ◆", id="radio-title")
            self.now_line = Static("Nothing playing", id="radio-now")
            yield self.now_line
            self.status_line = Static("", id="radio-status")
            yield self.status_line
        self.visualizer = Static("", id="radio-visualizer")
        yield self.visualizer
        with Horizontal(id="radio-body"):
            self.list_view = ListView(id="radio-list")
            yield self.list_view
        yield Static(
            "↑↓ move  Enter play  Space pause  f favorite  s shuffle  r repeat  n/p station  q/esc back",
            id="radio-help",
        )

    def on_mount(self):
        self._rebuild_list()
        self.list_view.focus()
        self._update_status()
        self._redraw_visualizer()
        # Two separate intervals, deliberately different rates: the visualizer
        # only reads an in-memory, lock-protected list (radio.get_levels()) --
        # cheap, redrawn fast for smoothness. The status line queries mpv over
        # its IPC socket (is_paused/get_position) -- a real, if normally fast,
        # blocking round trip on Textual's own event-loop thread, so it runs
        # far less often to keep worst-case UI stall low if mpv is ever slow
        # to respond.
        self.set_interval(1 / 12, self._redraw_visualizer)
        self.set_interval(0.5, self._update_status)

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

    def _update_status(self):
        station = self.player.current_station()
        if station is None:
            self.now_line.update("Nothing playing -- Enter to start a station")
            self.status_line.update("")
        else:
            paused = self.player.is_paused()
            icon = "❚❚" if paused else "▶"
            pos = _fmt_mmss(self.player.get_position())
            self.now_line.update(f"{icon}  {station['name']}   {pos}")
            shuffle_label = "On" if self.shuffle else "Off"
            self.status_line.update(f"Shuffle: {shuffle_label}   Repeat: {self.repeat.title()}")

    def _redraw_visualizer(self):
        self.visualizer.update(self._render_visualizer())

    def _render_visualizer(self):
        levels = self.player.get_levels()
        heights = []
        for level in levels:
            norm = max(0.0, min(1.0, (level + 60.0) / 60.0))
            heights.append(round(norm * _BAR_ROWS))
        text = Text()
        for row in range(_BAR_ROWS - 1, -1, -1):
            for col, height in enumerate(heights):
                color = _NEON[col % len(_NEON)]
                text.append("▇▇ " if height > row else "   ", style=color)
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
        self._save_state()

    def action_cycle_repeat(self):
        current = _REPEAT_CYCLE.index(self.repeat)
        self.repeat = _REPEAT_CYCLE[(current + 1) % len(_REPEAT_CYCLE)]
        self._save_state()

    def action_next_station(self):
        self._advance(1)

    def action_prev_station(self):
        self._advance(-1)

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
