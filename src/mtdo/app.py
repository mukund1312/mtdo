#!/usr/bin/env python3
"""One merged live app: a 4-column Kanban board (Backlog / Todo / In Progress / Done)
of today's cards, vim-navigable (h/l columns, j/k cards, space to advance, u to send
back, t/n/a/d to edit/note/add/delete), plus live 12h clock, calendar, streaks,
standalone pomodoro timer, a now-playing music panel, and a Learning Coach panel that
surfaces study/interview-prep guidance for whichever task is currently in progress.
Categories, curriculum, and goal all come from the user's config -- see config.py.
Run via the `mtdo` command (see cli.py), or `python3 -m mtdo.app` directly.
"""
import datetime
import os
import re
import subprocess

from . import core as tc
from . import config as appconfig
from . import coaching
from . import ai_backend
from . import music
from . import plan_wizard
from .claude_panel import ClaudePanel
from .errorlog import LOG_PATH, log as app_log

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


# ---- Spotify (fallback path -- see music.py for the primary nowplaying-cli path) -------

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


class AIBackendPickScreen(ModalScreen):
    """Modal: choose which AI backend runs in the Focus Mode assistant panel, shown
    every time C starts a fresh session -- Claude Code, a local Ollama model, or an
    API-key web chat are never silently auto-picked, so you always know and choose
    what's about to run. Only lists options ai_backend.list_available() confirms are
    actually usable right now (rather than a wishlist); if none are, shows the same
    "what to set up" guidance the panel itself would. Dismisses with the chosen
    (command, label) tuple, or None on Escape."""

    CSS = """
    AIBackendPickScreen { align: center middle; }
    #ai-pick-box { width: 60; height: auto; max-height: 20; border: round green; padding: 1 2; background: $panel; }
    """

    def __init__(self, options, remembered=None):
        super().__init__()
        self.options = options
        commands = [command for command, _label in options]
        self.preselect = commands.index(remembered[0]) if remembered and remembered[0] in commands else 0

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="ai-pick-box"):
                    if self.options:
                        yield Static("Start which AI assistant? (last choice pre-selected)")
                        items = [
                            ListItem(Label(label), name=str(i))
                            for i, (_command, label) in enumerate(self.options)
                        ]
                        yield VimListView(*items, initial_index=self.preselect)
                        yield Static("Enter to pick, Escape to cancel", classes="dim")
                    else:
                        yield Static(ai_backend.NOTHING_CONFIGURED_MESSAGE)
                        yield Static("Escape to close", classes="dim")

    def on_mount(self):
        if self.options:
            self.query_one(VimListView).focus()

    def on_list_view_selected(self, event: ListView.Selected):
        self.dismiss(self.options[int(event.item.name)])

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class PersonaPickScreen(ModalScreen):
    """Modal: first step of the plan-setup wizard (g) -- which of plan_wizard.PERSONAS
    you are, since the curated question set that follows differs by stage of life.
    Dismisses with the persona's key (e.g. "college"), or None on Escape."""

    CSS = """
    PersonaPickScreen { align: center middle; }
    #persona-pick-box { width: 60; height: auto; border: round magenta; padding: 1 2; background: $panel; }
    """

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="persona-pick-box"):
                    yield Static("Set up a plan -- which describes you best?")
                    items = [
                        ListItem(Label(label), name=key)
                        for key, label in plan_wizard.PERSONAS
                    ]
                    yield VimListView(*items)
                    yield Static("Enter to pick, Escape to cancel", classes="dim")

    def on_mount(self):
        self.query_one(VimListView).focus()

    def on_list_view_selected(self, event: ListView.Selected):
        self.dismiss(event.item.name)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class WeeklyMenuScreen(ModalScreen):
    """'a' opens here whenever there's a curriculum menu to pick from (see
    core.get_weekly_menu): every item due this week, across every curriculum field, in
    one list. Already-picked items (on today's board, or sitting undone in the backlog
    from earlier this week) show grayed-out and struck-through -- you can look at them but
    not re-pick them. Space toggles selection on an unpicked item; the "Add N selected"
    row (updates live as you toggle) commits them all to today's board at once. "+ Type my
    own card..." and "+ New field..." stay available as escape hatches for anything not on
    the menu. Dismisses with a dict describing what to do, or None on Escape."""

    ROW_CUSTOM = "__custom__"
    ROW_NEW_FIELD = "__new_field__"
    ROW_CONFIRM = "__confirm__"

    CSS = """
    WeeklyMenuScreen { align: center middle; }
    #menu-box { width: 78; height: auto; max-height: 34; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self, entries):
        """entries: list of (category, item_index, text, already_picked)."""
        super().__init__()
        self.entries = entries
        self.picked_lookup = {(c, i): picked for c, i, _text, picked in entries}
        self.selected = set()

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="menu-box"):
                    yield Static("This Week's Menu", classes="dim")
                    self.lv = VimListView()
                    yield self.lv
                    yield Static("space: toggle    enter: choose row    escape: cancel", classes="dim")

    def on_mount(self):
        self.rebuild()
        self.lv.focus()

    def rebuild(self):
        prev_index = self.lv.index if self.lv.index is not None else 0
        self.lv.clear()
        items = []
        for category, idx, text, picked in self.entries:
            color = CATEGORY_COLORS.get(category, "white")
            tag = tc.CATEGORY_META[category]["label"].split(" ")[0].split("/")[0]
            badge = Text(f" {tag} ", style=f"bold white on {color}")
            if picked:
                body = Text.assemble(badge, "  ", ("✓ " + text, "dim strike"), "  (already in your plate)")
            else:
                mark = "[x]" if (category, idx) in self.selected else "[ ]"
                body = Text.assemble(badge, f"  {mark} ", text)
            items.append(ListItem(Label(body), name=f"menu:{category}:{idx}"))
        items.append(ListItem(
            Label(Text(f"✔ Add {len(self.selected)} selected", style="bold green")), name=self.ROW_CONFIRM))
        items.append(ListItem(Label(Text("+ Type my own card...", style="bold cyan")), name=self.ROW_CUSTOM))
        items.append(ListItem(Label(Text("+ New field...", style="bold magenta")), name=self.ROW_NEW_FIELD))
        self.lv.extend(items)
        if items:
            self.lv.index = min(prev_index, len(items) - 1)

    def _toggle_highlighted(self):
        item = self.lv.highlighted_child
        if item is None or not item.name or not item.name.startswith("menu:"):
            return
        _, category, idx_s = item.name.split(":")
        key = (category, int(idx_s))
        if self.picked_lookup.get(key):
            return
        if key in self.selected:
            self.selected.discard(key)
        else:
            self.selected.add(key)
        self.rebuild()

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)
        elif event.key == "space":
            self._toggle_highlighted()
            event.stop()

    def on_list_view_selected(self, event: ListView.Selected):
        name = event.item.name
        if name == self.ROW_CONFIRM:
            self.dismiss({"action": "confirm", "picks": list(self.selected)})
        elif name == self.ROW_CUSTOM:
            self.dismiss({"action": "custom"})
        elif name == self.ROW_NEW_FIELD:
            self.dismiss({"action": "new_field"})
        elif name and name.startswith("menu:"):
            self._toggle_highlighted()


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

    def rebuild(self, query="", select_index=None):
        """select_index picks where the cursor lands after rebuilding -- defaults to
        staying near wherever it was (clamped to the new, possibly-shorter list). Always
        computed from `items` (our own just-built data), never from
        self.list_view.children -- that count doesn't reliably reflect clear()/extend()
        yet at this point (they're processed on Textual's message queue, not
        synchronously), so indexing off it can desync the ListView's cursor from its
        actual node list and crash on the next navigation."""
        state = self.app_ref.state
        prev_index = self.list_view.index if self.list_view.index is not None else 0
        target = prev_index if select_index is None else select_index
        self.list_view.clear()
        results = tc.search_notes(state, query)
        items = [NoteItem(i, n) for i, n in results]
        if items:
            self.list_view.extend(items)
            self.list_view.index = min(max(target, 0), len(items) - 1)
            self._load_editor(items[self.list_view.index].idx)
        else:
            self._load_editor(None)

    def _load_editor(self, idx):
        notes = tc.list_notes(self.app_ref.state)
        if idx is None or idx >= len(notes):
            # Defensive: idx can go stale (e.g. a NoteItem holding an index from before
            # a note was deleted elsewhere) -- never crash the whole app over a display
            # desync, just show nothing rather than raise.
            self.current_idx = None
            self.editor.load_text("")
            return
        self.current_idx = idx
        self.editor.load_text(notes[idx]["body"])

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
            # Jump to the new (last) note -- computed from our own data length via
            # rebuild()'s select_index, not from list_view.children (see rebuild()'s
            # docstring for why that's unsafe).
            self.rebuild(select_index=len(tc.list_notes(self.app_ref.state)))

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
        ("f", "Toggle Focus Mode -- hides the board + stats, keeps Active Task/Pomodoro/Music/Learning Coach + AI panel"),
        ("C", "Open the AI assistant panel (auto-enters Focus Mode) -- pick Claude Code, a local Ollama model, or Claude/ChatGPT/Gemini via API"),
        ("c", "Open the Career CRM"),
        ("v", "Open the Knowledge Vault"),
        ("A", "Add a new field (category) -- writes to goals.json, live-reloads immediately"),
        ("?", "Show this cheat sheet"),
        ("w", "Replay the first-launch walkthrough"),
        ("g", "Set up a plan -- a short Q&A, then hands a crafted prompt to the AI panel to design your goals.json"),
    ]),
    ("Pomodoro", [
        ("p", "Start/pause the pomodoro timer"),
        ("x", "Reset the pomodoro timer"),
        ("t", "Edit the pomodoro work/break length (e.g. 25/5)"),
    ]),
    ("Music", [
        ("m", "Play/pause"),
        ("[", "Previous track"),
        ("]", "Next track"),
        ("+ / -", "Volume up/down"),
        ("P", "Paste a Spotify playlist/album/track link and play it"),
    ]),
    ("Learning Coach (under the Now Playing box; shares a row with the AI panel in Focus Mode)", [
        ("space", "Start a card (in_progress) to activate the coach for it"),
        ("scroll", "Mouse-wheel/trackpad scroll to see the full coaching content"),
    ]),
    ("AI Assistant panel (Focus Mode only)", [
        ("C", "Start/focus it -- opens a picker the first time, remembers your last choice"),
        ("esc esc", "Double-tap Escape to release keyboard focus without ending the session"),
        ("F2", "Also releases focus (for keyboards that send real F-keys)"),
    ]),
    ("Kanban Board (Backlog / Todo / In Progress / Done)", [
        ("h / l", "Move focus between columns"),
        ("j / k", "Move focus between cards in a column"),
        ("space", "Advance the highlighted card to the next column"),
        ("u", "Send the highlighted card back one column"),
        ("t", "Edit a card's text (locked on fixed-label categories)"),
        ("n", "Edit a card's notes"),
        ("a", "Open this week's menu (space to select, one or several) -- or type a free-text card / create a new field"),
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


# ---- First-launch walkthrough -------------------------------------------------
# A short, skippable, game-tutorial-style tour: one idea per screen, paged through
# with space/enter/arrows, shown automatically the first time mtdo ever runs (see
# appconfig.has_onboarded()) and replayable any time with w. Each step's body is a
# list of either plain strings (a paragraph) or (key, description) tuples (a styled
# keybinding row) -- OnboardingScreen renders whichever it finds.

ONBOARDING_STEPS = [
    ("Welcome to mtdo", [
        "mtdo is a terminal task board built for deliberate practice, not busywork.",
        "This is a quick tour of everything it can do -- a few short steps, "
        "space/enter/-> to move forward, <- to go back.",
        "Escape skips straight to the board any time. Replay this later with w.",
    ]),
    ("The Board", [
        "Your main screen is a kanban board -- one column per subject you're "
        "tracking (a “field”), cut across four lanes: Backlog, Todo, "
        "In Progress, Done.",
        ("h / l", "move between columns"),
        ("j / k", "move between cards"),
        ("space", "advance the highlighted card to the next lane"),
        ("u", "send it back a lane"),
    ]),
    ("Adding Cards", [
        ("a", "add a card"),
        "Fields with a curriculum open this week's whole menu to pick from -- "
        "space selects one or several at once, the rest wait until you get to them.",
        ("t", "edit a card's text"),
        ("n", "edit a card's notes"),
        ("d", "delete a card"),
    ]),
    ("Focus Mode", [
        ("f", "toggle Focus Mode"),
        "Hides the board and weekly stats, starts a 45/10 pomodoro automatically, "
        "and gives the screen to your Active Task, Pomodoro, Music, the Learning "
        "Coach, and the AI panel.",
    ]),
    ("Learning Coach", [
        "Whatever card is In Progress, the Coach shows guidance for it -- what to "
        "focus on, questions to ask yourself, common mistakes, mental models.",
        "Not entertainment -- every panel here earns its space by helping you get "
        "better at what you're actually studying.",
        "Content can run long -- scroll it with your mouse wheel or trackpad.",
    ]),
    ("AI Assistant Panel", [
        ("Shift+C", "start or focus the AI panel (auto-enters Focus Mode)"),
        "A real terminal session embedded right in the app -- Claude Code, a local "
        "Ollama model, or Claude/ChatGPT/Gemini over their own API, your pick from a menu.",
        ("esc esc", "double-tap Escape to release keyboard focus without ending the session"),
    ]),
    ("Pomodoro & Music", [
        ("p / x / t", "start-pause / reset / edit the pomodoro's work-break length"),
        ("m", "play/pause -- whatever's in macOS's Now Playing, or Spotify"),
        ("[ / ]", "previous / next track"),
        ("+ / -", "volume up/down"),
    ]),
    ("Career CRM & Knowledge Vault", [
        ("c", "Career CRM -- track companies Applied -> OA -> Interview -> Offer"),
        ("v", "Knowledge Vault -- a searchable notes vault, separate from card notes"),
    ]),
    ("Stats, Streaks & Weekly Reports", [
        "The right side of the board tracks your daily score, current/longest "
        "streak, and a month calendar heatmap.",
        "Every Saturday: a week summary toast, plus a detailed report saved to "
        "~/.mtdo/reports/ -- hand it to an AI assistant for real coaching on "
        "consistency, not just a percentage.",
    ]),
    ("You're Set", [
        ("?", "the full keybinding cheat sheet, any time"),
        ("w", "replay this walkthrough any time"),
        ("Shift+A", "add a brand new field on the spot"),
        "Your whole plan lives in goals.json -- run `mtdo template` for a "
        "fully-commented one to fill in yourself or hand to an AI assistant.",
    ]),
]


class OnboardingScreen(ModalScreen):
    BINDINGS = [
        ("escape", "skip", "Skip"),
        ("enter", "next", "Next"),
        ("space", "next", "Next"),
        ("right", "next", "Next"),
        ("l", "next", "Next"),
        ("left", "back", "Back"),
        ("h", "back", "Back"),
    ]

    CSS = """
    OnboardingScreen { align: center middle; }
    #onboarding-box {
        width: 80; height: auto; max-height: 90%; background: $panel;
    }
    """

    def __init__(self):
        super().__init__()
        self.step = 0

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                yield Static(self._render_step(), id="onboarding-box")

    def _render_step(self):
        n = len(ONBOARDING_STEPS)
        title, body = ONBOARDING_STEPS[self.step]

        dots = Text(justify="center")
        for i in range(n):
            dots.append("●" if i == self.step else "○",
                        style="bold magenta" if i == self.step else "dim")
            if i < n - 1:
                dots.append(" ")

        rows = [dots, Text(""), Text(title, style="bold underline", justify="center"), Text("")]
        for item in body:
            if isinstance(item, tuple):
                key, desc = item
                rows.append(Text.assemble((f"  {key:<9}", "bold gold3"), desc))
            else:
                rows.append(Text(item))
            rows.append(Text(""))

        last = self.step == n - 1
        nav_parts = []
        if self.step > 0:
            nav_parts.append("← back")
        if not last:
            nav_parts.append("esc skip")
        nav_parts.append("enter/space/→ " + ("start using mtdo" if last else "next"))
        rows.append(Text("   ".join(nav_parts), style="dim italic", justify="center"))

        return Panel(Group(*rows), title=f"Walkthrough  {self.step + 1}/{n}",
                     border_style="magenta", box=box.ROUNDED)

    def _refresh(self):
        self.query_one("#onboarding-box", Static).update(self._render_step())

    def action_next(self):
        if self.step < len(ONBOARDING_STEPS) - 1:
            self.step += 1
            self._refresh()
        else:
            self.dismiss()

    def action_back(self):
        if self.step > 0:
            self.step -= 1
            self._refresh()

    def action_skip(self):
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
    if row["carried"] and not row["block"].get("claimed"):
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
        blk = self.app_ref.state[item.date_key][item.category][item.idx]
        if item.carried and not blk.get("claimed") and blk.get("status", tc.STATUS_TODO) == tc.STATUS_TODO:
            # Currently showing in Backlog -- claim it into Todo first; don't skip
            # straight to In Progress on the very first press.
            tc.claim_backlog_card(self.app_ref.state, item.date_key, item.category, item.idx)
        else:
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
        """If any curriculum field has a weekly menu (picked or not), 'a' opens that menu
        first -- see WeeklyMenuScreen. Otherwise (no curriculum anywhere yet) it falls
        straight back to the plain field-picker + free-text flow."""
        state = self.app_ref.state
        today = self.app_ref.today
        entries = []
        for category in tc.CATEGORY_ORDER:
            for idx, item in enumerate(tc.get_weekly_menu(state, today, category)):
                entries.append((category, idx, item["text"], item["picked"]))

        if not entries:
            self._open_field_picker_for_custom_card()
            return

        def on_result(result):
            if result is None:
                return
            if result["action"] == "confirm":
                picks = sorted(result["picks"])
                added = sum(1 for category, idx in picks if tc.pick_menu_item(state, today, category, idx))
                if added:
                    tc.save_state(state)
                    self.rebuild()
                    self.app_ref.refresh_side_panels()
                    self.app_ref.toast(f"Added {added} card(s) from this week's menu", style="bold green")
            elif result["action"] == "custom":
                self._open_field_picker_for_custom_card()
            elif result["action"] == "new_field":
                self.app_ref.create_field(on_created=self._add_card_to_category)

        self.app.push_screen(WeeklyMenuScreen(entries), on_result)

    def _open_field_picker_for_custom_card(self):
        """Escape hatch for a free-text card not on any menu -- always asks which field,
        never silently inferred from whatever's highlighted."""
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
            appconfig.append_extra_task(category, value)
            self.app_ref.mark_goals_write()
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
        week_progress = tc.compute_week_progress(state, today)
        cat_table = Table.grid(padding=(0, 1))
        cat_table.add_column()
        cat_table.add_column()
        for category in tc.CATEGORY_ORDER:
            done, total = week_progress.get(category, (0, 0))
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


class NowPlayingPanel(Static):
    """Compact now-playing display -- song/artist/progress only. Playback keys
    (m/[/]/+/-/P) still work, just not drawn as an icon row. Deliberately small
    (height: auto) -- MTDO isn't an entertainment app, music is background utility, not
    something that should compete with the Learning Coach panel below it for space.

    Controls whatever macOS's Now Playing session currently is (YouTube Music in a
    browser tab, Apple Music, VLC, Spotify, anything) via music.py's nowplaying-cli
    path when it's installed, falling back to Spotify-only AppleScript otherwise --
    see music.py for the full story. The title bar names whichever path is actually
    active, and the paste-a-link feature (P) stays Spotify-specific either way, since
    there's no universal equivalent for "play this exact link"."""

    def __init__(self):
        super().__init__()
        self.last_info = music.now_playing()
        self.render_panel()

    def refresh_music_info(self):
        self.last_info = music.now_playing()
        self.render_panel()

    def render_panel(self):
        info = self.last_info
        universal = music.has_nowplaying_cli()
        rows = [
            Text(info["song"], style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(info["artist"], style="grey70", justify="center", no_wrap=True, overflow="ellipsis"),
        ]
        if info["duration"] > 0:
            prog = _progress_bar(info["position"], info["duration"])
            rows.append(Text(f"{prog} {_fmt_mmss(info['position'])} / {_fmt_mmss(info['duration'])}",
                              style="cyan", justify="center"))
        if not universal:
            rows.append(Text(f"for YouTube Music/Apple Music/anything: {music.NOWPLAYING_INSTALL_HINT}",
                              style="dim italic", justify="center"))
        rows.append(Text("m play/pause  [ prev  ] next  +/- vol  P url", style="dim italic", justify="center"))
        title = "Now Playing" if universal else "Spotify"
        self.update(Panel(Group(*rows), title=title, border_style="green", box=box.ROUNDED))


class LearningCoachPanel(Static):
    """The panel animation used to occupy. MTDO isn't for entertainment -- every pixel
    should help the user get better. Shows coaching content for whichever task is
    currently in progress, most-specific source wins (see coaching.build_coaching_content):
    the task's own metadata, then the field's personalized coaching_framework in
    goals.json, then a built-in topic-appropriate fallback. Fills remaining space
    (height: 1fr)."""

    def update_content(self, state, today):
        active = tc.current_active_task(state, today)
        if active is None:
            self.update(self._idle_panel())
            return
        category_meta = tc.CATEGORY_META.get(active["category"])
        if not coaching.has_coaching_setup(active["block"], category_meta):
            self.update(self._no_coaching_panel(active["block"]["text"], category_meta))
            return
        content = coaching.build_coaching_content(active["block"], category_meta)
        self.update(self._coach_panel(active["block"]["text"], content))

    def _idle_panel(self):
        body = Group(
            Text(""),
            Text("No task in progress right now.", style="dim italic", justify="center"),
            Text("Press space on a card to start one --", style="dim italic", justify="center"),
            Text("the coach activates for whatever you're", style="dim italic", justify="center"),
            Text("actively working on.", style="dim italic", justify="center"),
        )
        return Panel(body, title="Learning Coach", border_style="magenta", box=box.ROUNDED)

    def _no_coaching_panel(self, task_text, category_meta):
        label = (category_meta or {}).get("label", "this field")
        body = Group(
            Text(task_text, style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(""),
            Text(f"No coaching content set up for {label} yet.", style="dim italic", justify="center"),
            Text("Add a topic_type or coaching_framework to this", style="dim italic", justify="center"),
            Text("field in goals.json to get guidance here.", style="dim italic", justify="center"),
        )
        return Panel(body, title="Learning Coach", border_style="magenta", box=box.ROUNDED)

    def _section(self, title, items):
        rows = [Text(title, style="bold cyan")]
        for item in items:
            rows.append(Text(f"  • {item}", style="white"))
        rows.append(Text(""))
        return rows

    def _coach_panel(self, task_text, content):
        rows = [
            Text(task_text, style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(""),
        ]
        rows += self._section("Focus On", content["focus_on"])
        rows += self._section("Ask Yourself", content["ask_yourself"])
        rows += self._section("Interview Check", content["interview_check"])
        rows += self._section("Common Mistakes", content["mistakes"])
        rows += self._section("Mental Models", content["mental_models"])
        if content["related_topics"]:
            rows.append(Text("Related Topics", style="bold cyan"))
            rows.append(Text(f"  {', '.join(content['related_topics'])}", style="white"))
            rows.append(Text(""))
        rows.append(Text("Pro Tip", style="bold cyan"))
        rows.append(Text(f"  {content['pro_tip']}", style="italic white"))
        rows.append(Text(""))
        rows.append(Text("🎯 If an interviewer stopped you now, could you explain this",
                          style="dim italic", justify="center"))
        rows.append(Text("for 5 minutes without notes? If no -- keep studying.",
                          style="dim italic", justify="center"))
        return Panel(Group(*rows), title="Learning Coach", border_style="magenta", box=box.ROUNDED)


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
    PomodoroPanel, ActiveTaskPanel, NowPlayingPanel { height: auto; }
    StatsPanel, CalendarPanel { height: auto; }
    #stats-scroll, #calendar-scroll { height: auto; max-height: 8; }
    #coach-claude-row { height: 1fr; }
    #coach-scroll { width: 1fr; height: 1fr; }
    LearningCoachPanel { height: auto; }
    ClaudePanel { width: 1fr; display: none; }
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
        ("m", "music_toggle", "Music"),
        ("[", "music_prev", "Prev"),
        ("]", "music_next", "Next"),
        ("+", "music_volume_up", "Vol+"),
        ("-", "music_volume_down", "Vol-"),
        ("P", "spotify_play_url", "Play Spotify URL"),
        ("A", "add_field", "Add Field"),
        ("C", "toggle_claude", "Claude Code"),
        ("w", "replay_walkthrough", "Walkthrough"),
        ("g", "plan_wizard", "Setup Plan"),
    ]

    def __init__(self):
        super().__init__()
        self.today = tc.get_today()
        self.state = tc.load_state()
        self.state = tc.ensure_day_registered(self.state, self.today)
        self.focus_mode = False
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
                self.music_panel = NowPlayingPanel()
                yield self.music_panel
                with Horizontal(id="coach-claude-row"):
                    self.coach_scroll = VerticalScroll(id="coach-scroll")
                    with self.coach_scroll:
                        self.coach_panel = LearningCoachPanel()
                        yield self.coach_panel
                    self.claude_panel = ClaudePanel()
                    yield self.claude_panel
        yield Footer()

    def on_mount(self):
        saved = tc.maybe_autosave_daily_report(self.state, self.today)
        self.refresh_side_panels()
        messages, style = [], "bold cyan"
        if saved:
            messages.append(f"Auto-saved yesterday's report -> {saved}")
        if self.today.weekday() == 5:  # Saturday -- the week's completion checkpoint
            check, all_done = self._weekly_check_summary()
            report_path = tc.save_weekly_report_txt(self.state, self.today)
            messages.append(f"{check}  (full report -> {report_path})")
            style = "bold green" if all_done else "bold yellow"
        if messages:
            self.toast("   |   ".join(messages), style=style)
        self.kanban.lists[tc.STATUS_TODO].focus()
        self.set_interval(1.0, self.on_second_tick)
        self.set_interval(2.0, self.check_goals_file)
        if not appconfig.has_onboarded():
            self.push_screen(OnboardingScreen(), callback=lambda _r=None: appconfig.mark_onboarded())

    def toast(self, text, style="dim"):
        self.query_one(ToastLine).show(text, style)

    def refresh_side_panels(self):
        self.stats_panel.update_content(self.state, self.today)
        self.calendar_panel.update_content(self.state, self.today)
        self.active_task_panel.update_content(self.state, self.today)
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))
        self.music_panel.refresh_music_info()
        self.coach_panel.update_content(self.state, self.today)

    def _weekly_check_summary(self):
        """Saturday's completion checkpoint: this week's done/total per field, using the
        same numbers as the Stats panel's weekly bars (see tc.compute_week_progress).
        Returns (summary_text, all_done)."""
        progress = tc.compute_week_progress(self.state, self.today)
        parts, all_done = [], True
        for category in tc.CATEGORY_ORDER:
            done, total = progress.get(category, (0, 0))
            if total == 0:
                continue
            label = tc.CATEGORY_META[category]["label"].split(" ")[0].split("/")[0]
            ok = done >= total
            all_done = all_done and ok
            parts.append(f"{label} {done}/{total}{'' if ok else ' ⚠'}")
        if not parts:
            return "Week check: nothing tracked yet this week.", True
        return "Week check (Sat): " + "  ".join(parts), all_done

    def mark_goals_write(self):
        """Call after writing to goals.json outside of reload_from_goals (e.g.
        append_extra_task) so the next check_goals_file poll doesn't mistake our own
        write for an external edit and fire a redundant "goals.json changed" toast --
        we already know what changed and don't need a full reconfigure for it."""
        try:
            self._goals_mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            pass

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
                meta = tc.CATEGORY_META[slug]
                today_wd = self.today.weekday()
                if today_wd in meta["days"]:
                    self.toast(f"Field '{slug}' already exists ({meta['label']}) -- "
                               f"look for it on the board.", style="bold yellow")
                else:
                    scheduled = ", ".join(tc.DAY_NAMES[d][:3] for d in sorted(meta["days"])) or "no days"
                    self.toast(f"Field '{slug}' already exists ({meta['label']}) but isn't "
                               f"scheduled today ({tc.DAY_NAMES[today_wd][:3]}) -- only shows up on "
                               f"{scheduled}. Edit goals.json's 'days' for it to change that.",
                               style="bold yellow")
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

    def on_second_tick(self):
        self.query_one(ClockHeader).update_clock()
        self.music_panel.refresh_music_info()
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
        self.claude_panel.display = self.focus_mode
        if self.focus_mode:
            if not self.pomo_panel.running:
                self._set_pomodoro_length(45, 10)
                self.pomo_panel.running = True
        else:
            if not self.pomo_panel.running:
                self._set_pomodoro_length(tc.DEFAULT_POMODORO_MINUTES, tc.DEFAULT_BREAK_MINUTES)
            if self.claude_panel.has_focus:
                self.claude_panel.blur()
        self.toast("Focus Mode ON -- 45/10 pomodoro started, press f to exit" if self.focus_mode else "Focus Mode off",
                   style="bold bright_green" if self.focus_mode else "dim")

    def action_toggle_claude(self):
        if not self.focus_mode:
            # C is how people reach for the assistant -- auto-enter Focus Mode instead
            # of just toasting an easy-to-miss "press f first" and leaving them to
            # press C again themselves.
            self.action_toggle_focus_mode()
        try:
            if self.claude_panel.has_focus:
                # Already in it -- C here means "step out", matching Esc Esc/F2.
                self.claude_panel.blur()
                return

            # Not focused, whether or not something's already running -- always show
            # the picker. It used to skip straight to focusing whatever was already
            # running, which meant there was no way back to this menu at all once
            # you'd started a session: Esc Esc released focus, but a second C just
            # refocused the same backend forever, with no path to switch to a
            # different one. Picking the SAME backend that's already running just
            # refocuses it (no restart, conversation intact); picking a different one
            # stops the old session and starts the new one.
            def start_backend(command, label):
                try:
                    if self.claude_panel.is_running and command == self.claude_panel.command:
                        self.claude_panel.focus()
                        return
                    ai_backend.save_choice(command, label)
                    if self.claude_panel.is_running:
                        self.claude_panel.stop()
                    self.claude_panel.start_with(command, label)
                    self.claude_panel.focus()
                except Exception:
                    app_log.exception("starting chosen AI backend failed")
                    self.toast(f"Claude Code panel hit an error -- see {LOG_PATH}", style="bold red")

            def on_model_name(model):
                model = (model or "").strip()
                if not model:
                    return
                start_backend(ai_backend.ollama_run_command(model), f"Ollama ({model})")

            def on_choice(choice):
                if choice is None:
                    return
                command, label = choice
                if command == ai_backend.PROMPT_CUSTOM_OLLAMA_MODEL:
                    self.push_screen(
                        TextPromptScreen(
                            "Which Ollama model? (e.g. llama3.2, mistral, qwen2.5:7b -- "
                            "see ollama.com/library)",
                        ),
                        on_model_name,
                    )
                    return
                start_backend(command, label)

            self.push_screen(
                AIBackendPickScreen(ai_backend.list_available(), remembered=ai_backend.load_choice()),
                on_choice,
            )
        except Exception:
            app_log.exception("action_toggle_claude failed")
            self.toast(f"Claude Code panel hit an error -- see {LOG_PATH}", style="bold red")

    def action_quit(self):
        try:
            self.claude_panel.stop()
        except Exception:
            app_log.exception("failed to stop claude panel on quit")
        self.exit()

    def _handle_exception(self, error: Exception) -> None:
        """Overrides Textual's private hook so any uncaught crash -- not just ones in
        the Claude panel -- lands in ~/.mtdo/error.log before the normal crash screen
        shows, since that screen (and its traceback) disappears the moment the
        terminal's alternate screen buffer closes."""
        app_log.error("mtdo crashed", exc_info=error)
        super()._handle_exception(error)

    def action_open_career(self):
        self.push_screen(CareerScreen(self), callback=lambda _r=None: self.refresh_side_panels())

    def action_open_vault(self):
        self.push_screen(VaultScreen(self), callback=lambda _r=None: self.refresh_side_panels())

    def action_open_help(self):
        self.push_screen(HelpScreen())

    def action_replay_walkthrough(self):
        self.push_screen(OnboardingScreen())

    def action_plan_wizard(self):
        def on_persona(persona):
            if persona is None:
                return
            questions = list(plan_wizard.questions_for(persona))
            self._ask_plan_wizard_questions(questions, {"persona": persona}, persona)

        self.push_screen(PersonaPickScreen(), on_persona)

    def _ask_plan_wizard_questions(self, questions, answers, persona):
        if not questions:
            self._finish_plan_wizard(persona, answers)
            return
        key, prompt_text = questions[0]
        rest = questions[1:]

        def on_answer(value):
            if value is None:
                self.toast("Plan setup cancelled -- nothing written.", style="dim")
                return
            answers[key] = value.strip()
            self._ask_plan_wizard_questions(rest, answers, persona)

        self.push_screen(TextPromptScreen(prompt_text, ""), on_answer)

    def _finish_plan_wizard(self, persona, answers):
        try:
            prompt = plan_wizard.build_prompt(persona, answers)
            path, copied = plan_wizard.save_and_copy(prompt)
        except Exception:
            app_log.exception("plan wizard failed to build/save prompt")
            self.toast(f"Plan setup hit an error -- see {LOG_PATH}", style="bold red")
            return
        if copied:
            self.toast(
                f"Copied to your clipboard -- press C, paste it (Cmd+V) into the AI panel, "
                f"and hit enter. Also saved to {path}.",
                style="bold green",
            )
        else:
            self.toast(f"Saved to {path} -- press C, then paste it into the AI panel.", style="bold yellow")

    def action_music_toggle(self):
        music.play_pause()

    def action_music_prev(self):
        music.previous_track()

    def action_music_next(self):
        music.next_track()

    def action_music_volume_up(self):
        music.volume_up()

    def action_music_volume_down(self):
        music.volume_down()

    def action_spotify_play_url(self):
        def on_result(value):
            if not value:
                return
            if music.play_spotify_url(value):
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
