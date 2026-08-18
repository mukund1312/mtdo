"""Picks which AI backend the assistant panel (claude_panel.py) should run, so the
user is never stuck without one just because they don't have Claude Code installed.
Priority order, checked fresh on every start() (not cached at import time, since
installing something or exporting a key shouldn't require restarting mtdo):

1. the `claude` CLI (Claude Code), if it's on PATH
2. a local model via `ollama run <model>`, if Ollama is installed and has at least one
   model already pulled (we pick the first one `ollama list` reports rather than
   guessing a name and triggering a slow, unexpected download)
3. a minimal built-in chat REPL against the Anthropic or OpenAI API (web_chat.py), if
   an API key is set in the environment -- so a user with neither Claude Code nor a
   local model still gets an assistant without ever tabbing out to a browser
4. otherwise, a clear message explaining what to install or set

detect() returns (command, label) for the best available backend, or (None, message)
when nothing is usable -- the caller shows `message` directly in the pane.
"""
import os
import shutil
import subprocess


NOTHING_CONFIGURED_MESSAGE = (
    "No AI backend found. Set up one of:\n\n"
    "  Claude Code -- npm install -g @anthropic-ai/claude-code\n"
    "  Ollama      -- install from ollama.com, then: ollama pull <model>\n"
    "  API chat    -- export ANTHROPIC_API_KEY=... or OPENAI_API_KEY=...\n\n"
    "Press C to try again after setting one up."
)


def list_available():
    """Every backend that's actually usable right now, most-preferred first -- what
    the backend-picker modal shows so the user chooses among real options instead of
    a wishlist. Each entry is (command, label)."""
    options = []
    if shutil.which("claude"):
        options.append(("claude", "Claude Code"))

    model = _first_ollama_model()
    if model:
        options.append((f"ollama run {model}", f"Ollama ({model})"))

    if os.environ.get("ANTHROPIC_API_KEY"):
        options.append(("python3 -m mtdo.web_chat anthropic", "Claude (API)"))
    if os.environ.get("OPENAI_API_KEY"):
        options.append(("python3 -m mtdo.web_chat openai", "GPT (API)"))

    return options


def detect():
    """The single best available backend, for callers that don't want to prompt --
    e.g. ClaudePanel.start() when no explicit command was pinned. Returns (command,
    label), or (None, NOTHING_CONFIGURED_MESSAGE) if nothing is usable."""
    options = list_available()
    if options:
        return options[0]
    return None, NOTHING_CONFIGURED_MESSAGE


def _first_ollama_model():
    if not shutil.which("ollama"):
        return None
    try:
        result = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) < 2:  # header only (or nothing) -- no model pulled yet
        return None
    return lines[1].split()[0]
