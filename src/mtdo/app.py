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
import time

from . import core as tc
from . import analytics
from . import config as appconfig
from . import coaching
from . import ai_backend
from . import ai_ask
from . import youtube_notes
from . import music
from . import radio
from . import plan_wizard
from . import bug_log
from . import profiles as pf
from .claude_panel import ClaudePanel
from .practice_lab_panel import PracticeLabPanel
from .radio_screen import RadioScreen
from .errorlog import LOG_PATH, log as app_log

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll, Center, Middle
from textual.widgets import Static, ListView, ListItem, Label, Input, Footer, TextArea, Button, DirectoryTree, Markdown, LoadingIndicator
from textual.screen import ModalScreen, Screen
from textual.message_pump import active_message_pump
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


def _greeting_for_hour(hour):
    if hour < 12:
        return "Good morning"
    elif hour < 18:
        return "Good afternoon"
    return "Good evening"


class ProfileFooter(Static):
    # NB: must be DEFAULT_CSS, not CSS -- Textual only recognizes CSS = "..." on
    # Screen/App subclasses; on a plain Widget it's silently ignored (Textual logs
    # "'ProfileFooter.CSS' will be ignored" via preflight_checks(), easy to miss).
    # This entire block -- dock, layer, border, background -- was a no-op before.
    # No border: a bordered box needs 3 rows (top/content/bottom) to render, but
    # this shares a single row with Footer -- height:1 with a border clips the
    # widget's own content and paints only a border sliver over Footer's text.
    DEFAULT_CSS = """
    ProfileFooter {
        dock: bottom;
        width: auto;
        height: 1;
        min-width: 12;
        max-width: 40;
        margin: 0 1;
        padding: 0 1;
        content-align: left middle;
        background: $panel;
        color: $text-muted;
    }
    ProfileFooter:hover {
        background: $boost;
        color: $text;
    }
    ProfileFooter:focus {
        background: $primary;
        color: $text;
    }
    """

    def __init__(self):
        super().__init__("")
        self.refresh_label()

    def on_mount(self):
        self._reposition()

    def on_resize(self, event):
        self._reposition()

    def _reposition(self):
        # dock:bottom always anchors a width:auto widget at x=0 (Textual's
        # _arrange_dock_widgets has no "dock to a corner" concept) -- wrapping it
        # in a container with align:right instead broke Footer's own rendering
        # entirely (its child FooterKey widgets stopped composing), so this
        # shifts it right via a plain visual offset, which doesn't touch layout
        # or dock-space reservation for any sibling.
        if not self.is_mounted or self.app is None:
            return
        self.styles.offset = (self.app.size.width - self.outer_size.width, 0)

    def refresh_label(self):
        active = pf.get_active_slug()
        profile = pf.get_profile(active) if active else None
        if profile:
            greeting = _greeting_for_hour(datetime.datetime.now().hour)
            self.update(f"👤 {greeting}, {profile['name']} ▾")
        else:
            self.update("👤 No profile ▾")
        # own width can change with the name/greeting length -- reposition once
        # the new content has actually been measured, not against the stale size.
        if self.is_mounted:
            self.call_after_refresh(self._reposition)

    def on_click(self):
        self.app.action_open_profile_menu()

    def on_key(self, event):
        if event.key in ("enter", "space"):
            self.app.action_open_profile_menu()


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


WIZARD_BACK = object()  # sentinel dismiss value meaning "go back a step" -- for a
# multi-step wizard's own back-stack (a list of redisplay closures, popped on
# WIZARD_BACK; the plan-setup wizard used one until its 2026-08-24 rework collapsed it
# to a single step, see _pick_populate_method). An object(), not a string, so it can
# never collide with a real typed answer. Only screens passed show_back=True render/bind
# Ctrl+B for this; every other call site of these generic screens is unaffected.


class TextPromptScreen(ModalScreen):
    """Generic modal: shows a prompt + text input, returns the value, WIZARD_BACK
    (Ctrl+B, only when show_back=True), or None on Escape.

    multiline=True swaps the single-line Input for a TextArea sized to show ~12 lines
    with scroll (Ctrl+S to save, since Enter means newline in a TextArea) -- same fix as
    BugReportScreen's, for the same reason: a one-line box makes a longer free-text
    answer hard to review before submitting. Used for the setup wizard's free-text
    questions (some, like "what's your academic goal", can run long); left off (the
    default) for genuinely short answers like a name or a card title, where single-line
    is the right, unsurprising affordance and Enter-to-submit is worth keeping.

    show_back=True adds a "Ctrl+B to go back" hint and binding -- only the setup wizard
    passes this (and only once there's an earlier step to return to); every other caller
    leaves it False and never sees WIZARD_BACK come out of dismiss()."""

    def __init__(self, prompt_text, initial="", multiline=False, secret=False, show_back=False):
        super().__init__()
        self.prompt_text = prompt_text
        self.initial = initial
        self.multiline = multiline
        self.secret = secret
        self.show_back = show_back

    CSS = """
    TextPromptScreen { align: center middle; }
    #prompt-box { width: 70; height: auto; border: round magenta; padding: 1 2; background: $panel; }
    #prompt-box TextArea { height: 14; border: round grey; margin: 1 0; }
    """

    def compose(self) -> ComposeResult:
        back_hint = ", Ctrl+B back" if self.show_back else ""
        with Center():
            with Middle():
                with Vertical(id="prompt-box"):
                    yield Static(self.prompt_text)
                    if self.multiline:
                        yield TextArea(self.initial, id="prompt-textarea")
                        yield Static(f"Ctrl+S to save, Escape to cancel{back_hint}", classes="dim")
                    else:
                        yield Input(value=self.initial, id="prompt-input", password=self.secret)
                        yield Static(f"Enter to save, Escape to cancel{back_hint}", classes="dim")

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
            # Unlike the branches below, this one was missing stop/prevent_default --
            # the unstopped key event kept bubbling past this (now-dismissed) modal to
            # whatever screen was underneath, so e.g. cancelling the "y" YouTube URL
            # prompt in the Vault also triggered VaultScreen's own escape binding and
            # closed the whole Vault instead of just the prompt.
            event.prevent_default()
            event.stop()
            self.dismiss(None)
        elif self.multiline and event.key == "ctrl+s":
            event.prevent_default()
            event.stop()
            self.dismiss(self.query_one(TextArea).text)
        elif self.show_back and event.key == "ctrl+b":
            event.prevent_default()
            event.stop()
            self.dismiss(WIZARD_BACK)


class ProfileMenuScreen(ModalScreen):
    CSS = """
    ProfileMenuScreen { align: center middle; }
    #profile-menu-box { width: 72; height: auto; border: round grey; padding: 1 2; background: $panel; }
    #profile-list { height: auto; max-height: 18; }
    #profile-list Button { width: 100%; margin: 0 0 1 0; }
    #profile-actions { height: 3; align: center middle; }
    #profile-actions Button { margin: 0 1; }
    """

    def __init__(self, step_label=None):
        """step_label: see OnboardingScreen's docstring -- gh28's shared setup-
        sequence indicator. None (default) for every normal use of this screen
        (the footer profile badge, action_open_profile_menu)."""
        super().__init__()
        self.step_label = step_label

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="profile-menu-box"):
                    if self.step_label:
                        yield Static(self.step_label, classes="dim")
                    yield Static("Profile")
                    self.profile_list = Vertical(id="profile-list")
                    yield self.profile_list
                    with Horizontal(id="profile-actions"):
                        yield Button("Add Profile", id="profile-add")
                        yield Button("Manage Profiles", id="profile-manage")
                        yield Button("Close", id="profile-close")

    def on_mount(self):
        self._refresh_list()

    def _refresh_list(self):
        for child in list(self.profile_list.children):
            child.remove()
        active = pf.get_active_slug()
        profiles = pf.list_profiles()
        if not profiles:
            self.profile_list.mount(Static("No profiles yet"))
            return
        for profile in profiles:
            marker = "✓ " if profile["slug"] == active else "  "
            # No id= here: a slug is only guaranteed to match [a-z0-9_], but Textual
            # widget ids must match [A-Za-z0-9_-] and never start with a digit -- a
            # slug starting with a digit, or embedded in an id via a separator like
            # ":", can produce an invalid id and crash on mount (BadIdentifier). The
            # slug is carried as a plain attribute instead, read back in
            # on_button_pressed, sidestepping the whole id-charset question.
            btn = Button(f"{marker}{profile['name']}")
            btn.profile_slug = profile["slug"]
            self.profile_list.mount(btn)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        slug = getattr(event.button, "profile_slug", None)
        if bid == "profile-close":
            self.dismiss(None)
        elif bid == "profile-add":
            self.dismiss(None)
            self.app.action_create_profile()
        elif bid == "profile-manage":
            self.dismiss(None)
            self.app.action_manage_profiles()
        elif slug is not None:
            self.dismiss(None)
            self.app._switch_profile(slug)

    def on_key(self, event):
        # Missing until 2026-08-25: every other modal in the app (TextPromptScreen,
        # ChoicePickScreen, PersonaPickScreen, ...) supports Escape-to-cancel; these
        # three profile screens never did, only a button click -- caught because it
        # also broke tests/test_profiles.py's shared dismiss-first-run-prompts helper
        # once _begin_setup_flow started auto-showing one of these three right after
        # the walkthrough (gh48).
        if event.key == "escape":
            self.dismiss(None)


class ProfileCreateScreen(ModalScreen):
    """gh44/gh49: password protection used to be a single easy-to-skip "Password
    (optional)" text field -- both bugs were two different testers independently
    surprised, later, that an unprotected profile they'd created without noticing
    never prompted for a password on switch and stored its data as plain JSON.
    Now the decision is unavoidable: after the name, a Yes/No choice with the
    actual consequence spelled out, not a field to tab past. "No" finishes
    immediately (the explanation was already on screen at the moment of the
    choice, which is the fix -- a second confirmation step would just be more
    friction, not more informed consent). "Yes" reveals password + confirm
    inputs; RecoveryCodeScreen (see below) is still shown once the profile is
    actually created, same as before."""

    CSS = """
    ProfileCreateScreen { align: center middle; }
    #profile-create-box { width: 56; height: auto; border: round grey; padding: 1 2; background: $panel; }
    #profile-create-box Input { margin: 0 0 1 0; }
    #profile-create-box Button { margin: 0 1; }
    #protect-explain { color: $text-muted; margin: 0 0 1 0; }
    """

    def __init__(self, step_label=None):
        """step_label: see OnboardingScreen's docstring -- gh28's shared setup-
        sequence indicator. None (default) for every normal use of this screen
        (the footer profile badge, action_create_profile)."""
        super().__init__()
        self.step_label = step_label

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="profile-create-box"):
                    if self.step_label:
                        yield Static(self.step_label, classes="dim")
                    yield Static("Create Profile")
                    yield Input(placeholder="Display name", id="profile-name")
                    yield Vertical(id="protect-area")

    def on_mount(self):
        self.query_one("#profile-name", Input).focus()
        self._show_protect_choice()

    def _protect_area(self):
        return self.query_one("#protect-area", Vertical)

    def _clear_protect_area(self):
        for child in list(self._protect_area().children):
            child.remove()

    def _show_protect_choice(self):
        self._clear_protect_area()
        area = self._protect_area()
        area.mount(Static(
            "Protect this profile with a password? Without one, this profile's "
            "goals/state files are stored as plain, readable JSON -- anyone with "
            "access to this computer can open and read them directly.",
            id="protect-explain",
        ))
        area.mount(Horizontal(
            Button("Yes, set a password", id="protect-yes", variant="primary"),
            Button("No, keep it unprotected", id="protect-no"),
        ))

    def _show_password_inputs(self):
        self._clear_protect_area()
        area = self._protect_area()
        area.mount(Input(placeholder="Password", id="profile-password", password=True))
        area.mount(Input(placeholder="Confirm password", id="profile-password-confirm", password=True))
        area.mount(Horizontal(
            Button("Save", id="profile-create-save", variant="primary"),
            Button("Back", id="profile-create-back"),
            Button("Cancel", id="profile-create-cancel"),
        ))
        self.query_one("#profile-password", Input).focus()

    def _name_or_refocus(self):
        name = self.query_one("#profile-name", Input).value.strip()
        if not name:
            self.query_one("#profile-name", Input).focus()
        return name or None

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "profile-create-cancel":
            self.dismiss(None)
            return
        if bid == "profile-create-back":
            self._show_protect_choice()
            return
        if bid == "protect-yes":
            if self._name_or_refocus() is None:
                return
            self._show_password_inputs()
            return
        if bid == "protect-no":
            name = self._name_or_refocus()
            if name is None:
                return
            self.dismiss((name, None))
            return
        if bid == "profile-create-save":
            name = self._name_or_refocus()
            if name is None:
                return
            password = self.query_one("#profile-password", Input).value
            confirm = self.query_one("#profile-password-confirm", Input).value
            if not password:
                self.query_one("#profile-password", Input).focus()
                return
            if password != confirm:
                self.app.toast("Passwords didn't match.", style="bold red")
                confirm_input = self.query_one("#profile-password-confirm", Input)
                confirm_input.value = ""
                confirm_input.focus()
                return
            self.dismiss((name, password))

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class RecoveryCodeScreen(ModalScreen):
    """Shown exactly once, right after a password-protected profile is created (the
    gh40 fix). This is the only time mtdo ever *generates and displays* the
    recovery code -- it isn't stored anywhere by default, so it can't be shown
    again later; losing both the password and this code means the profile's data
    really is gone for good.

    gh53: after showing it, offers to save a local copy too (so "I'll write it
    down somewhere" isn't the only option), with the same three-way choice the
    bug asked for -- protected with its own separate password, protected with
    nothing at all, or don't save a local copy and just move on. That local copy
    is deliberately independent of the profile's own password/data-key envelope:
    the whole point of a recovery code is surviving forgetting that password, so
    gating the backup behind the same secret would defeat it. Nothing here is
    cancelable (the profile already exists by the time this shows) -- Escape at
    any step just moves on without saving a local copy, same as the original
    single "I've saved it" button always did."""

    CSS = """
    RecoveryCodeScreen { align: center middle; }
    #recovery-box { width: 64; height: auto; border: round yellow; padding: 1 2; background: $panel; }
    #recovery-code { text-align: center; text-style: bold; padding: 1 0; color: $warning; }
    #recovery-warning { padding-bottom: 1; }
    .recovery-explain { color: $text-muted; padding: 0 0 1 0; }
    #recovery-action-area { height: auto; }
    #recovery-action-area Horizontal { height: 3; align: center middle; }
    #recovery-action-area Input { margin: 0 0 1 0; }
    """

    def __init__(self, recovery_code, slug):
        super().__init__()
        self.recovery_code = recovery_code
        self.slug = slug

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="recovery-box"):
                    yield Static("Save your recovery code")
                    yield Static(self.recovery_code, id="recovery-code")
                    yield Static(
                        "If you forget your password, this code is the ONLY way back "
                        "into this profile's data. mtdo does not store it and cannot "
                        "show it to you again.",
                        id="recovery-warning",
                    )
                    yield Vertical(id="recovery-action-area")

    def on_mount(self):
        self._show_save_choice()

    def _action_area(self):
        return self.query_one("#recovery-action-area", Vertical)

    def _clear_action_area(self):
        for child in list(self._action_area().children):
            child.remove()

    def _show_save_choice(self):
        # Unlike _show_protect_choice/_show_password_inputs below (reached from a
        # button click, well after mount has settled), this one runs from on_mount
        # itself -- focusing a button mounted moments earlier in the very same
        # on_mount call raises NoMatches, since it isn't queryable yet at that
        # point. ProfileCreateScreen's own on_mount-time step (_show_protect_choice)
        # skips auto-focus for the same reason; Tab/click both still reach it fine.
        self._clear_action_area()
        area = self._action_area()
        area.mount(Static(
            "Also save a local copy of this code, in case you don't write it down "
            "elsewhere?",
            classes="recovery-explain",
        ))
        area.mount(Horizontal(
            Button("Save a local copy", id="recovery-save-yes", variant="primary"),
            Button("No, I've saved it myself", id="recovery-save-no"),
        ))

    def _show_protect_choice(self):
        self._clear_action_area()
        area = self._action_area()
        area.mount(Static(
            "Protect this local copy with its own password? (Separate from this "
            "profile's password -- the point of a recovery code is surviving "
            "forgetting that one.)",
            classes="recovery-explain",
        ))
        area.mount(Horizontal(
            Button("Yes, set a password", id="recovery-protect-yes", variant="primary"),
            Button("No, save it as plain text", id="recovery-protect-no"),
        ))
        # No .focus() here -- a freshly-mounted Button isn't reliably queryable/
        # focusable in the same call that mounts it (unlike Input, see
        # _show_password_inputs below); Tab/click both still reach it fine.

    def _show_password_inputs(self):
        self._clear_action_area()
        area = self._action_area()
        area.mount(Input(placeholder="Password for this saved copy", password=True, id="recovery-save-password"))
        area.mount(Input(placeholder="Confirm password", password=True, id="recovery-save-password-confirm"))
        area.mount(Horizontal(
            Button("Save", id="recovery-save-confirm", variant="primary"),
            Button("Back", id="recovery-save-back"),
        ))
        self.query_one("#recovery-save-password", Input).focus()

    def _finish(self, password=None, protected=False):
        try:
            pf.save_recovery_code_locally(
                self.slug, self.recovery_code, password=password if protected else None,
            )
        except pf.ProfileError as exc:
            self.app.toast(str(exc), style="bold red")
        else:
            self.app.toast("Local copy of the recovery code saved.", style="bold green")
        self.dismiss(True)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "recovery-save-no":
            self.dismiss(True)
            return
        if bid == "recovery-save-yes":
            self._show_protect_choice()
            return
        if bid == "recovery-protect-no":
            self._finish(protected=False)
            return
        if bid == "recovery-protect-yes":
            self._show_password_inputs()
            return
        if bid == "recovery-save-back":
            self._show_protect_choice()
            return
        if bid == "recovery-save-confirm":
            password = self.query_one("#recovery-save-password", Input).value
            confirm = self.query_one("#recovery-save-password-confirm", Input).value
            if not password:
                self.query_one("#recovery-save-password", Input).focus()
                return
            if password != confirm:
                self.app.toast("Passwords didn't match.", style="bold red")
                confirm_input = self.query_one("#recovery-save-password-confirm", Input)
                confirm_input.value = ""
                confirm_input.focus()
                return
            self._finish(password=password, protected=True)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(True)


class LocalRecoveryCodeViewScreen(ModalScreen):
    """Read-only display of a recovery code that was saved locally via
    RecoveryCodeScreen (gh53) -- reached from Manage Profiles' "View Recovery
    Code" button, the counterpart that makes saving one actually useful."""

    CSS = """
    LocalRecoveryCodeViewScreen { align: center middle; }
    #view-recovery-box { width: 64; height: auto; border: round yellow; padding: 1 2; background: $panel; }
    #view-recovery-code { text-align: center; text-style: bold; padding: 1 0; color: $warning; }
    """

    def __init__(self, recovery_code):
        super().__init__()
        self.recovery_code = recovery_code

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="view-recovery-box"):
                    yield Static("Saved recovery code")
                    yield Static(self.recovery_code, id="view-recovery-code")
                    yield Button("Close", id="view-recovery-close", variant="primary")

    def on_mount(self):
        self.query_one("#view-recovery-close", Button).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(None)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class ProfileUnlockScreen(ModalScreen):
    """Blocks the app at launch until the active profile's password is entered --
    the launch-time counterpart to the switch-time gate gh40/44/49 already
    closed. Before this, mtdo booted straight into whatever was last active with
    no password check at all, even for a protected profile -- since the last
    session's decrypted goals.json/state.json just sit in ~/.mtdo between runs
    (there's no reliable crash hook to guarantee wiping them on exit, so a full
    re-lock-on-quit wasn't in scope -- see PROGRESS.md), a new launch could read
    them freely with zero authentication. This closes "the app itself opens
    with no password"; it does not make the plaintext working copy disappear
    between runs. Deliberately no Escape-to-bypass, unlike every other modal
    here -- quitting the app (Ctrl+C) is the only way out besides the right
    password or the recovery code below.

    "Forgot password?" was missing for one whole day (2026-08-25) after this
    screen first shipped -- a real, sharp lockout bug: this screen blocks
    *before* the rest of the app mounts, so Manage Profiles' Reset Password
    (where the recovery-code flow otherwise lives) was flatly unreachable if
    you actually forgot the password. Fixed by routing this button through the
    same TodoApp._reset_profile_password used there, with an on_done callback
    that dismisses this screen with the freshly-reset password once it
    succeeds, so a successful reset unlocks immediately instead of making you
    retype it."""

    CSS = """
    ProfileUnlockScreen { align: center middle; }
    #unlock-box { width: 60; height: auto; border: round yellow; padding: 1 2; background: $panel; }
    #unlock-box Input { margin: 1 0; }
    #unlock-error { color: $error; height: 1; margin: 0 0 1 0; }
    #unlock-forgot { margin-top: 1; }
    """

    def __init__(self, slug, name):
        super().__init__()
        self.slug = slug
        # Not self.name -- Widget/Screen already defines a read-only `name`
        # property of its own (from the constructor's optional name= kwarg),
        # and assigning over it raises AttributeError at mount time.
        self.profile_name = name

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="unlock-box"):
                    yield Static(f'Profile "{self.profile_name}" is password-protected.')
                    yield Input(placeholder="Password", id="unlock-password", password=True)
                    yield Static("", id="unlock-error")
                    yield Static("Enter to unlock. To quit instead, press Ctrl+C.", classes="dim")
                    yield Button("Forgot password?", id="unlock-forgot")

    def on_mount(self):
        self.query_one("#unlock-password", Input).focus()

    def on_input_submitted(self, event: Input.Submitted):
        if pf.check_password(self.slug, event.value):
            self.dismiss(event.value)
            return
        self.query_one("#unlock-error", Static).update("Wrong password.")
        inp = self.query_one("#unlock-password", Input)
        inp.value = ""

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "unlock-forgot":
            self.app._reset_profile_password(self.slug, self.profile_name, on_done=self.dismiss)


class ProfileManageScreen(ModalScreen):
    CSS = """
    ProfileManageScreen { align: center middle; }
    #profile-manage-box { width: 80; height: auto; border: round grey; padding: 1 2; background: $panel; }
    #profile-manage-rows { height: auto; max-height: 20; }
    #profile-manage-rows Horizontal { margin: 0 0 1 0; }
    .profile-row-primary { width: 1fr; }
    .profile-row-action { width: 10; margin-left: 1; }
    .profile-row-action-wide { width: 18; margin-left: 1; }
    #profile-manage-actions { align: center middle; }
    #profile-manage-add { width: auto; }
    """

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="profile-manage-box"):
                    yield Static("Manage Profiles")
                    self.rows = Vertical(id="profile-manage-rows")
                    yield self.rows
                    with Horizontal(id="profile-manage-actions"):
                        yield Button("Add Profile", id="profile-manage-add", variant="primary")
                        yield Button("Close", id="profile-manage-close")

    def on_mount(self):
        self._refresh_rows()

    def _refresh_rows(self):
        for child in list(self.rows.children):
            child.remove()
        active = pf.get_active_slug()
        if not pf.list_profiles():
            self.rows.mount(Static("No profiles yet"))
            return
        # profile_slug/row_action are plain attributes, not ids: a slug is only
        # guaranteed to match [a-z0-9_], but Textual widget ids must match
        # [A-Za-z0-9_-] and never start with a digit, so baking a slug into an id
        # (e.g. via a ":" separator) can produce an invalid id and crash on mount.
        for profile in pf.list_profiles():
            select_btn = Button(f"{'✓ ' if profile['slug'] == active else ''}{profile['name']}", classes="profile-row-primary")
            select_btn.profile_slug, select_btn.row_action = profile["slug"], "select"
            rename_btn = Button("Rename", classes="profile-row-action")
            rename_btn.profile_slug, rename_btn.row_action = profile["slug"], "rename"
            delete_btn = Button("Delete", classes="profile-row-action")
            delete_btn.profile_slug, delete_btn.row_action = profile["slug"], "delete"
            # children must be passed to the constructor -- mounting onto `row`
            # before `row` itself is attached (via self.rows.mount(row) below)
            # raises MountError ("Can't mount widget(s) before ... is mounted").
            row_children = [select_btn, rename_btn, delete_btn]
            if profile.get("protected"):
                # Only protected profiles have a password to reset (gh40) -- an
                # unprotected one has nothing for a recovery code to unlock.
                # "Reset Password", not "Reset" -- a bare "Reset" read as
                # wiping the whole profile back to empty, not resetting its
                # password.
                reset_btn = Button("Reset Password", classes="profile-row-action-wide")
                reset_btn.profile_slug, reset_btn.row_action = profile["slug"], "reset"
                row_children.append(reset_btn)
            if pf.has_local_recovery_code(profile["slug"]):
                # gh53: only shown once a local copy actually exists to view --
                # most profiles won't have one, since saving it was always optional.
                view_btn = Button("View Recovery Code", classes="profile-row-action-wide")
                view_btn.profile_slug, view_btn.row_action = profile["slug"], "view-recovery"
                row_children.append(view_btn)
            row = Horizontal(*row_children)
            self.rows.mount(row)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "profile-manage-close":
            self.dismiss(None)
            return
        if bid == "profile-manage-add":
            self.dismiss(None)
            self.app.action_create_profile()
            return
        slug = getattr(event.button, "profile_slug", None)
        action = getattr(event.button, "row_action", None)
        if slug is None or action is None:
            return
        if action == "select":
            self.dismiss(None)
            self.app._switch_profile(slug)
            return
        if action == "rename":
            self.dismiss(None)
            self.app._start_rename_profile(slug)
            return
        if action == "delete":
            self.dismiss(None)
            self.app._start_delete_profile(slug)
            return
        if action == "reset":
            profile = pf.get_profile(slug)
            if not profile:
                return
            self.dismiss(None)
            self.app._reset_profile_password(slug, profile["name"])
            return
        if action == "view-recovery":
            profile = pf.get_profile(slug)
            if not profile:
                return
            self.dismiss(None)
            self.app._view_local_recovery_code(slug, profile["name"])

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


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


class GuidedSetupScreen(ModalScreen):
    """Guided setup, reworked 2026-08-24 (gh47): no in-app questions, no AI called by
    mtdo itself. Three self-contained actions -- export the self-documenting template,
    copy a short fixed prompt to go with it, import whatever goals.json the user's own
    AI hands back -- reusing appconfig.import_goals() (already existed for the CLI
    `mtdo import`). See plan_wizard.py's module docstring for why this replaces the
    older persona+Q&A wizard (bugs #6/#13) entirely rather than extending it.

    Deliberately stays open across actions instead of dismissing after one -- export,
    then later come back and import, all in one visit. Escape closes it once done."""

    CSS = """
    GuidedSetupScreen { align: center middle; }
    #guided-setup-box { width: 84; height: auto; max-height: 26; border: round magenta; padding: 1 2; background: $panel; }
    #guided-setup-intro { margin-bottom: 1; }
    #guided-setup-status { color: $text-muted; margin-top: 1; }
    """

    ACTIONS = [
        ("export", "1. Export the template  ->  saves goals_template.json to ~/Downloads"),
        ("copy_prompt", "2. Copy the AI prompt  ->  paste it (with the template) into any AI"),
        ("import", "3. Import your goals.json  ->  browse for the file your AI gave back"),
    ]

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="guided-setup-box"):
                    yield Static(
                        "Guided setup -- no questions here. Export the template, hand it "
                        "to any AI you already use (ChatGPT, Claude, Gemini, ...) along "
                        "with what you want to work on, then import the goals.json it "
                        "gives back.",
                        id="guided-setup-intro",
                    )
                    items = [ListItem(Label(label), name=key) for key, label in self.ACTIONS]
                    yield VimListView(*items, id="guided-setup-list")
                    yield Static("", id="guided-setup-status")
                    yield Static("Enter to run, Escape when done", classes="dim")

    def on_mount(self):
        self.query_one(VimListView).focus()

    def _set_status(self, text):
        self.query_one("#guided-setup-status", Static).update(text)

    def on_list_view_selected(self, event: ListView.Selected):
        action = event.item.name
        if action == "export":
            try:
                dest = plan_wizard.export_template()
                self._set_status(f"Exported -> {dest}")
            except Exception:
                app_log.exception("guided setup: export_template failed")
                self._set_status(f"Export failed -- see {LOG_PATH}")
        elif action == "copy_prompt":
            path, copied = plan_wizard.save_and_copy(plan_wizard.GUIDED_SETUP_PROMPT)
            note = "Copied to your clipboard and saved" if copied else "Saved"
            self._set_status(f"{note} -> {path}")
        elif action == "import":
            self.app.push_screen(GoalsFilePickScreen(), self._on_file_picked)

    def _on_file_picked(self, path):
        if not path:
            return
        try:
            added, updated = appconfig.import_goals(path)
        except Exception:
            app_log.exception("guided setup: import_goals failed for %s", path)
            self._set_status(f"Import failed -- see {LOG_PATH}")
            return
        self._set_status(
            f"Imported -- {len(added)} new field(s), {len(updated)} updated. "
            "Loads within a couple seconds."
        )

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss()


class GoalsFilePickScreen(ModalScreen):
    """Browse for a completed goals.json -- arrow keys + Enter, no path to type. A
    terminal app has no native OS file-picker; this is the closest real equivalent
    (Textual's DirectoryTree). Starts in ~/Downloads, since that's where both the
    exported template and a typical AI-chat/browser download land. Dismisses with the
    picked file's path, or None on Escape."""

    CSS = """
    GoalsFilePickScreen { align: center middle; }
    #file-pick-box { width: 76; height: 26; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self):
        super().__init__()
        downloads = os.path.expanduser("~/Downloads")
        self.start_dir = downloads if os.path.isdir(downloads) else os.path.expanduser("~")

    def compose(self) -> ComposeResult:
        with Center():
            with Middle():
                with Vertical(id="file-pick-box"):
                    yield Static("Pick your completed goals.json")
                    yield DirectoryTree(self.start_dir, id="goals-file-tree")
                    yield Static("Enter to import, Escape to cancel", classes="dim")

    def on_mount(self):
        self.query_one(DirectoryTree).focus()

    def on_directory_tree_file_selected(self, event: DirectoryTree.FileSelected):
        self.dismiss(str(event.path))

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)


class ChoicePickScreen(ModalScreen):
    """Generic modal: pick one of several options from a list, for the setup wizard's
    many multiple-choice questions (unlike TextPromptScreen's free-text Input). Dismisses
    with the chosen option's exact text, WIZARD_BACK (Ctrl+B, only when show_back=True),
    or None on Escape."""

    CSS = """
    ChoicePickScreen { align: center middle; }
    #choice-pick-box { width: 74; height: auto; max-height: 22; border: round magenta; padding: 1 2; background: $panel; }
    """

    def __init__(self, prompt_text, options, show_back=False, step_label=None):
        """step_label: see OnboardingScreen's docstring -- gh28's shared setup-
        sequence indicator. None (default) for every other use of this generic
        picker."""
        super().__init__()
        self.prompt_text = prompt_text
        self.options = options
        self.show_back = show_back
        self.step_label = step_label

    def compose(self) -> ComposeResult:
        back_hint = ", Ctrl+B back" if self.show_back else ""
        with Center():
            with Middle():
                with Vertical(id="choice-pick-box"):
                    if self.step_label:
                        yield Static(self.step_label, classes="dim")
                    yield Static(self.prompt_text)
                    items = [ListItem(Label(opt), name=opt) for opt in self.options]
                    yield VimListView(*items)
                    yield Static(f"Enter to pick, Escape to cancel{back_hint}", classes="dim")

    def on_mount(self):
        self.query_one(VimListView).focus()

    def on_list_view_selected(self, event: ListView.Selected):
        self.dismiss(event.item.name)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(None)
        elif self.show_back and event.key == "ctrl+b":
            event.prevent_default()
            event.stop()
            self.dismiss(WIZARD_BACK)


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

def _note_age(iso_date_str):
    """Notes only ever store a date (get_today().isoformat(), no time-of-day
    component -- see core.add_note), so this is day-granularity only, same as
    dashboard.py's own (separate, ISO-datetime-based) _age() -- not shared with
    it since the two work off different timestamp formats."""
    then = datetime.date.fromisoformat(iso_date_str)
    days = (tc.get_today() - then).days
    if days <= 0:
        return "today"
    if days == 1:
        return "1 day ago"
    return f"{days} days ago"


class NoteItem(ListItem):
    def __init__(self, idx, note):
        self.idx = idx
        super().__init__(Label(self._render_note(note)))

    def _render_note(self, note):
        header = Text(note["title"], style="bold cyan")
        first_line = note["body"].strip().splitlines()[0].lstrip("#").strip() if note["body"].strip() else "(empty)"
        preview = Text(first_line[:50], style="dim")
        tags = note.get("tags", [])
        meta_parts = []
        if tags:
            meta_parts.append(" ".join(f"#{t}" for t in tags))
        meta_parts.append(_note_age(note.get("updated") or note.get("created", tc.get_today().isoformat())))
        meta = Text(" · ".join(meta_parts), style="italic #6a9955" if tags else "dim")
        return Group(header, preview, meta)


class VaultScreen(Screen):
    BINDINGS = [
        ("escape", "close", "Back"),
        ("q", "close", "Back"),
        ("a", "add_note", "Add"),
        ("d", "delete_note", "Delete"),
        ("/", "focus_search", "Search"),
        ("e", "focus_editor", "Edit"),
        ("t", "edit_tags", "Tags"),
        ("p", "toggle_preview", "Preview"),
        ("y", "add_from_youtube", "From YouTube"),
    ]

    CSS = """
    VaultScreen { layout: vertical; }
    #vault-search { dock: top; }
    #vault-status-row { dock: top; height: 1; }
    #vault-status { width: 1fr; padding: 0 1; }
    #vault-spinner { width: 3; height: 1; padding: 0 1 0 0; }
    #vault-body { height: 1fr; }
    #vault-list { width: 1fr; border: round cyan; padding: 0 1; }
    #vault-editor { width: 2fr; border: round magenta; }
    #vault-preview { width: 2fr; border: round magenta; padding: 0 1; }
    #vault-help { height: 1; dock: bottom; padding: 0 1; }
    """

    def __init__(self, app_ref):
        super().__init__()
        self.app_ref = app_ref
        self.current_idx = None

    def compose(self) -> ComposeResult:
        yield Input(placeholder="/ to search notes...", id="vault-search")
        with Horizontal(id="vault-status-row"):
            self.status_line = Static("", id="vault-status")
            yield self.status_line
            self.spinner = LoadingIndicator(id="vault-spinner")
            self.spinner.display = False
            yield self.spinner
        with Horizontal(id="vault-body"):
            self.list_view = VimListView(id="vault-list")
            yield self.list_view
            self.editor = TextArea(id="vault-editor")
            yield self.editor
            # Markdown isn't scrollable on its own, unlike TextArea -- it needs a
            # scrolling container around it (same as Textual's own MarkdownViewer
            # does internally), or content past what fits on screen is unreachable.
            self.preview_md = Markdown("")
            self.preview = VerticalScroll(self.preview_md, id="vault-preview")
            self.preview.display = False
            yield self.preview
        yield Static(
            "a: add  d: delete  e: edit  t: tags  p: preview  y: YouTube  /: search  esc/q: back",
            id="vault-help", classes="dim",
        )

    def _set_status(self, text, style="dim"):
        """VaultScreen is a full Screen push, not a ModalScreen -- the main app's
        ToastLine lives on the board screen underneath it, which is completely
        hidden while Vault is active. self.app_ref.toast(...) still "succeeds"
        (no exception, the ToastLine widget's own content genuinely updates) but
        is never actually visible to the user, since Textual only renders the
        current top screen -- confirmed by hand: the message text showed up in
        ToastLine.content but never in an actual screenshot render. Vault needs
        its own visible status line instead of relying on the app-level toast."""
        self.status_line.update(Text(text, style=style))

    def _show_spinner(self, visible):
        self.spinner.display = visible

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
            if self.preview.display:
                self.preview_md.update("")
            return
        self.current_idx = idx
        body = notes[idx]["body"]
        self.editor.load_text(body)
        # Preview mode is sticky across selection changes -- if it's open, keep
        # showing whatever note is now selected instead of silently going stale.
        # scroll_home resets the scroll position too -- otherwise switching to a
        # shorter note while scrolled down in a longer one left the view stuck
        # mid-scroll, showing nothing of the newly-selected note. Markdown.update()
        # returns an AwaitComplete -- its actual re-layout (new block widgets get
        # mounted) doesn't happen synchronously, so scroll_home has to wait for
        # the next refresh or it resets the scroll position against the *old*
        # (about-to-be-replaced) content and the reset doesn't stick.
        if self.preview.display:
            self.preview_md.update(body)
            self.call_after_refresh(self.preview.scroll_home, animate=False)

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
        # The editor/preview swallow every other single-letter binding while
        # focused (TextArea treats them as literal text -- correctly, you need
        # to be able to type the letter "t" in a note), which made Escape the
        # only reachable key there. Without this, Escape from the editor closed
        # the whole Vault instead of just returning to the list -- losing your
        # place instead of getting you back to the a/d/t/p/y actions.
        if self.editor.has_focus or self.preview.has_focus:
            self.list_view.focus()
            return
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

    def action_edit_tags(self):
        item = self.current_item()
        if item is None:
            return
        notes = tc.list_notes(self.app_ref.state)
        current_tags = notes[item.idx].get("tags", [])

        def on_result(value):
            if value is None:
                return
            tags = [t.strip() for t in value.split(",") if t.strip()]
            tc.set_note_tags(self.app_ref.state, item.idx, tags)
            tc.save_state(self.app_ref.state)
            self.rebuild(select_index=self.list_view.index)

        self.app.push_screen(
            TextPromptScreen("Tags (comma-separated)", ", ".join(current_tags)), on_result
        )

    def action_toggle_preview(self):
        if self.preview.display:
            self.preview.display = False
            self.editor.display = True
            self.editor.focus()
            return
        if self.current_idx is None:
            return
        notes = tc.list_notes(self.app_ref.state)
        self.preview_md.update(notes[self.current_idx]["body"])
        self.editor.display = False
        self.preview.display = True
        # See _load_editor's comment on why this waits for a refresh rather than
        # calling scroll_home() immediately after update().
        self.call_after_refresh(self.preview.scroll_home, animate=False)
        self.preview.focus()

    def action_add_from_youtube(self):
        def on_url(url):
            url = (url or "").strip()
            if not url:
                return
            self._set_status("Fetching transcript...", style="bold yellow")
            self._show_spinner(True)
            threading.Thread(target=self._youtube_worker, args=(url,), daemon=True).start()

        self.app.push_screen(TextPromptScreen("YouTube video URL", ""), on_url)

    def _youtube_worker(self, url):
        """Runs off the main thread -- fetch_transcript()/generate_notes_and_quiz()
        both do real network calls (yt-dlp, then the AI backend), same reasoning as
        every other ai_ask caller in this app (see practice_lab_panel.py). Every
        Textual state touch goes back through call_from_thread. Status goes through
        _set_status (this screen's own status line), not self.app_ref.toast -- see
        _set_status's docstring for why toast() is silently invisible here."""
        title, transcript, error = youtube_notes.fetch_transcript(url)
        if error:
            self.app.call_from_thread(self._youtube_failed, error)
            return
        self.app.call_from_thread(self._set_status, f'Writing notes for "{title}"...', "bold yellow")
        body, error = youtube_notes.generate_notes_and_quiz(title, transcript)
        if error:
            self.app.call_from_thread(self._youtube_failed, error)
            return
        self.app.call_from_thread(self._add_youtube_note, title, body)

    def _youtube_failed(self, error):
        self._show_spinner(False)
        self._set_status(f"✗ {error}", style="bold red")

    def _add_youtube_note(self, title, body):
        self._show_spinner(False)
        tc.add_note(self.app_ref.state, title, body)
        tc.save_state(self.app_ref.state)
        self.rebuild(select_index=len(tc.list_notes(self.app_ref.state)))
        self._set_status(f'✓ Added notes from "{title}"', style="bold green")


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
    # gh28: reordered 2026-08-25 so the steps most people act on right away (the
    # board, adding cards, Focus Mode, the always-on Coach/AI panel) come before
    # the more specialized/optional ones (Practice Lab -- specifically DSA/SQL
    # practice; Career CRM -- specifically job-hunting) -- those two now sit right
    # before the closing step instead of interrupting the core flow.
    ("Pomodoro & Music", [
        ("p / x / t", "start-pause / reset / edit the pomodoro's work-break length"),
        ("m", "play/pause -- whatever's in macOS's Now Playing, or Spotify"),
        ("[ / ]", "previous / next track"),
        ("+ / -", "volume up/down"),
    ]),
    ("Stats, Streaks & Weekly Reports", [
        "The right side of the board tracks your daily score, current/longest "
        "streak, and a month calendar heatmap.",
        "Every Saturday: a week summary toast, plus a detailed report saved to "
        "~/.mtdo/reports/ -- hand it to an AI assistant for real coaching on "
        "consistency, not just a percentage.",
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
    ("Career CRM & Knowledge Vault", [
        ("c", "Career CRM -- track companies Applied -> OA -> Interview -> Offer"),
        ("v", "Knowledge Vault -- a searchable notes vault, separate from card notes"),
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

    def __init__(self, step_label=None):
        """step_label (e.g. "Setup 1 of 3"), when given, renders as an overall-
        sequence indicator above this screen's own internal "Walkthrough n/N" --
        gh28: the walkthrough, the automatic profile step, and the populate-method
        choice used to have no shared sense of being one continuous setup, each
        landing as an unrelated interruption. Only set when this screen is the
        first stage of that larger sequence (see TodoApp.on_mount) -- a standalone
        replay via 'w' (action_replay_walkthrough) passes nothing, since it isn't
        part of any larger sequence."""
        super().__init__()
        self.step = 0
        self.step_label = step_label

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

        rows = []
        if self.step_label:
            rows.append(Text(self.step_label, style="dim italic", justify="center"))
        rows += [dots, Text(""), Text(title, style="bold underline", justify="center"), Text("")]
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

    def on_mount(self):
        self._record_step_viewed()

    def _record_step_viewed(self):
        analytics.record(
            "onboarding_step_viewed", step_index=self.step,
            step_title=ONBOARDING_STEPS[self.step][0], total_steps=len(ONBOARDING_STEPS),
        )

    def action_next(self):
        if self.step < len(ONBOARDING_STEPS) - 1:
            self.step += 1
            self._refresh()
            self._record_step_viewed()
        else:
            self.dismiss()

    def action_back(self):
        if self.step > 0:
            self.step -= 1
            self._refresh()

    def action_skip(self):
        analytics.record("onboarding_skipped", step_index=self.step)
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
                epoch = self.app._profile_epoch
                threading.Thread(
                    target=self._generate_worker, args=(block, topic_type, epoch), daemon=True,
                ).start()
            self.update(self._generating_panel(block["text"]))
            return
        self.update(self._dsa_problem_panel(block["text"], problem))

    def _generate_worker(self, block, topic_type, epoch):
        prompt = coaching.build_problem_prompt(block["text"], topic_type)
        try:
            answer, error = ai_ask.ask(prompt, timeout=90)
        except Exception as e:
            app_log.exception("DSA problem generation failed")
            answer, error = None, str(e)
        self.app.call_from_thread(self._store_generated, block, answer, error, epoch)

    def _store_generated(self, block, answer, error, epoch):
        self.app.dsa_generating.discard(id(block))
        if epoch != self.app._profile_epoch:
            # gh63: the user switched profiles while this generation was in
            # flight (it can take up to 90s) -- `block` belongs to a state
            # tree that's no longer self.app.state, so mutating/saving it
            # here would silently go nowhere. Drop the result.
            return
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
                epoch = self.app._profile_epoch
                threading.Thread(
                    target=self._generate_coaching_worker, args=(block, label, epoch), daemon=True,
                ).start()
            self.update(self._generating_panel(block["text"], "Asking the AI to tailor coaching notes..."))
            return
        if cached is False:
            # Generation failed or no AI backend is configured -- fall back to the plain
            # static panel rather than getting stuck showing "Generating..." forever.
            self.update(self._no_coaching_panel(block["text"], category_meta))
            return
        self.update(self._coach_panel(block["text"], cached, note="AI-tailored for this task"))

    def _generate_coaching_worker(self, block, label, epoch):
        prompt = coaching.build_ai_coaching_prompt(block["text"], label)
        try:
            answer, error = ai_ask.ask(prompt, timeout=60)
        except Exception as e:
            app_log.exception("AI coaching generation failed")
            answer, error = None, str(e)
        self.app.call_from_thread(self._store_generated_coaching, block, answer, error, epoch)

    def _store_generated_coaching(self, block, answer, error, epoch):
        self.app.coaching_generating.discard(id(block))
        if epoch != self.app._profile_epoch:
            # gh63: see _store_generated's identical comment above.
            return
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
        now = datetime.datetime.now()
        name = None
        active = pf.get_active_slug()
        if active:
            profile = pf.get_profile(active)
            if profile:
                name = profile["name"]
        if not name:
            name = appconfig.get_user_name()
        if name:
            title = f"Hello, {name} · {_greeting_for_hour(now.hour)}"
        else:
            title = tc.APP_NAME
        display_time = now.strftime("%I:%M:%S %p")
        today = tc.get_today()
        self.update(Text(f" {title}    {tc.DAY_NAMES[today.weekday()]}, {today.strftime('%b %d, %Y')}    {display_time} ",
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
    #enter-radio-btn { width: 100%; height: 3; background: #1a0d2e; color: #ff2d95; border: round #7c5cff; }
    #enter-radio-btn:hover { background: #2a1550; }
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
        ("U", "open_profile_menu", "Profile"),
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
        ("R", "open_radio", "Radio"),
    ] + ([("B", "report_bug", "Report Bug")] if SANDBOX_INSTANCE_MODE else [])

    def __init__(self):
        super().__init__()
        self._session_started = time.monotonic()
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
        # gh63: bumped on every profile switch (see _switch_profile). A DSA/coaching
        # generation worker can run up to 90s in the background; if the user switches
        # profiles before it finishes, the `block` dict it closed over belongs to the
        # OLD self.state tree, not the new one -- mutating/saving it would be a silent
        # no-op that also wastes the AI call. Workers capture this epoch when they
        # start and compare it against the current value before storing their result,
        # discarding it if the profile has changed since. Deliberately not keyed off
        # id(block) alone (the previous bug) -- CPython can reuse a freed object's
        # address, which could make a stale result look like it belongs to a
        # same-address block in the new profile.
        self._profile_epoch = 0
        self._hint_prompt_open = False
        # AI-panel context priming (see coaching.build_focus_context_message /
        # _prime_ai_context_if_needed): the (date_key, category, idx) of the active task
        # last sent into the running AI panel, so switching tasks re-primes it but
        # refocusing the same task/session doesn't spam the conversation.
        self.ai_primed_ref = None
        # The active protected profile's password, kept in memory only for as long as
        # it's active (gh52) -- set the moment it's proven correct (startup unlock or
        # a switch into it), cleared the moment a different profile becomes active.
        # This is *not* the gh49 session-lifetime cache that was deliberately removed:
        # gh49 was about not skipping re-entry when switching INTO a profile you've
        # visited before this session; this is only ever used to auto-save the
        # profile you are *currently, already* in on your way out of it, which needs
        # no re-proof since you're already proving it every time you touch the app.
        self._active_profile_password = None
        try:
            self._goals_mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            self._goals_mtime = None
        # One shared RadioPlayer for the whole app run, owned here (not by
        # RadioScreen) specifically so playback survives closing and reopening
        # that screen -- it's a "session" you dip in and out of, not something
        # tied to the screen's own lifetime. Stopped explicitly on quit (see
        # _stop_claude_and_exit) so mpv/ffmpeg never survive as orphaned
        # background processes after mtdo exits.
        self.radio_player = radio.RadioPlayer()

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
                yield Button("🎧 Enter Radio Session", id="enter-radio-btn")
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
        self.profile_footer = ProfileFooter()
        yield self.profile_footer

    def on_mount(self):
        self._refresh_profile_footer()
        active = pf.get_active_slug()
        profile = pf.get_profile(active) if active else None
        if profile and profile.get("protected"):
            # gh49: gate the app itself on launch, not just switches -- see
            # ProfileUnlockScreen's docstring. Everything else in this method is
            # deferred until unlocked.
            def _unlocked(pw):
                self._active_profile_password = pw
                self._finish_startup()
            self._push_modal(ProfileUnlockScreen(active, profile["name"]), _unlocked)
            return
        self._finish_startup()

    def _finish_startup(self):
        # gh71: prune_older_than() does a DELETE + VACUUM against events.db --
        # VACUUM rebuilds the whole file and scales with its size. Nothing
        # downstream in this method depends on its result, so run it off the
        # main/event-loop thread rather than blocking every single app launch
        # on it (harmless today at typical events.db sizes, but the one place
        # in this app doing blocking DB maintenance directly in the startup
        # path instead of off-thread like other slow I/O).
        threading.Thread(target=analytics.prune_older_than, kwargs={"days": 180}, daemon=True).start()
        saved = tc.maybe_autosave_daily_report(self.state, self.today)
        self.refresh_side_panels()
        messages, style = [], "bold cyan"
        if saved:
            messages.append(f"Auto-saved yesterday's report -> {saved}")
        if self.today.weekday() == 5:  # Saturday -- the week's completion checkpoint
            check, all_done = self._weekly_check_summary()
            report_path = tc.save_weekly_report_txt(self.state, self.today)
            analytics.record("weekly_report_generated", all_done=all_done)
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
                if not appconfig.has_configured_plan():
                    self._begin_setup_flow(step_offset=1)
            walkthrough_total = 1 + self._setup_sequence_length()
            self.push_screen(
                OnboardingScreen(step_label=f"Setup 1 of {walkthrough_total}"), callback=after_onboarding,
            )
        elif not appconfig.has_configured_plan():
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
        if not self.is_running:
            return  # see on_second_tick's comment on why this guard exists
        try:
            mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            return
        if self._goals_mtime is not None and mtime == self._goals_mtime:
            return
        self._goals_mtime = mtime
        self.reload_from_goals(toast_on_change=True)

    def reload_from_goals(self, toast_on_change=False):
        # No goals.json (a brand new/empty profile just switched to, or the last
        # profile just deleted -- see _delete_profile) means a genuinely empty board,
        # not "leave whatever was loaded before showing" -- this used to just return
        # here doing nothing, so switching to an empty profile silently kept showing
        # the previous profile's categories (caught live 2026-08-25, gh19/gh48).
        try:
            goals = appconfig.load_goals()
        except FileNotFoundError:
            cfg = appconfig.empty_config()
        except appconfig.ConfigError as e:
            self._reload_failed(e)
            return
        else:
            try:
                cfg, _, _ = appconfig.goals_to_config(goals)
            except appconfig.ConfigError as e:
                self._reload_failed(e)
                return
        try:
            tc.configure(cfg)
        except appconfig.ConfigError as e:
            self._reload_failed(e)
            return
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

    def _reload_failed(self, error):
        """gh39: a hand-edit that leaves goals.json invalid (bad JSON, a category
        missing "label"/"days", ...) must not crash the running app -- the polling
        check_goals_file (every 2s, see above) would otherwise take the whole app
        down almost immediately after a bad save. Keeps showing whatever config was
        last successfully loaded and always says what's wrong -- unlike the
        "changed -- reloaded" message above, this ignores toast_on_change, since a
        real problem should surface regardless of which caller triggered the
        reload. Still updates _goals_mtime so the poll doesn't re-toast the exact
        same error every 2 seconds until the file actually changes again."""
        try:
            self._goals_mtime = os.path.getmtime(appconfig.GOALS_PATH)
        except OSError:
            pass
        self.toast(f"goals.json problem, not reloaded: {error}", style="bold red")

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
        if not self.is_running:
            # Textual cancels an app's own set_interval timers on exit, but a
            # tick already scheduled at the moment of exit can still land just
            # after teardown -- confirmed live via CI (not locally, timing-
            # dependent): a previous test's leftover tick fired into a torn-down
            # screen stack with no ClockHeader left, crashing query_one with
            # NoMatches. This guard makes a late tick a no-op instead.
            return
        self.query_one(ClockHeader).update_clock()
        self.profile_footer.refresh_label()
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
                    analytics.record("pomodoro_completed", duration_seconds=self.pomo_panel.work_minutes * 60)
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
        ended up with zero context at all, not just late context.

        Wrapped in try/except (bug #7/GH#11 -- "the AI in focus mode is crashing
        again and again"): this used to have no guard of its own, unlike every other
        entry point into the AI panel (see action_toggle_claude). It's reached from
        several call sites (here, action_toggle_claude's start_backend,
        LearningCoachPanel._store_generated, PracticeLabPanel.action_evaluate_code)
        -- some of those already wrap their own call, but not all did, so a bad/
        malformed active task (e.g. a stale category no longer in CATEGORY_META, or
        a block missing an expected key from an older saved state) degrades to
        "priming skipped, Focus Mode/the panel still opens" instead of taking the
        whole app down with an exception no code path here was logging."""
        if not self.focus_mode:
            return
        try:
            active = tc.current_active_task(self.state, self.today)
            if active is None:
                return
            ref = (active["date_key"], active["category"], active["idx"])
            if ref == self.ai_primed_ref:
                return
            category_meta = tc.CATEGORY_META.get(active["category"]) or {}
            raw_capable = ai_backend.supports_raw_multiline_paste(self.claude_panel.command)
            message = coaching.build_focus_context_message(
                active["block"].get("text", ""),
                category_meta.get("label", active["category"]),
                active["block"].get("dsa_problem"),
                multiline=raw_capable,
            )
            self.ai_primed_ref = ref
            if self.claude_panel.is_running:
                self.claude_panel.send_text_when_idle(message, flatten=not raw_capable)
        except Exception:
            app_log.exception("_prime_ai_context_if_needed failed")

    def action_toggle_pomodoro(self):
        self.pomo_panel.running = not self.pomo_panel.running
        if self.pomo_panel.running:
            analytics.record("pomodoro_started", duration_seconds=self.pomo_panel.work_minutes * 60)
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
        """Bound to 'f'. Wrapped in try/except (bug #7/GH#11 -- "the AI in focus
        mode is crashing again and again"): this had no guard of its own, unlike
        action_toggle_claude right below it -- so any failure past the display
        toggles (pomodoro setup, blur(), refresh_side_panels/the Learning Coach's
        own rendering, or priming the AI panel) took down the whole app with
        nothing logged, since it's the one direct path into Focus Mode that wasn't
        covered. The focus_mode flag and pane visibility are set before the guarded
        section so even a failure downstream leaves the board in the state the
        press asked for, not stuck."""
        self.focus_mode = not self.focus_mode
        show = not self.focus_mode
        self.kanban.display = show
        self.stats_scroll.display = show
        self.calendar_scroll.display = show
        self.claude_panel.display = self.focus_mode
        self.practice_panel.display = self.focus_mode and self.practice_terminal_enabled
        try:
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
            analytics.record("focus_mode_toggled", enabled=self.focus_mode)
            self.refresh_side_panels()
            self._prime_ai_context_if_needed()
        except Exception:
            app_log.exception("action_toggle_focus_mode failed")
            self.toast(f"Focus Mode hit an error -- see {LOG_PATH}", style="bold red")

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
                    was_running = self.claude_panel.is_running
                    prev_label = self.claude_panel._chosen_label
                    ai_backend.save_choice(command, label)
                    if self.claude_panel.is_running:
                        self.claude_panel.stop()
                    self.ai_primed_ref = None  # fresh process -- (re)prime even the same task
                    self.claude_panel.start_with(command, label)
                    self.claude_panel.focus()
                    self._prime_ai_context_if_needed()
                    if was_running:
                        analytics.record(
                            "ai_panel_backend_switch",
                            from_backend=analytics.classify_ai_backend(prev_label),
                            to_backend=analytics.classify_ai_backend(label),
                        )
                    else:
                        analytics.record(
                            "ai_panel_backend_started",
                            backend=analytics.classify_ai_backend(label), auto_detected=False,
                        )
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
                self._sync_bug_in_background()
        self.push_screen(BugReportScreen(), on_result)

    def _sync_bug_in_background(self):
        """Fires GitHub sync -> auto-triage -> dashboard regeneration on a background
        thread right after a bug is logged, so neither dev has to run the 3-command flow
        (`bugs sync` / `gh issue list` / `dashboard`) by hand (2026-08-24, explicit
        request). Never blocks the UI -- `gh` calls are network I/O -- and never puts the
        bug itself at risk: bug_log.add_bug() above already wrote it to disk durably
        before this is even called, so a failure here (offline, `gh` not authenticated)
        just means sync/triage/the dashboard file are stale until the next successful
        run, not that the bug report is lost.

        Does NOT publish the dashboard as a shared Artifact -- nothing running locally
        can do that; only a Claude Code session under the account that owns the artifact
        link can (see dashboard.py's module docstring). That step still needs asking."""
        def worker():
            try:
                from . import bug_sync, dashboard
                filed, triaged = bug_sync.sync_and_triage()
                # dashboard.generate()'s own safety-net triage pass often catches a
                # just-filed bug the line above missed (GitHub's issue-list endpoint has
                # shown a beat of lag right after a create, in practice) -- merge both so
                # the toast below reports what actually ended up triaged, not just the
                # first attempt's count.
                _, triaged_after = dashboard.generate()
                if triaged_after is None:
                    # gh67: a transient `gh` failure inside generate() itself
                    # (as opposed to bug_sync.sync_and_triage() above, already
                    # covered by this whole method's own try/except) -- the
                    # dashboard file is untouched, still showing the last
                    # generated version, so say that plainly instead of
                    # claiming a refresh that didn't happen.
                    msg = "Dashboard refresh skipped (a `gh` call failed) -- still showing the last generated version"
                else:
                    triaged = {**triaged, **triaged_after}
                    if filed or triaged:
                        msg = f"Synced {filed} bug(s), triaged {len(triaged)} -- dashboard updated"
                    else:
                        msg = "Dashboard refreshed"
                self.call_from_thread(self.toast, msg, style="dim")
            except Exception:
                app_log.exception("background bug sync/triage/dashboard failed")
                self.call_from_thread(
                    self.toast, "Background bug sync failed -- see log", style="bold red"
                )
        threading.Thread(target=worker, daemon=True).start()

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
        analytics.record(
            "app_exited", quit_via="q",
            session_seconds=round(time.monotonic() - self._session_started),
        )
        try:
            self.claude_panel.stop()
        except Exception:
            app_log.exception("failed to stop claude panel on quit")
        try:
            self.radio_player.stop()
        except Exception:
            app_log.exception("failed to stop radio player on quit")
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
        analytics.record("error_shown_to_user", error_type=type(error).__name__, context="app_crash")
        analytics.record(
            "app_exited", quit_via="crash",
            session_seconds=round(time.monotonic() - self._session_started),
        )
        super()._handle_exception(error)

    def action_open_career(self):
        analytics.record("screen_opened", screen="career")
        self.push_screen(CareerScreen(self), callback=lambda _r=None: self.refresh_side_panels())

    def action_open_vault(self):
        analytics.record("screen_opened", screen="vault")
        self.push_screen(VaultScreen(self), callback=lambda _r=None: self.refresh_side_panels())

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "enter-radio-btn":
            self.action_open_radio()

    def action_open_radio(self):
        if not radio.has_mpv():
            self.toast(
                f"Radio needs mpv -- run `{radio.MPV_INSTALL_HINT}`, then try again.",
                style="bold red",
            )
            return
        analytics.record("screen_opened", screen="radio")
        self.push_screen(RadioScreen(self.radio_player))

    def _refresh_profile_footer(self):
        if self.profile_footer is not None:
            self.profile_footer.refresh_label()
        # keep the "Hello, <name>" header in sync immediately on create/switch/rename/
        # delete, rather than waiting for the next on_second_tick.
        self.query_one(ClockHeader).update_clock()

    def _push_modal(self, screen, callback=None):
        """push_screen wrapper that pins the result callback's requester to the App.

        Screen.dismiss() delivers its result callback via requester.call_next(...),
        where requester is whatever active_message_pump.get() resolves to at push
        time. The profile screens routinely dismiss themselves and then immediately
        push a follow-up modal (e.g. "close this menu, open Create Profile") in the
        same synchronous handler -- active_message_pump still resolves to the screen
        that just dismissed, and its message pump stops processing once torn down,
        so the callback is silently dropped (confirmed: it never fires, no error).
        Pinning the requester to self (the App, always alive) sidesteps that --
        needed for any push_screen(..., callback) reachable from inside another
        screen's own dismiss-then-push chain.
        """
        token = active_message_pump.set(self)
        try:
            return self.push_screen(screen, callback)
        finally:
            active_message_pump.reset(token)

    def _save_current_profile(self):
        """Auto-saves the outgoing profile on the way out of a switch, using the
        password already cached in self._active_profile_password from when THIS
        profile became active (startup unlock or an earlier switch into it) --
        gh52: re-prompting here was pure friction, since saving the profile you're
        already in proves nothing gh49 cares about (that's about not skipping
        re-entry for a profile you're switching INTO). Falls back to prompting only
        if that cache is somehow unset (defensive; shouldn't happen in practice)."""
        active = pf.get_active_slug()
        if active is None:
            return
        profile = pf.get_profile(active)
        if profile is None:
            return
        if profile.get("protected"):
            if self._active_profile_password is not None:
                self._write_current_profile(active, self._active_profile_password)
                return
            self._push_modal(
                TextPromptScreen(f"Password for profile '{profile['name']}' (saving)", "", secret=True),
                lambda value: self._save_current_profile_after_password(value, active),
            )
            return
        self._write_current_profile(active, None)

    def _save_current_profile_after_password(self, value, slug):
        if value is None:
            return
        self._write_current_profile(slug, value)

    def _write_current_profile(self, slug, password):
        if os.path.exists(appconfig.GOALS_PATH):
            try:
                goals = appconfig.load_goals()
                pf.write_goals(slug, goals, password)
            except FileNotFoundError:
                pass
        pf.write_state(slug, self.state, password)

    def _switch_profile(self, slug, password=None):
        """gh49: every switch to a protected profile re-prompts for its password,
        every time -- no cache that would let you switch INTO a profile without
        re-proving you know its password (there used to be one; a tester explicitly
        asked for a password to be required "each time," not just the first). If
        canceled (Escape -> None from the prompt), the lambda below just doesn't
        recurse, so the switch quietly doesn't happen instead of looping back into
        asking again forever.

        Once `password` is actually verified below (via read_goals/read_state), it's
        cached onto self._active_profile_password for as long as this profile stays
        active -- gh52, so a *later* switch away from THIS profile can auto-save it
        without asking a third time for a password already proven twice today (once
        to switch in here, and originally to unlock it in the first place). This
        cache never shortcuts switching INTO a profile -- gh49's protection is
        untouched -- only saving the one you're already, currently in."""
        target = pf.get_profile(slug)
        if target is None:
            self.toast("No profile selected.", style="bold red")
            return
        if target.get("protected") and password is None:
            self._push_modal(
                TextPromptScreen(f"Password for profile '{target['name']}' (switching)", "", secret=True),
                lambda value: self._switch_profile(slug, password=value) if value is not None else None,
            )
            return
        current = pf.get_active_slug()
        switching_profile = current is not None and current != slug
        if switching_profile:
            self._save_current_profile()
        try:
            goals = pf.read_goals(slug, password)
            state = pf.read_state(slug, password)
        except pf.WrongPassword:
            self.toast("Wrong password for that profile.", style="bold red")
            return
        if goals is not None:
            with open(appconfig.GOALS_PATH, "w") as f:
                import json
                json.dump(goals, f, indent=2, sort_keys=False)
        elif os.path.exists(appconfig.GOALS_PATH):
            os.remove(appconfig.GOALS_PATH)
        with open(appconfig.STATE_PATH, "w") as f:
            import json
            json.dump(state or {"_meta": {}}, f, indent=2, sort_keys=False)
        pf.set_active(slug)
        self._active_profile_password = password if target.get("protected") else None
        appconfig.set_user_name(target["name"])
        self.state = state or {"_meta": {}}
        if switching_profile:
            # gh57: none of this is part of goals.json/state.json (it's plain
            # runtime bookkeeping on TodoApp/PomodoroPanel), so it survived a
            # profile switch untouched before this -- a Pomodoro left running
            # in profile A kept ticking, still showing its elapsed time, after
            # switching to profile B, and stale DSA/coaching/AI-priming refs
            # from A's specific tasks could carry over into B's (different)
            # ones. Reset here, before reload_from_goals() (which re-renders
            # every side panel via refresh_side_panels()), so that render
            # already reflects the fresh values instead of needing a second
            # pass. Deliberately NOT resetting focus_mode -- that's a view
            # preference, not profile data, and nothing here reads or writes
            # through it in a way that could leak between profiles.
            self.pomo_panel.running = False
            self.pomo_panel.on_break = False
            self.pomo_panel.work_minutes = tc.DEFAULT_POMODORO_MINUTES
            self.pomo_panel.break_minutes = tc.DEFAULT_BREAK_MINUTES
            self.pomo_panel.remaining = tc.DEFAULT_POMODORO_MINUTES * 60
            self.current_dsa_ref = None
            self.dsa_generating = set()
            self.coaching_generating = set()
            self._profile_epoch += 1
            self.ai_primed_ref = None
            self._hint_prompt_open = False
        self.reload_from_goals()
        self._refresh_profile_footer()
        self.toast(f"Switched to profile '{target['name']}'", style="bold green")

    def action_open_profile_menu(self):
        analytics.record("screen_opened", screen="profile_menu")
        self.push_screen(ProfileMenuScreen())

    def action_create_profile(self):
        self._push_modal(ProfileCreateScreen(), self._on_profile_created_manual)

    def _on_profile_created_manual(self, result):
        """The "Add Profile" action (Manage Profiles / footer badge), reached
        once at least one profile already exists -- deliberately a separate
        method from _on_profile_created below, not a shared one with an extra
        flag: that method is also called internally by _begin_setup_flow's own
        first-run bootstrapping branch (when there are no profiles at all yet),
        which already chains straight into _pick_populate_method itself --
        triggering the setup wizard here too would fire it twice for a brand
        new install. A profile created via *this* action is always brand new
        with an empty board, so the goals-setup wizard always makes sense here
        -- gh57: this used to be silently skipped, leaving a fresh profile's
        board empty with no prompt to fill it in until the user discovered 'g'
        themselves. Fires after the actual switch, not merely after creation,
        so it lands correctly whether or not a recovery-code screen appears in
        between (protected profiles show one; unprotected ones don't)."""
        if result is None:
            return
        name, password = result
        try:
            slug, recovery_code = pf.create_profile(name, password=password)
        except pf.ProfileError as exc:
            self.toast(str(exc), style="bold red")
            return
        appconfig.set_user_name(name)
        def _switch_then_setup():
            self._switch_profile(slug, password=password)
            self._begin_setup_flow()
        if recovery_code:
            self._push_modal(RecoveryCodeScreen(recovery_code, slug), lambda _r=None: _switch_then_setup())
        else:
            _switch_then_setup()

    def _on_profile_created(self, result):
        """Only reached from _begin_setup_flow's first-run bootstrapping branch
        (no profiles exist yet) -- that caller already chains into
        _pick_populate_method itself right after this returns, so this must
        NOT also trigger _begin_setup_flow() (see _on_profile_created_manual's
        docstring for why). See that method for the "Add Profile" action."""
        if result is None:
            return
        name, password = result
        try:
            slug, recovery_code = pf.create_profile(name, password=password)
        except pf.ProfileError as exc:
            self.toast(str(exc), style="bold red")
            return
        appconfig.set_user_name(name)
        if recovery_code:
            self._push_modal(
                RecoveryCodeScreen(recovery_code, slug),
                lambda _r=None: self._switch_profile(slug, password=password),
            )
        else:
            self._switch_profile(slug, password=password)

    def action_manage_profiles(self):
        self.push_screen(ProfileManageScreen())

    def _with_profile_auth(self, slug, on_authorized):
        """Gate a Manage Profiles action behind the profile's own password if it's
        protected -- gh49: rename and delete used to need no authentication at
        all, so anyone at the app could rename, or permanently delete (including
        its encrypted files -- delete_profile removes the directory outright,
        recovery code included), a protected profile without ever knowing its
        password. Unprotected profiles stay exactly as frictionless as before --
        this only gates profiles that opted into protection."""
        profile = pf.get_profile(slug)
        if profile is None:
            return
        if not profile.get("protected"):
            on_authorized()
            return
        def got_password(password):
            if password is None:
                return
            if not pf.check_password(slug, password):
                self.toast("Wrong password.", style="bold red")
                return
            on_authorized()
        self._push_modal(
            TextPromptScreen(f"Password for '{profile['name']}' (required to continue)", "", secret=True),
            got_password,
        )

    def _start_rename_profile(self, slug):
        profile = pf.get_profile(slug)
        if profile is None:
            return
        def do_rename():
            self._push_modal(
                TextPromptScreen("Rename profile", profile["name"]),
                lambda value: self._rename_profile(slug, value),
            )
        self._with_profile_auth(slug, do_rename)

    def _start_delete_profile(self, slug):
        profile = pf.get_profile(slug)
        if profile is None:
            return
        self._with_profile_auth(slug, lambda: self._delete_profile(slug, profile["name"]))

    def _rename_profile(self, slug, value):
        if value is None or not value.strip():
            return
        try:
            pf.rename_profile(slug, value)
        except pf.ProfileError as exc:
            self.toast(str(exc), style="bold red")
            return
        self._refresh_profile_footer()
        self.toast("Profile renamed", style="bold green")

    def _delete_profile(self, slug, name):
        def on_confirm(value):
            if value is None:
                return
            if value.strip() != name:
                self.toast("Deletion cancelled -- name did not match.", style="bold yellow")
                return
            try:
                pf.delete_profile(slug)
            except pf.ProfileError as exc:
                self.toast(str(exc), style="bold red")
                return
            if pf.get_active_slug() is None:
                self.state = {"_meta": {}}
                if os.path.exists(appconfig.GOALS_PATH):
                    os.remove(appconfig.GOALS_PATH)
                if os.path.exists(appconfig.STATE_PATH):
                    os.remove(appconfig.STATE_PATH)
                self.reload_from_goals()
            self._refresh_profile_footer()
            self.toast(f"Deleted profile '{name}'", style="bold yellow")
        self._push_modal(TextPromptScreen(f"Type '{name}' to confirm delete", ""), on_confirm)

    def _reset_profile_password(self, slug, name, on_done=None):
        """Reset a forgotten password via recovery code (gh40) -- reached from
        ProfileManageScreen's own dismiss-then-push chain, so every step uses
        _push_modal, not push_screen (see its docstring). Also reachable from
        ProfileUnlockScreen's "Forgot password?" button (the only way past that
        screen besides the actual password, so this had to be reachable from
        there too -- see its docstring) -- on_done(new_password) fires only on
        an actual successful reset, letting that screen dismiss itself with the
        new password and unlock immediately instead of making the user retype
        it. ProfileManageScreen's call leaves on_done unset and just toasts,
        same as before.

        The recovery code is checked (pf.check_recovery_code) as soon as it's
        entered, before asking for a new password at all (gh51) -- it used to only
        get validated at the very end, after the user had already typed and
        confirmed a brand-new password, which read exactly like the app "let" a
        wrong code through even though the actual reset was always correctly
        rejected. recover_profile() itself still re-validates the code at the end
        (belt and suspenders against the profile record changing in between)."""
        def got_code(code):
            if code is None or not code.strip():
                return
            if not pf.check_recovery_code(slug, code):
                self.toast(f'wrong recovery code for profile "{name}".', style="bold red")
                return
            def got_new_password(new_password):
                if new_password is None or not new_password.strip():
                    return
                def got_confirm(confirm):
                    if confirm is None:
                        return
                    if confirm != new_password:
                        self.toast("Passwords didn't match -- not reset.", style="bold red")
                        return
                    try:
                        pf.recover_profile(slug, code, new_password)
                    except pf.InvalidRecoveryCode as exc:
                        self.toast(str(exc), style="bold red")
                        return
                    except pf.ProfileError as exc:
                        self.toast(str(exc), style="bold red")
                        return
                    self.toast(f"Password reset for '{name}'.", style="bold green")
                    if on_done is not None:
                        on_done(new_password)
                self._push_modal(
                    TextPromptScreen("Confirm new password", "", secret=True), got_confirm,
                )
            self._push_modal(
                TextPromptScreen(f"New password for '{name}'", "", secret=True), got_new_password,
            )
        self._push_modal(
            TextPromptScreen(f"Recovery code for '{name}'", ""), got_code,
        )

    def _view_local_recovery_code(self, slug, name):
        """Shows a locally saved recovery code back to the user (gh53) -- the
        read-back counterpart to RecoveryCodeScreen's optional local save, without
        which saving one would be write-only and pointless. Only reachable via
        Manage Profiles' "View Recovery Code" button, itself only shown when
        pf.has_local_recovery_code(slug) is true.

        Deliberately NOT gated behind _with_profile_auth (the profile's own
        password), unlike rename/delete -- a recovery code exists specifically to
        get back in when that password is forgotten, so requiring it here would
        defeat the entire feature. If the local save itself was protected at save
        time, its own separate password (below) is the real gate; if it wasn't,
        that was the user's own explicit choice, same tradeoff an unprotected
        profile already makes."""
        if pf.local_recovery_code_protected(slug):
            def got_password(password):
                if password is None:
                    return
                try:
                    code = pf.read_local_recovery_code(slug, password)
                except pf.WrongPassword as exc:
                    self.toast(str(exc), style="bold red")
                    return
                self.push_screen(LocalRecoveryCodeViewScreen(code))
            self._push_modal(
                TextPromptScreen(f"Password for '{name}''s saved recovery code", "", secret=True),
                got_password,
            )
            return
        try:
            code = pf.read_local_recovery_code(slug)
        except pf.ProfileError as exc:
            self.toast(str(exc), style="bold red")
            return
        self.push_screen(LocalRecoveryCodeViewScreen(code))

    def action_open_help(self):
        analytics.record("help_opened", context="focus_mode" if self.focus_mode else "board")
        self.push_screen(HelpScreen())

    def action_replay_walkthrough(self):
        self.push_screen(OnboardingScreen())

    def action_plan_wizard(self):
        self._begin_setup_flow()

    def _setup_sequence_length(self):
        """How many steps _begin_setup_flow's own sequence has THIS run: profile +
        populate-method, plus the analytics opt-in only if it hasn't been answered
        yet. Computed fresh each call (not a constant) so a re-run after analytics
        is already decided displays an accurate total instead of counting a
        step that _prompt_analytics_optin will silently skip."""
        return 2 if appconfig.load_analytics_settings()["decided_at"] is not None else 3

    def _begin_setup_flow(self, step_offset=0):
        """Entry point for the whole setup wizard: Profiles Section -> "how do you want
        to build your plan" (Manual vs Guided setup) -> analytics opt-in (skipped if
        already answered). Triggered automatically right after the feature walkthrough
        on a genuine first run (see on_mount), or any time via 'g' (action_plan_wizard)
        to re-run it.

        Reworked 2026-08-24 (gh47): previously asked for a name, then a persona, then
        (for guided setup) walked a persona-specific Q&A before building an AI prompt.
        All of that's gone -- profiles already carry identity (ClockHeader's greeting
        already prefers the active profile's name), and Guided setup no longer asks
        anything in-app either; see GuidedSetupScreen and plan_wizard.py for why.

        Reworked again 2026-08-25 (gh48): the intended flow was always
        "walkthrough -> Profiles Section -> How do you want to build your plan" --
        confirmed live that no profile step was actually happening automatically here,
        only reachable manually via the footer badge. No profiles yet -> straight to
        creating the first one (a picker with nothing in it would be a dead end).
        Profiles already exist -> the picker, so you can switch to one or add another.
        Either way, proceeds to the populate-method step next regardless of what
        happened there (closed without picking, cancelled creation, ...) -- consistent
        with the rest of this wizard: skippable at every step, the board starts (and
        stays, if you cancel out) genuinely empty either way.

        step_offset (gh28): shifts the displayed numbers when a walkthrough precedes
        this (on_mount passes offset=1). total_steps is always computed here, not
        passed in, via _setup_sequence_length() -- see its docstring for why."""
        total_steps = step_offset + self._setup_sequence_length()
        profile_step, populate_step = step_offset + 1, step_offset + 2
        if not pf.list_profiles():
            def on_created(result):
                self._on_profile_created(result)
                self._pick_populate_method(populate_step, total_steps)
            self._push_modal(
                ProfileCreateScreen(step_label=f"Setup {profile_step} of {total_steps}"), on_created,
            )
        else:
            # _push_modal, not push_screen -- _begin_setup_flow is itself reached from
            # inside another screen's dismiss-then-push chain (OnboardingScreen's
            # callback, see on_mount), the exact case _push_modal's docstring warns a
            # plain push_screen(..., callback) callback would silently never fire for.
            self._push_modal(
                ProfileMenuScreen(step_label=f"Setup {profile_step} of {total_steps}"),
                lambda _result: self._pick_populate_method(populate_step, total_steps),
            )

    def _pick_populate_method(self, step=2, total=3):
        options = [
            "Manual -- I'll build it myself in the app (press 'a' to add fields)",
            "Guided setup -- export a template, hand it to any AI, import the result",
        ]

        def on_choice(choice):
            if choice is None:
                self._prompt_analytics_optin(step + 1, total)
                return
            appconfig.mark_plan_configured()
            if choice.startswith("Manual"):
                analytics.record("plan_setup_completed", method="manual")
                self.toast(
                    "Okay -- your board is empty. Press 'a' any time to add a field, "
                    "then start adding cards to it.",
                    style="bold cyan",
                )
            else:
                analytics.record("plan_setup_completed", method="guided")
                self.push_screen(GuidedSetupScreen())
            self._prompt_analytics_optin(step + 1, total)

        self.push_screen(
            ChoicePickScreen(
                "How do you want to build your plan?", options,
                step_label=f"Setup {step} of {total}",
            ),
            on_choice,
        )

    def _prompt_analytics_optin(self, step, total):
        """Last step of the setup sequence -- ask once whether to turn on local usage
        analytics (see analytics.py, PRIVACY.md). Never re-asked once answered:
        set_analytics_local_enabled always stamps decided_at, even on "No" or
        Escape, same as every other step in this wizard being freely skippable."""
        if appconfig.load_analytics_settings()["decided_at"] is not None:
            return
        options = [
            "Yes -- help improve mtdo (stays on this machine, see PRIVACY.md)",
            "No thanks",
        ]

        def on_choice(choice):
            appconfig.set_analytics_local_enabled(bool(choice) and choice.startswith("Yes"))

        self.push_screen(
            ChoicePickScreen(
                "Turn on local usage analytics?", options,
                step_label=f"Setup {step} of {total}",
            ),
            on_choice,
        )

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
    import platform
    from . import __version__
    analytics.record("app_launched", version=__version__, platform=platform.system())
    TodoApp().run()


if __name__ == "__main__":
    from . import config as appconfig
    run_app(appconfig.load_config())
