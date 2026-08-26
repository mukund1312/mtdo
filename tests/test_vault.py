"""Tests for the Knowledge Vault UX improvements: tags, a markdown preview
toggle, and a loading spinner during the YouTube notes flow. Each test computes
its own "before" baseline from the shared state rather than assuming an empty
vault -- MTDO_HOME (and so state.json) is shared across this whole pytest
session (see conftest.py), so other tests' notes may already be present.
"""
import asyncio
import io
import time

from rich.console import Console

from mtdo import core as tc
from mtdo import youtube_notes as yn
from mtdo.app import TextPromptScreen, TodoApp, VaultScreen
from textual.screen import ModalScreen


async def _dismiss_first_run_prompts(pilot, app):
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


# ---------------- core.py: tags data model ----------------

def test_add_note_defaults_to_empty_tags():
    state = {}
    tc.add_note(state, "Untagged note")
    assert tc.list_notes(state)[0]["tags"] == []


def test_add_note_accepts_initial_tags():
    state = {}
    tc.add_note(state, "Tagged note", tags=["dsa", "interview"])
    assert tc.list_notes(state)[0]["tags"] == ["dsa", "interview"]


def test_set_note_tags_updates_and_bumps_updated_date():
    state = {}
    tc.add_note(state, "A note")
    note = tc.list_notes(state)[0]
    note["updated"] = "2000-01-01"  # force a stale date to prove it gets bumped
    tc.set_note_tags(state, 0, ["sql"])
    note = tc.list_notes(state)[0]
    assert note["tags"] == ["sql"]
    assert note["updated"] == tc.get_today().isoformat()


def test_search_notes_matches_tags():
    state = {}
    tc.add_note(state, "Two Sum", body="hashmap approach", tags=["dsa", "hashmap"])
    tc.add_note(state, "Joins", body="sql joins", tags=["sql"])
    results = tc.search_notes(state, "hashmap")
    assert len(results) == 1
    assert results[0][1]["title"] == "Two Sum"


def test_search_notes_tolerates_notes_with_no_tags_key():
    """Notes created before tags existed have no "tags" key at all -- search
    must not KeyError on those."""
    state = {"_notes": [{"title": "Old note", "body": "from before tags existed"}]}
    results = tc.search_notes(state, "old")
    assert len(results) == 1


# ---------------- Vault UI: tags ----------------

async def test_edit_tags_via_ui_updates_note_and_list_display():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.press("v")
        await pilot.pause()
        assert isinstance(app.screen, VaultScreen)

        await pilot.press("a")
        await pilot.pause()
        for ch in "Tagging Test Note":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        idx = app.screen.current_item().idx
        await pilot.press("t")
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)
        for ch in "dsa, two pointers":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        note = tc.list_notes(app.state)[idx]
        assert note["tags"] == ["dsa", "two pointers"]

        # the currently-highlighted list item's rendered Group includes the tags
        item = app.screen.current_item()
        buf = io.StringIO()
        Console(file=buf, width=100).print(item._render_note(note))
        rendered = buf.getvalue()
        assert "#dsa" in rendered
        assert "#two pointers" in rendered


async def test_edit_tags_cancel_leaves_tags_unchanged():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.press("v")
        await pilot.pause()

        await pilot.press("a")
        await pilot.pause()
        for ch in "Untouched Tags Note":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        idx = app.screen.current_item().idx

        await pilot.press("t")
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()

        assert tc.list_notes(app.state)[idx]["tags"] == []


# ---------------- Vault UI: markdown preview toggle ----------------

async def test_toggle_preview_shows_rendered_markdown_and_reverts():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.press("v")
        await pilot.pause()

        await pilot.press("a")
        await pilot.pause()
        for ch in "Markdown Note":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        screen = app.screen
        idx = screen.current_item().idx
        tc.set_note_body(app.state, idx, "# Heading\n\nSome **bold** text.")
        screen._load_editor(idx)  # simulate the editor already having this body loaded

        assert screen.editor.display is True
        assert screen.preview.display is False

        await pilot.press("p")
        await pilot.pause()
        assert screen.editor.display is False
        assert screen.preview.display is True

        await pilot.press("p")
        await pilot.pause()
        assert screen.editor.display is True
        assert screen.preview.display is False


async def test_preview_stays_sticky_across_note_selection_change():
    """Preview mode is meant to persist as you move through the list, updating
    to show whichever note is now selected -- not silently go stale or force
    you back into edit mode just for looking at a different note."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.press("v")
        await pilot.pause()
        screen = app.screen

        await pilot.press("a")
        await pilot.pause()
        for ch in "First Preview Note":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        first_idx = screen.current_item().idx
        tc.set_note_body(app.state, first_idx, "First body")

        await pilot.press("a")
        await pilot.pause()
        for ch in "Second Preview Note":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        second_idx = screen.current_item().idx
        tc.set_note_body(app.state, second_idx, "Second body")
        screen._load_editor(second_idx)

        await pilot.press("p")
        await pilot.pause()
        assert screen.preview.display is True

        # move selection to the first note while still in preview mode
        screen._load_editor(first_idx)
        await pilot.pause()
        assert screen.preview.display is True, "should stay in preview mode across selection changes"


# ---------------- Vault UI: loading spinner during the YouTube flow ----------------

async def test_youtube_flow_shows_spinner_while_running_and_hides_on_success(monkeypatch):
    def slow_fetch(url):
        time.sleep(0.3)
        return ("Spinner Test Video", "a transcript", None)

    monkeypatch.setattr(yn, "fetch_transcript", slow_fetch)
    monkeypatch.setattr(
        yn.ai_ask, "ask",
        lambda prompt, timeout=60: ("===NOTES===\nsome notes\n===QUESTIONS===\n1. q?", None),
    )

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.press("v")
        await pilot.pause()
        screen = app.screen
        assert screen.spinner.display is False

        await pilot.press("y")
        await pilot.pause()
        for ch in "https://youtu.be/x":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        assert screen.spinner.display is True, "spinner should show while the worker is running"

        for _ in range(30):
            await pilot.pause()
            await asyncio.sleep(0.05)
            if not screen.spinner.display:
                break

        assert screen.spinner.display is False, "spinner should hide once the flow completes"


async def test_youtube_flow_hides_spinner_on_error(monkeypatch):
    def failing_fetch(url):
        return (None, None, "no captions available")

    monkeypatch.setattr(yn, "fetch_transcript", failing_fetch)

    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)
        await pilot.press("v")
        await pilot.pause()
        screen = app.screen

        await pilot.press("y")
        await pilot.pause()
        for ch in "https://youtu.be/x":
            await pilot.press(ch)
        await pilot.press("enter")

        for _ in range(20):
            await pilot.pause()
            await asyncio.sleep(0.05)
            if not screen.spinner.display:
                break

        assert screen.spinner.display is False
        status = screen.status_line.content
        status_text = status.plain if hasattr(status, "plain") else str(status)
        assert "no captions available" in status_text
