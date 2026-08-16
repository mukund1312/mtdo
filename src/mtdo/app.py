#!/usr/bin/env python3
"""One merged live app: a 4-column Kanban board (Backlog / Todo / In Progress / Done)
of today's cards, vim-navigable (h/l columns, j/k cards, space to advance, u to send
back, t/n/a/d to edit/note/add/delete), plus live 12h clock, calendar, streaks,
standalone pomodoro timer, and a Spotify now-playing panel. Categories, curriculum,
and goal all come from the user's config -- see config.py.
Run via the `mtdo` command (see cli.py), or `python3 -m mtdo.app` directly.
"""
import datetime
import math
import os
import re
import subprocess

from . import core as tc

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, Center, Middle
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


def _volume_bar(volume, width=10):
    return _block_bar((volume or 0) / 100, width)


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
        ("f", "Toggle Focus Mode -- hides the board + stats, keeps Active Task/Pomodoro/Spotify"),
        ("c", "Open the Career CRM"),
        ("v", "Open the Knowledge Vault"),
        ("?", "Show this cheat sheet"),
    ]),
    ("Pomodoro", [
        ("p", "Start/pause the pomodoro timer"),
        ("x", "Reset the pomodoro timer"),
    ]),
    ("Spotify", [
        ("m", "Play/pause"),
        ("[", "Previous track"),
        ("]", "Next track"),
        ("+ / -", "Volume up/down"),
        ("P", "Paste a playlist/album/track link and play it"),
    ]),
    ("Kanban Board (Backlog / Todo / In Progress / Done)", [
        ("h / l", "Move focus between columns"),
        ("j / k", "Move focus between cards in a column"),
        ("space", "Advance the highlighted card to the next column"),
        ("u", "Send the highlighted card back one column"),
        ("t", "Edit a card's text (locked on fixed-label categories)"),
        ("n", "Edit a card's notes"),
        ("a", "Add a new card (same category as the highlighted card)"),
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
        header = Text(tag, style=f"bold {color}")
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
        item = self.current_card()
        category = item.category if item is not None else "jobs"
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
            Text("p: start/pause   x: reset", style="dim italic", justify="center"),
        )
        self.update(Panel(body, title="Pomodoro", border_style="orange3", box=box.ROUNDED))


FLUID_WIDTH = 20
FLUID_HEIGHT = 5


class SpotifyPanel(Static):
    frame = 0

    def _generate_fluid(self):
        chars = ["░", "▒", "▓", "█"]
        cx, cy = (FLUID_WIDTH - 1) / 2, (FLUID_HEIGHT - 1) / 2
        pulse = 0.5 + 0.5 * math.sin(self.frame * 0.3)
        rows = []
        for y in range(FLUID_HEIGHT):
            line = ""
            for x in range(FLUID_WIDTH):
                dx, dy = (x - cx) / cx, (y - cy) / cy
                dist = math.sqrt(dx * dx + dy * dy) - pulse * 0.3
                line += chars[3 if dist < 0.25 else 2 if dist < 0.5 else 1 if dist < 0.75 else 0]
            rows.append(line)
        self.frame += 1
        return Text("\n".join(rows), style="bright_blue", justify="center")

    def update_content(self):
        info = spotify_track()
        icon = "⏸" if info["state"] == "playing" else "▶"
        controls = Text.assemble(("[⏮] ", "bold white"), (f"[{icon}] ", "bold bright_green"), ("[⏭]", "bold white"))
        controls.justify = "center"

        rows = [
            Text("NOW PLAYING", style="bold dim", justify="center"),
            Text(""),
            Text(info["song"], style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(info["artist"], style="bold grey70", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(""),
        ]
        if info["duration"] > 0:
            prog = _progress_bar(info["position"], info["duration"])
            rows.append(Text(f"{prog} {_fmt_mmss(info['position'])} / {_fmt_mmss(info['duration'])}",
                              style="cyan", justify="center"))
            rows.append(Text(""))
        if info["volume"] is not None:
            vol = _volume_bar(info["volume"])
            rows.append(Text(f"\U0001F50A {vol} {info['volume']}%", style="dim", justify="center"))
            rows.append(Text(""))
        rows.append(self._generate_fluid())
        rows.append(Text(""))
        rows.append(controls)
        rows.append(Text(""))
        rows.append(Text("[ prev    m play/pause    ] next    P: play a link", style="dim italic", justify="center"))
        rows.append(Text("-  vol down    +  vol up", style="dim italic", justify="center"))
        self.update(Panel(Group(*rows), title="Spotify", border_style="green", box=box.ROUNDED))


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
    #right-col { width: 1fr; }
    StatsPanel, CalendarPanel, PomodoroPanel, ActiveTaskPanel { height: auto; }
    SpotifyPanel { height: 1fr; }
    ClockHeader { height: 1; dock: top; }
    ToastLine { height: 1; dock: top; padding: 0 1; }
    ListItem { padding: 0; }
    """
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("p", "toggle_pomodoro", "Start/Pause Pomodoro"),
        ("x", "reset_pomodoro", "Reset Pomodoro"),
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
    ]

    def __init__(self):
        super().__init__()
        self.today = tc.get_today()
        self.state = tc.load_state()
        self.state = tc.ensure_day_registered(self.state, self.today)
        self.focus_mode = False

    def compose(self) -> ComposeResult:
        yield ClockHeader()
        yield ToastLine()
        with Horizontal(id="main"):
            self.kanban = KanbanBoard(self)
            yield self.kanban
            with Vertical(id="right-col"):
                self.stats_panel = StatsPanel()
                yield self.stats_panel
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

    def toast(self, text, style="dim"):
        self.query_one(ToastLine).show(text, style)

    def refresh_side_panels(self):
        self.stats_panel.update_content(self.state, self.today)
        self.calendar_panel.update_content(self.state, self.today)
        self.active_task_panel.update_content(self.state, self.today)
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))
        self.spotify_panel.update_content()

    def on_second_tick(self):
        self.query_one(ClockHeader).update_clock()
        self.spotify_panel.update_content()
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

    def action_toggle_focus_mode(self):
        self.focus_mode = not self.focus_mode
        show = not self.focus_mode
        self.kanban.display = show
        self.stats_panel.display = show
        self.calendar_panel.display = show
        if self.focus_mode:
            if not self.pomo_panel.running:
                self._set_pomodoro_length(45, 10)
                self.pomo_panel.running = True
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
