"""Regression tests for gh18: the now-playing position froze instead of ticking in
real time for YouTube Music playing in a browser tab. Confirmed live against a real,
currently-playing WebKit (browser) MediaRemote session on a real machine before
writing any fix: kMRMediaRemoteNowPlayingInfoElapsedTime stayed at a literally
identical value across 9+ seconds of continuous polling while actively playing at 2x
rate, and kMRMediaRemoteNowPlayingInfoTimestamp was never present at all -- exactly
the condition music.py's own existing extrapolation logic required to fix a frozen
position, and exactly the condition a browser-based source never satisfies.

Real playback state isn't reproducible in CI (no real music playing on a runner), so
these mock nowplaying-cli's `get-raw` output directly to control each scenario
precisely, and monkeypatch time.monotonic so the extrapolation math is checked
exactly, not just "some plausible number came out."
"""
import json
import time
from unittest.mock import patch

from mtdo import music


def _raw(elapsed=0.0, rate=2, title="Some Video", artist="Some Artist",
         duration=1000.0, identifier=123, include_timestamp=False):
    data = {
        "kMRMediaRemoteNowPlayingInfoElapsedTime": elapsed,
        "kMRMediaRemoteNowPlayingInfoPlaybackRate": rate,
        "kMRMediaRemoteNowPlayingInfoTitle": title,
        "kMRMediaRemoteNowPlayingInfoArtist": artist,
        "kMRMediaRemoteNowPlayingInfoDuration": duration,
        "kMRMediaRemoteNowPlayingInfoUniqueIdentifier": identifier,
        "kMRMediaRemoteNowPlayingInfoClientBundleIdentifier": "com.apple.WebKit.GPU",
    }
    if include_timestamp:
        data["kMRMediaRemoteNowPlayingInfoTimestamp"] = time.time()
    return json.dumps(data)


def _reset_fallback_state():
    music._fallback_snapshot["identifier"] = None
    music._fallback_snapshot["elapsed"] = None
    music._fallback_snapshot["seen_at"] = None


def _mock_run(stdout):
    class _Result:
        pass
    r = _Result()
    r.stdout = stdout
    return r


def test_frozen_elapsed_with_no_timestamp_still_advances_in_real_time():
    """The exact gh18 scenario: a WebKit/browser source with a frozen
    ElapsedTime and no Timestamp field at all. Playing at 2x rate, our own
    clock should extrapolate position forward at 2x wall-clock speed."""
    _reset_fallback_state()
    raw = _raw(elapsed=76.72, rate=2, include_timestamp=False)

    with patch("mtdo.music.time.monotonic", return_value=1000.0), \
         patch("subprocess.run", return_value=_mock_run(raw)):
        first = music._nowplaying_cli_info()
    assert first["position"] == 76.72
    assert first["state"] == "playing"

    with patch("mtdo.music.time.monotonic", return_value=1002.0), \
         patch("subprocess.run", return_value=_mock_run(raw)):
        second = music._nowplaying_cli_info()
    # 2 real seconds later, at 2x rate, with elapsed unchanged from the source
    assert second["position"] == 76.72 + 2.0 * 2


def test_paused_position_does_not_advance_even_without_timestamp():
    """Rate 0 (paused) must freeze position exactly at elapsed, not keep
    ticking forward using the fallback clock."""
    _reset_fallback_state()
    raw = _raw(elapsed=50.0, rate=0, include_timestamp=False)

    with patch("mtdo.music.time.monotonic", return_value=2000.0), \
         patch("subprocess.run", return_value=_mock_run(raw)):
        first = music._nowplaying_cli_info()
    assert first["position"] == 50.0
    assert first["state"] == "paused"

    with patch("mtdo.music.time.monotonic", return_value=2010.0), \
         patch("subprocess.run", return_value=_mock_run(raw)):
        second = music._nowplaying_cli_info()
    assert second["position"] == 50.0


def test_a_genuinely_new_elapsed_value_resets_the_extrapolation_baseline():
    """When the source actually pushes a new snapshot (a real jump, a seek),
    the fallback baseline must reset to it, not keep extrapolating from the
    stale one and drifting further out of sync."""
    _reset_fallback_state()
    raw1 = _raw(elapsed=10.0, rate=1, include_timestamp=False)
    with patch("mtdo.music.time.monotonic", return_value=100.0), \
         patch("subprocess.run", return_value=_mock_run(raw1)):
        first = music._nowplaying_cli_info()
    assert first["position"] == 10.0

    # 5s later, our clock would extrapolate to 15.0, but the source pushes a
    # real new snapshot at 40.0 (e.g. a seek) -- must snap to that, not to 15.0.
    raw2 = _raw(elapsed=40.0, rate=1, include_timestamp=False)
    with patch("mtdo.music.time.monotonic", return_value=105.0), \
         patch("subprocess.run", return_value=_mock_run(raw2)):
        second = music._nowplaying_cli_info()
    assert second["position"] == 40.0

    with patch("mtdo.music.time.monotonic", return_value=108.0), \
         patch("subprocess.run", return_value=_mock_run(raw2)):
        third = music._nowplaying_cli_info()
    assert third["position"] == 43.0  # 40.0 + 3s at 1x from the NEW baseline


def test_source_provided_timestamp_is_still_preferred_when_present():
    """Native apps that do publish Timestamp (unlike WebKit) should keep using
    that path unchanged -- the fallback is additive, not a replacement."""
    _reset_fallback_state()
    raw = _raw(elapsed=30.0, rate=1, include_timestamp=True)
    with patch("subprocess.run", return_value=_mock_run(raw)):
        info = music._nowplaying_cli_info()
    # timestamp was "just now", so position should be ~30.0 (not affected by
    # our fallback clock, which was never engaged for this call)
    assert 29.5 < info["position"] < 31.0
