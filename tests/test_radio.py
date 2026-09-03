"""Regression tests for radio.py -- the internal internet-radio player added
alongside music.py's external-player remote control. No real subprocess, audio,
or network is ever touched here (same isolation strategy as test_music.py):
`subprocess.Popen` is mocked for start()/stop(), and the ffmpeg-stderr level
parser (_read_levels_loop) is exercised directly against synthetic lines
shaped exactly like real ffmpeg `ametadata=mode=print` output, captured by hand
against a real, currently-playing SomaFM stream before writing this player at
all (see radio.py's module docstring and PROGRESS.md for that verification).
"""
import json
import os
import shutil
from unittest.mock import MagicMock, patch

import pytest

from mtdo import config as appconfig
from mtdo import radio


@pytest.fixture(autouse=True)
def _clean_radio_state():
    """radio_state.json is one shared file (not per-profile like most of this
    test suite's own data), so tests would otherwise leak state into each
    other across the shared MTDO_HOME test session (see conftest.py) --
    scoped to just this file, local to this test module."""
    def _remove():
        if os.path.exists(appconfig.RADIO_STATE_PATH):
            os.remove(appconfig.RADIO_STATE_PATH)
    _remove()
    yield
    _remove()


def _fake_proc(alive_polls=0):
    """A stand-in for subprocess.Popen()'s return value. `alive_polls` is how
    many times .poll() reports "still running" (None) before reporting exited
    -- 0 means it's already dead by the time anything checks."""
    proc = MagicMock()
    poll_results = [None] * alive_polls + [0]
    proc.poll.side_effect = poll_results + [0] * 10  # plenty of extra calls tolerated
    return proc


def test_band_filter_covers_low_middle_and_high_bands():
    assert radio._band_filter(0) == "lowpass=f=60"
    assert radio._band_filter(radio.NUM_BANDS - 1) == "highpass=f=12000"
    middle = radio._band_filter(1)
    assert middle.startswith("bandpass=f=")


def test_build_filter_complex_declares_every_band_once():
    graph = radio._build_filter_complex()
    assert f"asplit={radio.NUM_BANDS}" in graph
    assert graph.count("ametadata=mode=print") == radio.NUM_BANDS
    for i in range(radio.NUM_BANDS):
        assert f"[a{i}]" in graph


def test_has_mpv_reflects_shutil_which():
    with patch("shutil.which", return_value="/opt/homebrew/bin/mpv"):
        assert radio.has_mpv() is True
    with patch("shutil.which", return_value=None):
        assert radio.has_mpv() is False


def test_has_ffmpeg_reflects_shutil_which():
    with patch("shutil.which", return_value="/opt/homebrew/bin/ffmpeg"):
        assert radio.has_ffmpeg() is True
    with patch("shutil.which", return_value=None):
        assert radio.has_ffmpeg() is False


def test_read_levels_loop_maps_instances_to_bands_in_first_seen_order():
    """Synthetic lines shaped like real ffmpeg output (captured by hand against
    a real SomaFM stream): each band's ametadata filter gets its own numbered
    instance, appearing in the same left-to-right order the bands were
    declared -- confirmed live these numbers aren't 1,2,3 but always
    increasing in that same order, which is what this mapping actually relies
    on (not any specific number)."""
    lines = [
        "[Parsed_ametadata_3 @ 0x1] lavfi.astats.Overall.RMS_level=-16.481437\n",
        "[Parsed_ametadata_6 @ 0x1] lavfi.astats.Overall.RMS_level=-33.613825\n",
        "[Parsed_ametadata_9 @ 0x1] lavfi.astats.Overall.RMS_level=-45.104131\n",
        "[Parsed_ametadata_3 @ 0x1] lavfi.astats.Overall.RMS_level=-14.255713\n",
    ]
    player = radio.RadioPlayer()
    player._levels = [0.0, 0.0, 0.0]
    fake_proc = MagicMock()
    fake_proc.stderr = iter(lines)
    player._read_levels_loop(fake_proc)
    assert player.get_levels() == [-14.255713, -33.613825, -45.104131]


def test_read_levels_loop_ignores_inf_and_unparseable_values():
    """-inf shows up for real at stream start (silence before decoding
    catches up) -- must not clobber a real value with it, and must never
    crash on it either."""
    lines = [
        "[Parsed_ametadata_1 @ 0x1] lavfi.astats.Overall.RMS_level=-inf\n",
        "[Parsed_ametadata_1 @ 0x1] lavfi.astats.Overall.RMS_level=-20.0\n",
        "[Parsed_ametadata_1 @ 0x1] lavfi.astats.Overall.RMS_level=-inf\n",
        "some unrelated ffmpeg log line\n",
    ]
    player = radio.RadioPlayer()
    player._levels = [0.0] * radio.NUM_BANDS
    fake_proc = MagicMock()
    fake_proc.stderr = iter(lines)
    player._read_levels_loop(fake_proc)
    assert player.get_levels()[0] == -20.0


def test_start_spawns_mpv_with_ipc_socket_and_the_right_url():
    player = radio.RadioPlayer()
    with patch("mtdo.radio.has_mpv", return_value=True), \
         patch("mtdo.radio.has_ffmpeg", return_value=True), \
         patch("mtdo.radio.subprocess.Popen") as mock_popen, \
         patch("mtdo.radio.threading.Thread"):
        mock_popen.side_effect = [_fake_proc(alive_polls=5), _fake_proc(alive_polls=5)]
        player.start(0)

    mpv_call, ffmpeg_call = mock_popen.call_args_list
    mpv_args = mpv_call.args[0]
    assert mpv_args[0] == "mpv"
    assert radio.STATIONS[0]["url"] in mpv_args
    assert any(a.startswith("--input-ipc-server=") for a in mpv_args)

    ffmpeg_args = ffmpeg_call.args[0]
    assert ffmpeg_args[0] == "ffmpeg"
    assert radio.STATIONS[0]["url"] in ffmpeg_args
    assert player.current_station() == radio.STATIONS[0]


def test_start_raises_without_mpv_and_touches_nothing():
    player = radio.RadioPlayer()
    with patch("mtdo.radio.has_mpv", return_value=False), \
         patch("mtdo.radio.subprocess.Popen") as mock_popen:
        with pytest.raises(RuntimeError):
            player.start(0)
    mock_popen.assert_not_called()
    assert player.is_playing() is False


def test_start_raises_without_ffmpeg_and_never_spawns_mpv():
    """gh58: a missing ffmpeg must be caught before mpv is ever spawned --
    otherwise mpv starts, plays real audio, and is left orphaned with no
    reachable way to stop it once the ffmpeg Popen call fails."""
    player = radio.RadioPlayer()
    with patch("mtdo.radio.has_mpv", return_value=True), \
         patch("mtdo.radio.has_ffmpeg", return_value=False), \
         patch("mtdo.radio.subprocess.Popen") as mock_popen:
        with pytest.raises(RuntimeError):
            player.start(0)
    mock_popen.assert_not_called()
    assert player.is_playing() is False


def test_start_stops_the_previous_station_first():
    player = radio.RadioPlayer()
    with patch("mtdo.radio.has_mpv", return_value=True), \
         patch("mtdo.radio.has_ffmpeg", return_value=True), \
         patch("mtdo.radio.subprocess.Popen") as mock_popen, \
         patch("mtdo.radio.threading.Thread"):
        first_mpv, first_ffmpeg = _fake_proc(alive_polls=5), _fake_proc(alive_polls=5)
        mock_popen.side_effect = [first_mpv, first_ffmpeg, _fake_proc(5), _fake_proc(5)]
        player.start(0)
        player.start(1)

    assert player.current_station() == radio.STATIONS[1]
    first_mpv.terminate.assert_called_once()
    first_ffmpeg.terminate.assert_called_once()


def test_stop_terminates_then_escalates_to_kill_if_still_alive():
    """Mirrors pty_panel.py's own two-step shutdown: SIGTERM first, SIGKILL
    only if the process is still alive shortly after -- the one failure mode
    that matters most for this feature (an orphaned mpv/ffmpeg still
    streaming audio after mtdo has exited)."""
    player = radio.RadioPlayer()
    with patch("mtdo.radio.has_mpv", return_value=True), \
         patch("mtdo.radio.has_ffmpeg", return_value=True), \
         patch("mtdo.radio.subprocess.Popen") as mock_popen, \
         patch("mtdo.radio.threading.Thread"):
        # poll() never reports exited -- forces the kill() escalation path
        stuck_proc = MagicMock()
        stuck_proc.poll.return_value = None
        mock_popen.side_effect = [stuck_proc, _fake_proc(alive_polls=0)]
        player.start(0)
        player.stop()

    stuck_proc.terminate.assert_called_once()
    stuck_proc.kill.assert_called_once()


def test_send_ipc_returns_none_on_socket_failure_without_raising():
    player = radio.RadioPlayer()
    player._ipc_sock = "/nonexistent/mtdo-radio-test.sock"
    with patch("socket.socket", side_effect=OSError("no such socket")):
        assert player.is_paused() is False
        assert player.get_position() is None
    player.toggle_pause()  # must not raise even though the socket doesn't exist
    player.set_volume(10)


def test_toggle_pause_sends_the_right_ipc_command():
    player = radio.RadioPlayer()
    player._ipc_sock = "/tmp/fake.sock"
    with patch.object(player, "_send_ipc") as mock_send:
        player.toggle_pause()
        mock_send.assert_called_once_with(["cycle", "pause"])


def test_set_volume_sends_the_right_ipc_command():
    player = radio.RadioPlayer()
    player._ipc_sock = "/tmp/fake.sock"
    with patch.object(player, "_send_ipc") as mock_send:
        player.set_volume(10)
        mock_send.assert_called_once_with(["add", "volume", 10])


def test_is_paused_and_get_position_parse_real_ipc_reply_shapes():
    """Reply shapes captured by hand from a real mpv IPC socket."""
    player = radio.RadioPlayer()
    player._ipc_sock = "/tmp/fake.sock"
    with patch.object(player, "_send_ipc", return_value={"data": True, "error": "success"}):
        assert player.is_paused() is True
    with patch.object(player, "_send_ipc", return_value={"data": False, "error": "success"}):
        assert player.is_paused() is False
    with patch.object(player, "_send_ipc", return_value={"data": 8.64, "error": "success"}):
        assert player.get_position() == 8.64
    with patch.object(player, "_send_ipc", return_value=None):
        assert player.get_position() is None
        assert player.is_paused() is False
    with patch.object(player, "_send_ipc", return_value={"data": 85.0, "error": "success"}):
        assert player.get_volume() == 85.0
    with patch.object(player, "_send_ipc", return_value=None):
        assert player.get_volume() is None


def test_load_radio_state_defaults_when_missing():
    state = appconfig.load_radio_state()
    assert state == {"favorites": [], "last_station": None, "shuffle": False, "repeat": "off"}


def test_save_and_load_radio_state_round_trips():
    appconfig.save_radio_state({"favorites": [2, 5], "last_station": 5, "shuffle": True, "repeat": "one"})
    assert appconfig.load_radio_state() == {
        "favorites": [2, 5], "last_station": 5, "shuffle": True, "repeat": "one",
    }


def test_load_radio_state_ignores_unknown_keys_and_survives_corrupt_json():
    with open(appconfig.RADIO_STATE_PATH, "w") as f:
        json.dump({"favorites": [1], "bogus_future_key": "ignored"}, f)
    state = appconfig.load_radio_state()
    assert state["favorites"] == [1]
    assert "bogus_future_key" not in state

    with open(appconfig.RADIO_STATE_PATH, "w") as f:
        f.write("{not valid json")
    assert appconfig.load_radio_state() == {
        "favorites": [], "last_station": None, "shuffle": False, "repeat": "off",
    }


# -- RadioScreen, driven through the real app via Textual's Pilot (same style
# as test_profiles.py) -- subprocess.Popen is still mocked throughout, so no
# real mpv/ffmpeg/network involved, only the screen's own wiring/logic.

from mtdo.app import RadioScreen, TodoApp, ToastLine
from textual.screen import ModalScreen


async def _dismiss_first_run_prompts(pilot, app):
    await pilot.pause()
    while isinstance(app.screen, ModalScreen):
        await pilot.press("escape")
        await pilot.pause()


def _mock_popen_pair():
    return [_fake_proc(alive_polls=20), _fake_proc(alive_polls=20)]


class _FakeSelected:
    """Stands in for ListView.Selected -- RadioScreen's own handler only ever
    reads `.item` off it, so a real Message instance isn't needed to exercise
    that handler directly (see the test below for why this is deliberate)."""
    def __init__(self, item):
        self.item = item


async def test_radio_screen_opens_via_keybinding_and_plays_on_enter():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        assert isinstance(app.screen, RadioScreen)

        # Real root cause of this test failing on CI (Linux, no mpv
        # installed) but passing locally every time on macOS (mpv genuinely
        # installed there for this work): RadioPlayer.start() calls has_mpv()
        # a SECOND time, independently of action_open_radio's own check above
        # -- that first `with` block already exited by this point, and this
        # one only patched subprocess.Popen/threading.Thread, not has_mpv.
        # start() raised RuntimeError (silently caught and swallowed by
        # _play()) before ever reaching Popen, so _mpv_proc was never set --
        # nothing to do with keyboard/message-dispatch timing, which is what
        # this looked like at first and wasted real effort chasing. Two
        # earlier fix attempts (widening the press+pause mock scope, then
        # invoking on_list_view_selected directly instead of a real keypress)
        # both left this exact gap and both failed identically on CI for
        # exactly this reason.
        item = app.screen.list_view.children[0]
        with patch("mtdo.radio.has_mpv", return_value=True), \
             patch("mtdo.radio.has_ffmpeg", return_value=True), \
             patch("mtdo.radio.subprocess.Popen", side_effect=_mock_popen_pair()), \
             patch("mtdo.radio.threading.Thread"):
            app.screen.on_list_view_selected(_FakeSelected(item))
            await pilot.pause()

        assert app.radio_player.is_playing() is True
        assert app.radio_player.current_station() == radio.STATIONS[0]

        # closing the screen must not stop playback (it's a session, not a modal)
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, RadioScreen)
        assert app.radio_player.is_playing() is True

        app.radio_player.stop()


async def test_radio_keybinding_without_mpv_toasts_and_does_not_open():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=False):
            await pilot.press("R")
            await pilot.pause()

        assert not isinstance(app.screen, RadioScreen)
        assert "mpv" in app.query_one(ToastLine).content.plain.lower()


async def test_play_without_ffmpeg_shows_error_without_crashing_or_orphaning_mpv():
    """gh58: mpv installed but ffmpeg missing must fail cleanly through the
    real Textual event handler -- no uncaught FileNotFoundError, and no mpv
    process left running with nothing to stop it."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        assert isinstance(app.screen, RadioScreen)

        item = app.screen.list_view.children[0]
        with patch("mtdo.radio.has_mpv", return_value=True), \
             patch("mtdo.radio.has_ffmpeg", return_value=False), \
             patch("mtdo.radio.subprocess.Popen") as mock_popen:
            # Deliberately not followed by `await pilot.pause()` here: the
            # screen's own 0.5s _update_status interval (radio_screen.py)
            # would otherwise get a chance to fire and stomp the error
            # message this asserts on -- on_list_view_selected -> _play is
            # itself synchronous, so the assertion right after it is exactly
            # the wording the handler leaves behind, before anything else
            # runs.
            app.screen.on_list_view_selected(_FakeSelected(item))
            mock_popen.assert_not_called()
            assert app.radio_player.is_playing() is False
            assert "ffmpeg" in app.screen.now_line.content.lower()


async def test_favoriting_a_station_persists_across_reopening_the_screen():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        await pilot.press("f")
        await pilot.pause()
        assert app.screen.favorites == {0}

        await pilot.press("escape")
        await pilot.pause()
        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        assert app.screen.favorites == {0}


# -- Shine-sweep art (radio_screen.py) -- replaces the earlier real-video
# vinyl-spin attempt the user found looked bad. No subprocess/network
# involved at all here, just pure text/color logic.

from mtdo import radio_screen


def test_render_shine_art_highlights_a_band_around_the_given_position():
    text = radio_screen._render_shine_art(0)
    plain_rows = text.plain.split("\n")[:-1]
    assert plain_rows == radio_screen._SHINE_ART

    spans = text.spans
    row_len = radio_screen._SHINE_WIDTH + 1  # +1 for the row's trailing "\n"
    first_row_spans = [s for s in spans if s.start < row_len]
    highlighted_cols = set()
    for span in first_row_spans:
        if span.style == radio_screen._SHINE_HIGHLIGHT_COLOR:
            highlighted_cols.update(range(span.start, min(span.end, radio_screen._SHINE_WIDTH)))

    half = radio_screen._SHINE_BAND_HALF_WIDTH
    assert highlighted_cols == set(range(0, half + 1)) | set(range(
        radio_screen._SHINE_WIDTH - half, radio_screen._SHINE_WIDTH
    ))


def test_render_shine_art_band_wraps_seamlessly_across_the_edge():
    """Sweeping past the last column must wrap the highlight band back around
    to column 0 with no gap/jump -- this is the whole point of the circular
    `min(dist, width - dist)` distance calculation, not a plain linear one."""
    position = radio_screen._SHINE_WIDTH - 1
    text = radio_screen._render_shine_art(position)
    plain_rows = text.plain.split("\n")[:-1]
    row_len = radio_screen._SHINE_WIDTH + 1
    first_row_spans = [s for s in text.spans if s.start < row_len]
    highlighted_cols = set()
    for span in first_row_spans:
        if span.style == radio_screen._SHINE_HIGHLIGHT_COLOR:
            highlighted_cols.update(range(span.start, min(span.end, radio_screen._SHINE_WIDTH)))

    half = radio_screen._SHINE_BAND_HALF_WIDTH
    expected = {(position + offset) % radio_screen._SHINE_WIDTH for offset in range(-half, half + 1)}
    assert highlighted_cols == expected
    assert 0 in highlighted_cols  # confirms the wrap actually reached column 0


async def test_shine_sweep_advances_while_playing_freezes_on_pause_parks_on_stop():
    """Drives _advance_shine directly rather than relying on the real
    set_interval-driven timer's exact call count -- the screen's own
    background interval (also ticking during every `await pilot.pause()`
    above) would otherwise race these manual calls and make exact position
    values flaky. What matters -- and what's asserted here -- is the
    interaction logic: advances while playing, frozen in place on pause,
    resumes on unpause, parks at 0 once stopped."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        screen = app.screen
        assert screen._shine_position == 0

        item = screen.list_view.children[0]
        with patch("mtdo.radio.has_mpv", return_value=True), \
             patch("mtdo.radio.has_ffmpeg", return_value=True), \
             patch("mtdo.radio.subprocess.Popen", side_effect=_mock_popen_pair()), \
             patch("mtdo.radio.threading.Thread"):
            screen.on_list_view_selected(_FakeSelected(item))

        screen._last_paused = False
        baseline = screen._shine_position
        screen._advance_shine()
        assert screen._shine_position == (baseline + radio_screen._SHINE_STEP) % radio_screen._SHINE_WIDTH

        # frozen while paused
        screen._last_paused = True
        position_while_paused = screen._shine_position
        screen._advance_shine()
        screen._advance_shine()
        assert screen._shine_position == position_while_paused

        # resumes advancing once unpaused
        screen._last_paused = False
        screen._advance_shine()
        assert screen._shine_position == (position_while_paused + radio_screen._SHINE_STEP) % radio_screen._SHINE_WIDTH

        # parks back at 0 once stopped
        app.radio_player.stop()
        screen._advance_shine()
        assert screen._shine_position == 0


# -- Dense "skyline" visualizer (radio_screen.py) -- sits beside the
# shine-sweep art rather than stacked below it. _interpolate_bars/
# _gradient_color/_render_visualizer are pure functions of their inputs (no
# player/screen access needed), so their span/color logic is tested directly
# here rather than only through a rendered screenshot.

def test_interpolate_bars_reproduces_real_band_values_at_their_own_positions():
    """At the exact fractional position of a real band (i * (num_bands-1) /
    (num_bars-1) landing on an integer), the Catmull-Rom spline must
    reproduce that band's own real (normalized) value exactly -- confirms
    the interpolation is anchored to genuine data, not just plausible-looking
    curvature untethered from it."""
    levels = [-60.0, -50.0, -40.0, -30.0, -20.0, -10.0, -5.0, 0.0]  # 8 real bands, quiet to loud
    norms = [max(0.0, min(1.0, (lvl + 60.0) / 60.0)) for lvl in levels]
    num_bars = 15  # (num_bars - 1) is a multiple of (len(levels) - 1) == 7
    bars = radio_screen._interpolate_bars(levels, num_bars)
    assert len(bars) == num_bars
    for band_index, expected in enumerate(norms):
        bar_index = band_index * (num_bars - 1) // (len(levels) - 1)
        assert bars[bar_index] == pytest.approx(expected, abs=1e-9)


def test_interpolate_bars_stays_in_unit_range_and_is_flat_for_uniform_levels():
    flat = radio_screen._interpolate_bars([-30.0] * 8, 24)
    assert len(flat) == 24
    assert all(v == pytest.approx(0.5, abs=1e-9) for v in flat)

    loud = radio_screen._interpolate_bars([0.0] * 8, 24)
    assert all(0.0 <= v <= 1.0 for v in loud)
    assert all(v == pytest.approx(1.0, abs=1e-9) for v in loud)


def test_interpolate_bars_produces_more_resolution_than_the_8_real_bands():
    """The whole point of interpolating -- a monotonically increasing real
    signal across the 8 real bands must not just repeat 8 flat chunks once
    subdivided into more bars."""
    levels = [-60.0, -50.0, -40.0, -30.0, -20.0, -10.0, -5.0, 0.0]
    bars = radio_screen._interpolate_bars(levels, radio_screen._VIS_BARS)
    assert len(bars) == radio_screen._VIS_BARS
    assert len(set(round(v, 6) for v in bars)) > len(levels)


def test_gradient_color_matches_every_stop_at_its_own_frac_and_clamps_outside_0_1():
    """Reads _VIS_GRADIENT_STOPS itself rather than hardcoding fracs/colors,
    so this stays correct if the ramp is ever re-tuned again (as it already
    was once, to match a pasted reference mockup more closely -- see
    PROGRESS.md)."""
    for frac, color in radio_screen._VIS_GRADIENT_STOPS:
        assert radio_screen._gradient_color(frac) == color
    # out-of-range fracs clamp to the end stops rather than extrapolating
    assert radio_screen._gradient_color(-5.0) == radio_screen._gradient_color(0.0)
    assert radio_screen._gradient_color(5.0) == radio_screen._gradient_color(1.0)


def test_gradient_color_is_monotonic_in_each_rgb_channel_within_a_stop_span():
    """Cheap sanity check that a mid-span frac is genuinely between its two
    bracketing stops in RGB space, not some interpolation-math typo. Uses the
    gold->orange span (a real color change) rather than the bottom span,
    which is deliberately a flat green plateau (see _VIS_GRADIENT_STOPS)."""
    low = radio_screen._hex_to_rgb(radio_screen._gradient_color(0.72))
    mid = radio_screen._hex_to_rgb(radio_screen._gradient_color(0.80))
    high = radio_screen._hex_to_rgb(radio_screen._gradient_color(0.88))
    for lo, m, hi in zip(low, mid, high):
        assert min(lo, hi) <= m <= max(lo, hi)


def test_vis_row_colors_run_from_green_at_the_bottom_to_coral_at_the_top():
    assert radio_screen._VIS_ROW_COLORS[0] == radio_screen._GREEN_BRIGHT
    assert radio_screen._VIS_ROW_COLORS[-1] == radio_screen._VIS_CORAL


def _row_spans(text, row, width):
    """Extracts the (start, end, style) spans belonging to one rendered row
    of a _render_visualizer() Text, given every row is `width` chars plus a
    trailing newline."""
    row_start = row * (width + 1)
    row_end = row_start + width
    return [s for s in text.spans if s.start < row_end and s.end > row_start]


def test_render_visualizer_silence_is_all_unlit():
    text = radio_screen._render_visualizer([-60.0] * 8)
    plain_rows = text.plain.split("\n")[:-1]
    assert len(plain_rows) == radio_screen._VIS_ROWS
    assert all(ch == "░" for row in plain_rows for ch in row)
    bottom_row_spans = _row_spans(text, radio_screen._VIS_ROWS - 1, radio_screen._VIS_BARS)
    assert all(s.style == radio_screen._VIS_OFF for s in bottom_row_spans)


def test_render_visualizer_full_volume_lights_every_bar_with_a_peak_cap_and_the_gradient():
    """0 dBFS on every real band normalizes to 1.0 everywhere, so every bar
    is lit its full real height. Since every bar reaches the exact same
    height here, the very top physical row is EVERY bar's own peak -- drawn
    with the hatched peak-hold cap (see _render_visualizer's docstring),
    not a solid gradient-colored block. Bottom row is green, per the
    low-to-high color ramp."""
    text = radio_screen._render_visualizer([0.0] * 8)
    plain_rows = text.plain.split("\n")[:-1]
    assert len(plain_rows) == radio_screen._VIS_ROWS
    assert all(ch == "▒" for ch in plain_rows[0])
    assert all(ch == "█" for row in plain_rows[1:] for ch in row)

    # row 0 in the rendered Text is the TOP of the bar (rows are emitted
    # top-down); the bottom row is printed last.
    top_spans = _row_spans(text, 0, radio_screen._VIS_BARS)
    bottom_spans = _row_spans(text, radio_screen._VIS_ROWS - 1, radio_screen._VIS_BARS)
    assert all(s.style == radio_screen._VIS_PEAK for s in top_spans)
    assert all(s.style == radio_screen._GREEN_BRIGHT for s in bottom_spans)


def test_render_visualizer_peak_cap_lands_on_each_bars_own_top_row():
    """The peak-hold cap must track each bar's OWN height, not a single row
    shared across the whole visualizer -- confirmed here per-column against
    heights computed independently via _interpolate_bars, for a level shape
    (one loud band, rest silent) guaranteed to produce genuinely unequal bar
    heights across the 34 interpolated bars."""
    levels = [-60.0] * 7 + [0.0]
    heights = [round(v * radio_screen._VIS_ROWS) for v in radio_screen._interpolate_bars(levels, radio_screen._VIS_BARS)]
    assert len(set(heights)) > 1  # otherwise this wouldn't exercise per-column placement at all

    text = radio_screen._render_visualizer(levels)
    plain_rows = text.plain.split("\n")[:-1]
    columns = list(zip(*plain_rows))  # column-major view, top row first
    for col_index, height in enumerate(heights):
        for row_index in range(radio_screen._VIS_ROWS):
            ch = columns[col_index][row_index]
            row_from_bottom = radio_screen._VIS_ROWS - 1 - row_index
            if height <= 0 or row_from_bottom >= height:
                assert ch == "░"
            elif row_from_bottom == height - 1:
                assert ch == "▒"
            else:
                assert ch == "█"


async def test_visualizer_freezes_on_pause_parks_on_stop_resumes_on_play():
    """Same freeze/park pattern as the shine-sweep test above, and for the
    same reason: the screen's own real set_interval would otherwise race
    these manual _redraw_visualizer() calls, so this drives it directly and
    asserts relative behavior rather than exact tick counts."""
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        screen = app.screen
        assert screen._last_vis_levels == [0.0] * radio.NUM_BANDS

        item = screen.list_view.children[0]
        with patch("mtdo.radio.has_mpv", return_value=True), \
             patch("mtdo.radio.has_ffmpeg", return_value=True), \
             patch("mtdo.radio.subprocess.Popen", side_effect=_mock_popen_pair()), \
             patch("mtdo.radio.threading.Thread"):
            screen.on_list_view_selected(_FakeSelected(item))

        # genuinely playing, not paused -- pulls fresh real levels
        screen._last_paused = False
        with patch.object(app.radio_player, "get_levels", return_value=[-10.0] * radio.NUM_BANDS):
            screen._redraw_visualizer()
        assert screen._last_vis_levels == [-10.0] * radio.NUM_BANDS

        # frozen while paused -- must NOT pick up this new (also real) value
        screen._last_paused = True
        with patch.object(app.radio_player, "get_levels", return_value=[-1.0] * radio.NUM_BANDS):
            screen._redraw_visualizer()
        assert screen._last_vis_levels == [-10.0] * radio.NUM_BANDS

        # resumes pulling fresh real levels once unpaused
        screen._last_paused = False
        with patch.object(app.radio_player, "get_levels", return_value=[-1.0] * radio.NUM_BANDS):
            screen._redraw_visualizer()
        assert screen._last_vis_levels == [-1.0] * radio.NUM_BANDS

        # parks at the rest baseline once stopped
        app.radio_player.stop()
        screen._redraw_visualizer()
        assert screen._last_vis_levels == [0.0] * radio.NUM_BANDS
