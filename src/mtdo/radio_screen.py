"""A self-contained "radio session" screen -- the retro-terminal internet-radio
player (station list, real audio-reactive visualizer, favorites, shuffle/
repeat) requested to sit alongside, not replace, the existing NowPlayingPanel
remote control in app.py. Extracted into its own module rather than folded
into app.py, same precedent as practice_lab_panel.py for a feature this size.

Visual design matches a specific reference mockup (a fictional "cliamp"
terminal player) the user provided, with one deliberate departure: the
mockup's "EQ [ Rock ]" row implies a genre EQ preset that actually reshapes
the sound -- discussed with the user, who chose NOT to build that (a real
audio-processing feature, not a UI concern) and instead have that row show
the same real per-band audio levels already driving the visualizer, labeled
honestly ("EQ [Live]") rather than a fake preset name. Everything else in the
mockup that had no real backing data in this app (a "SRC 1/9" source
counter, a "SPD [1x]"/bandwidth footer) was dropped rather than faked.

The header art above the transport controls is a static Braille-block ASCII
image the user supplied directly, animated by a sweeping color highlight (see
the `_SHINE_ART` block below for why -- this replaced an earlier real-video
vinyl-spin attempt the user found looked bad).

A full Screen (VaultScreen's pattern), not a ModalScreen or docked panel --
pushed via a keybinding/click from TodoApp, popped with q/Escape. Closing this
screen does NOT stop playback: this is meant to be a "session" you can dip in
and out of while the rest of mtdo stays usable, not something that forces you
to stay on it to keep the music going. TodoApp itself owns the one shared
`radio.RadioPlayer` instance (see app.py) and is responsible for actually
stopping it on quit -- this screen only ever reads/commands that instance,
never creates its own.
"""
from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.screen import Screen
from textual.widgets import Static, ListView, ListItem, Label
from rich.text import Text

from . import config as appconfig
from . import radio

_REPEAT_CYCLE = ["off", "all", "one"]
_VOL_BAR_WIDTH = 28

_GREEN_BRIGHT = "#39ff8a"
_GREEN_MID = "#1f7a4d"
_GREEN_BG = "#0d2318"
_TEAL = "#3ddc97"
_ORANGE = "#ffb454"
_DIM = "#7c8c83"
_BOX_BORDER = "#1f4d33"
_PANEL_BG = "#0a0f0c"

# -- Shine-sweep art -- replaces an earlier real-video vinyl-spin attempt the
# user found looked bad (garbled/blocky rendering). This is a single static
# piece of Braille-block ASCII art the user provided directly, with no source
# frames to play -- so "looping" it means synthesizing motion on top of a
# fixed character grid, not decoding real video. Chose a sweeping highlight
# band (the user's own pick among a few options) over reshaping/rotating the
# art itself: pure color modulation over an unchanged grid can never distort
# or garble it, which a rotate/scale attempt on pre-rendered block characters
# generally can. No textual-image/Pillow/ffmpeg needed at all for this --
# genuinely simpler than the vinyl attempt, plain text the whole way.
_SHINE_ART_FULL = [
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠉⢋⡛⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠉⡴⠎⠹⣿⣷⣾⣿⣶⣬⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋⣰⣵⣶⣶⣦⡈⣿⣿⣿⣿⡏⣄⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⢁⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⡀⢉⣿⣿⣿⣿⣿⡿⠟⠃⣹⣿⣿⣿⣧⠘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠗⠐⠉⠉⠻⠿⠥⠤⠒⠛⣋⠉⢻⣿⠏⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀⢀⠁⠐⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠰⠿⠿⠛⠛⠛⠿⠿⣿⡿⠟⢁⣴⡿⠀⢁⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣿⣿⢠⣤⠄⠀⢀⠀⣀⣴⣿⣿⠇⡀⠘⠿⠿⠿⠛⠛⠛⢛⡋⠙⠻⢿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆⠻⣄⠛⣋⣴⣿⣿⠟⠁⣰⣿⠆⠀⣰⣶⣶⣶⣾⣿⣿⣦⣤⡈⢿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⣋⠉⠁⣀⠙⡤⠀⢲⡿⠃⠀⣰⣿⠖⢀⡜⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠈⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠉⣡⣴⣾⣿⠉⠐⠇⠀⣆⠈⠋⠩⠀⠀⣴⠟⢁⣤⡾⣡⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⢺⣿⣿⣿⣿⣿⣿⡁⠀⠀⡑⠄⡀⠀⢈⣤⡶⠟⣡⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠀⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⢺⣿⣿⣿⣿⣿⡏⣿⣷⣤⡀⠁⠀⠚⣋⣡⡴⠾⢋⣡⣀⣀⣉⣻⣿⣿⣿⠛⠉⠀⣸⠀⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄⠸⣿⣿⣿⣿⣿⠇⠉⢉⣡⣤⣴⣶⣿⣿⣿⣷⣶⣿⣿⣿⣿⣿⣿⣿⡿⠛⠁⢠⣾⣿⠀⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⠀⠻⡿⠟⠛⣁⣤⣤⡀⠙⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠛⠉⠀⠀⣴⣿⣿⠇⠀⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠛⢋⣉⣠⣴⣶⣶⣾⣿⣿⣿⣿⠦⠀⠀⠈⠙⠻⢿⣿⡿⠟⠻⠋⠁⠀⠀⠀⣠⣾⣿⣿⠏⡀⢰⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⢀⣤⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣤⠀⠀⠀⠀⠚⠁⠀⠀⠀⠀⢀⣾⡿⢿⣿⡟⣴⠃⣸⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⢁⣴⣿⠃⣿⣿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠛⠛⠉⠥⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠿⣋⣴⡿⢋⣴⠋⣠⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⢩⣤⣾⣿⠿⢋⣼⠁⣶⣶⣶⣶⡆⠰⣶⣦⣤⣤⣀⡀⠀⠀⠀⣀⣠⣤⣤⣖⣠⣶⣿⣦⡄⠀⣠⣾⡿⠋⣠⣿⠏⣴⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠛⠛⠛⠛⠛⠛⡁⢰⠟⠋⠉⠀⠾⣿⣿⠀⣿⣿⣿⣿⣧⠀⣿⣿⣿⠿⠟⠛⠛⠓⠂⠈⠻⣿⣿⣿⣿⣿⡟⢉⣴⣾⣿⠟⣡⣾⣿⡏⢰⣿⣿⣿⣿⣿⣿",
    "⣿⣿⡿⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠰⠶⠋⢡⠏⠀⠀⠀⠀⠀⠈⠻⠄⠉⠛⠿⣿⣿⣆⠈⢻⡿⠀⠀⠀⢀⣠⣤⣤⡀⠙⣿⠿⠋⢀⣴⣿⣿⠟⣡⣾⣿⣿⡿⠀⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣏⠀⠀⠀⠐⠒⠒⠒⠚⠛⠛⠉⠀⠀⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡸⠻⢿⣿⣄⠁⠀⠀⠘⠻⣿⣿⣿⣿⡄⠀⢀⣴⣿⣿⣿⣷⣾⣿⣿⣿⣿⡇⣤⣿⣿⣿⣿⣿⣿⣿",
    "⣙⠻⠷⡀⠄⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⠄⠀⠀⠀⠀⠀⠀⡀⠠⠄⠊⠁⠀⠀⢻⣿⣧⣄⠀⠀⠀⠈⠻⣿⣿⣿⣦⡀⠉⠛⠻⠿⢿⣿⣿⣿⣿⣿⡇⢻⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣷⣦⣌⠐⠠⣍⠀⠐⠒⠒⠐⠀⠀⠀⣤⣤⡤⠀⠰⡆⠂⡂⠀⠥⠄⠒⠒⠀⠉⠀⠈⠉⠀⠀⠀⠀⠀⠀⠀⠀⠹⣿⣿⣿⣿⣶⣤⡁⠒⠦⠬⣍⡙⠛⢿⣿⡈⢿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣶⣤⣉⠐⠤⣀⠀⠀⠀⢦⠀⠈⢳⡀⠀⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⠀⠀⠀⠀⠈⢻⣿⠻⡟⠻⣿⣦⣀⠲⢤⡬⠉⠲⢤⣅⣈⣛⢿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣄⣉⠐⠤⣀⠁⠀⠈⠀⠀⠀⠀⠒⠒⠋⠈⠉⠉⠁⠉⠉⠈⠈⠀⠀⠀⠀⠀⠀⡀⠀⠀⠀⢸⡏⠀⡇⠀⢻⡇⠙⠻⣦⣄⡀⠀⠀⣿⣿⣿⣿⣿⡿⠿⠋",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣤⣈⠒⠨⢦⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠂⠀⠀⢸⠇⠀⣿⠀⠀⠻⡄⠀⠀⠀⢀⣠⣴⠿⠟⠛⠉⠀⢀⣠⣴",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣤⣈⠙⠓⠶⣤⣤⣤⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠘⣃⣀⣤⣤⡤⠶⠚⠋⠉⠀⢀⣠⣤⣴⣾⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣦⣄⡉⠛⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠋⢉⣁⣠⣤⣤⣶⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣄⣈⠙⠻⢿⣿⣿⣿⣿⣿⡿⠿⢿⣿⣿⣿⣿⣿⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⣌⡙⠛⠉⠁⢠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡷⠀⣀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
]

# Cropped to the center _SHINE_DISPLAY_WIDTH columns of the 65-wide source
# art -- this screen puts the visualizer BESIDE the art (not stacked below
# it), and the two split the panel's real content width (80 - 2*1 margin -
# 2*1 border - 2*2 padding = 70 cols, the same 80-col terminal assumption
# other screens in this app make) as an actual LEFT HALF / RIGHT HALF, per
# direct user feedback on an earlier lopsided 42/24 split that shortchanged
# the visualizer -- not just "whatever's left over" for either side.
# _SHINE_DISPLAY_WIDTH (35) + _VIS_GAP (1) + _VIS_BARS (34) = 70, an even
# split. Cropped from the center, not an edge, on the assumption the art's
# focal point is centered like most portrait-style ASCII art --
# _SHINE_ART_FULL is kept above uncropped in case a future session wants to
# re-tune this (e.g. a wider-than-80 terminal).
_SHINE_CROP_START = 15
_SHINE_DISPLAY_WIDTH = 35
_SHINE_ART = [row[_SHINE_CROP_START:_SHINE_CROP_START + _SHINE_DISPLAY_WIDTH] for row in _SHINE_ART_FULL]
_SHINE_WIDTH = len(_SHINE_ART[0])
_SHINE_BASE_COLOR = "#a8b0ac"
_SHINE_HIGHLIGHT_COLOR = "#c8ffe0"
_SHINE_BAND_HALF_WIDTH = 6
_SHINE_STEP = 2
_SHINE_TICK = 1 / 20

# -- Dense "skyline" visualizer -- sits beside the shine-sweep art (not
# stacked below it), occupying the panel's right half (see the crop comment
# above for the width budget). Height matches the art's row count exactly
# so the two sit as one aligned block.
#
# Still real-data-only, same "EQ honesty" line the rest of this file holds
# to (see module docstring): radio.py's RadioPlayer.get_levels() is the only
# real audio data that exists, and it is only ever NUM_BANDS=8 values wide.
# Going from 8 real bands to _VIS_BARS=34 dense bars is spline interpolation
# across those 8 real values (_interpolate_bars, below), not decoration --
# a Catmull-Rom spline's curvature between control points is itself derived
# from the real neighboring bands' values, so the "skyline" texture between
# bars is real spectral shape, not randomness standing in for it.
_VIS_BARS = 34
_VIS_GAP = 1
_VIS_ROWS = len(_SHINE_ART)
_VIS_OFF = "#16241c"
_VIS_GOLD = "#ffd166"
_VIS_CORAL = "#ff5f56"
_VIS_PEAK = "#ff7fa6"  # bright pink-red "peak hold" cap, see _render_visualizer
# Low-to-high color ramp, re-tuned to match a reference "cliamp" mockup the
# user pasted directly (image-based feedback, not just the earlier written
# spec): mostly glowing green through the lower half (reused _GREEN_BRIGHT,
# no separate green constant needed), rising through warm gold and orange,
# hot coral only near the very top -- close to the mockup's segmented LED-
# meter look, which reads green-dominant with red only at the tips, not the
# more cyan-forward ramp an earlier revision used.
_VIS_GRADIENT_STOPS = [
    (0.0, _GREEN_BRIGHT),
    (0.55, _GREEN_BRIGHT),
    (0.72, _VIS_GOLD),
    (0.88, _ORANGE),
    (1.0, _VIS_CORAL),
]


def _hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4))


def _gradient_color(frac):
    """One color along the _VIS_GRADIENT_STOPS ramp at `frac` (0 = bottom of
    a bar, 1 = top), linearly interpolated in RGB between the two bracketing
    stops. Depends only on row position, never on live audio data, so it's
    computed once into _VIS_ROW_COLORS at import time rather than per frame."""
    frac = max(0.0, min(1.0, frac))
    for (f0, c0), (f1, c1) in zip(_VIS_GRADIENT_STOPS, _VIS_GRADIENT_STOPS[1:]):
        if frac <= f1:
            r0, g0, b0 = _hex_to_rgb(c0)
            r1, g1, b1 = _hex_to_rgb(c1)
            span = f1 - f0
            t = (frac - f0) / span if span else 0.0
            r = round(r0 + (r1 - r0) * t)
            g = round(g0 + (g1 - g0) * t)
            b = round(b0 + (b1 - b0) * t)
            return f"#{r:02x}{g:02x}{b:02x}"
    return _VIS_GRADIENT_STOPS[-1][1]


_VIS_ROW_COLORS = [_gradient_color(row / (_VIS_ROWS - 1)) for row in range(_VIS_ROWS)]


def _interpolate_bars(levels, num_bars):
    """Subdivides `levels` (real per-band dBFS values -- only NUM_BANDS=8 of
    them exist, see radio.py) into `num_bars` normalized 0..1 heights via
    Catmull-Rom spline interpolation between the real band values. Chosen
    over plain linear interpolation specifically because a spline's natural
    curvature between control points comes from the real slope/difference
    between neighboring bands -- it gives the 'skyline' its irregular
    per-bar variation honestly, from real spectral shape, rather than via
    decorative randomness (see this file's module docstring on EQ honesty)."""
    norms = [max(0.0, min(1.0, (lvl + 60.0) / 60.0)) for lvl in levels]
    n = len(norms)
    if n == 0:
        return [0.0] * num_bars
    if n == 1:
        return [norms[0]] * num_bars
    bars = []
    for i in range(num_bars):
        u = i / (num_bars - 1) * (n - 1) if num_bars > 1 else 0.0
        k = int(u)
        frac = u - k
        p0 = norms[max(k - 1, 0)]
        p1 = norms[k]
        p2 = norms[min(k + 1, n - 1)]
        p3 = norms[min(k + 2, n - 1)]
        t, t2 = frac, frac * frac
        t3 = t2 * t
        value = 0.5 * (
            2 * p1
            + (-p0 + p2) * t
            + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
            + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
        )
        bars.append(max(0.0, min(1.0, value)))
    return bars


def _render_visualizer(levels):
    """Renders the dense skyline visualizer from real per-band `levels`.
    Pure function of its input (no player/screen access) so the
    interpolation and gradient-color logic can be unit-tested directly by
    span/color inspection, same pattern as _render_shine_art above.

    Each bar's own topmost lit cell (row == height - 1, i.e. THAT bar's
    current peak -- not a fixed row shared across every bar) is drawn with a
    hatched "▒" texture in _VIS_PEAK instead of a solid block, echoing the
    dotted peak-hold cap on the reference mockup's meter. Everything below
    it is a solid block colored by _VIS_ROW_COLORS at that row's own
    position, same gradient regardless of which bar it belongs to."""
    heights = [round(v * _VIS_ROWS) for v in _interpolate_bars(levels, _VIS_BARS)]
    text = Text()
    for row in range(_VIS_ROWS - 1, -1, -1):
        row_color = _VIS_ROW_COLORS[row]
        for height in heights:
            if height <= 0 or row >= height:
                text.append("░", style=_VIS_OFF)
            elif row == height - 1:
                text.append("▒", style=_VIS_PEAK)
            else:
                text.append("█", style=row_color)
        text.append("\n")
    return text


def _render_shine_art(position):
    """Renders _SHINE_ART with a bright highlight band swept across it at
    `position` (a column index, wrapping circularly so the loop never jumps
    or restarts visibly). Built row by row with run-length-grouped spans
    (not one .append() per character) -- cheap enough to redraw at _SHINE_TICK
    even for a 65-wide, 33-row grid."""
    text = Text()
    for row in _SHINE_ART:
        run_style = None
        run_start = 0
        for col in range(_SHINE_WIDTH):
            dist = abs(col - position)
            dist = min(dist, _SHINE_WIDTH - dist)
            style = _SHINE_HIGHLIGHT_COLOR if dist <= _SHINE_BAND_HALF_WIDTH else _SHINE_BASE_COLOR
            if style != run_style:
                if run_style is not None:
                    text.append(row[run_start:col], style=run_style)
                run_style, run_start = style, col
        text.append(row[run_start:], style=run_style)
        text.append("\n")
    return text


def _fmt_mmss(seconds):
    if seconds is None:
        return "--:--"
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def _key_chip(key, label):
    """One 'key cap' hint chip -- a solid-background span faking a bordered
    key the way terminal cheat-sheets commonly do it, since Rich/Textual can
    only border a whole widget, never a span within a line of text."""
    chip = Text()
    chip.append(f" {key} ", style=f"bold black on {_TEAL}")
    chip.append(f" {label}   ", style=_DIM)
    return chip


def _eq_bands_text(levels):
    """Real per-band levels (dBFS, same data driving the visualizer) shown as
    small signed numbers -- an honest stand-in for the mockup's genre EQ
    preset readout (see module docstring): -30dBFS is an arbitrary but
    reasonable mid-loudness reference point for these stations, scaled so a
    band swinging through typical radio loudness reads roughly -9..+9,
    matching the mockup's single-digit style without claiming to be a
    calibrated meter."""
    text = Text()
    for lvl in levels:
        rel = max(-9, min(9, round((lvl + 30) / 3)))
        text.append(f"{rel:+d} ", style="white")
    return text


class StationItem(ListItem):
    # Named _build_label, not _render -- Widget itself defines a _render()
    # used internally for painting; a same-named method with a different
    # signature here silently overrides it and crashes on the next real
    # render call (confirmed by hand: a "missing 3 required positional
    # arguments" TypeError deep inside Textual's own render_content).
    def __init__(self, index, station, is_current, is_favorite):
        self.station_index = index
        super().__init__(Label(self._build_label(index, station, is_current, is_favorite)))

    def _build_label(self, index, station, is_current, is_favorite):
        marker = "▶ " if is_current else "  "
        star = " ★" if is_favorite else ""
        style = f"bold {_GREEN_BRIGHT}" if is_current else "white"
        return Text(f"{marker}{index + 1:>2}. {station['name']}{star}", style=style)


class RadioScreen(Screen):
    """`player` is the app-owned radio.RadioPlayer -- never constructed here,
    always passed in, so playback state genuinely survives this screen being
    closed and reopened (a fresh RadioPlayer would forget what was playing)."""

    BINDINGS = [
        ("escape", "close", "Back"),
        ("q", "close", "Back"),
        ("space", "toggle_pause", "Play/Pause"),
        ("f", "toggle_favorite", "Favorite"),
        ("s", "toggle_shuffle", "Shuffle"),
        ("r", "cycle_repeat", "Repeat"),
        ("n", "next_station", "Next"),
        ("p", "prev_station", "Prev"),
        ("+", "volume_up", "Vol+"),
        ("-", "volume_down", "Vol-"),
    ]

    CSS = f"""
    RadioScreen {{ layout: vertical; background: #05070a; }}
    #radio-topbar {{ dock: top; height: 1; padding: 0 2; background: #05070a; }}
    #radio-prompt {{ width: 1fr; color: {_TEAL}; }}
    #radio-tty {{ width: auto; color: {_DIM}; }}
    #radio-panel {{ margin: 1 2 1 2; border: round {_BOX_BORDER}; background: {_PANEL_BG}; padding: 0 2 1 2; height: 1fr; }}
    #radio-hero {{ height: auto; margin-top: 1; margin-bottom: 1; }}
    #radio-shine {{ width: {_SHINE_DISPLAY_WIDTH}; height: auto; }}
    #radio-visualizer {{ width: {_VIS_BARS}; height: {_VIS_ROWS}; margin-left: {_VIS_GAP}; background: {_GREEN_BG}; }}
    #radio-title-row {{ height: 1; margin-top: 1; }}
    #radio-cliamp {{ width: 1fr; color: {_TEAL}; text-style: bold; }}
    #radio-playlist-tag {{ width: auto; color: {_DIM}; }}
    #radio-now {{ color: white; text-style: bold; height: 1; margin-top: 1; }}
    #radio-time-row {{ height: 1; margin-bottom: 1; }}
    #radio-time {{ width: 1fr; color: {_DIM}; }}
    #radio-state {{ width: auto; color: {_DIM}; }}
    #radio-stream-divider {{ color: {_ORANGE}; text-align: center; height: 1; margin-bottom: 1; }}
    #radio-eq {{ height: 1; }}
    #radio-vol {{ height: 1; margin-bottom: 1; }}
    #radio-playlist-header {{ color: {_ORANGE}; height: 1; }}
    #radio-list {{ height: auto; background: {_PANEL_BG}; border: none; }}
    #radio-help {{ dock: bottom; height: 1; margin: 0 0 1 2; }}
    """

    def __init__(self, player):
        super().__init__()
        self.player = player
        radio_state = appconfig.load_radio_state()
        self.favorites = set(radio_state["favorites"])
        self.shuffle = radio_state["shuffle"]
        self.repeat = radio_state["repeat"]
        self._shine_position = 0
        self._last_paused = False
        self._last_vis_levels = [0.0] * radio.NUM_BANDS

    def compose(self) -> ComposeResult:
        with Horizontal(id="radio-topbar"):
            prompt = Text()
            prompt.append("$ ", style="bold white")
            prompt.append("cliamp ", style=f"bold {_TEAL}")
            prompt.append("--provider radio", style=_DIM)
            yield Static(prompt, id="radio-prompt")
            self.topbar_state = Static("■  tty1", id="radio-tty")
            yield self.topbar_state
        with VerticalScroll(id="radio-panel"):
            with Horizontal(id="radio-hero"):
                self.shine_widget = Static(_render_shine_art(0), id="radio-shine")
                yield self.shine_widget
                self.visualizer = Static(_render_visualizer(self._last_vis_levels), id="radio-visualizer")
                yield self.visualizer
            with Horizontal(id="radio-title-row"):
                yield Static("C L I A M P", id="radio-cliamp")
                yield Static("[Playlist]", id="radio-playlist-tag")
            self.now_line = Static("♪ Nothing playing -- Enter to start a station", id="radio-now")
            yield self.now_line
            with Horizontal(id="radio-time-row"):
                self.time_line = Static("--:-- / LIVE", id="radio-time")
                yield self.time_line
                self.state_line = Static("■ Stopped", id="radio-state")
                yield self.state_line
            self.stream_divider = Static("", id="radio-stream-divider")
            yield self.stream_divider
            self.eq_line = Static("", id="radio-eq")
            yield self.eq_line
            self.vol_line = Static("", id="radio-vol")
            yield self.vol_line
            self.playlist_header = Static("", id="radio-playlist-header")
            yield self.playlist_header
            self.list_view = ListView(id="radio-list")
            yield self.list_view
        self.help_line = Static("", id="radio-help")
        yield self.help_line

    def on_mount(self):
        self._rebuild_list()
        self._render_help()
        self.list_view.focus()
        self._update_status()
        self._redraw_visualizer()
        # Two separate intervals, deliberately different rates: the visualizer
        # only reads an in-memory, lock-protected list (radio.get_levels()) --
        # cheap, redrawn fast for smoothness. The status line queries mpv over
        # its IPC socket (is_paused/get_position/get_volume) -- a real, if
        # normally fast, blocking round trip on Textual's own event-loop
        # thread, so it runs far less often to keep worst-case UI stall low
        # if mpv is ever slow to respond.
        self.set_interval(1 / 12, self._redraw_visualizer)
        self.set_interval(0.5, self._update_status)
        self.set_interval(_SHINE_TICK, self._advance_shine)

    def _advance_shine(self):
        """Only actually sweeps while a station is genuinely playing --
        freezes in place on pause (mirrors the same "freeze, don't reset"
        interaction the earlier vinyl-spin attempt used), and parks back at
        position 0 once nothing is playing at all. Reads self._last_paused
        (cached by _update_status) rather than querying the mpv IPC socket
        itself -- see that method's comment for why this ticks too often for
        a fresh round trip each time."""
        if not self.player.is_playing():
            self._shine_position = 0
        elif not self._last_paused:
            self._shine_position = (self._shine_position + _SHINE_STEP) % _SHINE_WIDTH
        self.shine_widget.update(_render_shine_art(self._shine_position))

    def _render_help(self):
        text = Text()
        for key, label in (
            ("↑↓", "Scroll"), ("Enter", "Play"), ("Spc", "Pause"), ("f", "Fav"),
            ("s", "Shuffle"), ("r", "Repeat"), ("n/p", "Station"), ("+/-", "Vol"), ("q", "Back"),
        ):
            text.append(_key_chip(key, label))
        self.help_line.update(text)

    def _save_state(self):
        appconfig.save_radio_state({
            "favorites": sorted(self.favorites),
            "last_station": self.player.current_station() and self.player.station_index,
            "shuffle": self.shuffle,
            "repeat": self.repeat,
        })

    def _rebuild_list(self):
        prev_index = self.list_view.index or 0
        self.list_view.clear()
        current = self.player.station_index
        items = [
            StationItem(i, station, i == current, i in self.favorites)
            for i, station in enumerate(radio.STATIONS)
        ]
        self.list_view.extend(items)
        self.list_view.index = min(prev_index, len(items) - 1)
        self._render_playlist_header()

    def _render_playlist_header(self):
        current = self.player.station_index
        position = f"{current + 1}/{len(radio.STATIONS)}" if current is not None else f"-/{len(radio.STATIONS)}"
        shuffle_label = "On" if self.shuffle else "Off"
        text = Text("▸─ Playlist ── ", style=_ORANGE)
        text.append(f"[Shuffle: {shuffle_label}] ", style="white")
        text.append(f"[Repeat: {self.repeat.title()}] ", style="white")
        text.append(f"[{position}] ", style="white")
        text.append("──", style=_ORANGE)
        self.playlist_header.update(text)

    def _update_status(self):
        station = self.player.current_station()
        playing = self.player.is_playing()
        paused = playing and self.player.is_paused()
        # Cached for _advance_shine, which ticks at 1 / _SHINE_TICK (20/sec) --
        # querying mpv's IPC socket for is_paused() that often, instead of
        # reusing this slower (0.5/sec) poll's already-fetched value, would
        # reintroduce the same "frequent blocking round trip on Textual's
        # event-loop thread" concern this method's own docstring note above
        # already exists to avoid.
        self._last_paused = paused

        if station is None:
            self.now_line.update("♪ Nothing playing -- Enter to start a station")
            self.time_line.update("--:-- / LIVE")
            self.state_line.update(Text("■ Stopped  (Enter to play)", style=_DIM))
            self.stream_divider.update(Text("── STOPPED ──", style=_ORANGE))
            self.topbar_state.update(Text("■  tty1", style=_DIM))
        else:
            self.now_line.update(f"♪ {station['name']}")
            pos = _fmt_mmss(self.player.get_position()) if playing else "--:--"
            self.time_line.update(f"{pos} / LIVE")
            if paused:
                self.state_line.update(Text("❚❚ Paused  (Space to resume)", style=_DIM))
                self.stream_divider.update(Text("── PAUSED ──", style=_ORANGE))
                self.topbar_state.update(Text("❚❚  tty1", style=_TEAL))
            else:
                self.state_line.update(Text("▶ Playing  (Space to pause)", style=_DIM))
                self.stream_divider.update(Text("── STREAMING ──", style=_ORANGE))
                self.topbar_state.update(Text("▶  tty1", style=_GREEN_BRIGHT))

        eq = Text("EQ ", style="white")
        eq.append("[Live] ", style=_ORANGE)
        eq.append_text(_eq_bands_text(self.player.get_levels()))
        self.eq_line.update(eq)

        vol = self.player.get_volume() if playing else None
        vol_pct = vol if vol is not None else 100.0
        filled = round(vol_pct / 100 * _VOL_BAR_WIDTH)
        bar = Text("VOL ", style="white")
        bar.append("▮" * filled, style=_GREEN_BRIGHT)
        bar.append("·" * (_VOL_BAR_WIDTH - filled), style=_GREEN_MID)
        bar.append(f" {vol_pct:.0f}%", style=_DIM)
        self.vol_line.update(bar)

    def _redraw_visualizer(self):
        """Same freeze/park-on-pause/stop semantics as _advance_shine above,
        deliberately mirrored: while genuinely playing, pull fresh real
        levels; frozen exactly in place on pause (radio.py's analysis
        ffmpeg process keeps reading the stream independently of mpv's own
        pause state, so without this the visualizer would otherwise keep
        moving to audio the user can no longer hear); parked at an explicit
        rest baseline once stopped, rather than trusting RadioPlayer's own
        internal level reset to land at the same moment this redraws."""
        if not self.player.is_playing():
            self._last_vis_levels = [0.0] * radio.NUM_BANDS
        elif not self._last_paused:
            self._last_vis_levels = self.player.get_levels()
        self.visualizer.update(_render_visualizer(self._last_vis_levels))

    # -- actions --------------------------------------------------------

    def action_close(self):
        self.app.pop_screen()

    def on_list_view_selected(self, event: ListView.Selected):
        """Enter on the focused list -- NOT a Screen-level "enter" binding:
        ListView itself already binds Enter (to emit this exact message) and
        a focused widget's own bindings take priority over an ancestor
        Screen's for the same key, so a same-named Screen binding here would
        simply never fire (confirmed by hand -- the intended play-on-Enter
        silently did nothing until this was the actual handler)."""
        if isinstance(event.item, StationItem):
            self._play(event.item.station_index)

    def _play(self, index):
        try:
            self.player.start(index)
        except RuntimeError as exc:
            self.now_line.update(str(exc))
            return
        self._rebuild_list()
        self._save_state()
        self._update_status()

    def action_toggle_pause(self):
        if self.player.is_playing():
            self.player.toggle_pause()
            self._update_status()

    def action_toggle_favorite(self):
        if self.list_view.index is None:
            return
        item = self.list_view.children[self.list_view.index]
        if not isinstance(item, StationItem):
            return
        if item.station_index in self.favorites:
            self.favorites.discard(item.station_index)
        else:
            self.favorites.add(item.station_index)
        self._rebuild_list()
        self._save_state()

    def action_toggle_shuffle(self):
        self.shuffle = not self.shuffle
        self._render_playlist_header()
        self._save_state()

    def action_cycle_repeat(self):
        current = _REPEAT_CYCLE.index(self.repeat)
        self.repeat = _REPEAT_CYCLE[(current + 1) % len(_REPEAT_CYCLE)]
        self._render_playlist_header()
        self._save_state()

    def action_next_station(self):
        self._advance(1)

    def action_prev_station(self):
        self._advance(-1)

    def action_volume_up(self):
        if self.player.is_playing():
            self.player.set_volume(5)
            self._update_status()

    def action_volume_down(self):
        if self.player.is_playing():
            self.player.set_volume(-5)
            self._update_status()

    def _advance(self, direction):
        if self.repeat == "one" or self.player.station_index is None:
            return
        n = len(radio.STATIONS)
        if self.shuffle:
            import random
            choices = [i for i in range(n) if i != self.player.station_index]
            next_index = random.choice(choices) if choices else self.player.station_index
        else:
            next_index = (self.player.station_index + direction) % n
        self._play(next_index)
