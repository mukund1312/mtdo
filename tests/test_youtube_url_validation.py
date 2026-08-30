"""Regression tests for gh73: fetch_transcript() must reject a non-YouTube URL
with a clear message rather than handing it to yt-dlp, which supports far more
than YouTube and could either "succeed" against an unrelated site or fail with
a generic, unhelpful error.
"""
from mtdo import youtube_notes as yn


def test_is_youtube_url_accepts_common_real_shapes():
    assert yn._is_youtube_url("https://www.youtube.com/watch?v=jNQXAC9IVRw")
    assert yn._is_youtube_url("https://youtube.com/watch?v=jNQXAC9IVRw")
    assert yn._is_youtube_url("https://m.youtube.com/watch?v=jNQXAC9IVRw")
    assert yn._is_youtube_url("https://youtu.be/jNQXAC9IVRw")
    assert yn._is_youtube_url("https://music.youtube.com/watch?v=jNQXAC9IVRw")


def test_is_youtube_url_rejects_non_youtube_urls():
    assert not yn._is_youtube_url("https://vimeo.com/12345")
    assert not yn._is_youtube_url("https://example.com/watch?v=jNQXAC9IVRw")
    assert not yn._is_youtube_url("https://notyoutube.com/youtube.com")
    assert not yn._is_youtube_url("not a url at all")
    assert not yn._is_youtube_url("")


def test_fetch_transcript_rejects_a_non_youtube_url_with_a_clear_message(monkeypatch):
    monkeypatch.setattr(yn, "YT_DLP_AVAILABLE", True)
    title, transcript, error = yn.fetch_transcript("https://vimeo.com/12345")
    assert title is None
    assert transcript is None
    assert "youtube" in error.lower()


def test_missing_yt_dlp_is_still_reported_before_the_url_check(monkeypatch):
    """The yt-dlp-availability check must still come first -- a missing yt-dlp
    should be reported even for an otherwise-invalid URL, not masked by the
    newer URL check."""
    monkeypatch.setattr(yn, "YT_DLP_AVAILABLE", False)
    title, transcript, error = yn.fetch_transcript("https://vimeo.com/12345")
    assert "yt-dlp isn't installed" in error
