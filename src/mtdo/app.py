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
import threading

from . import core as tc
from . import config as appconfig
from . import coaching
from . import ai_backend
from . import ai_ask
from . import music
from . import plan_wizard
from . import bug_log
from .claude_panel import ClaudePanel
from .practice_lab_panel import PracticeLabPanel
from .errorlog import LOG_PATH, log as app_log

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll, Center, Middle
from textual.widgets import Static, ListView, ListItem, Label, Input, Footer, TextArea, Button
from textual.screen import ModalScreen, Screen
from textual.reactive import reactive
from rich.text import Text
from rich.table import Table
from rich.console import Group
from rich.panel import Panel
from rich import box

_COLOR_PALETTE = ["magenta", "blue", "orange3", "green", "red3", "purple", "grey70",
                  "cyan", "gold3", "deep_pink3", "turquoise2", "dark_orange3"]

# Sandbox-only named-instance mode (see sandbox_entry.py) -- always unset/False for the
# real `mtdo` command, which never sets these env vars, so this is completely inert there.
# When set, action_quit shows a save/discard/cancel prompt instead of exiting immediately,
# and MTDO_INSTANCE_SCRATCH is the live scratch copy that gets promoted into
# ~/.mtdo-sandbox/instances/<slug> (save) or thrown away (discard).
SANDBOX_INSTANCE_MODE = os.environ.get("MTDO_INSTANCE_MODE") == "1"
_INSTANCE_SLUG = os.environ.get("MTDO_INSTANCE_SLUG") or None
_INSTANCE_NAME = os.environ.get("MTDO_INSTANCE_NAME", "")
_INSTANCE_DESCRIPTION = os.environ.get("MTDO_INSTANCE_DESCRIPTION", "")
_INSTANCE_SCRATCH = os.environ.get("MTDO_INSTANCE_SCRATCH")


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
    """Generic modal: shows a prompt + text input, returns the value (or None on Escape).

    multiline=True swaps the single-line Input for a TextArea sized to show ~12 lines
    with scroll (Ctrl+S to save, since Enter means newline in a TextArea) -- same fix as
    BugReportScreen's, for the same reason: a one-line box makes a longer free-text
    answer hard to review before submitting. Used for the setup wizard's free-text
    questions (some, like "what's your academic goal", can run long); left off (the
    default) for genuinely short answers like a name or a card title, where single-line
    is the right, unsurprising affordance and Enter-to-submit is worth keeping."""

    def __init__(self, prompt_text, initial="", multiline=False):
        super().__init__()
        self.prompt_text = prompt_text
        self.initial = initial
        self.multiline = multiline

    CSS = """
    TextPromptScreen { align: center middle; }
    #prompt-box { width: 70; height: auto; border: round magenta; padding: 1 2; background: $panel; }
    #prompt-box TextArea { height: 14; border: round grey; margin: 1 0; }
    """

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="prompt-box"):
                    yield Static(self.prompt_text)
                    if self.multiline:
                        yield TextArea(self.initial, id="prompt-textarea")
                        yield Static("Ctrl+S to save, Escape to cancel", classes="dim")
                    else:
                        yield Input(value=self.initial, id="prompt-input")
                        yield Static("Enter to save, Escape to cancel", classes="dim")

    def on_mount(self):
        if self.multiline:
            self.query_one(TextArea).focus()
        else:
            inp = self.query_one(Input)
            inp.focus()
            inp.cursor_position = len(inp.value)

    def on_input_submitted(self, event: Input.Submitted):
        self.dismiss(event.value)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)
        elif self.multiline and event.key == "ctrl+s":
            event.prevent_default()
            event.stop()
            self.dismiss(self.query_one(TextArea).text)


class SaveInstanceScreen(ModalScreen):
    """Sandbox-only: shown by TodoApp.action_quit instead of exiting immediately when
    SANDBOX_INSTANCE_MODE is set. A brand-new (never-saved) instance asks for a
    name+description before it can be saved; a re-entered one just confirms saving over
    the existing name. Dismisses with ("save", name, description), ("discard", None, None),
    or None on Cancel/Escape (stays in the app -- nothing is touched)."""

    CSS = """
    SaveInstanceScreen { align: center middle; }
    #save-box { width: 66; height: auto; border: round magenta; padding: 1 2; background: $panel; }
    #save-box Input { margin-bottom: 1; }
    #save-buttons { height: 3; align: center middle; }
    #save-buttons Button { margin: 0 1; }
    """

    def __init__(self, is_new, existing_name="", existing_description=""):
        super().__init__()
        self.is_new = is_new
        self.existing_name = existing_name
        self.existing_description = existing_description

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="save-box"):
                    if self.is_new:
                        yield Static("Save this test instance?")
                        yield Input(placeholder="Name", id="save-name")
                        yield Input(placeholder="Description (optional)", id="save-desc")
                    else:
                        yield Static(f'Save changes to "{self.existing_name}"?')
                    with Horizontal(id="save-buttons"):
                        yield Button("Save", id="save-yes", variant="primary")
                        yield Button("Discard", id="save-discard")
                        yield Button("Cancel", id="save-cancel")

    def on_mount(self):
        if self.is_new:
            self.query_one("#save-name", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save-yes":
            if self.is_new:
                name = self.query_one("#save-name", Input).value.strip()
                if not name:
                    self.query_one("#save-name", Input).focus()
                    return
                desc = self.query_one("#save-desc", Input).value.strip()
                self.dismiss(("save", name, desc))
            else:
                self.dismiss(("save", self.existing_name, self.existing_description))
        elif event.button.id == "save-discard":
            self.dismiss(("discard", None, None))
        else:
            self.dismiss(None)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class BugReportScreen(ModalScreen):
    """Sandbox-only bug capture (see TodoApp.action_report_bug, bound to 'B'). Uses a
    TextArea, not the single-line TextPromptScreen Input other prompts use -- a one-line
    box made it hard to see what you'd already typed once a bug description ran past a
    few words. Sized to show ~10 lines and scrolls for anything longer. Dismisses with the
    typed text, or None on Cancel/Escape (nothing is logged)."""

    CSS = """
    BugReportScreen { align: center middle; }
    #bug-box { width: 90; height: auto; border: round yellow; padding: 1 2; background: $panel; }
    #bug-box TextArea { height: 14; border: round grey; margin: 1 0; }
    #bug-buttons { height: 3; align: center middle; }
    #bug-buttons Button { margin: 0 1; }
    """

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="bug-box"):
                    yield Static("Describe the bug you just found")
                    yield TextArea(id="bug-text")
                    yield Static("Ctrl+S to save, Escape to cancel", classes="dim")
                    with Horizontal(id="bug-buttons"):
                        yield Button("Save", id="bug-save", variant="primary")
                        yield Button("Cancel", id="bug-cancel")

    def on_mount(self):
        self.query_one(TextArea).focus()

    def _submit(self):
        text = self.query_one(TextArea).text.strip()
        self.dismiss(text if text else None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "bug-save":
            self._submit()
        else:
            self.dismiss(None)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)
        elif event.key == "ctrl+s":
            event.prevent_default()
            event.stop()
            self._submit()


class HintPromptScreen(ModalScreen):
    """Popped up by TodoApp._check_dsa_hint_timer every 10 minutes spent on the
    active DSA task. Dismisses with True/False -- the caller reveals the next
    pre-generated hint only on True."""

    BINDINGS = [("escape", "dismiss_no", "No")]

    CSS = """
    HintPromptScreen { align: center middle; }
    #hint-box { width: 46; height: auto; border: round yellow; padding: 1 2; background: $panel; }
    #hint-question { text-align: center; padding-bottom: 1; }
    #hint-buttons { height: 3; align: center middle; }
    #hint-buttons Button { margin: 0 1; }
    """

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="hint-box"):
                    yield Static("10 minutes in on this one -- want a hint?", id="hint-question")
                    with Horizontal(id="hint-buttons"):
                        yield Button("Yes", id="hint-yes", variant="primary")
                        yield Button("No", id="hint-no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "hint-yes")

    def action_dismiss_no(self):
        self.dismiss(False)


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


class ChoicePickScreen(ModalScreen):
    """Generic modal: pick one of several options from a list, for the setup wizard's
    many multiple-choice questions (unlike TextPromptScreen's free-text Input). Dismisses
    with the chosen option's exact text, or None on Escape."""

    CSS = """
    ChoicePickScreen { align: center middle; }
    #choice-pick-box { width: 74; height: auto; max-height: 22; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self, prompt_text, options):
        super().__init__()
        self.prompt_text = prompt_text
        self.options = options

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="choice-pick-box"):
                    yield Static(self.prompt_text)
                    items = [ListItem(Label(opt), name=opt) for opt in self.options]
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
        ("Shift+S", "Save the AI panel's transcript to a file -- a memory.md workaround for backends with no file access"),
        ("Shift+T", "Toggle the optional Practice Lab column in Focus Mode -- language picker, editor, run, AI time/space complexity"),
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
        ("(DSA/SQL, Focus Mode)", "AI generates an actual practice problem instead of the "
                                  "usual guidance -- no solution, just the problem. A popup offers "
                                  "the next hint every 10 minutes; the regular guidance unlocks once "
                                  "you mark the card done."),
    ]),
    ("AI Assistant panel (Focus Mode only)", [
        ("C", "Start/focus it -- opens a picker the first time, remembers your last choice"),
        ("(automatic)", "It's primed with the active task, field, and generated problem (if any) "
                         "the moment it starts or you switch tasks -- no need to explain your "
                         "problem to it yourself. Told to teach via questions/hints, not just answer."),
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
    ("Practice Lab (Shift+T to show it, in the row alongside the Learning Coach/AI panel in Focus Mode)", [
        ("click", "Pick Python / Java / C / C++ / SQL from the language row"),
        ("ctrl+r", "Run the code (or query), see real output and real run time -- SQL runs against a real sqlite3 sample.db"),
        ("ctrl+b", "AI time/space complexity estimate (\"B\" for Big-O) -- for SQL, a real EXPLAIN QUERY PLAN + row count instead"),
        ("ctrl+a", "Send your code to the AI panel for a Socratic review -- hints toward the fix, not the fix itself"),
        ("ctrl+n", "Reset the current language's buffer to its starter template"),
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
        "For a DSA or SQL field, in Focus Mode specifically: instead of that "
        "guidance up front, the AI generates an actual practice problem for the "
        "task (a LeetCode-style problem for DSA, a plain-English question "
        "answerable against the Practice Lab's real sample database for SQL) -- "
        "it won't hand you the solution, just the problem to work out yourself.",
        "A popup offers the next hint every 10 minutes you spend on it -- never "
        "forced, and never the answer outright, just a nudge in the right "
        "direction. The regular guidance above unlocks once you mark it done, "
        "for review.",
        "Not entertainment -- every panel here earns its space by helping you get "
        "better at what you're actually studying. Content can run long -- scroll "
        "it with your mouse wheel or trackpad.",
    ]),
    ("AI Assistant Panel", [
        ("Shift+C", "start or focus the AI panel (auto-enters Focus Mode)"),
        "A real terminal session embedded right in the app -- Claude Code, a local "
        "Ollama model, or Claude/ChatGPT/Gemini over their own API, your pick from a menu.",
        "It already knows what you're working on: the moment it starts (or you "
        "switch tasks), mtdo sends it the active task, field, and the generated "
        "problem if there is one -- you don't have to explain your problem to it "
        "yourself. It's told to teach, not just answer: guide you toward the "
        "solution with questions and hints rather than handing it over outright.",
        ("esc esc", "double-tap Escape to release keyboard focus without ending the session"),
    ]),
    ("Practice Lab", [
        ("Shift+T", "toggle the optional Practice Lab column, alongside the Coach and AI panel"),
        "A real language picker (Python / Java / C / C++ / SQL), a code editor, "
        "and real execution -- nothing simulated. SQL runs against a real sqlite3 "
        "database seeded with sample tables, right there in the Practice Lab.",
        ("ctrl+r", "run the code (or query) and see real output"),
        ("ctrl+b", "AI time/space estimate for code -- for SQL, a real EXPLAIN QUERY PLAN + row count instead"),
        ("ctrl+a", "send your code to the AI panel next to it for a review -- hints toward the issue, not the fix"),
        ("ctrl+n", "reset the current language's buffer to its starter template"),
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
    (height: 1fr).

    In Focus Mode specifically, a "dsa" or "database" topic_type task gets different
    treatment: instead of the Focus On/Ask Yourself content above (which already
    assumes you understand the problem), the AI generates a problem for the task --
    LeetCode-style for dsa, a SQL question answerable against the Practice Lab's real
    sample.db for database (see coaching.build_problem_prompt) -- and shows that
    instead -- the point is to make the person reason through it, not read the
    answer. Hints are pre-generated alongside the problem and revealed one at a time,
    only when accepted via the popup TodoApp._check_dsa_hint_timer raises every 10
    minutes. The regular coaching content unlocks for that same task once it's marked
    done -- app.current_dsa_ref keeps pointing at it after that so this panel can
    still find it once it's no longer the "active" (in_progress) task. Outside Focus
    Mode, these tasks get the regular coaching content like every other field,
    unchanged."""

    def update_content(self, state, today, focus_mode):
        app = self.app
        active = tc.current_active_task(state, today)

        if active is not None:
            category_meta = tc.CATEGORY_META.get(active["category"])
            if focus_mode and coaching.has_generated_problem_support(category_meta):
                app.current_dsa_ref = (active["date_key"], active["category"], active["idx"])
                self._render_dsa_mode(active["block"], category_meta.get("topic_type"))
                return
            app.current_dsa_ref = None
            if not coaching.has_coaching_setup(active["block"], category_meta):
                self._render_ai_coaching_mode(active["block"], category_meta)
                return
            content = coaching.build_coaching_content(active["block"], category_meta)
            self.update(self._coach_panel(active["block"]["text"], content))
            return

        ref = app.current_dsa_ref
        if ref is not None:
            date_key, category, idx = ref
            blocks = state.get(date_key, {}).get(category, [])
            block = blocks[idx] if idx < len(blocks) else None
            if block is not None and block.get("status") == tc.STATUS_DONE:
                category_meta = tc.CATEGORY_META.get(category)
                content = coaching.build_coaching_content(block, category_meta)
                self.update(self._coach_panel(
                    block["text"], content, note="Solved -- for further understanding",
                ))
                return

        self.update(self._idle_panel())

    # -- Generated problem mode (Focus Mode only) -----------------------------

    def _render_dsa_mode(self, block, topic_type):
        problem = block.get("dsa_problem")
        if problem is None:
            if id(block) not in self.app.dsa_generating:
                self.app.dsa_generating.add(id(block))
                threading.Thread(target=self._generate_worker, args=(block, topic_type), daemon=True).start()
            self.update(self._generating_panel(block["text"]))
            return
        self.update(self._dsa_problem_panel(block["text"], problem))

    def _generate_worker(self, block, topic_type):
        prompt = coaching.build_problem_prompt(block["text"], topic_type)
        try:
            answer, error = ai_ask.ask(prompt, timeout=90)
        except Exception as e:
            app_log.exception("DSA problem generation failed")
            answer, error = None, str(e)
        self.app.call_from_thread(self._store_generated, block, answer, error)

    def _store_generated(self, block, answer, error):
        self.app.dsa_generating.discard(id(block))
        if answer:
            statement, hints = coaching.parse_problem_response(answer)
        else:
            statement, hints = f"Couldn't generate a problem: {error}", []
        block["dsa_problem"] = {"statement": statement, "hints": hints, "revealed": 0, "next_hint_at": 10}
        tc.save_state(self.app.state)
        # If the AI panel was already primed for this same task before generation
        # finished, that priming message went out without the problem statement --
        # force a fresh one now that it exists, so the assistant actually knows what
        # problem is being discussed instead of the student having to paste it in.
        self.app.ai_primed_ref = None
        self.app.refresh_side_panels()
        self.app._prime_ai_context_if_needed()

    def _generating_panel(self, task_text, message="Generating your problem..."):
        body = Group(
            Text(task_text, style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(""),
            Text(message, style="dim italic", justify="center"),
        )
        return Panel(body, title="Learning Coach", border_style="magenta", box=box.ROUNDED)

    # -- AI-generated coaching content, fields with no setup (see coaching.build_ai_coaching_prompt) --

    def _render_ai_coaching_mode(self, block, category_meta):
        cached = block.get("ai_coaching")
        if cached is None:
            if id(block) not in self.app.coaching_generating:
                self.app.coaching_generating.add(id(block))
                label = (category_meta or {}).get("label", "this field")
                threading.Thread(
                    target=self._generate_coaching_worker, args=(block, label), daemon=True,
                ).start()
            self.update(self._generating_panel(block["text"], "Asking the AI to tailor coaching notes..."))
            return
        if cached is False:
            # Generation failed or no AI backend is configured -- fall back to the plain
            # static panel rather than getting stuck showing "Generating..." forever.
            self.update(self._no_coaching_panel(block["text"], category_meta))
            return
        self.update(self._coach_panel(block["text"], cached, note="AI-tailored for this task"))

    def _generate_coaching_worker(self, block, label):
        prompt = coaching.build_ai_coaching_prompt(block["text"], label)
        try:
            answer, error = ai_ask.ask(prompt, timeout=60)
        except Exception as e:
            app_log.exception("AI coaching generation failed")
            answer, error = None, str(e)
        self.app.call_from_thread(self._store_generated_coaching, block, answer, error)

    def _store_generated_coaching(self, block, answer, error):
        self.app.coaching_generating.discard(id(block))
        content = coaching.parse_ai_coaching_response(answer) if answer else None
        has_enough = content and (content["focus_on"] or content["ask_yourself"])
        if not has_enough:
            app_log.info(f"AI coaching generation unusable: {error or 'empty/unparseable response'}")
        block["ai_coaching"] = content if has_enough else False
        tc.save_state(self.app.state)
        self.app.refresh_side_panels()

    def _dsa_problem_panel(self, task_text, problem):
        rows = [
            Text(task_text, style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
            Text(""),
        ]
        for line in problem["statement"].splitlines():
            rows.append(Text(line, style="white"))
        hints = problem.get("hints") or []
        revealed = problem.get("revealed", 0)
        if revealed:
            rows.append(Text(""))
            rows.append(Text("Hints revealed so far", style="bold cyan"))
            for i, hint in enumerate(hints[:revealed], 1):
                rows.append(Text(f"  {i}. {hint}", style="yellow"))
        remaining = len(hints) - revealed
        rows.append(Text(""))
        if remaining > 0:
            rows.append(Text(f"{remaining} more hint(s) available -- a popup offers one every "
                              "10 minutes spent on this task.", style="dim italic", justify="center"))
        rows.append(Text("Work it out yourself first -- the full coaching notes unlock",
                          style="dim italic", justify="center"))
        rows.append(Text("once you mark this done.", style="dim italic", justify="center"))
        return Panel(Group(*rows), title="Learning Coach", border_style="magenta", box=box.ROUNDED)

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
            Text(f"No coaching content set up for {label} yet,", style="dim italic", justify="center"),
            Text("and the AI couldn't generate any either --", style="dim italic", justify="center"),
            Text("check an AI backend is configured (press C),", style="dim italic", justify="center"),
            Text("or add a topic_type/coaching_framework to this", style="dim italic", justify="center"),
            Text("field in goals.json to get guidance here.", style="dim italic", justify="center"),
        )
        return Panel(body, title="Learning Coach", border_style="magenta", box=box.ROUNDED)

    def _section(self, title, items):
        rows = [Text(title, style="bold cyan")]
        for item in items:
            rows.append(Text(f"  • {item}", style="white"))
        rows.append(Text(""))
        return rows

    def _coach_panel(self, task_text, content, note=None):
        rows = [
            Text(task_text, style="bold bright_white", justify="center", no_wrap=True, overflow="ellipsis"),
        ]
        if note:
            rows.append(Text(note, style="bold green", justify="center"))
        rows.append(Text(""))
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
        name = appconfig.get_user_name()
        title = f"{tc.APP_NAME} · {name}" if name else tc.APP_NAME
        self.update(Text(f" {title}    {tc.DAY_NAMES[today.weekday()]}, {today.strftime('%b %d, %Y')}    {now} ",
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
    PracticeLabPanel { width: 1fr; display: none; }
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
        ("S", "save_ai_transcript", "Save AI Transcript"),
        ("T", "toggle_practice_terminal", "Practice Lab"),
    ] + ([("B", "report_bug", "Report Bug")] if SANDBOX_INSTANCE_MODE else [])

    def __init__(self):
        super().__init__()
        self.today = tc.get_today()
        self.state = tc.load_state()
        self.state = tc.ensure_day_registered(self.state, self.today)
        self.focus_mode = False
        self.practice_terminal_enabled = appconfig.practice_terminal_enabled()
        # DSA problem-generation bookkeeping (see LearningCoachPanel/_check_dsa_hint_timer):
        # current_dsa_ref points at the (date_key, category, idx) of the DSA task the coach
        # is currently showing a generated problem for, kept even after it's marked done so
        # the coach can switch to the regular coaching content for THAT SAME task ("for
        # further understanding") instead of just going idle. dsa_generating holds id(block)
        # for tasks with a generation request in flight, so a fast refresh_side_panels tick
        # doesn't fire a second redundant AI call before the first one returns.
        self.current_dsa_ref = None
        self.dsa_generating = set()
        # Same in-flight bookkeeping as dsa_generating above, but for AI-generated Learning
        # Coach content on fields with no static setup (see LearningCoachPanel._render_ai_coaching_mode).
        self.coaching_generating = set()
        self._hint_prompt_open = False
        # AI-panel context priming (see coaching.build_focus_context_message /
        # _prime_ai_context_if_needed): the (date_key, category, idx) of the active task
        # last sent into the running AI panel, so switching tasks re-primes it but
        # refocusing the same task/session doesn't spam the conversation.
        self.ai_primed_ref = None
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
                    self.practice_panel = PracticeLabPanel()
                    yield self.practice_panel
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
            def after_onboarding(_r=None):
                appconfig.mark_onboarded()
                if appconfig.get_user_name() is None:
                    self._begin_setup_flow()
            self.push_screen(OnboardingScreen(), callback=after_onboarding)
        elif appconfig.get_user_name() is None:
            # Onboarded before, but never actually ran the setup flow (e.g. upgraded
            # from an older mtdo, or a saved instance from before this existed) --
            # still worth asking, just without replaying the feature walkthrough too.
            self._begin_setup_flow()

    def toast(self, text, style="dim"):
        self.query_one(ToastLine).show(text, style)

    def refresh_side_panels(self):
        self.stats_panel.update_content(self.state, self.today)
        self.calendar_panel.update_content(self.state, self.today)
        self.active_task_panel.update_content(self.state, self.today)
        self.pomo_panel.render_panel(tc.get_pomodoro_count(self.state, self.today))
        self.music_panel.refresh_music_info()
        self.coach_panel.update_content(self.state, self.today, self.focus_mode)

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
        self.coach_panel.update_content(self.state, self.today, self.focus_mode)
        self._check_dsa_hint_timer()
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

    def _check_dsa_hint_timer(self):
        """Every 10 minutes of real focus time spent on the active dsa/database task
        (see core.task_elapsed_seconds -- wall-clock since it went in_progress,
        independent of whether the Pomodoro is running), offers the next
        pre-generated hint via a popup. Only fires in Focus Mode, once a problem has
        actually finished generating (nothing to hint at before that), and never
        stacks a second popup while one is already open."""
        if not self.focus_mode or self._hint_prompt_open:
            return
        active = tc.current_active_task(self.state, self.today)
        if active is None:
            return
        category_meta = tc.CATEGORY_META.get(active["category"])
        if not coaching.has_generated_problem_support(category_meta):
            return
        block = active["block"]
        problem = block.get("dsa_problem")
        if not problem or not problem.get("hints"):
            return
        if problem.get("revealed", 0) >= len(problem["hints"]):
            return
        elapsed_minutes = tc.task_elapsed_seconds(block) // 60
        threshold = problem.get("next_hint_at", 10)
        if elapsed_minutes < threshold:
            return
        problem["next_hint_at"] = threshold + 10
        tc.save_state(self.state)
        self._hint_prompt_open = True

        def on_answer(want_hint):
            self._hint_prompt_open = False
            if want_hint:
                problem["revealed"] = problem.get("revealed", 0) + 1
                tc.save_state(self.state)
                self.toast("Hint revealed in the Learning Coach panel.", style="bold yellow")
            self.refresh_side_panels()

        self.push_screen(HintPromptScreen(), on_answer)

    def _prime_ai_context_if_needed(self):
        """Sends the active focus task's context (+ the Socratic tutor framework, see
        coaching.build_focus_context_message) into the running AI panel as if typed, so
        whichever backend the user picked -- Claude Code, a local Ollama model, or an
        API chat, it's all the same pty underneath -- already knows what's on the board
        instead of starting cold. Applies to any field, not just DSA: the framework
        itself branches on topic (DSA/SQL/backend/system design/generic). Only primes
        again when the active task actually changed since the last prime (self.ai_primed_ref),
        so refocusing the same task/session doesn't spam the conversation -- but a
        freshly started process always gets one, since start_backend() clears
        ai_primed_ref first for exactly that case.

        Sent via send_text_when_idle, not send_text directly: a freshly-spawned
        backend's is_running goes True the instant the subprocess exists, well
        before its own input handler is actually listening, and text written before
        that can be silently dropped rather than just arriving unsubmitted -- this
        used to fire after a flat 2s delay, which was confirmed too short often
        enough (Claude Code's real startup time varies) that the assistant sometimes
        ended up with zero context at all, not just late context."""
        if not self.focus_mode:
            return
        active = tc.current_active_task(self.state, self.today)
        if active is None:
            return
        ref = (active["date_key"], active["category"], active["idx"])
        if ref == self.ai_primed_ref:
            return
        category_meta = tc.CATEGORY_META.get(active["category"]) or {}
        raw_capable = ai_backend.supports_raw_multiline_paste(self.claude_panel.command)
        message = coaching.build_focus_context_message(
            active["block"]["text"],
            category_meta.get("label", active["category"]),
            active["block"].get("dsa_problem"),
            multiline=raw_capable,
        )
        self.ai_primed_ref = ref
        if self.claude_panel.is_running:
            self.claude_panel.send_text_when_idle(message, flatten=not raw_capable)

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
        self.practice_panel.display = self.focus_mode and self.practice_terminal_enabled
        if self.focus_mode:
            if not self.pomo_panel.running:
                self._set_pomodoro_length(45, 10)
                self.pomo_panel.running = True
        else:
            if not self.pomo_panel.running:
                self._set_pomodoro_length(tc.DEFAULT_POMODORO_MINUTES, tc.DEFAULT_BREAK_MINUTES)
            if self.claude_panel.has_focus:
                self.claude_panel.blur()
            if self.practice_panel.has_focus_within:
                # PracticeLabPanel is a plain container (the editor/buttons inside it
                # are what actually take focus), not a pty widget that owns focus
                # itself like ClaudePanel -- has_focus_within + clearing focus on the
                # screen is the equivalent of "blur" here.
                self.screen.set_focus(None)
        self.toast("Focus Mode ON -- 45/10 pomodoro started, press f to exit" if self.focus_mode else "Focus Mode off",
                   style="bold bright_green" if self.focus_mode else "dim")
        self.refresh_side_panels()
        self._prime_ai_context_if_needed()

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
                        self._prime_ai_context_if_needed()
                        return
                    ai_backend.save_choice(command, label)
                    if self.claude_panel.is_running:
                        self.claude_panel.stop()
                    self.ai_primed_ref = None  # fresh process -- (re)prime even the same task
                    self.claude_panel.start_with(command, label)
                    self.claude_panel.focus()
                    self._prime_ai_context_if_needed()
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

            # ai_backend.list_available() can genuinely block for seconds (an Ollama
            # `ollama list` probe with retries, up to ~40s worst case if the service
            # is down and slow to answer) -- confirmed by hand this used to run
            # straight on the UI thread here, which froze the ENTIRE app (Textual is
            # single-threaded), not just the AI panel, for as long as the probe took.
            # Computing it in the background and only pushing the picker once it's
            # back keeps the app responsive the whole time.
            self.toast("Checking available AI backends...", style="dim")
            remembered = ai_backend.load_choice()

            def show_picker(options):
                self.push_screen(AIBackendPickScreen(options, remembered=remembered), on_choice)

            def load_backends():
                try:
                    options = ai_backend.list_available()
                except Exception:
                    app_log.exception("ai_backend.list_available failed")
                    options = []
                self.call_from_thread(show_picker, options)

            threading.Thread(target=load_backends, daemon=True).start()
        except Exception:
            app_log.exception("action_toggle_claude failed")
            self.toast(f"Claude Code panel hit an error -- see {LOG_PATH}", style="bold red")

    def action_report_bug(self):
        """Sandbox-only (see the SANDBOX_INSTANCE_MODE-gated BINDINGS entry above): quick-
        capture a bug without breaking your testing flow -- keep going, and it's written
        to disk immediately (see bug_log.py), independent of the instance's own
        save/discard fate. Uses BugReportScreen (a real multi-line TextArea, ~10 lines
        visible + scroll) rather than the single-line TextPromptScreen, since a one-line
        box made longer descriptions hard to review before saving."""
        def on_result(text):
            if text and text.strip():
                bug_id = bug_log.add_bug(text.strip())
                self.toast(f"Bug #{bug_id} logged -- keep testing", style="bold yellow")
        self.push_screen(BugReportScreen(), on_result)

    def action_quit(self):
        if SANDBOX_INSTANCE_MODE:
            self.push_screen(
                SaveInstanceScreen(
                    is_new=(_INSTANCE_SLUG is None),
                    existing_name=_INSTANCE_NAME,
                    existing_description=_INSTANCE_DESCRIPTION,
                ),
                self._on_save_instance_choice,
            )
            return
        self._stop_claude_and_exit()

    def _stop_claude_and_exit(self):
        try:
            self.claude_panel.stop()
        except Exception:
            app_log.exception("failed to stop claude panel on quit")
        self.exit()

    def _on_save_instance_choice(self, result):
        if result is None:
            return  # cancelled -- stay in the app, nothing touched
        action, name, description = result
        from . import instance_store
        try:
            if action == "save":
                instance_store.save_scratch(_INSTANCE_SCRATCH, slug=_INSTANCE_SLUG, name=name, description=description)
            else:
                instance_store.discard_scratch(_INSTANCE_SCRATCH)
        except Exception:
            app_log.exception("failed to finalize sandbox instance on quit")
        self._stop_claude_and_exit()

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
        self._begin_setup_flow()

    def _begin_setup_flow(self):
        """Entry point for the whole setup wizard -- name (first time only) -> persona ->
        how to populate goals.json (manual vs AI-guided) -> (if AI-guided) which AI ->
        that persona's full bespoke Q&A -> build+save the AI prompt. Triggered
        automatically right after the feature walkthrough on a genuine first run (see
        on_mount), or any time via 'g' (action_plan_wizard) to re-run it.

        Runs entirely in-app rather than as CLI-level input() prompts before the app even
        started (an earlier version of this wizard did that specifically to avoid hot-
        reloading a running app's category structure) -- per explicit user request that
        the app boot first and only then start asking questions. The board starts (and,
        if you cancel out partway, stays) genuinely empty either way; nothing here writes
        categories directly -- the AI prompt this produces is what eventually does, once
        pasted into an AI and the result imported.
        """
        if appconfig.get_user_name() is None:
            def on_name(name):
                if name and name.strip():
                    appconfig.set_user_name(name.strip())
                self._pick_persona_for_setup()
            self.push_screen(TextPromptScreen("What should we call you?", ""), on_name)
        else:
            self._pick_persona_for_setup()

    def _pick_persona_for_setup(self):
        def on_persona(persona):
            if persona is None:
                return
            self._pick_populate_method(persona)
        self.push_screen(PersonaPickScreen(), on_persona)

    def _pick_populate_method(self, persona):
        options = [
            "Manual -- I'll build it myself in the app (press 'a' to add fields)",
            "Guided setup -- answer a few questions and let an AI build it (Recommended)",
        ]

        def on_choice(choice):
            if choice is None:
                return
            if choice.startswith("Manual"):
                self.toast(
                    "Okay -- your board is empty. Press 'a' any time to add a field, "
                    "then start adding cards to it.",
                    style="bold cyan",
                )
                return
            self._pick_ai_choice(persona)

        self.push_screen(ChoicePickScreen("How do you want to build your plan?", options), on_choice)

    def _pick_ai_choice(self, persona):
        options = [
            "mtdo's built-in AI (Claude Code, Ollama, or an API key)",
            "An AI I already use day to day (ChatGPT, Claude, Gemini, etc)",
        ]

        def on_choice(choice):
            if choice is None:
                return
            use_builtin = choice.startswith("mtdo's built-in")
            questions = list(plan_wizard.questions_for(persona))
            self._ask_plan_wizard_questions(questions, {"persona": persona}, persona, use_builtin)

        self.push_screen(ChoicePickScreen("How do you want to build it?", options), on_choice)

    def _ask_plan_wizard_questions(self, questions, answers, persona, use_builtin):
        if not questions:
            self._finish_plan_wizard(persona, answers, use_builtin)
            return
        key, prompt_text, choices = questions[0]
        rest = questions[1:]

        def on_answer(value):
            if value is None:
                self.toast("Setup cancelled -- nothing written.", style="dim")
                return
            answers[key] = value.strip() if isinstance(value, str) and not choices else value
            self._ask_plan_wizard_questions(rest, answers, persona, use_builtin)

        if choices:
            self.push_screen(ChoicePickScreen(prompt_text, choices), on_answer)
        else:
            self.push_screen(TextPromptScreen(prompt_text, "", multiline=True), on_answer)

    def _finish_plan_wizard(self, persona, answers, use_builtin):
        try:
            prompt = plan_wizard.build_prompt(persona, answers)
            path, copied = plan_wizard.save_and_copy(prompt)
        except Exception:
            app_log.exception("plan wizard failed to build/save prompt")
            self.toast(f"Plan setup hit an error -- see {LOG_PATH}", style="bold red")
            return
        if use_builtin:
            self.toast(
                f"Saved -- press C to open the built-in AI panel, paste it there (Cmd+V), and hit enter. "
                f"Also saved to {path}.",
                style="bold green",
            )
        else:
            clip_note = " and copied to your clipboard" if copied else ""
            self.toast(f"Saved to {path}{clip_note} -- paste it into your AI of choice.", style="bold yellow")

    def action_save_ai_transcript(self):
        if not self.claude_panel.is_running:
            self.toast("No AI session running to save a transcript from.", style="dim")
            return
        try:
            path = self.claude_panel.save_transcript()
        except Exception:
            app_log.exception("action_save_ai_transcript failed")
            self.toast(f"Couldn't save the transcript -- see {LOG_PATH}", style="bold red")
            return
        self.toast(
            f"Saved -> {path}. Ask Claude Code to fold anything worth keeping into ~/.mtdo/memory.md.",
            style="bold green",
        )

    def action_toggle_practice_terminal(self):
        """Turns the optional third column (Coach / AI / Practice Lab) on or off,
        persisted so the choice survives a restart. The Practice Lab widget itself
        (language picker, editor, run, AI time/space complexity -- see
        practice_lab_panel.py) stays mounted either way, code and results intact --
        this just shows or hides it, same "keep it alive while hidden" idea as the AI
        panel already has, so turning it back on later finds it exactly where it was
        left."""
        self.practice_terminal_enabled = not self.practice_terminal_enabled
        appconfig.set_practice_terminal_enabled(self.practice_terminal_enabled)
        if self.focus_mode:
            self.practice_panel.display = self.practice_terminal_enabled
        self.toast(
            "Practice Lab on -- language picker, editor, run, AI complexity, right in Focus Mode"
            if self.practice_terminal_enabled else "Practice Lab off",
            style="bold green" if self.practice_terminal_enabled else "dim",
        )

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
