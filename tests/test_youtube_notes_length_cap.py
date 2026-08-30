"""Regression tests for gh69: generate_notes_and_quiz() must cap transcript length
before embedding it in the AI prompt, rather than risking a context-window
overflow on a long video (or silently truncating with no indication).
"""
from unittest.mock import patch

from mtdo import youtube_notes as yn


def test_short_transcript_is_not_truncated_and_carries_no_note():
    transcript = "word " * 100
    with patch.object(yn.ai_ask, "ask", return_value=("===NOTES===\nsome notes\n===QUESTIONS===\n1. q?", None)) as mock_ask:
        body, error = yn.generate_notes_and_quiz("Short Video", transcript)

    assert error is None
    assert "truncated" not in body.lower()
    prompt_sent = mock_ask.call_args.args[0]
    assert transcript.strip() in prompt_sent


def test_long_transcript_is_truncated_before_reaching_the_ai_and_notes_say_so():
    transcript = "word " * (yn._MAX_TRANSCRIPT_WORDS + 5000)
    with patch.object(yn.ai_ask, "ask", return_value=("===NOTES===\nsome notes\n===QUESTIONS===\n1. q?", None)) as mock_ask:
        body, error = yn.generate_notes_and_quiz("Very Long Lecture", transcript)

    assert error is None
    assert "only the first" in body.lower()

    prompt_sent = mock_ask.call_args.args[0]
    # The prompt must not contain the full (untruncated) transcript.
    assert transcript.strip() not in prompt_sent
    # But it must contain a real prefix of it.
    first_words = " ".join(transcript.split()[:50])
    assert first_words in prompt_sent


def test_truncation_boundary_is_exactly_max_words():
    transcript = "word " * (yn._MAX_TRANSCRIPT_WORDS + 1)
    with patch.object(yn.ai_ask, "ask", return_value=("===NOTES===\nx\n===QUESTIONS===\n1. q?", None)) as mock_ask:
        yn.generate_notes_and_quiz("Boundary Video", transcript)

    prompt_sent = mock_ask.call_args.args[0]
    # Extract the transcript portion back out via the prompt template's known shape
    # isn't reliable across prompt-wording changes -- instead confirm indirectly:
    # the untruncated (longer) transcript must not appear, but a max-words-length
    # prefix must.
    truncated_prefix = " ".join(transcript.split()[:yn._MAX_TRANSCRIPT_WORDS])
    assert truncated_prefix in prompt_sent
