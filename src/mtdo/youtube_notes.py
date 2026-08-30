"""YouTube video -> AI-generated notes + question bank, for the Knowledge Vault's
"from YouTube" action (see app.py's VaultScreen.action_add_from_youtube).

Scope, deliberately: captioned videos only. Extracting existing captions (via
yt-dlp, no video/audio download) is fast and needs no extra system dependency
beyond the yt-dlp package itself. Transcribing uncaptioned video with Whisper is a
real feature too, but a much heavier one (ffmpeg, a local model, real CPU/GPU
time) -- left out of this first pass rather than half-built in. A video with no
captions at all fails with a clear message instead of silently doing nothing.

fetch_transcript() and generate_notes_and_quiz() are split so the caller can show
"fetching transcript..." and "writing notes..." as two distinct status updates
instead of one opaque wait -- see VaultScreen's worker thread.
"""
import re
import urllib.parse
import urllib.request

from . import ai_ask

try:
    import yt_dlp
    YT_DLP_AVAILABLE = True
except ImportError:
    YT_DLP_AVAILABLE = False

NOT_INSTALLED_MESSAGE = (
    "yt-dlp isn't installed -- run `pip install yt-dlp` (or `pip install -e '.[youtube]'` "
    "from a clone of mtdo), then try again."
)

# Prefer real (human-written) captions over auto-generated ones when both exist --
# auto captions are lower quality and more prone to repeated/overlapping lines.
_PREFERRED_LANGS = ["en", "en-US", "en-GB"]

# gh69: no cap on transcript length used to mean a long video (e.g. a multi-hour
# lecture) could plausibly exceed the active backend's context window --
# especially a small local Ollama model -- either erroring out or silently
# returning notes based on a truncated/garbled prompt, with nothing telling the
# user their transcript was too long. ~92 minutes of speech at the 130
# words/minute estimate generate_notes_and_quiz already uses below -- long
# enough for nearly any real video, short enough to stay safely inside even a
# modest local model's context. Longer transcripts are truncated (kept from
# the start, not rejected outright) so a very long video's beginning still
# gets useful notes, and the returned notes say plainly that this happened.
_MAX_TRANSCRIPT_WORDS = 12000

# gh73: yt-dlp itself supports far more than YouTube, so a pasted non-YouTube
# URL in what's presented as a YouTube-specific Vault feature could either
# "succeed" against an unrelated site or fail with a generic yt-dlp error --
# neither is a clear "that's not a YouTube URL" message. Checked by hostname,
# not a stricter path/ID-shape regex, since valid YouTube URLs come in enough
# shapes (watch?v=, youtu.be/<id>, /shorts/<id>, /live/<id>, music.youtube.com)
# that a hostname allowlist is the more robust, less guessable-wrong check.
_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}


def _is_youtube_url(url):
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in _YOUTUBE_HOSTS


def fetch_transcript(url):
    """Returns (title, transcript_text, None) on success, or (None, None, error)
    on failure. Never raises -- every real failure mode (bad URL, private/deleted
    video, no captions in any language) is meant to surface as a plain-language
    error the UI can just display, not a traceback."""
    if not YT_DLP_AVAILABLE:
        return None, None, NOT_INSTALLED_MESSAGE
    if not _is_youtube_url(url):
        return None, None, "That doesn't look like a YouTube URL -- paste a youtube.com or youtu.be link."

    ydl_opts = {"skip_download": True, "quiet": True, "no_warnings": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        return None, None, f"Couldn't read that video: {e}"

    title = info.get("title") or "Untitled video"
    caption_url = _pick_caption_url(info)
    if caption_url is None:
        return None, None, (
            f'"{title}" has no captions (manual or auto-generated) in any language mtdo could find. '
            "Only captioned videos are supported right now."
        )

    try:
        req = urllib.request.Request(caption_url, headers={"User-Agent": "Mozilla/5.0"})
        raw_vtt = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, None, f"Found captions but couldn't download them: {e}"

    transcript = _vtt_to_text(raw_vtt)
    if not transcript.strip():
        return None, None, f'"{title}"\'s captions came back empty.'
    return title, transcript, None


def _pick_caption_url(info):
    """Manual captions first, then auto-generated -- in each, our preferred
    languages first, then whatever's first available. Always asks for the vtt
    format specifically (simplest to parse, and every track yt-dlp reports offers
    it as one of the conversion options)."""
    for track_map in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        if not track_map:
            continue
        langs = [l for l in _PREFERRED_LANGS if l in track_map]
        langs += [l for l in track_map if l not in langs]
        for lang in langs:
            for entry in track_map[lang]:
                if entry.get("ext") == "vtt":
                    return entry["url"]
    return None


_TIMESTAMP_LINE = re.compile(r"^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->")
_CUE_INDEX_LINE = re.compile(r"^\d+$")
_INLINE_TAG = re.compile(r"<[^>]+>")


def _vtt_to_text(raw_vtt):
    """Strips WEBVTT header/metadata, cue-timing lines, cue-index lines, and
    inline markup (auto-captions embed word-level <00:00:01.200> timing tags),
    then merges the remaining lines with _merge_overlap.

    Auto-generated captions are commonly delivered as a rolling "karaoke" window
    -- each new cue re-includes the tail of the previous one, e.g. cue 1 =
    "so today we're going to talk", cue 2 = "so today we're going to talk about
    recursion". These aren't consecutive *duplicate* lines (cue 2 is longer, not
    identical), so naive dedup doesn't catch it -- confirmed by hand against a
    real video's auto-captions, which is what this is actually for."""
    lines_out = []
    for raw_line in raw_vtt.splitlines():
        line = _INLINE_TAG.sub("", raw_line).strip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            continue
        if _TIMESTAMP_LINE.match(line) or _CUE_INDEX_LINE.match(line):
            continue
        lines_out.append(line)
    text = _merge_overlap(lines_out)
    return re.sub(r"\s+", " ", text).strip()


_MIN_OVERLAP_WORDS = 2  # below this, treat a match as coincidence (e.g. one cue
                        # ending in "the" and the next starting with an unrelated
                        # word), not real rolling-caption duplication


def _merge_overlap(lines):
    """Stitches consecutive lines together, dropping the repeated portion
    whenever one line's start overlaps with the previous line's end -- the
    general form of the rolling-caption problem described above (a plain
    duplicate line is just the special case where the whole line overlaps).

    Matches at the *word* level, not character level: an earlier character-level
    version corrupted ordinary multi-line cue text like "...in front of the" /
    "elephants" into "...in front of thelephants" by matching the single shared
    "e" at that word boundary. Words avoid that whole class of false positive."""
    words = []
    for line in lines:
        line_words = line.split()
        if not line_words:
            continue
        if not words:
            words = line_words
            continue
        max_check = min(len(words), len(line_words))
        overlap_len = 0
        for k in range(max_check, 0, -1):
            if k >= _MIN_OVERLAP_WORDS and words[-k:] == line_words[:k]:
                overlap_len = k
                break
        words.extend(line_words[overlap_len:])
    return " ".join(words)


_NOTES_PROMPT = """You're a study coach turning a video transcript into material someone can \
actually learn from, instead of re-watching a {minutes}-minute video.

Video title: {title}

Produce exactly two sections, in this format, with these markers on their own \
lines and nothing outside them (no preamble, no closing remarks):

===NOTES===
Concise study notes covering the real content -- key concepts, how they fit \
together, anything a viewer would want to remember. Use short paragraphs or \
bullet points. Skip filler, intros, sponsor reads, and anything not actually \
about the subject.

===QUESTIONS===
5-8 active-recall questions that test understanding of the material (not just \
"what did the video say" trivia) -- the kind a real quiz or flashcard deck would \
use. One per line, numbered. Do not include the answers.

Transcript:
{transcript}
"""


def generate_notes_and_quiz(title, transcript):
    """Returns (notes_and_quiz_markdown, None) on success, or (None, error) on
    failure. Calls ai_ask.ask() -- a real, possibly slow network/subprocess call,
    so (like every other ai_ask caller in this app) this must be invoked from a
    background thread, never the main/UI thread."""
    words = transcript.split()
    truncated = len(words) > _MAX_TRANSCRIPT_WORDS
    if truncated:
        transcript = " ".join(words[:_MAX_TRANSCRIPT_WORDS])
    # A rough word-count-based minute estimate is enough context for the prompt;
    # exact video duration isn't worth threading through for this.
    minutes = max(1, len(transcript.split()) // 130)
    prompt = _NOTES_PROMPT.format(title=title, minutes=minutes, transcript=transcript)
    answer, error = ai_ask.ask(prompt, timeout=120)
    if not answer:
        return None, error or "The AI backend returned nothing."
    body = _format_vault_body(title, answer)
    if truncated:
        body += (
            f"\n\n---\n*Note: this video's transcript was long enough that only the "
            f"first ~{minutes} minutes were used to generate these notes/quiz.*"
        )
    return body, None


def _format_vault_body(title, ai_answer):
    body = ai_answer.strip().replace("===NOTES===", "## Notes").replace("===QUESTIONS===", "## Questions")
    return f"# {title}\n\n{body}".strip()
