"""A genuine, self-contained internet-radio player -- not a remote control like
music.py (which only ever forwards commands to whatever's already playing
externally). This owns real audio playback: it starts and stops its own
processes, decodes and streams actual audio, and reports real, live audio
levels for a genuinely audio-reactive visualizer.

Two external processes per active station, both spawned and owned here:

1. `mpv` -- does the actual audio decoding/playback. Controlled entirely via
   its `--input-ipc-server` JSON socket (play/pause/volume/position), never by
   sending it terminal keystrokes. Required, no fallback: there's no other
   common tool with mpv's combination of "plays internet radio streams
   reliably" and "has a clean, scriptable IPC control interface" (`ffplay`,
   also on this machine, has neither).
2. `ffmpeg` -- runs the *same* stream through `astats`, split into several
   bandpass-filtered copies, purely to extract real per-band RMS levels for
   the visualizer. Entirely separate from mpv's own pipeline (its output goes
   nowhere -- `-f null -`) specifically so a visualizer bug can never affect
   actual playback, and vice versa. Confirmed live, by hand, against a real
   stream before writing this: `-af astats=metadata=1:reset=1,ametadata=...`
   genuinely tracks a stream's real, moving loudness (not a static value), and
   splitting into N lowpass/bandpass/highpass copies each with their own
   astats gives genuinely different levels per band (e.g. -16dB bass vs -51dB
   treble on the same instant of real audio).

This means each active station costs two parallel network connections to the
same URL (one played, one silently analyzed) -- worth knowing, not a bug.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time

MPV_INSTALL_HINT = "brew install mpv"

_RMS_LINE_RE = re.compile(r"Parsed_ametadata_(\d+).*?RMS_level=(-?[\d.]+|-?inf)")

# Verified live via `curl` before adding any of these -- all real, currently-
# working, freely-embeddable streams (SomaFM and Nightride FM both publish
# direct stream URLs specifically for third-party player integration, unlike
# e.g. YouTube, which prohibits raw stream extraction).
STATIONS = [
    {"name": "Lofi Hip Hop Radio", "url": "https://ice1.somafm.com/groovesalad-128-mp3"},
    {"name": "EDM Pulse", "url": "https://ice1.somafm.com/thetrip-128-mp3"},
    {"name": "Synthwave Nights", "url": "https://stream.nightride.fm/nightride.mp3"},
    {"name": "House Grooves", "url": "https://ice1.somafm.com/beatblender-128-mp3"},
    {"name": "Dubstep Underground", "url": "https://ice1.somafm.com/dubstep-128-mp3"},
    {"name": "Drum & Bass", "url": "https://ice1.somafm.com/fluid-128-mp3"},
    {"name": "Darksynth", "url": "https://stream.nightride.fm/darksynth.mp3"},
    {"name": "Chillsynth", "url": "https://stream.nightride.fm/chillsynth.mp3"},
    {"name": "Vaporwave", "url": "https://ice1.somafm.com/vaporwaves-128-mp3"},
    {"name": "Indie Pop", "url": "https://ice1.somafm.com/poptron-128-mp3"},
    {"name": "Hacker Radio", "url": "https://ice1.somafm.com/defcon-128-mp3"},
]

# Crossover frequencies (Hz) splitting the spectrum into len(_BAND_EDGES) + 1
# bands, low to high -- not scientifically precise crossovers, just enough to
# make bass/mid/treble visibly move independently for the visualizer.
_BAND_EDGES = [60, 150, 400, 1000, 2500, 6000, 12000]
NUM_BANDS = len(_BAND_EDGES) + 1


def has_mpv():
    return shutil.which("mpv") is not None


def _band_filter(index):
    """One lowpass/bandpass/highpass filter for band `index`, 0 (bass) to
    NUM_BANDS - 1 (treble)."""
    if index == 0:
        return f"lowpass=f={_BAND_EDGES[0]}"
    if index == NUM_BANDS - 1:
        return f"highpass=f={_BAND_EDGES[-1]}"
    lo, hi = _BAND_EDGES[index - 1], _BAND_EDGES[index]
    center = (lo + hi) / 2
    half_width = (hi - lo) / 2
    return f"bandpass=f={center}:width_type=h:w={half_width}"


def _build_filter_complex():
    """The full ffmpeg -filter_complex string: split the input into NUM_BANDS
    copies, filter each into its own frequency band, and meter each with
    astats + ametadata (default target: stderr, i.e. no file= at all --
    verified live that a file= target buffers and never flushes for an
    indefinite/never-exits run, which is every real radio stream; printing to
    stderr instead is confirmed to flush continuously in real time, hundreds
    of samples/sec, while the process is still running). Each band's
    ametadata filter gets its own numbered instance in the output
    (`Parsed_ametadata_<N>`); `_read_stderr_loop` below discovers the N
    distinct instance numbers actually seen and maps them, sorted ascending,
    to band 0..NUM_BANDS-1 -- robust to whatever exact numbers ffmpeg assigns,
    since they always appear in the same left-to-right order these bands are
    declared in below."""
    splits = "".join(f"[a{i}]" for i in range(NUM_BANDS))
    parts = [f"[0:a]asplit={NUM_BANDS}{splits}"]
    for i in range(NUM_BANDS):
        parts.append(
            f"[a{i}]{_band_filter(i)},astats=metadata=1:reset=1,"
            f"ametadata=mode=print:key=lavfi.astats.Overall.RMS_level"
        )
    return "; ".join(parts)


class RadioPlayer:
    """Owns the whole lifecycle of at most one playing station at a time. Not
    thread-safe against concurrent start()/stop() calls from multiple threads
    -- only ever driven from the Textual app's own single event loop thread,
    same assumption every other panel in this app already makes."""

    def __init__(self):
        self._mpv_proc = None
        self._ffmpeg_proc = None
        self._ipc_sock = None
        self._tmp_dir = None
        self._station_index = None
        self._levels = [0.0] * NUM_BANDS
        self._lock = threading.Lock()
        self._poll_thread = None

    def is_playing(self):
        return self._mpv_proc is not None and self._mpv_proc.poll() is None

    def current_station(self):
        return STATIONS[self._station_index] if self._station_index is not None else None

    @property
    def station_index(self):
        return self._station_index

    def start(self, station_index):
        """Starts `STATIONS[station_index]`, stopping whatever was playing
        first. Raises RuntimeError if mpv isn't installed -- callers should
        check has_mpv() before ever offering this."""
        if not has_mpv():
            raise RuntimeError(f"mpv not found -- install it with `{MPV_INSTALL_HINT}`.")
        self.stop()
        station = STATIONS[station_index]

        self._tmp_dir = tempfile.mkdtemp(prefix="mtdo-radio-")
        self._ipc_sock = os.path.join(self._tmp_dir, "mpv.sock")
        self._mpv_proc = subprocess.Popen(
            ["mpv", "--no-video", "--no-terminal", "--really-quiet",
             f"--input-ipc-server={self._ipc_sock}", station["url"]],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self._ffmpeg_proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "info", "-i", station["url"],
             "-filter_complex", _build_filter_complex(),
             "-f", "null", "-"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self._station_index = station_index
        self._levels = [0.0] * NUM_BANDS

        self._poll_thread = threading.Thread(
            target=self._read_levels_loop, args=(self._ffmpeg_proc,), daemon=True,
        )
        self._poll_thread.start()

    def stop(self):
        # ffmpeg first: closing it ends its stderr pipe, which is what
        # unblocks _read_levels_loop's line-by-line read below -- setting a
        # stop flag alone wouldn't, since that loop blocks on readline().
        for proc in (self._mpv_proc, self._ffmpeg_proc):
            if proc is None:
                continue
            self._terminate(proc)
        if self._poll_thread is not None:
            self._poll_thread.join(timeout=1.0)
            self._poll_thread = None
        self._mpv_proc = None
        self._ffmpeg_proc = None
        self._station_index = None
        self._levels = [0.0] * NUM_BANDS
        if self._tmp_dir is not None:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None
        self._ipc_sock = None

    @staticmethod
    def _terminate(proc):
        """SIGTERM first, escalate to SIGKILL if it's still alive shortly
        after -- same two-step shutdown pty_panel.py already uses for its own
        owned subprocess, so a stuck mpv/ffmpeg can never survive mtdo
        quitting (the one failure mode that matters most here: an orphaned
        background process still streaming audio after the app has exited)."""
        if proc.poll() is not None:
            return
        try:
            proc.terminate()
        except OSError:
            return
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.05)
        try:
            proc.kill()
        except OSError:
            pass

    def _send_ipc(self, command):
        if self._ipc_sock is None:
            return None
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(1.0)
                sock.connect(self._ipc_sock)
                sock.sendall((json.dumps({"command": command}) + "\n").encode("utf-8"))
                data = sock.recv(4096)
            return json.loads(data.decode("utf-8").strip().splitlines()[0])
        except (OSError, ValueError, IndexError):
            return None

    def toggle_pause(self):
        self._send_ipc(["cycle", "pause"])

    def set_volume(self, delta):
        self._send_ipc(["add", "volume", delta])

    def get_volume(self):
        """mpv's real volume property, 0-100, or None if unavailable (e.g.
        nothing playing yet)."""
        reply = self._send_ipc(["get_property", "volume"])
        if reply and reply.get("error") == "success" and isinstance(reply.get("data"), (int, float)):
            return float(reply["data"])
        return None

    def is_paused(self):
        reply = self._send_ipc(["get_property", "pause"])
        return bool(reply and reply.get("data"))

    def get_position(self):
        """Elapsed seconds into the current stream connection, or None if not
        playing/not yet available (mpv hasn't reported time-pos yet, e.g. the
        first moment a stream connects)."""
        reply = self._send_ipc(["get_property", "time-pos"])
        if reply and reply.get("error") == "success" and isinstance(reply.get("data"), (int, float)):
            return float(reply["data"])
        return None

    def get_levels(self):
        """Latest real per-band RMS levels, in dBFS (typically -60 silent to 0
        loudest), low band first. Thread-safe snapshot -- updated continuously
        by the background thread reading the analysis ffmpeg process's own
        stderr (see _read_levels_loop)."""
        with self._lock:
            return list(self._levels)

    def _read_levels_loop(self, proc):
        """Reads the analysis ffmpeg process's stderr line by line for as long
        as it's alive, discovering which `Parsed_ametadata_<N>` instance
        number belongs to which band (in first-seen order -- see
        _build_filter_complex's docstring for why that's reliable) and keeping
        self._levels updated with each band's latest real value. Exits on its
        own once `proc`'s stderr hits EOF (i.e. the process was terminated by
        stop() -- no separate stop signal needed here)."""
        instance_to_band = {}
        next_band = 0
        for line in proc.stderr:
            match = _RMS_LINE_RE.search(line)
            if not match:
                continue
            instance, raw_value = match.groups()
            if instance not in instance_to_band:
                if next_band >= NUM_BANDS:
                    continue  # more distinct instances than expected bands -- ignore extras
                instance_to_band[instance] = next_band
                next_band += 1
            try:
                value = float(raw_value)
            except ValueError:
                continue
            if value != value or value in (float("-inf"), float("inf")):  # NaN/inf -- no signal yet
                continue
            band = instance_to_band[instance]
            with self._lock:
                self._levels[band] = value
