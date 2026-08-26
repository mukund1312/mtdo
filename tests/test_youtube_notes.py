"""Tests for the Knowledge Vault's "paste a YouTube URL" -> AI notes + quiz
feature (gh23). Split deliberately by what needs network/yt-dlp and what doesn't:

- The caption text-cleanup logic (_vtt_to_text/_merge_overlap) is pure string
  processing and runs unconditionally -- no network, no yt-dlp import needed. This
  is also where the real bug lived: an early character-level overlap-merge
  algorithm corrupted ordinary multi-line cue text ("...in front of the" /
  "elephants" -> "...in front of thelephants") by matching a single coincidental
  shared letter at the word boundary. The word-level version and its minimum-
  overlap threshold exist specifically to not regress that.
- fetch_transcript()'s "yt-dlp not installed" path is deterministic and always
  runs (matches this suite's actual default CI state: yt-dlp is behind the
  `youtube` extra, not included in `.[dev]`).
- The one real-network test (against a real, long-stable public video) is skipped
  whenever yt-dlp isn't installed, same pattern as test_code_runner_sandbox.py's
  per-toolchain skips -- confidence for local dev, no CI flakiness/dependency.
"""
import asyncio

import pytest

from mtdo import core as tc
from mtdo import youtube_notes as yn
from mtdo.app import TextPromptScreen, TodoApp, VaultScreen
from textual.screen import ModalScreen

_STABLE_TEST_VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"  # "Me at the zoo" -- the first YouTube video ever uploaded; won't be taken down or re-edited


def test_merge_overlap_collapses_rolling_caption_duplication():
    """Auto-generated captions are commonly delivered as a rolling window: each
    new cue re-includes the tail of the previous one as its own head."""
    lines = [
        "so today we're going to talk",
        "so today we're going to talk about recursion",
        "about recursion and how it works in practice",
    ]
    assert yn._merge_overlap(lines) == "so today we're going to talk about recursion and how it works in practice"


def test_merge_overlap_does_not_corrupt_ordinary_wrapped_lines():
    """Regression test for a real bug: an earlier character-level version of this
    merged "...in front of the" + "elephants" into "...in front of thelephants",
    matching the single coincidental shared "e" at the word boundary."""
    assert yn._merge_overlap(["in front of the", "elephants"]) == "in front of the elephants"


def test_merge_overlap_ignores_single_word_coincidence():
    """A single shared word at a boundary ("the" / "the") is exactly the kind of
    false positive a character-level match would produce -- must not merge."""
    assert yn._merge_overlap(["I saw the", "the cat sit down"]) == "I saw the the cat sit down"


def test_merge_overlap_handles_exact_duplicate_lines():
    # the simplest case: one line's whole content overlaps the next entirely
    assert yn._merge_overlap(["hello world", "hello world", "hello world again"]) == "hello world again"


def test_vtt_to_text_strips_markup_and_headers():
    raw_vtt = (
        "WEBVTT\nKind: captions\nLanguage: en\n\n"
        "00:00:01.200 --> 00:00:03.360\n"
        "<00:00:01.200><c> All right,</c> so here we are\n\n"
        "00:00:03.360 --> 00:00:05.000\n"
        "so here we are in front of the elephants\n"
    )
    result = yn._vtt_to_text(raw_vtt)
    assert "WEBVTT" not in result
    assert "-->" not in result
    assert "<c>" not in result
    assert "elephants" in result


def test_fetch_transcript_reports_missing_yt_dlp(monkeypatch):
    monkeypatch.setattr(yn, "YT_DLP_AVAILABLE", False)
    title, transcript, error = yn.fetch_transcript(_STABLE_TEST_VIDEO)
    assert title is None
    assert transcript is None
    assert "yt-dlp isn't installed" in error


@pytest.mark.skipif(not yn.YT_DLP_AVAILABLE, reason="yt-dlp not installed (pip install -e '.[youtube]')")
def test_fetch_transcript_against_a_real_video():
    title, transcript, error = yn.fetch_transcript(_STABLE_TEST_VIDEO)
    assert error is None
    assert title == "Me at the zoo"
    assert "elephants" in transcript
    # confirms the overlap-merge didn't stutter-duplicate any real caption text
    assert "elephants elephants" not in transcript


async def test_vault_add_from_youtube_creates_a_note(monkeypatch):
    """End-to-end through the real UI (Vault -> 'y' -> paste URL -> a new note
    appears), via real key dispatch, not a direct method call -- this app has a
    real, previously-shipped bug class (a screen dismissing itself then
    immediately pushing a follow-up modal in the same handler silently drops the
    callback) that only reproduces on the real event-dispatch path.

    Network and the AI backend are mocked so this runs fast and unconditionally
    in CI (yt-dlp isn't part of the `dev` extra, and no real AI backend is
    configured there either) -- see test_fetch_transcript_against_a_real_video
    above for the one test that actually hits the network."""
    monkeypatch.setattr(
        yn, "fetch_transcript",
        lambda url: ("Two Pointers Explained", "a transcript about the two pointer technique", None),
    )
    monkeypatch.setattr(
        yn.ai_ask, "ask",
        lambda prompt, timeout=60: ("===NOTES===\nUse two pointers.\n===QUESTIONS===\n1. When?", None),
    )

    app = TodoApp()
    async with app.run_test() as pilot:
        # this test doesn't care about the setup/profile/plan-choice sequence,
        # only about reaching the plain board -- escape through whatever modal
        # sequence first-run shows (its exact shape isn't this test's concern).
        await pilot.pause()
        while isinstance(app.screen, ModalScreen):
            await pilot.press("escape")
            await pilot.pause()

        notes_before = len(tc.list_notes(app.state))

        await pilot.press("v")  # open the Knowledge Vault
        await pilot.pause()
        assert isinstance(app.screen, VaultScreen)

        await pilot.press("y")  # From YouTube
        await pilot.pause()
        assert isinstance(app.screen, TextPromptScreen)
        for ch in _STABLE_TEST_VIDEO:
            await pilot.press(ch)
        await pilot.press("enter")

        # the worker thread runs off-loop; give it a moment to finish and marshal
        # its result back via call_from_thread
        for _ in range(20):
            await pilot.pause()
            await asyncio.sleep(0.05)
            if len(tc.list_notes(app.state)) > notes_before:
                break

        notes = tc.list_notes(app.state)
        assert len(notes) == notes_before + 1
        assert notes[-1]["title"] == "Two Pointers Explained"
        assert "Use two pointers" in notes[-1]["body"]
        assert "Questions" in notes[-1]["body"]

        # Regression check for a real bug: this flow originally reported status
        # via self.app_ref.toast(...), which updates ToastLine on the *board*
        # screen underneath -- invisible the whole time VaultScreen (a full
        # Screen push, not a ModalScreen) is on top. toast() never raised, so it
        # was a silent failure: confirmed by hand that the message landed in
        # ToastLine.content but never appeared in an actual screenshot render.
        # Status now goes through VaultScreen's own status_line instead.
        assert isinstance(app.screen, VaultScreen)
        status = app.screen.status_line.content
        status_text = status.plain if hasattr(status, "plain") else str(status)
        assert 'Added notes from "Two Pointers Explained"' in status_text
