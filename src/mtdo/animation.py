"""Terminal animation playback for the side panel (and Focus Mode), inspired by/adapted
from anifetch (https://github.com/Notenlish/anifetch): ffmpeg extracts frames from a
video/gif, chafa renders each frame to ANSI "symbols" art, and we cycle through the
rendered frames inside a small Textual widget.

This is deliberately a slimmed-down reimplementation rather than a dependency on the
anifetch package: anifetch's own renderer takes over the whole terminal (absolute cursor
positioning, its own keyboard capture via pynput, fastfetch/neofetch info merged into the
frame) which doesn't fit inside a single panel of an existing Textual app. We reuse just
the ffmpeg/chafa pipeline shape, rendering into cached plain ANSI strings that a Textual
widget can display with Text.from_ansi().

Requires the `ffmpeg` and `chafa` CLI tools to be installed separately (not Python
packages -- see check_deps()). Frames are cached on disk keyed by (file, size, fps) so
re-playing the same clip at the same size is instant after the first render.
"""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor

from . import config as appconfig

ANIM_DIR = os.path.join(appconfig.APP_DIR, "animations")
CACHE_DIR = os.path.join(appconfig.APP_DIR, "anim_cache")

_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ASSET = os.path.join(_PACKAGE_DIR, "assets", "example.mp4")

VIDEO_EXTENSIONS = (".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v", ".gif")


def check_deps():
    """Returns (chafa_installed, ffmpeg_installed)."""
    return shutil.which("chafa") is not None, shutil.which("ffmpeg") is not None


def ensure_default_asset():
    """Copies the bundled example clip into ~/.mtdo/animations/ on first use, so there's
    always at least one animation available out of the box."""
    os.makedirs(ANIM_DIR, exist_ok=True)
    dest = os.path.join(ANIM_DIR, "example.mp4")
    if not os.path.exists(dest) and os.path.exists(DEFAULT_ASSET):
        shutil.copy(DEFAULT_ASSET, dest)
    return dest


def list_animations():
    """Names (filenames) of all animation clips available to play, sorted."""
    ensure_default_asset()
    if not os.path.isdir(ANIM_DIR):
        return []
    return sorted(
        f for f in os.listdir(ANIM_DIR)
        if os.path.splitext(f)[1].lower() in VIDEO_EXTENSIONS
    )


def add_animation_file(src_path):
    """Copies a user-provided video/gif into ~/.mtdo/animations/ so it shows up in the
    picker from then on. Returns the new filename. Raises FileNotFoundError / ValueError."""
    src_path = os.path.expanduser(src_path.strip())
    if not os.path.isfile(src_path):
        raise FileNotFoundError(f"No such file: {src_path}")
    ext = os.path.splitext(src_path)[1].lower()
    if ext not in VIDEO_EXTENSIONS:
        raise ValueError(f"Unsupported file type '{ext}'. Use one of: {', '.join(VIDEO_EXTENSIONS)}")
    os.makedirs(ANIM_DIR, exist_ok=True)
    dest_name = os.path.basename(src_path)
    dest = os.path.join(ANIM_DIR, dest_name)
    shutil.copy(src_path, dest)
    return dest_name


def _cache_key(path, width, height, fps):
    stat = os.stat(path)
    raw = f"{path}|{stat.st_mtime}|{stat.st_size}|{width}|{height}|{fps}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _render_frame(image_path, width, height):
    p = subprocess.run(
        ["chafa", "--format", "symbols", f"--size={width}x{height}", image_path],
        text=True, encoding="utf-8", errors="replace",
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if p.returncode != 0:
        raise RuntimeError(f"chafa failed on {image_path}: {p.stderr.strip()}")
    return p.stdout


def get_frames(name, width=28, height=12, fps=8, quality=6):
    """Returns a cached list of rendered ANSI frame strings for the given clip
    (a filename inside ANIM_DIR), rendering + caching them first if needed.
    Safe to call from a background thread -- does real subprocess work, never touches
    Textual widgets directly."""
    path = os.path.join(ANIM_DIR, name)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"No animation named '{name}' in {ANIM_DIR}")

    key = _cache_key(path, width, height, fps)
    cache_file = os.path.join(CACHE_DIR, f"{key}.json")
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            return json.load(f)

    chafa_ok, ffmpeg_ok = check_deps()
    if not chafa_ok:
        raise RuntimeError("chafa is not installed (brew install chafa)")
    if not ffmpeg_ok:
        raise RuntimeError("ffmpeg is not installed (brew install ffmpeg)")

    with tempfile.TemporaryDirectory(prefix="mtdo_anim_") as tmp:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-vf", f"fps={fps}", "-q:v",
             str(min(max(quality, 2), 10)), os.path.join(tmp, "%05d.jpg")],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed on {name}: {result.stderr.strip()[-400:]}")

        frame_files = sorted(f for f in os.listdir(tmp) if f.endswith(".jpg"))
        if not frame_files:
            raise RuntimeError(f"ffmpeg produced no frames for {name}")

        max_workers = max(1, min(8, os.cpu_count() or 2))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            frames = list(executor.map(
                lambda f: _render_frame(os.path.join(tmp, f), width, height), frame_files
            ))

    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache_file, "w") as f:
        json.dump(frames, f)

    return frames
