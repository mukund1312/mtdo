"""Picks which AI backends the assistant panel (claude_panel.py) can offer, so the
user is never stuck without one just because they don't have Claude Code installed.
list_available() is checked fresh every time C opens the picker (not cached at import
time, since installing something or exporting a key shouldn't require restarting
mtdo), and includes -- in preference order:

1. the `claude` CLI (Claude Code), if it's on PATH
2. every local model Ollama already has pulled, via `ollama run <model>`
3. Gemma 3 4B via Ollama specifically, always offered if Ollama is on PATH even when
   not pulled yet -- `ollama run` pulls on first use automatically, so picking it is
   genuinely zero extra setup ("out of the box"), just a first-run download. Every
   Ollama command here (this one included) first makes sure `ollama serve` is
   actually running before the `run` -- it does NOT reliably auto-start on its own
   (confirmed by hand: a fresh install leaves nothing listening, and `ollama run`
   just fails with "could not connect to a running Ollama instance").
4. a picker entry to run *any* Ollama model by name (not just Gemma) -- prompts for
   a model tag via a text prompt, see app.OnboardingScreen's sibling,
   PROMPT_CUSTOM_OLLAMA_MODEL below and TodoApp.action_toggle_claude's on_choice
5. if Ollama itself isn't installed, an option that installs it via Ollama's own
   official install script (ollama.com/install.sh -- works on macOS and Linux, no
   Homebrew dependency) and starts it, then runs Gemma 3 4B -- so a user with
   *nothing* installed still never has to leave the terminal. Not offered at all on
   an unsupported OS (Windows has no shell one-liner for this, and mtdo's AI panel
   itself needs a POSIX pty, so it can't run there regardless -- see
   list_available()'s platform check).
6. Claude, ChatGPT, and Gemini via their own APIs (web_chat.py) -- always offered
   regardless of whether a key is already set, since web_chat.py prompts for one
   (and offers to remember it) the first time it's actually picked, and now also
   offers to install its own SDK dependency automatically if that's missing too.
   This is the "browser-free" option: real access to any of the big three without
   ever opening a browser tab, which is the whole point of keeping the user inside
   the terminal.

detect() returns list_available()'s first entry for callers that don't want to
prompt (e.g. ClaudePanel.start() with no pinned command), or (None,
NOTHING_CONFIGURED_MESSAGE) in the (now very unlikely) case nothing is usable at all.
"""
import json
import os
import platform
import shlex
import shutil
import subprocess

CHOICE_PATH = os.path.expanduser("~/.mtdo/ai_backend_choice.json")

GEMMA_MODEL = "gemma3:4b"

# Sentinel "command" for the picker's "run any Ollama model" entry -- app.py's
# on_choice special-cases this instead of starting a session directly, since it needs
# to prompt for a model name first. Not a real shell command, never reaches Popen.
PROMPT_CUSTOM_OLLAMA_MODEL = "__prompt_custom_ollama_model__"

NOTHING_CONFIGURED_MESSAGE = (
    "No AI backend found. Set up one of:\n\n"
    "  Claude Code -- npm install -g @anthropic-ai/claude-code\n"
    "  Ollama      -- install from ollama.com, then: ollama pull <model>\n"
    "  API chat    -- pick Claude/ChatGPT/Gemini (API) and enter a key when asked\n\n"
    "Press C to try again after setting one up."
)


def list_available():
    """Every backend offered right now, most-preferred first. Each entry is
    (command, label). Local/installed backends come before API ones, since those
    need no key and (for Claude Code and already-pulled Ollama models) no network
    wait either."""
    options = []
    if shutil.which("claude"):
        options.append(("claude", "Claude Code"))

    has_ollama = shutil.which("ollama") is not None
    pulled = _pulled_ollama_models() if has_ollama else []
    for model in pulled:
        options.append((ollama_run_command(model), f"Ollama ({model})"))

    if has_ollama:
        if GEMMA_MODEL not in pulled:
            options.append((
                ollama_run_command(GEMMA_MODEL),
                f"Ollama ({GEMMA_MODEL}) -- downloads on first run",
            ))
        options.append((PROMPT_CUSTOM_OLLAMA_MODEL, "Ollama -- run any model (type the name)"))
    elif platform.system() in ("Darwin", "Linux"):
        options.append((_install_ollama_command(), "Install Ollama + gemma3:4b (first-time setup)"))
    # else: no shell one-liner for this on Windows, and the AI panel itself needs a
    # POSIX pty anyway -- nothing usable to offer here, so nothing is added.

    options.append(("python3 -m mtdo.web_chat anthropic", "Claude (API)"))
    options.append(("python3 -m mtdo.web_chat openai", "ChatGPT (API)"))
    options.append(("python3 -m mtdo.web_chat gemini", "Gemini (API)"))

    return options


def detect():
    """The single best available backend, for callers that don't want to prompt --
    e.g. ClaudePanel.start() when no explicit command was pinned. Returns (command,
    label), or (None, NOTHING_CONFIGURED_MESSAGE) if nothing is usable. Skips the
    "run any model" prompt entry since there's no one here to answer a prompt."""
    for command, label in list_available():
        if command != PROMPT_CUSTOM_OLLAMA_MODEL:
            return command, label
    return None, NOTHING_CONFIGURED_MESSAGE


def save_choice(command, label):
    """Remembers the last backend picked in AIBackendPickScreen, so next time it's
    pre-selected in the list instead of always defaulting back to the top -- picking
    is still shown every time (in case you want to switch), it just takes one Enter
    press to repeat your last choice instead of navigating to it again."""
    try:
        os.makedirs(os.path.dirname(CHOICE_PATH), exist_ok=True)
        with open(CHOICE_PATH, "w") as f:
            json.dump({"command": command, "label": label}, f)
    except OSError:
        pass


def load_choice():
    """Returns the remembered (command, label), or None if nothing's been picked yet
    or the file's unreadable."""
    try:
        with open(CHOICE_PATH) as f:
            data = json.load(f)
        return data["command"], data["label"]
    except (OSError, ValueError, KeyError):
        return None


def ollama_run_command(model):
    """Wraps `ollama run <model>` so the background service is actually up first.
    `ollama run` does NOT reliably auto-start it (verified by hand: right after a
    fresh install, nothing is listening, and a plain `ollama run` just fails with
    "could not connect to a running Ollama instance"). Starting it again when one's
    already running is harmless and fast -- it just fails to bind the port and exits,
    which is why this is safe to prepend unconditionally rather than trying to first
    detect whether a server's already up.

    Actively polls readiness (`ollama list` succeeding) for up to 5s instead of a
    blind sleep -- a fixed sleep is a race: fine most of the time, but a slower first
    boot (cold disk cache, GPU detection) can still lose it, and the fix must be a
    poll, not a longer guess."""
    script = (
        "(ollama serve >/dev/null 2>&1 &) ; "
        "for i in $(seq 1 20); do ollama list >/dev/null 2>&1 && break; sleep 0.25; done ; "
        f"ollama run {shlex.quote(model)}"
    )
    return f"bash -lc {shlex.quote(script)}"


def _pulled_ollama_models():
    try:
        result = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    if result.returncode != 0:
        return []
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return [line.split()[0] for line in lines[1:]]  # skip the header row


def _install_ollama_command():
    """Ollama's own official install script (not Homebrew) -- works the same way on
    macOS and Linux, so this isn't tied to any one package manager. Starts the
    service and runs Gemma 3 4B right after, so this works as one shot from a
    completely clean machine."""
    script = (
        "curl -fsSL https://ollama.com/install.sh | sh && "
        "(ollama serve >/dev/null 2>&1 &) && "
        "sleep 2 && "
        f"ollama run {GEMMA_MODEL}"
    )
    return f"bash -lc {shlex.quote(script)}"
