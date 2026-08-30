"""Now-playing display + playback controls for whatever's actually playing --
YouTube Music in a browser tab, Apple Music, VLC, Spotify, anything -- not just
Spotify. MTDO isn't an entertainment app; music is background utility, so this stays
a thin, best-effort layer, not a real player.

Two paths, tried in this order:

1. nowplaying-cli (https://github.com/kirtan-shah/nowplaying-cli), if installed --
   a small open-source wrapper around macOS's own MediaRemote framework, the same
   thing that drives the system media widget. Works for whatever app currently owns
   "Now Playing", regardless of which one that is. `brew install nowplaying-cli` sets
   it up; there's no in-app installer for this (unlike the AI panel's Ollama install)
   since there's no natural interactive moment to ask in a passive, always-on
   feature -- the panel just shows the one-line install hint instead, and it's
   already inside a terminal with an AI panel one keypress away that can run the
   install itself if asked to.
2. Spotify-specific AppleScript, as a fallback when nowplaying-cli isn't installed --
   the original behavior, unchanged, so nothing regresses for anyone who doesn't
   want the extra dependency.

Volume is the one place these genuinely differ: nowplaying-cli's underlying
framework has no volume control, so when it's the active path, volume commands
nudge the system's actual output volume (which affects whatever's playing, which is
arguably more "universal" anyway) instead of a single app's internal volume.
"""
import datetime
import json
import re
import shutil
import subprocess
import time

NOWPLAYING_INSTALL_HINT = "brew install nowplaying-cli"


def has_nowplaying_cli():
    return shutil.which("nowplaying-cli") is not None


def _run_best_effort(argv):
    """Fire-and-forget subprocess call for a control command (play/pause, skip,
    volume) where there's nothing useful to do with a failure -- just don't let a
    hung or missing subprocess freeze the UI. Every one of these runs directly on
    the main thread from a keybinding's action handler (see app.py's
    action_music_*), not a background thread -- a missing timeout here is a real,
    not just theoretical, way to freeze the entire app until the process returns
    or is killed (gh64)."""
    try:
        subprocess.run(argv, timeout=3)
    except Exception:
        pass


def _spotify_running():
    try:
        return subprocess.run(
            ["pgrep", "-x", "Spotify"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=3,
        ).returncode == 0
    except Exception:
        return False


_EMPTY = {"song": "Nothing Playing", "artist": "", "position": 0.0, "duration": 0.0,
          "state": "stopped", "volume": None}


def now_playing():
    """Returns {song, artist, position, duration, state, volume} -- position/duration
    in seconds, volume 0-100 or None if not controllable on this path."""
    if has_nowplaying_cli():
        return _nowplaying_cli_info()
    return _spotify_info()


def play_pause():
    if has_nowplaying_cli():
        _run_best_effort(["nowplaying-cli", "togglePlayPause"])
    else:
        _spotify_osa('tell application "Spotify" to playpause')


def next_track():
    if has_nowplaying_cli():
        _run_best_effort(["nowplaying-cli", "next"])
    else:
        _spotify_osa('tell application "Spotify" to next track')


def previous_track():
    if has_nowplaying_cli():
        _run_best_effort(["nowplaying-cli", "previous"])
    else:
        _spotify_osa('tell application "Spotify" to previous track')


def volume_up():
    _nudge_volume(10)


def volume_down():
    _nudge_volume(-10)


def _nudge_volume(delta):
    if has_nowplaying_cli():
        # No per-app volume in MediaRemote -- nudge the actual system output volume,
        # which affects whatever's playing regardless of app.
        _run_best_effort(["osascript", "-e", f'''
            set v to output volume of (get volume settings)
            set v to v + ({delta})
            if v > 100 then set v to 100
            if v < 0 then set v to 0
            set volume output volume v
        '''])
    else:
        _run_best_effort(["osascript", "-e", f'''
            tell application "Spotify"
                set v to sound volume + ({delta})
                if v > 100 then set v to 100
                if v < 0 then set v to 0
                set sound volume to v
            end tell
        '''])


# -- Spotify path (fallback / also used for the "P" paste-a-link feature, which has
# no universal equivalent) -----------------------------------------------------

def _spotify_osa(script):
    _run_best_effort(["osascript", "-e", script])


def _spotify_info():
    if not _spotify_running():
        return dict(_EMPTY)
    try:
        output = subprocess.check_output([
            "osascript", "-e",
            'tell application "Spotify" to name of current track & "|||" & artist of current track'
            ' & "|||" & (player position as string) & "|||" & (duration of current track as string)'
            ' & "|||" & (player state as string) & "|||" & (sound volume as string)'
        ], timeout=3).decode().strip()
        song, artist, position_s, duration_ms, state, volume_s = output.split("|||")
        return {
            "song": song, "artist": artist,
            "position": float(position_s), "duration": float(duration_ms) / 1000.0,
            "state": state, "volume": int(round(float(volume_s))),
        }
    except Exception:
        return dict(_EMPTY)


_SPOTIFY_URI_RE = re.compile(r"^spotify:(playlist|album|track|artist):[A-Za-z0-9]+$")
_SPOTIFY_WEB_RE = re.compile(r"^https?://open\.spotify\.com/(?:intl-\w+/)?(playlist|album|track|artist)/([A-Za-z0-9]+)")


def _spotify_uri_from_input(value):
    value = value.strip()
    if _SPOTIFY_URI_RE.match(value):
        return value
    m = _SPOTIFY_WEB_RE.match(value)
    if m:
        kind, sid = m.groups()
        return f"spotify:{kind}:{sid}"
    return None


def play_spotify_url(value):
    """Plays a pasted Spotify playlist/album/track/artist link -- Spotify-specific,
    no equivalent through nowplaying-cli, so this always goes straight to Spotify's
    own AppleScript regardless of which path is otherwise active. Returns False (and
    leaves whatever's currently playing untouched) if the input isn't a recognizable
    Spotify link."""
    uri = _spotify_uri_from_input(value)
    if not uri:
        return False
    try:
        result = subprocess.run(
            ["osascript", "-e", f'tell application "Spotify" to play track "{uri}"'],
            capture_output=True, timeout=3,
        )
    except Exception:
        return False
    return result.returncode == 0


# -- nowplaying-cli path ---------------------------------------------------------

def _parse_mediaremote_timestamp(value):
    """kMRMediaRemoteNowPlayingInfoTimestamp comes back either as a raw epoch number
    or as Foundation's default NSDate string description ("2026-08-20 12:34:56 +0000")
    depending on the source app -- try both rather than assuming one."""
    if isinstance(value, (int, float)):
        return float(value)
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.datetime.strptime(str(value), fmt).timestamp()
        except ValueError:
            continue
    raise ValueError(f"unrecognized MediaRemote timestamp: {value!r}")


# gh18: our own fallback clock for extrapolating position when the source doesn't
# publish a Timestamp at all (confirmed live: a real WebKit/browser session --
# YouTube Music in a Safari tab -- never includes kMRMediaRemoteNowPlayingInfo
# Timestamp, and its ElapsedTime sat at a literally frozen value across 9+ seconds
# of continuous polling while actively playing at 2x rate). Keyed on the track's
# UniqueIdentifier + the last elapsed value actually seen from the source, so a
# genuinely new snapshot (a real position jump, a seek, MediaRemote finally
# pushing an update) resets the extrapolation baseline instead of compounding
# drift on top of it. Module-level, not per-call, since now_playing() is polled
# repeatedly (every second, from TodoApp's own tick) by the one running process.
_fallback_snapshot = {"identifier": None, "elapsed": None, "seen_at": None}

# gh55: apps we can ask directly, via AppleScript, for their real play/pause
# state -- keyed by the ClientBundleIdentifier MediaRemote reports. Used only
# when PlaybackRate is absent (see _nowplaying_cli_info) to override the
# "assume playing" guess below with ground truth for these two.
_APPLESCRIPT_PLAYER_APPS = {
    "com.spotify.client": "Spotify",
    "com.apple.Music": "Music",
}


def _apple_script_is_playing(bundle_id):
    """True/False if `bundle_id` is a known app we can directly ask for its real
    player state -- None if it's some other app we have no such query for, or the
    query itself fails (e.g. the app quit despite still being MediaRemote's
    last-known Now Playing owner). Only called when PlaybackRate is absent."""
    app_name = _APPLESCRIPT_PLAYER_APPS.get(bundle_id)
    if app_name is None:
        return None
    try:
        state = subprocess.check_output(
            ["osascript", "-e", f'tell application "{app_name}" to player state as string'],
            stderr=subprocess.DEVNULL, timeout=3,
        ).decode().strip()
    except Exception:
        return None
    return state == "playing"


def _nowplaying_cli_info():
    """Uses `get-raw` (the full MediaRemote dict), not `get --json <keys>` -- confirmed
    by hand that the shorthand key-selection path is broken for elapsedTime
    specifically: it reliably reports 0 even while a track is actively playing,
    while get-raw's kMRMediaRemoteNowPlayingInfoElapsedTime has the real value at the
    same instant. That mismatch is also the real explanation for a "frozen" position
    in general, not just the always-zero case: MediaRemote's ElapsedTime is a
    snapshot updated only on discrete events (play/pause/seek/track change), not a
    continuously ticking clock. Some sources also publish Timestamp + PlaybackRate
    specifically so a consumer can extrapolate "right now" from that snapshot --
    used below when present, preferred over our own fallback since it's the source's
    own authoritative clock. When it's absent (gh18 -- confirmed live: WebKit/browser
    sources, e.g. YouTube Music web, never publish one), fall back to extrapolating
    from our own wall clock instead, using the moment we first observed the current
    elapsed value as the substitute timestamp (see _fallback_snapshot above) --
    same idea, just backed by our own clock rather than the source's.

    gh55: PlaybackRate being absent does NOT reliably mean "this source never
    publishes one" (gh18's original assumption, based on Spotify never including
    it either at the time) -- confirmed live that Spotify (via nowplaying-cli)
    actually publishes Rate:1 while genuinely playing and drops the key entirely
    while paused, so treating "absent" as "assume playing" made the position keep
    ticking forward via the fallback clock for the entire time the track was
    actually paused, then visibly jump back down to the real position on resume
    (exactly the reported bug: "even when i stop the music player... the time
    goes on... when i play the song again the timer... back where it paused").
    For the two apps we can directly ask (_APPLESCRIPT_PLAYER_APPS), that real
    state now overrides the guess; for anything else (e.g. a WebKit tab with
    truly no Rate field even while playing, gh18's actual original case) the old
    "assume playing" guess is the only option left and is unchanged."""
    try:
        result = subprocess.run(
            ["nowplaying-cli", "get-raw"], capture_output=True, text=True, timeout=3,
        )
        data = json.loads(result.stdout)
    except Exception:
        return dict(_EMPTY)

    title = data.get("kMRMediaRemoteNowPlayingInfoTitle")
    if not title:
        return dict(_EMPTY)

    elapsed = float(data.get("kMRMediaRemoteNowPlayingInfoElapsedTime") or 0)
    rate = data.get("kMRMediaRemoteNowPlayingInfoPlaybackRate")
    timestamp = data.get("kMRMediaRemoteNowPlayingInfoTimestamp")
    identifier = data.get("kMRMediaRemoteNowPlayingInfoUniqueIdentifier")
    playing = rate is None or float(rate) > 0  # no rate published -- assume playing, unless...
    if rate is None:
        bundle_id = data.get("kMRMediaRemoteNowPlayingInfoClientBundleIdentifier")
        known_state = _apple_script_is_playing(bundle_id)
        if known_state is not None:
            playing = known_state  # ...we can just ask this app directly (gh55)

    position = elapsed
    used_source_timestamp = False
    if rate is not None and timestamp is not None:
        try:
            since_snapshot = time.time() - _parse_mediaremote_timestamp(timestamp)
            position = elapsed + since_snapshot * float(rate)
            used_source_timestamp = True
        except (ValueError, TypeError):
            position = elapsed

    if not used_source_timestamp:
        now = time.monotonic()
        same_snapshot = (
            _fallback_snapshot["identifier"] == identifier and _fallback_snapshot["elapsed"] == elapsed
        )
        if not same_snapshot:
            _fallback_snapshot["identifier"] = identifier
            _fallback_snapshot["elapsed"] = elapsed
            _fallback_snapshot["seen_at"] = now
        if playing:
            effective_rate = float(rate) if rate is not None else 1.0
            position = elapsed + (now - _fallback_snapshot["seen_at"]) * effective_rate
        else:
            position = elapsed

    return {
        "song": title,
        "artist": data.get("kMRMediaRemoteNowPlayingInfoArtist") or "",
        "position": max(0.0, position),
        "duration": float(data.get("kMRMediaRemoteNowPlayingInfoDuration") or 0),
        "state": "playing" if playing else "paused",
        "volume": None,  # not controllable via MediaRemote -- see _nudge_volume
    }
