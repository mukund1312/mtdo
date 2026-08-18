"""Picks which AI backends the assistant panel (claude_panel.py) can offer, so the
user is never stuck without one just because they don't have Claude Code installed.
list_available() is checked fresh every time C opens the picker (not cached at import
time, since installing something or exporting a key shouldn't require restarting
mtdo), and includes -- in preference order:

1. the `claude` CLI (Claude Code), if it's on PATH
2. every local model Ollama already has pulled, via `ollama run <model>`
3. Gemma 3 4B via Ollama specifically, always offered if Ollama is on PATH even when
   not pulled yet -- `ollama run` pulls on first use automatically, so picking it is
   genuinely zero extra setup ("out of the box"), just a first-run download
4. if Ollama itself isn't installed but Homebrew is (this is macOS), an option that
   installs Ollama and starts it, then runs Gemma 3 4B -- so a user with *nothing*
   still never has to leave the terminal to get a local model running
5. Claude, GPT, and Gemini via their own APIs (web_chat.py) -- always offered
   regardless of whether a key is already set, since web_chat.py prompts for one
   (and offers to remember it) the first time it's actually picked. This is the
   "browser-free" option: real access to any of the big three without ever opening a
   browser tab, which is the whole point of keeping the user inside the terminal.

detect() returns list_available()'s first entry for callers that don't want to
prompt (e.g. ClaudePanel.start() with no pinned command), or (None,
NOTHING_CONFIGURED_MESSAGE) in the (now very unlikely) case nothing is usable at all.
"""
import json
import os
import shlex
import shutil
import subprocess

CHOICE_PATH = os.path.expanduser("~/.mtdo/ai_backend_choice.json")

GEMMA_MODEL = "gemma3:4b"

NOTHING_CONFIGURED_MESSAGE = (
    "No AI backend found. Set up one of:\n\n"
    "  Claude Code -- npm install -g @anthropic-ai/claude-code\n"
    "  Ollama      -- install from ollama.com, then: ollama pull <model>\n"
    "  API chat    -- pick Claude/GPT/Gemini (API) and enter a key when asked\n\n"
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

    pulled = _pulled_ollama_models()
    for model in pulled:
        options.append((f"ollama run {model}", f"Ollama ({model})"))

    if shutil.which("ollama"):
        if GEMMA_MODEL not in pulled:
            options.append((
                f"ollama run {GEMMA_MODEL}",
                f"Ollama ({GEMMA_MODEL}) -- downloads on first run",
            ))
    elif shutil.which("brew"):
        options.append((_install_ollama_command(), "Install Ollama + gemma3:4b (first-time setup)"))

    options.append(("python3 -m mtdo.web_chat anthropic", "Claude (API)"))
    options.append(("python3 -m mtdo.web_chat openai", "GPT (API)"))
    options.append(("python3 -m mtdo.web_chat gemini", "Gemini (API)"))

    return options


def detect():
    """The single best available backend, for callers that don't want to prompt --
    e.g. ClaudePanel.start() when no explicit command was pinned. Returns (command,
    label), or (None, NOTHING_CONFIGURED_MESSAGE) if nothing is usable."""
    options = list_available()
    if options:
        return options[0]
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


def _pulled_ollama_models():
    if not shutil.which("ollama"):
        return []
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
    """`ollama run` normally auto-starts Ollama's background service, but right after
    a fresh `brew install` nothing is running yet -- explicitly start it and give it a
    moment before the first `run`, so this works as one shot from a completely clean
    machine instead of needing to be picked twice."""
    script = (
        "brew install ollama && "
        "(ollama serve >/dev/null 2>&1 &) && "
        "sleep 2 && "
        f"ollama run {GEMMA_MODEL}"
    )
    return f"bash -lc {shlex.quote(script)}"
