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


def test_start_stops_the_previous_station_first():
    player = radio.RadioPlayer()
    with patch("mtdo.radio.has_mpv", return_value=True), \
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


async def test_radio_screen_opens_via_keybinding_and_plays_on_enter():
    app = TodoApp()
    async with app.run_test() as pilot:
        await _dismiss_first_run_prompts(pilot, app)

        with patch("mtdo.radio.has_mpv", return_value=True):
            await pilot.press("R")
            await pilot.pause()
        assert isinstance(app.screen, RadioScreen)

        # ListView's Enter -> its own internal handling -> a Selected message
        # -> on_list_view_selected is (at least) two message-pump hops, not
        # one -- confirmed on CI (Linux): patching only around press("enter")
        # let the second hop's actual player.start() call land *after* the
        # patch context had already exited, silently falling through to a
        # real, unmocked subprocess.Popen(["mpv", ...]) (which doesn't exist
        # on a CI runner). The patch has to cover pilot.pause() too, not just
        # press(), for any binding that isn't a single direct key->action hop.
        with patch("mtdo.radio.subprocess.Popen", side_effect=_mock_popen_pair()), \
             patch("mtdo.radio.threading.Thread"):
            await pilot.press("enter")
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
