#!/usr/bin/env python3
"""One merged live app: a 4-column Kanban board (Backlog / Todo / In Progress / Done)
of today's cards, vim-navigable (h/l columns, j/k cards, space to advance, u to send
back, t/n/a/d to edit/note/add/delete), plus live 12h clock, calendar, streaks,
standalone pomodoro timer, and a Spotify now-playing panel. Categories, curriculum,
and goal all come from the user's config -- see config.py.
Run via the `mtdo` command (see cli.py), or `python3 -m mtdo.app` directly.
"""
import datetime
import os
import re
import shlex
import subprocess

from . import core as tc
from . import config as appconfig
from . import animation as anim

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll, Center, Middle
from textual.widgets import Static, ListView, ListItem, Label, Input, Footer, TextArea
from textual.screen import ModalScreen, Screen
from textual.reactive import reactive
from rich.text import Text
from rich.table import Table
from rich.console import Group
from rich.panel import Panel
from rich import box

_COLOR_PALETTE = ["magenta", "blue", "orange3", "green", "red3", "purple", "grey70",
                  "cyan", "gold3", "deep_pink3", "turquoise2", "dark_orange3"]


def _build_category_colors():
    """Auto-assigns a color per category from a fixed palette, by CATEGORY_ORDER position
    -- works for anyone's category names, not just a hardcoded set."""
    return {cat: _COLOR_PALETTE[i % len(_COLOR_PALETTE)] for i, cat in enumerate(tc.CATEGORY_ORDER)}


CATEGORY_COLORS = {}

STATUS_COLORS = {
    "future": "white",
    "pre_plan": "grey50",
    "none": "bright_red",
    "partial": "bright_yellow",
    "complete": "bright_green",
}

CAREER_STATUS_COLORS = {
    "applied": "cyan", "oa": "gold3", "interview": "blue",
    "offer": "bright_green", "rejected": "red3", "ghosted": "grey50",
}


class VimListView(ListView):
    BINDINGS = [("j", "cursor_down", "Down"), ("k", "cursor_up", "Up")]


def bar(done, total, width=18, color="white"):
    frac = 0 if total == 0 else min(done / total, 1.0)
    filled = int(round(frac * width))
    text = Text()
    text.append("█" * filled, style=color)
    text.append("░" * (width - filled), style="grey30")
    text.append(f"  {done}/{total} {round(frac*100)}%", style="bold white")
    return text


# ---- Spotify -----------------------------------------------------------------

def _spotify_running():
    return subprocess.run(
        ["pgrep", "-x", "Spotify"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode == 0


_SPOTIFY_EMPTY = {"song": "Spotify Not Running", "artist": "", "position": 0.0, "duration": 0.0,
                   "state": "stopped", "volume": None}


def spotify_track():
    """Returns {song, artist, position, duration, state, volume} -- position/duration in seconds."""
    if not _spotify_running():
        return dict(_SPOTIFY_EMPTY)
    try:
        output = subprocess.check_output([
            "osascript", "-e",
            'tell application "Spotify" to name of current track & "|||" & artist of current track'
            ' & "|||" & (player position as string) & "|||" & (duration of current track as string)'
            ' & "|||" & (player state as string) & "|||" & (sound volume as string)'
        ]).decode().strip()
        song, artist, position_s, duration_ms, state, volume_s = output.split("|||")
        return {
            "song": song, "artist": artist,
            "position": float(position_s), "duration": float(duration_ms) / 1000.0,
            "state": state, "volume": int(round(float(volume_s))),
        }
    except Exception:
        return dict(_SPOTIFY_EMPTY)


_SPOTIFY_URI_RE = re.compile(r"^spotify:(playlist|album|track|artist):[A-Za-z0-9]+$")
_SPOTIFY_WEB_RE = re.compile(r"^https?://open\.spotify\.com/(?:intl-\w+/)?(playlist|album|track|artist)/([A-Za-z0-9]+)")


def _spotify_uri_from_input(value):
    value = value.strip()
    if _SPOTIFY_URI_RE.match(value):
        return value
    m = _SPOTIFY_WEB_RE.match(value)
    if m:
        kind, sid = m.groups()
        return f"spotify:{kind}:{sid}"
    return None


def spotify_play_url(value):
    """Plays a pasted playlist/album/track/artist link. Returns False (and leaves whatever's
    currently playing untouched) if the input isn't a recognizable Spotify link."""
    uri = _spotify_uri_from_input(value)
    if not uri:
        return False
    result = subprocess.run(
        ["osascript", "-e", f'tell application "Spotify" to play track "{uri}"'],
        capture_output=True,
    )
    return result.returncode == 0


def _fmt_mmss(seconds):
    seconds = max(0, int(seconds))
    mins, secs = divmod(seconds, 60)
    return f"{mins}:{secs:02d}"


def _block_bar(frac, width):
    filled = min(max(int(round(frac * width)), 0), width)
    return "█" * filled + "░" * (width - filled)


def _progress_bar(position, duration, width=18):
    frac = 0 if duration <= 0 else position / duration
    return _block_bar(frac, width)


def _parse_anim_options(text):
    """Parses a subset of anifetch's own CLI flags for the 'G' -> add-clip flow:
    -r/--framerate and -ca/-c/--chafa-arguments (e.g. '-r 20 -ca "--symbols wide --fg-only"').
    -W/--width and -H/--height are recognized but ignored -- animation render size always
    comes from the live SpotifyPanel size (see animation_target_size), never a fixed value,
    so the clip keeps fitting as the terminal is resized. -s/--sound is recognized but
    ignored too -- audio always comes from Spotify itself, never extracted from the clip.
    Returns (fps_or_None, chafa_args_or_None)."""
    fps, chafa_args = None, None
    try:
        tokens = shlex.split(text or "")
    except ValueError:
        tokens = (text or "").split()
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in ("-r", "--framerate") and i + 1 < len(tokens):
            try:
                fps = int(tokens[i + 1])
            except ValueError:
                pass
            i += 2
        elif tok in ("-ca", "-c", "--chafa-arguments") and i + 1 < len(tokens):
            chafa_args = tokens[i + 1]
            i += 2
        elif tok in ("-W", "--width", "-H", "--height") and i + 1 < len(tokens):
            i += 2
        elif tok in ("-s", "--sound"):
            i += 1
        else:
            i += 1
    return fps, chafa_args


def spotify_play_pause():
    subprocess.run(["osascript", "-e", 'tell application "Spotify" to playpause'])


def spotify_next():
    subprocess.run(["osascript", "-e", 'tell application "Spotify" to next track'])


def spotify_previous():
    subprocess.run(["osascript", "-e", 'tell application "Spotify" to previous track'])


def _spotify_nudge_volume(delta):
    subprocess.run(["osascript", "-e", f'''
        tell application "Spotify"
            set v to sound volume + ({delta})
            if v > 100 then set v to 100
            if v < 0 then set v to 0
            set sound volume to v
        end tell
    '''])


def spotify_volume_up():
    _spotify_nudge_volume(10)


def spotify_volume_down():
    _spotify_nudge_volume(-10)


class TextPromptScreen(ModalScreen):
    """Generic modal: shows a prompt + text input, returns the value (or None on Escape)."""

    CSS = """
    TextPromptScreen { align: center middle; }
    #prompt-box { width: 70; height: auto; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self, prompt_text, initial=""):
        super().__init__()
        self.prompt_text = prompt_text
        self.initial = initial

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="prompt-box"):
                    yield Static(self.prompt_text)
                    yield Input(value=self.initial, id="prompt-input")
                    yield Static("Enter to save, Escape to cancel", classes="dim")

    def on_mount(self):
        inp = self.query_one(Input)
        inp.focus()
        inp.cursor_position = len(inp.value)

    def on_input_submitted(self, event: Input.Submitted):
        self.dismiss(event.value)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class CategoryPickScreen(ModalScreen):
    """Modal: pick which field (category) a new card belongs to -- shown every time you
    press 'a', never inferred from whatever happens to be highlighted, so you always
    explicitly choose (or create) the target instead of silently landing on the wrong
    field. Includes a "+ New field..." row that creates a whole new category on the spot.
    Dismisses with the category name, ADD_NEW, or None on Escape."""

    ADD_NEW = "__add_new_field__"

    CSS = """
    CategoryPickScreen { align: center middle; }
    #pick-box { width: 60; height: auto; max-height: 20; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self, categories):
        super().__init__()
        self.categories = categories

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="pick-box"):
                    yield Static("Add a card to which field?")
                    items = [
                        ListItem(Label(Text.assemble(
                            (" " + tc.CATEGORY_META[c]["label"].split(" ")[0].split("/")[0] + " ",
                             f"bold white on {CATEGORY_COLORS.get(c, 'white')}"),
                            ("  " + tc.CATEGORY_META[c]["label"], ""),
                        )), name=c)
                        for c in self.categories
                    ]
                    items.append(ListItem(Label("+ New field..."), name=self.ADD_NEW))
                    yield VimListView(*items)
                    yield Static("Enter to pick, Escape to cancel", classes="dim")

    def on_mount(self):
        self.query_one(VimListView).focus()

    def on_list_view_selected(self, event: ListView.Selected):
        self.dismiss(event.item.name)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class AnimationPickScreen(ModalScreen):
    """Modal: pick which animation clip to play, or add a new one from a file path.
    Dismisses with a filename (inside ~/.mtdo/animations/) to play, or None on cancel."""

    ADD_NEW = "__add_new__"

    CSS = """
    AnimationPickScreen { align: center middle; }
    #anim-pick-box { width: 60; height: auto; max-height: 20; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self, names):
        super().__init__()
        self.names = names

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="anim-pick-box"):
                    yield Static("Play which animation?")
                    items = [ListItem(Label(n), name=n) for n in self.names]
                    items.append(ListItem(Label("+ Add new from a file path..."), name=self.ADD_NEW))
                    yield VimListView(*items)
                    yield Static("Enter to pick, Escape to cancel", classes="dim")

    def on_mount(self):
        self.query_one(VimListView).focus()

    def on_list_view_selected(self, event: ListView.Selected):
        self.dismiss(event.item.name)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


# ---- Career CRM screen -------------------------------------------------------

class CompanyItem(ListItem):
    def __init__(self, idx, company):
        self.idx = idx
        super().__init__(Label(self._render_company(company)))

    def _render_company(self, company):
        status = company.get("status", "applied")
        color = CAREER_STATUS_COLORS.get(status, "white")
        label = tc.CAREER_STATUS_LABELS.get(status, status)
        note_flag = "  \U0001F4DD" if company.get("notes") else ""
        return Text.assemble((f"{company['name']:<26}", "bold white"), (label, f"bold {color}"), note_flag)


class CareerScreen(Screen):
    BINDINGS = [
        ("escape", "close", "Back"),
        ("q", "close", "Back"),
        ("space", "advance", "Advance"),
        ("u", "regress", "Move Back"),
        ("a", "add_company", "Add"),
        ("n", "edit_notes", "Notes"),
        ("d", "delete_company", "Delete"),
    ]

    CSS = """
    CareerScreen { layout: vertical; }
    #career-header { height: 1; dock: top; padding: 0 1; }
    #career-list { height: 1fr; border: round cyan; padding: 0 1; }
    #career-help { height: 1; dock: bottom; padding: 0 1; }
    """

    def __init__(self, app_ref):
        super().__init__()
        self.app_ref = app_ref

    def compose(self) -> ComposeResult:
        yield Static(id="career-header")
        self.list_view = VimListView(id="career-list")
        yield self.list_view
        yield Static("a: add   space: advance   u: move back   n: notes   d: delete   esc/q: back",
                      id="career-help", classes="dim")

    def on_mount(self):
        self.rebuild()
        self.list_view.focus()

    def rebuild(self):
        state = self.app_ref.state
        prev_index = self.list_view.index if self.list_view.index is not None else 0
        self.list_view.clear()
        companies = tc.list_companies(state)
        items = [CompanyItem(i, c) for i, c in enumerate(companies)]
        if items:
            self.list_view.extend(items)
            self.list_view.index = min(prev_index, len(items) - 1)
        counts = tc.career_funnel_counts(state)
        parts = []
        for s in tc.CAREER_STATUSES:
            color = CAREER_STATUS_COLORS.get(s, "white")
            parts.append((f"{tc.CAREER_STATUS_LABELS[s]} {counts[s]}   ", f"bold {color}"))
        header = Text.assemble(*parts)
        header.justify = "center"
        self.query_one("#career-header", Static).update(header)

    def current_item(self):
        hc = self.list_view.highlighted_child
        return hc if isinstance(hc, CompanyItem) else None

    def action_close(self):
        self.dismiss()

    def _cycle(self, delta):
        item = self.current_item()
        if item is None:
            return
        companies = tc.list_companies(self.app_ref.state)
        statuses = tc.CAREER_STATUSES
        cur = companies[item.idx].get("status", "applied")
        pos = statuses.index(cur) if cur in statuses else 0
        new_pos = max(0, min(len(statuses) - 1, pos + delta))
        tc.set_company_status(self.app_ref.state, item.idx, statuses[new_pos])
        tc.save_state(self.app_ref.state)
        self.rebuild()

    def action_advance(self):
        self._cycle(1)

    def action_regress(self):
        self._cycle(-1)

    def action_add_company(self):
        def on_result(value):
            if not value:
                return
            tc.add_company(self.app_ref.state, value)
            tc.save_state(self.app_ref.state)
            self.rebuild()

        self.app.push_screen(TextPromptScreen("New company", ""), on_result)

    def action_edit_notes(self):
        item = self.current_item()
        if item is None:
            return
        companies = tc.list_companies(self.app_ref.state)
        current = companies[item.idx].get("notes", "")

        def on_result(value):
            if value is None:
                return
            tc.set_company_notes(self.app_ref.state, item.idx, value)
            tc.save_state(self.app_ref.state)
            self.rebuild()

        self.app.push_screen(TextPromptScreen(f"Notes for {companies[item.idx]['name']}", current), on_result)

    def action_delete_company(self):
        item = self.current_item()
        if item is None:
            return
        tc.delete_company(self.app_ref.state, item.idx)
        tc.save_state(self.app_ref.state)
        self.rebuild()


# ---- Knowledge Vault screen ---------------------------------------------------

class NoteItem(ListItem):
    def __init__(self, idx, note):
        self.idx = idx
        super().__init__(Label(self._render_note(note)))

    def _render_note(self, note):
        header = Text(note["title"], style="bold cyan")
        first_line = note["body"].strip().splitlines()[0] if note["body"].strip() else "(empty)"
        body = Text(first_line[:50], style="dim")
        return Group(header, body)


class VaultScreen(Screen):
    BINDINGS = [
        ("escape", "close", "Back"),
        ("q", "close", "Back"),
        ("a", "add_note", "Add"),
        ("d", "delete_note", "Delete"),
        ("/", "focus_search", "Search"),
        ("e", "focus_editor", "Edit"),
    ]

    CSS = """
    VaultScreen { layout: vertical; }
    #vault-search { dock: top; }
    #vault-body { height: 1fr; }
    #vault-list { width: 1fr; border: round cyan; padding: 0 1; }
    #vault-editor { width: 2fr; border: round magenta; }
    #vault-help { height: 1; dock: bottom; padding: 0 1; }
    """

    def __init__(self, app_ref):
        super().__init__()
        self.app_ref = app_ref
        self.current_idx = None

    def compose(self) -> ComposeResult:
        yield Input(placeholder="/ to search notes...", id="vault-search")
        with Horizontal(id="vault-body"):
            self.list_view = VimListView(id="vault-list")
            yield self.list_view
            self.editor = TextArea(id="vault-editor")
            yield self.editor
        yield Static("a: add   d: delete   e: edit body   /: search   esc/q: back",
                      id="vault-help", classes="dim")

    def on_mount(self):
        self.rebuild()
        self.list_view.focus()

    def rebuild(self, query=""):
        state = self.app_ref.state
        prev_index = self.list_view.index if self.list_view.index is not None else 0
        self.list_view.clear()
        results = tc.search_notes(state, query)
        items = [NoteItem(i, n) for i, n in results]
        if items:
            self.list_view.extend(items)
            self.list_view.index = min(prev_index, len(items) - 1)
            self._load_editor(items[self.list_view.index].idx)
        else:
            self._load_editor(None)

    def _load_editor(self, idx):
        self.current_idx = idx
        if idx is None:
            self.editor.load_text("")
            return
        self.editor.load_text(tc.list_notes(self.app_ref.state)[idx]["body"])

    def on_list_view_highlighted(self, message: ListView.Highlighted):
        item = message.item
        if isinstance(item, NoteItem):
            self._load_editor(item.idx)

    def on_input_changed(self, event: Input.Changed):
        if event.input.id == "vault-search":
            self.rebuild(event.value)

    def on_text_area_changed(self, event: TextArea.Changed):
        if self.current_idx is not None:
            tc.set_note_body(self.app_ref.state, self.current_idx, self.editor.text)
            tc.save_state(self.app_ref.state)

    def action_close(self):
        self.dismiss()

    def action_focus_search(self):
        self.query_one("#vault-search", Input).focus()

    def action_focus_editor(self):
        self.editor.focus()

    def current_item(self):
        hc = self.list_view.highlighted_child
        return hc if isinstance(hc, NoteItem) else None

    def action_add_note(self):
        def on_result(value):
            if not value:
                return
            tc.add_note(self.app_ref.state, value)
            tc.save_state(self.app_ref.state)
            self.rebuild()
            self.list_view.index = len(self.list_view.children) - 1

        self.app.push_screen(TextPromptScreen("New note title", ""), on_result)

    def action_delete_note(self):
        item = self.current_item()
        if item is None:
            return
        tc.delete_note(self.app_ref.state, item.idx)
        tc.save_state(self.app_ref.state)
        self.rebuild()


# ---- Help / cheat sheet screen ------------------------------------------------

HELP_SECTIONS = [
    ("Global", [
        ("q", "Quit the app"),
        ("r", "Refresh all panels"),
        ("f", "Toggle Focus Mode -- hides the board + stats, keeps Active Task/Pomodoro/Spotify/Animation. Auto-starts the animation if one isn't already playing."),
        ("c", "Open the Career CRM"),
        ("v", "Open the Knowledge Vault"),
        ("A", "Add a new field (category) -- writes to goals.json, live-reloads immediately"),
        ("?", "Show this cheat sheet"),
    ]),
    ("Pomodoro", [
        ("p", "Start/pause the pomodoro timer"),
        ("x", "Reset the pomodoro timer"),
        ("t", "Edit the pomodoro work/break length (e.g. 25/5)"),
    ]),
    ("Spotify", [
        ("m", "Play/pause"),
        ("[", "Previous track"),
        ("]", "Next track"),
        ("+ / -", "Volume up/down"),
        ("P", "Paste a playlist/album/track link and play it"),
    ]),
    ("Animation (under the Spotify box, also plays in Focus Mode)", [
        ("g", "Start/stop the animation (renders + plays the default clip on first use)"),
        ("G", "Pick a different clip, or add a new one from a file path"),
    ]),
    ("Kanban Board (Backlog / Todo / In Progress / Done)", [
        ("h / l", "Move focus between columns"),
        ("j / k", "Move focus between cards in a column"),
        ("space", "Advance the highlighted card to the next column"),
        ("u", "Send the highlighted card back one column"),
        ("t", "Edit a card's text (locked on fixed-label categories)"),
        ("n", "Edit a card's notes"),
        ("a", "Add a new card -- always asks which field, with a \"+ New field...\" option to create one on the spot"),
        ("d", "Delete the highlighted card"),
    ]),
    ("Career CRM (press c to open)", [
        ("space", "Advance status: Applied -> OA -> Interview -> Offer"),
        ("u", "Move status back a step"),
        ("a", "Add a company"),
        ("n", "Edit notes for the highlighted company"),
        ("d", "Delete the highlighted company"),
        ("esc / q", "Back to the board"),
    ]),
    ("Knowledge Vault (press v to open)", [
        ("/", "Focus the search box -- filters notes live as you type"),
        ("e", "Focus the note editor"),
        ("a", "Add a new note"),
        ("d", "Delete the highlighted note"),
        ("esc / q", "Back to the board"),
    ]),
    ("Text prompt popups", [
        ("enter", "Save"),
        ("escape", "Cancel"),
    ]),
]


class HelpScreen(Screen):
    BINDINGS = [("escape", "close", "Back"), ("q", "close", "Back"), ("?", "close", "Back")]

    CSS = """
    HelpScreen { align: center middle; }
    #help-box {
        width: 92; height: auto; max-height: 90%; border: round cyan;
        padding: 1 2; background: $panel; overflow-y: auto;
    }
    """

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                yield Static(self._build_help(), id="help-box")

    def _build_help(self):
        sections = [Text("Keybindings Cheat Sheet", style="bold underline", justify="center"), Text("")]
        for title, rows in HELP_SECTIONS:
            table = Table.grid(padding=(0, 2))
            table.add_column(width=10)
            table.add_column()
            for key, desc in rows:
                table.add_row(Text(key, style="bold gold3"), Text(desc))
            sections.append(Text(title, style="bold cyan"))
            sections.append(table)
            sections.append(Text(""))
        sections.append(Text("esc / q / ?  --  close this cheat sheet", style="dim italic", justify="center"))
        return Group(*sections)

    def action_close(self):
        self.dismiss()


# ---- Kanban board (main screen) ---------------------------------------------
# Cards are individual blocks from every category scheduled today, bucketed into
# 4 columns purely by status + origin: unfinished blocks carried in from previous
# days sit in Backlog until you touch them; a block's own status (todo/in_progress/
# done) places it in the other 3 once you start or finish it.

KANBAN_COLUMNS = [
    ("backlog", "Backlog"),
    (tc.STATUS_TODO, "Todo"),
    (tc.STATUS_IN_PROGRESS, "In Progress"),
    (tc.STATUS_DONE, "Done"),
]


def kanban_column(row):
    status = row["block"].get("status", tc.STATUS_TODO)
    if status in (tc.STATUS_IN_PROGRESS, tc.STATUS_DONE):
        return status
    if row["carried"]:
        return "backlog"
    return tc.STATUS_TODO


class CardItem(ListItem):
    def __init__(self, row):
        self.date_key = row["date_key"]
        self.category = row["category"]
        self.idx = row["idx"]
        self.carried = row["carried"]
        self.origin_date = row["date"]
        super().__init__(Label(self._render_card(row["block"])))

    def _render_card(self, block):
        color = CATEGORY_COLORS.get(self.category, "white")
        tag = tc.CATEGORY_META[self.category]["label"].split(" ")[0].split("/")[0]
        header = Text(f" {tag} ", style=f"bold white on {color}")
        if self.carried:
            header.append(f"  ↩ {self.origin_date.strftime('%a %d')}", style="dim italic")
        note_flag = "  \U0001F4DD" if block.get("notes") else ""
        text = block["text"] or "(empty -- press t)"
        body = Text(f"{text}{note_flag}", style="dim" if not block["text"] else "")
        return Group(header, body, Text(""))


class KanbanColumnList(VimListView):
    BINDINGS = [("space", "select_cursor", "Advance")]

    def __init__(self, column_key):
        super().__init__(id=f"kanban-list-{column_key}")
        self.column_key = column_key


class KanbanBoard(Horizontal):
    BINDINGS = [
        ("h", "focus_prev_column", "Prev Col"),
        ("l", "focus_next_column", "Next Col"),
        ("u", "regress_card", "Move Back"),
        ("t", "edit_text", "Edit text"),
        ("n", "edit_notes", "Notes"),
        ("a", "add_card", "Add"),
        ("d", "delete_card", "Delete"),
    ]

    def __init__(self, app_ref):
        super().__init__(id="kanban-board")
        self.app_ref = app_ref
        self.lists = {}

    def compose(self) -> ComposeResult:
        for key, label in KANBAN_COLUMNS:
            with Vertical(classes="kanban-col"):
                yield Static(f"{label} (0)", classes="kanban-col-header", id=f"kanban-header-{key}")
                lv = KanbanColumnList(key)
                self.lists[key] = lv
                yield lv

    def on_mount(self):
        self.rebuild()

    def rebuild(self):
        state = self.app_ref.state
        today = self.app_ref.today
        buckets = {key: [] for key, _ in KANBAN_COLUMNS}
        for category in tc.categories_for_day(today):
            for row in tc.blocks_for_category(state, category, today):
                buckets[kanban_column(row)].append(row)
        for key, label in KANBAN_COLUMNS:
            lv = self.lists[key]
            prev_index = lv.index if lv.index is not None else 0
            lv.clear()
            items = [CardItem(row) for row in buckets[key]]
            if items:
                lv.extend(items)
                lv.index = min(prev_index, len(items) - 1)
            self.query_one(f"#kanban-header-{key}", Static).update(f"{label} ({len(items)})")

    def focused_list(self):
        focused = self.app.focused
        return focused if isinstance(focused, KanbanColumnList) else None

    def current_card(self):
        lv = self.focused_list()
        if lv is None:
            return None
        hc = lv.highlighted_child
        return hc if isinstance(hc, CardItem) else None

    def action_focus_prev_column(self):
        self._shift_focus(-1)

    def action_focus_next_column(self):
        self._shift_focus(1)

    def _shift_focus(self, delta):
        keys = [key for key, _ in KANBAN_COLUMNS]
        lv = self.focused_list()
        cur = keys.index(lv.column_key) if lv is not None else 0
        target = keys[(cur + delta) % len(keys)]
        self.lists[target].focus()

    def on_list_view_selected(self, message: ListView.Selected):
        item = message.item
        if not isinstance(item, CardItem):
            return
        tc.advance_status(self.app_ref.state, item.date_key, item.category, item.idx)
        tc.save_state(self.app_ref.state)
        self.rebuild()
        self.app_ref.refresh_side_panels()

    def action_regress_card(self):
        item = self.current_card()
        if item is None:
            return
        tc.regress_status(self.app_ref.state, item.date_key, item.category, item.idx)
        tc.save_state(self.app_ref.state)
        self.rebuild()
        self.app_ref.refresh_side_panels()

    def action_edit_text(self):
        item = self.current_card()
        if item is None:
            return
        meta = tc.CATEGORY_META[item.category]
        if meta["fixed_labels"] is not None:
            self.app_ref.toast("This category's card text is fixed.", style="bold yellow")
            return
        current = self.app_ref.state[item.date_key][item.category][item.idx]["text"]

        def on_result(value):
            if value is None:
                return
            tc.set_block_text(self.app_ref.state, item.date_key, item.category, item.idx, value)
            tc.save_state(self.app_ref.state)
            self.rebuild()

        self.app.push_screen(TextPromptScreen(f"Edit text ({meta['label']})", current), on_result)

    def action_edit_notes(self):
        item = self.current_card()
        if item is None:
            return
        meta = tc.CATEGORY_META[item.category]
        if not meta["notes"]:
            self.app_ref.toast("This category doesn't support notes.", style="bold yellow")
            return
        current = self.app_ref.state[item.date_key][item.category][item.idx].get("notes", "")

        def on_result(value):
            if value is None:
                return
            tc.set_block_notes(self.app_ref.state, item.date_key, item.category, item.idx, value)
            tc.save_state(self.app_ref.state)
            self.rebuild()

        self.app.push_screen(TextPromptScreen("Notes", current), on_result)

    def action_add_card(self):
        """Always asks which field the new card belongs to -- never silently inferred
        from whatever card happens to be highlighted, so 'a' never surprises you by
        landing on the wrong field. Picking "+ New field..." creates a field on the spot
        and immediately asks for its first card, so DSA-style "create field, then add
        sub-cards to it" is a single flow."""
        categories = tc.categories_for_day(self.app_ref.today)

        def on_pick(category):
            if category is None:
                return
            if category == CategoryPickScreen.ADD_NEW:
                self.app_ref.create_field(on_created=self._add_card_to_category)
                return
            self._add_card_to_category(category)

        if not categories:
            self.app_ref.create_field(on_created=self._add_card_to_category)
            return
        self.app.push_screen(CategoryPickScreen(categories), on_pick)

    def _add_card_to_category(self, category):
        meta = tc.CATEGORY_META[category]
        if not meta["addable"]:
            self.app_ref.toast(f"{meta['label']} doesn't support adding cards.", style="bold yellow")
            return
        key = self.app_ref.today.isoformat()

        def on_result(value):
            if value is None:
                return
            tc.add_block(self.app_ref.state, key, category, value)
            tc.save_state(self.app_ref.state)
            self.rebuild()
            self.app_ref.refresh_side_panels()

        self.app.push_screen(TextPromptScreen(f"New {meta['label']} card", ""), on_result)

    def action_delete_card(self):
        item = self.current_card()
        if item is None:
            return
        meta = tc.CATEGORY_META[item.category]
        if not meta["deletable"]:
            self.app_ref.toast(f"{meta['label']} cards can't be deleted.", style="bold yellow")
            return
        tc.delete_block(self.app_ref.state, item.date_key, item.category, item.idx)
        tc.save_state(self.app_ref.state)
        self.rebuild()
        self.app_ref.refresh_side_panels()


# ---- Side panels -------------------------------------------------------------

class StatsPanel(Static):
    def update_content(self, state, today):
        monday = today - datetime.timedelta(days=today.weekday())
        cat_table = Table.grid(padding=(0, 1))
        cat_table.add_column()
        cat_table.add_column()
        for category in tc.CATEGORY_ORDER:
            done, total = 0, 0
            d = monday
            while d <= today:
                key = d.isoformat()
                blocks = state.get(key, {}).get(category, [])
                total += len(blocks)
                done += sum(1 for b in blocks if tc.is_done(b))
                d += datetime.timedelta(days=1)
            if total == 0:
                continue
            color = CATEGORY_COLORS.get(category, "white")
            label = tc.CATEGORY_META[category]["label"]
            cat_table.add_row(Text(f"{label:<22}", style=f"bold {color}"), bar(done, total, width=16, color=color))

        current, longest = tc.compute_day_streaks(state, today)
        total_done, total_tasks, tracked_days = tc.compute_alltime_totals(state)
        rate = round(total_done / total_tasks * 100) if total_tasks else 0
        score, _ = tc.compute_daily_score(state, today)
        focus_seconds = tc.total_focus_seconds_today(state, today)
        focus_h, focus_rem = divmod(int(focus_seconds), 3600)
        focus_m = focus_rem // 60
        stats = Table.grid(padding=(0, 2))
        stats.add_column()
        stats.add_column(justify="right")
        score_color = "bright_green" if score >= 80 else "bright_yellow" if score >= 50 else "bright_red"
        stats.add_row("Score Today", Text(f"{score}/100", style=f"bold {score_color}"))
        stats.add_row("Focus Time", Text(f"{focus_h}h {focus_m}m", style="bold bright_blue"))
        stats.add_row("Current Streak", Text(f"{current}d", style="bold bright_green" if current else "dim"))
        stats.add_row("Longest Streak", Text(f"{longest}d", style="bold gold3"))
        stats.add_row("All-Time", Text(f"{total_done}/{total_tasks} ({rate}%)", style="bold cyan"))
        stats.add_row("Pomodoros Today", Text(str(tc.get_pomodoro_count(state, today)), style="bold orange3"))

        body = Group(Text("This Week", style="bold underline"), cat_table, Text(""),
                      Text("Productivity", style="bold underline"), stats)
        self.update(Panel(body, border_style="magenta", box=box.ROUNDED))


class CalendarPanel(Static):
    def update_content(self, state, today):
        grid = tc.compute_month_heatmap(state, today.year, today.month)
        table = Table.grid(padding=(0, 1))
        for _ in range(7):
            table.add_column(justify="center", width=3)
        table.add_row(*[Text(d, style="bold dim") for d in ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]])
        for week in grid:
            cells = []
            for day_num, done, total in week:
                if day_num is None:
                    cells.append(Text(""))
                    continue
                d = datetime.date(today.year, today.month, day_num)
                status = tc.day_status(state, d, today)
                color = STATUS_COLORS[status]
                style = f"bold {color}" if d != today else f"bold reverse {color}"
                cells.append(Text(f"{day_num:>2}", style=style))
            table.add_row(*cells)
        legend = Text.assemble(("Missed ", "bright_red"), ("Partial ", "bright_yellow"),
                                 ("Complete ", "bright_green"), ("Upcoming", "white"))
        self.update(Panel(Group(table, Text(""), legend), title=today.strftime("%B %Y"), border_style="blue", box=box.ROUNDED))


class ActiveTaskPanel(Static):
    def update_content(self, state, today):
        active = tc.current_active_task(state, today)
        if active is None:
            body = Text("No active task -- press space on a Todo card to start one.",
                         style="dim italic", justify="center")
        else:
            blk = active["block"]
            color = CATEGORY_COLORS.get(active["category"], "white")
            tag = tc.CATEGORY_META[active["category"]]["label"]
            elapsed = tc.task_elapsed_seconds(blk)
            mins = int(elapsed) // 60
            body = Group(
                Text(f"▶ {tag}", style=f"bold {color}", justify="center"),
                Text(blk["text"] or "(untitled)", style="bold bright_white", justify="center"),
                Text(f"{mins}m focus time", style="dim", justify="center"),
            )
        self.update(Panel(body, title="Active Task", border_style="bright_white", box=box.ROUNDED))


class PomodoroPanel(Static):
    remaining = reactive(tc.DEFAULT_POMODORO_MINUTES * 60)
    running = reactive(False)
    on_break = reactive(False)
    work_minutes = reactive(tc.DEFAULT_POMODORO_MINUTES)
    break_minutes = reactive(tc.DEFAULT_BREAK_MINUTES)

    def render_panel(self, sessions_today):
        mins, secs = divmod(max(self.remaining, 0), 60)
        state_label = "PAUSED" if not self.running else ("BREAK" if self.on_break else "FOCUS")
        color = "bright_yellow" if not self.running else ("cyan" if self.on_break else "bright_green")
        body = Group(
            Text(f"{mins:02d}:{secs:02d}", style=f"bold {color}", justify="center"),
            Text(f"{state_label}  ({self.work_minutes}/{self.break_minutes})", style=f"bold {color}", justify="center"),
            Text(f"Sessions today: {sessions_today}", style="dim", justify="center"),
            Text(""),
            Text("p: start/pause   x: reset   t: edit", style="dim italic", justify="center"),
        )
        self.update(Panel(body, title="Pomodoro", border_style="orange3", box=box.ROUNDED))


DEFAULT_ANIM_FPS = 8


class SpotifyPanel(Static):
    """Now-playing display (song/artist/progress) merged with the chafa-rendered
    animation (see animation.py) into one panel, no controls/volume clutter -- Spotify
    playback keys (m/[/]/+/-/P) still work, they just aren't drawn as an icon row
    anymore. The animation fills all space below the progress bar and re-renders itself
    (via TodoApp.maybe_rerender_for_resize) whenever the panel is resized, so it always
    fits the actual terminal size instead of being pinned to a fixed resolution."""

    def __init__(self):
        super().__init__()
        self.last_info = dict(_SPOTIFY_EMPTY)
        self.frames = []
        self.frame_idx = 0
        self.running = False
        self.loading = False
        self.current_name = None
        self.rendered_size = None
        self._resize_timer = None
        self.render_panel()

    def refresh_spotify_info(self):
        """Cheap 1Hz refresh of song metadata -- deliberately separate from tick() so the
        (much faster) animation frame loop never shells out to osascript on every frame."""
        self.last_info = spotify_track()
        self.render_panel()

    def load(self, name, frames):
        self.current_name = name
        self.frames = frames
        self.frame_idx = 0
        self.running = True
        self.loading = False
        self.render_panel()

    def stop(self):
        self.running = False
        self.render_panel()

    def tick(self):
        if self.running and self.frames:
            self.frame_idx = (self.frame_idx + 1) % len(self.frames)
        self.render_panel()

    def on_resize(self, event):
        if self._resize_timer is not None:
            self._resize_timer.stop()
        self._resize_timer = self.set_timer(0.6, self._resize_settled)

    def _resize_settled(self):
        if self.current_name:
            self.app.maybe_rerender_for_resize(self.current_name)

    def animation_target_size(self):
        """Character-cell size available for the animation right now, based on the
        panel's live size minus the fixed header/footer rows and Panel border+padding.
        Rounded to an even number to keep the on-disk render cache from growing one
        entry per single-pixel resize."""
        width = max(10, self.size.width - 4)
        height = max(3, self.size.height - 12)
        width -= width % 2
        height -= height % 2
        return max(10, width), max(3, height)

    def render_panel(self):
        self.update(self._build_panel())

    def _build_panel(self):
        info = self.last_info
        header = [
            Text("NOW PLAYING", style="bold dim", justify="center"),
            Text(""),
            Text(info["song"], style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(info["artist"], style="bold grey70", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(""),
        ]
        if info["duration"] > 0:
            prog = _progress_bar(info["position"], info["duration"])
            header.append(Text(f"{prog} {_fmt_mmss(info['position'])} / {_fmt_mmss(info['duration'])}",
                                style="cyan", justify="center"))
            header.append(Text(""))

        footer = [
            Text(""),
            Text("m play/pause  [ prev  ] next  +/- volume  P play url", style="dim italic", justify="center"),
            Text("g start/stop animation    G pick/add clip", style="dim italic", justify="center"),
        ]

        avail_h = max(1, self.size.height - 2 - len(header) - len(footer))

        if self.loading:
            lines = [Text("Rendering animation...", style="dim italic", justify="center")]
        elif self.frames:
            frame_text = Text.from_ansi(self.frames[self.frame_idx])
            lines = list(frame_text.split("\n", allow_blank=True))
            for line in lines:
                line.justify = "center"
            if not self.running:
                lines.append(Text(f"({self.current_name} -- stopped)", style="dim italic", justify="center"))
        else:
            lines = [Text("g: start animation    G: pick/add a clip", style="dim italic", justify="center")]

        pad = max(0, avail_h - len(lines))
        top_pad, bottom_pad = pad // 2, pad - pad // 2
        lines = [Text("")] * top_pad + lines + [Text("")] * bottom_pad

        return Panel(Group(*header, *lines, *footer), title="Spotify", border_style="green", box=box.ROUNDED)


class ClockHeader(Static):
    def update_clock(self):
        now = datetime.datetime.now().strftime("%I:%M:%S %p")
        today = tc.get_today()
        self.update(Text(f" {tc.APP_NAME}    {tc.DAY_NAMES[today.weekday()]}, {today.strftime('%b %d, %Y')}    {now} ",
                          style="bold white on rgb(40,20,60)", justify="center"))


class ToastLine(Static):
    def show(self, text, style="dim"):
        self.update(Text(text, style=style))


# ---- Main app -----------------------------------------------------------------

class TodoApp(App):
    CSS = """
    Screen { layout: vertical; }
    #main { height: 1fr; }
    #kanban-board { width: 3fr; }
    .kanban-col { width: 1fr; height: 1fr; margin: 0 1 0 0; }
    .kanban-col-header { height: 1; text-style: bold; text-align: center; padding: 0 1; }
    #kanban-header-backlog { color: grey; }
    #kanban-header-todo { color: cyan; }
    #kanban-header-in_progress { color: gold; }
    #kanban-header-done { color: green; }
    #kanban-list-backlog { border: round grey; }
    #kanban-list-todo { border: round cyan; }
    #kanban-list-in_progress { border: round gold; }
    #kanban-list-done { border: round green; }
    KanbanColumnList { height: 1fr; padding: 0 1; }
    #right-col { width: 1fr; overflow-y: auto; }
    PomodoroPanel, ActiveTaskPanel { height: auto; }
    StatsPanel, CalendarPanel { height: auto; }
    #stats-scroll, #calendar-scroll { height: auto; max-height: 8; }
    SpotifyPanel { height: 1fr; }
    ClockHeader { height: 1; dock: top; }
    ToastLine { height: 1; dock: top; padding: 0 1; }
    ListItem { padding: 0; }
    """
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("p", "toggle_pomodoro", "Start/Pause Pomodoro"),
        ("x", "reset_pomodoro", "Reset Pomodoro"),
        ("t", "edit_pomodoro", "Edit Pomodoro"),
        ("r", "refresh_all", "Refresh"),
        ("f", "toggle_focus_mode", "Focus Mode"),
        ("c", "open_career", "Career"),
        ("v", "open_vault", "Vault"),
        ("?", "open_help", "Help"),
        ("m", "spotify_toggle", "Spotify"),
        ("[", "spotify_prev", "Prev"),
        ("]", "spotify_next", "Next"),
        ("+", "spotify_volume_up", "Vol+"),
        ("-", "spotify_volume_down", "Vol-"),
        ("P", "spotify_play_url", "Play URL"),
        ("A", "add_field", "Add Field"),
        ("g", "animation_toggle", "Start/Stop Animation"),
        ("G", "animation_pick", "Pick Animation"),
    ]

    def __init__(self):
        super().__init__()
        self.today = tc.get_today()
        self.state = tc.load_state()
        self.state = tc.ensure_day_registered(self.state, self.today)
        self.focus_mode = False
        self.anim_fps = DEFAULT_ANIM_FPS
        self.anim_chafa_args = ""
        self._anim_timer = None
        try:
            self._goals_mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            self._goals_mtime = None

    def compose(self) -> ComposeResult:
        yield ClockHeader()
        yield ToastLine()
        with Horizontal(id="main"):
            self.kanban = KanbanBoard(self)
            yield self.kanban
            with Vertical(id="right-col"):
                self.stats_scroll = VerticalScroll(id="stats-scroll")
                with self.stats_scroll:
                    self.stats_panel = StatsPanel()
                    yield self.stats_panel
                self.calendar_scroll = VerticalScroll(id="calendar-scroll")
                with self.calendar_scroll:
                    self.calendar_panel = CalendarPanel()
                    yield self.calendar_panel
                self.active_task_panel = ActiveTaskPanel()
                yield self.active_task_panel
                self.pomo_panel = PomodoroPanel()
                yield self.pomo_panel
                self.spotify_panel = SpotifyPanel()
                yield self.spotify_panel
        yield Footer()

    def on_mount(self):
        saved = tc.maybe_autosave_daily_report(self.state, self.today)
        self.refresh_side_panels()
        if saved:
            self.toast(f"Auto-saved yesterday's report -> {saved}", style="bold cyan")
        self.kanban.lists[tc.STATUS_TODO].focus()
        self.set_interval(1.0, self.on_second_tick)
        self.set_interval(2.0, self.check_goals_file)
        self._anim_timer = self.set_interval(1.0 / self.anim_fps, self.spotify_panel.tick)

    def toast(self, text, style="dim"):
        self.query_one(ToastLine).show(text, style)

    def refresh_side_panels(self):
        self.stats_panel.update_content(self.state, self.today)
        self.calendar_panel.update_content(self.state, self.today)
        self.active_task_panel.update_content(self.state, self.today)
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))
        self.spotify_panel.refresh_spotify_info()

    def check_goals_file(self):
        """Polled every 2s: if goals.json changed on disk since we last read it (hand-edited,
        or written by another mtdo process/action_add_field below), reload it into the running
        app -- no restart needed. goals.json is the single source of truth; this makes the
        live app always match whatever's currently on disk."""
        try:
            mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            return
        if self._goals_mtime is not None and mtime == self._goals_mtime:
            return
        self._goals_mtime = mtime
        self.reload_from_goals(toast_on_change=True)

    def reload_from_goals(self, toast_on_change=False):
        try:
            goals = appconfig.load_goals()
        except FileNotFoundError:
            return
        cfg, _, _ = appconfig.goals_to_config(goals)
        tc.configure(cfg)
        CATEGORY_COLORS.update(_build_category_colors())
        self.state = tc.ensure_day_registered(self.state, self.today)
        tc.save_state(self.state)
        self.kanban.rebuild()
        self.refresh_side_panels()
        try:
            self._goals_mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            pass
        if toast_on_change:
            self.toast("goals.json changed -- reloaded", style="bold cyan")

    def action_add_field(self):
        """Create a brand new top-level category (e.g. a new subject/track) from inside
        the app, with no follow-up card prompt. See create_field() for the shared flow --
        the 'a' add-card picker's "+ New field..." option uses the same flow but chains
        into immediately adding the field's first card."""
        self.create_field()

    def create_field(self, on_created=None):
        """Prompts for a new field's name + label, writes it to goals.json (the source of
        truth) and reloads from it so the field shows up immediately and survives a
        restart. If on_created is given, it's called with the new field's slug afterward
        (used to chain straight into adding that field's first card)."""

        def on_name(name):
            if not name:
                return
            slug = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower()).strip("_")
            if not slug:
                self.toast("Invalid field name.", style="bold red")
                return
            if slug in tc.CATEGORY_META:
                self.toast(f"Field '{slug}' already exists.", style="bold yellow")
                return

            def on_label(label):
                label = (label or name).strip()
                new_category = {
                    "name": slug,
                    "label": label,
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "min_blocks": 0,
                    "addable": True,
                    "deletable": True,
                    "notes": True,
                    "score_weight": 10,
                    "curriculum": [],
                }
                try:
                    appconfig.add_category_to_goals(new_category)
                except (FileNotFoundError, ValueError) as e:
                    self.toast(str(e), style="bold red")
                    return
                self.reload_from_goals()
                self.toast(f"Added field: {label}", style="bold green")
                if on_created:
                    on_created(slug)

            self.push_screen(TextPromptScreen("Display label for this field", name), on_label)

        self.push_screen(TextPromptScreen("New field name (short id, e.g. 'networking')", ""), on_name)

    # ---- Animation (merged into SpotifyPanel, see animation.py) --------------

    def action_animation_toggle(self):
        """g: if a clip is already loaded, start/stop it in place. Otherwise render and
        play the default clip (first run) so 'g' alone is enough to get something going."""
        sp = self.spotify_panel
        if sp.frames:
            if sp.running:
                sp.stop()
                self.toast("Animation stopped", style="dim")
            else:
                sp.running = True
                sp.render_panel()
                self.toast(f"Playing {sp.current_name}", style="bold green")
            return
        names = anim.list_animations()
        if not names:
            self.toast("No animations available -- press G to add one", style="bold yellow")
            return
        self.start_animation(names[0])

    def action_animation_pick(self):
        """G: choose which clip to play, or add a new one from a file path. Adding a new
        clip also lets you set its framerate and chafa symbol style (anifetch-style flags:
        -r/--framerate, -ca/-c/--chafa-arguments). -W/-H/-s/--sound are recognized but
        ignored -- render size always fits the live panel, and audio always comes from
        Spotify itself, never the clip."""
        names = anim.list_animations()

        def on_pick(name):
            if name is None:
                return
            if name == AnimationPickScreen.ADD_NEW:
                def on_path(path):
                    if not path:
                        return
                    try:
                        new_name = anim.add_animation_file(path)
                    except (FileNotFoundError, ValueError) as e:
                        self.toast(str(e), style="bold red")
                        return

                    def on_options(opts):
                        fps, chafa_args = _parse_anim_options(opts)
                        self.start_animation(new_name, fps=fps, chafa_args=chafa_args)

                    self.push_screen(
                        TextPromptScreen(
                            'Render options, e.g. -r 20 -ca "--symbols wide --fg-only" (blank = defaults)', ""
                        ),
                        on_options,
                    )
                self.push_screen(TextPromptScreen("Path to a video/gif file", ""), on_path)
                return
            self.start_animation(name)

        self.push_screen(AnimationPickScreen(names), on_pick)

    def _set_anim_fps(self, fps):
        fps = max(1, min(fps, 30))
        if fps == self.anim_fps:
            return
        self.anim_fps = fps
        if self._anim_timer is not None:
            self._anim_timer.stop()
        self._anim_timer = self.set_interval(1.0 / self.anim_fps, self.spotify_panel.tick)

    def start_animation(self, name, fps=None, chafa_args=None):
        """Kicks off background rendering (ffmpeg + chafa, can take a couple seconds on
        first play, instant afterward from cache) and plays the clip once ready. Render
        size is always the live SpotifyPanel size -- see animation_target_size()."""
        chafa_ok, ffmpeg_ok = anim.check_deps()
        if not (chafa_ok and ffmpeg_ok):
            missing = [t for t, ok in (("chafa", chafa_ok), ("ffmpeg", ffmpeg_ok)) if not ok]
            self.toast(f"Animation needs {' + '.join(missing)} installed (brew install {' '.join(missing)})",
                       style="bold red")
            return
        if fps:
            self._set_anim_fps(fps)
        if chafa_args is not None:
            self.anim_chafa_args = chafa_args
        width, height = self.spotify_panel.animation_target_size()
        self.spotify_panel.loading = True
        self.spotify_panel.render_panel()
        self.toast(f"Rendering {name}...", style="bold cyan")
        self.run_worker(
            lambda: self._render_animation(name, width, height, self.anim_fps, self.anim_chafa_args),
            thread=True, exclusive=True, group="anim_render",
        )

    def maybe_rerender_for_resize(self, name):
        """Called by SpotifyPanel after its resize settles. Re-renders at the new size
        only if a resize actually changed the target size for the currently-playing clip
        -- avoids re-rendering on every resize event during a drag."""
        sp = self.spotify_panel
        if not sp.frames or sp.current_name != name:
            return
        width, height = sp.animation_target_size()
        if sp.rendered_size == (width, height):
            return
        self.start_animation(name)

    def _render_animation(self, name, width, height, fps, chafa_args):
        try:
            frames = anim.get_frames(name, width=width, height=height, fps=fps, chafa_args=chafa_args)
        except Exception as e:
            self.call_from_thread(self._animation_failed, str(e))
            return
        self.call_from_thread(self._animation_ready, name, frames, width, height)

    def _animation_ready(self, name, frames, width, height):
        self.spotify_panel.rendered_size = (width, height)
        self.spotify_panel.load(name, frames)
        self.toast(f"Playing {name}", style="bold green")

    def _animation_failed(self, message):
        self.spotify_panel.loading = False
        self.spotify_panel.render_panel()
        self.toast(f"Animation render failed: {message}", style="bold red")

    def on_second_tick(self):
        self.query_one(ClockHeader).update_clock()
        self.spotify_panel.refresh_spotify_info()
        self.active_task_panel.update_content(self.state, self.today)
        if self.pomo_panel.running:
            if self.pomo_panel.remaining > 0:
                self.pomo_panel.remaining -= 1
            else:
                if not self.pomo_panel.on_break:
                    tc.increment_pomodoro(self.state, self.today)
                    self.pomo_panel.on_break = True
                    self.pomo_panel.remaining = self.pomo_panel.break_minutes * 60
                else:
                    self.pomo_panel.on_break = False
                    self.pomo_panel.remaining = self.pomo_panel.work_minutes * 60
                    self.pomo_panel.running = False
                self.refresh_side_panels()
            self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))

    def action_toggle_pomodoro(self):
        self.pomo_panel.running = not self.pomo_panel.running
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))

    def action_reset_pomodoro(self):
        self.pomo_panel.running = False
        self.pomo_panel.on_break = False
        self.pomo_panel.remaining = self.pomo_panel.work_minutes * 60
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))

    def action_refresh_all(self):
        self.kanban.rebuild()
        self.refresh_side_panels()

    def _set_pomodoro_length(self, work_minutes, break_minutes):
        self.pomo_panel.work_minutes = work_minutes
        self.pomo_panel.break_minutes = break_minutes
        if not self.pomo_panel.running:
            self.pomo_panel.on_break = False
            self.pomo_panel.remaining = work_minutes * 60
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))

    def action_edit_pomodoro(self):
        def on_result(value):
            if not value:
                return
            work_str, _, break_str = value.partition("/")
            try:
                work_minutes = int(work_str.strip())
                break_minutes = int(break_str.strip()) if break_str.strip() else self.pomo_panel.break_minutes
            except ValueError:
                self.toast("Invalid format -- use e.g. 25/5", style="bold yellow")
                return
            if work_minutes <= 0 or break_minutes <= 0:
                self.toast("Minutes must be positive", style="bold yellow")
                return
            self._set_pomodoro_length(work_minutes, break_minutes)
            self.toast(f"Pomodoro set to {work_minutes}/{break_minutes}", style="bold green")

        current = f"{self.pomo_panel.work_minutes}/{self.pomo_panel.break_minutes}"
        self.push_screen(TextPromptScreen("Work/break minutes (e.g. 25/5)", current), on_result)

    def action_toggle_focus_mode(self):
        self.focus_mode = not self.focus_mode
        show = not self.focus_mode
        self.kanban.display = show
        self.stats_scroll.display = show
        self.calendar_scroll.display = show
        if self.focus_mode:
            if not self.pomo_panel.running:
                self._set_pomodoro_length(45, 10)
                self.pomo_panel.running = True
            if self.spotify_panel.frames and not self.spotify_panel.running:
                self.spotify_panel.running = True
                self.spotify_panel.render_panel()
            elif not self.spotify_panel.frames:
                names = anim.list_animations()
                if names:
                    self.start_animation(names[0])
        elif not self.pomo_panel.running:
            self._set_pomodoro_length(tc.DEFAULT_POMODORO_MINUTES, tc.DEFAULT_BREAK_MINUTES)
        self.toast("Focus Mode ON -- 45/10 pomodoro started, press f to exit" if self.focus_mode else "Focus Mode off",
                   style="bold bright_green" if self.focus_mode else "dim")

    def action_open_career(self):
        self.push_screen(CareerScreen(self), callback=lambda _r=None: self.refresh_side_panels())

    def action_open_vault(self):
        self.push_screen(VaultScreen(self), callback=lambda _r=None: self.refresh_side_panels())

    def action_open_help(self):
        self.push_screen(HelpScreen())

    def action_spotify_toggle(self):
        spotify_play_pause()

    def action_spotify_prev(self):
        spotify_previous()

    def action_spotify_next(self):
        spotify_next()

    def action_spotify_volume_up(self):
        spotify_volume_up()

    def action_spotify_volume_down(self):
        spotify_volume_down()

    def action_spotify_play_url(self):
        def on_result(value):
            if not value:
                return
            if spotify_play_url(value):
                self.toast(f"Playing: {value[:60]}", style="bold green")
            else:
                self.toast("Not a Spotify link -- left current playback alone.", style="bold yellow")

        self.push_screen(TextPromptScreen("Paste a Spotify playlist/album/track link", ""), on_result)


def run_app(cfg):
    """Configures the core engine + this module's derived state (category colors) from
    the user's config, then runs the TUI. This is the one entry point cli.py calls."""
    tc.configure(cfg)
    CATEGORY_COLORS.update(_build_category_colors())
    TodoApp().run()


if __name__ == "__main__":
    from . import config as appconfig
    run_app(appconfig.load_config())
