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

Persistent memory across sessions: unlike Claude Code (which already has its own
CLAUDE.md / session-resume story), a bare `ollama run` REPL has zero memory beyond one
session's context window -- exit it and the next `ollama run` starts from nothing.
~/.mtdo/memory.md is a plain, user-curated file (same idea as CLAUDE.md: "here's what
you should always know about me") that ollama_run_command() loads as a real system
prompt on every Ollama session, via Ollama's own Modelfile mechanism -- verified by
hand in a real pty that `ollama create` reuses the base model's existing weight layers
(~0.07s, no meaningful extra disk) and that the resulting model's SYSTEM prompt
actually takes effect on chat responses. web_chat.py loads the same file as each API's
own system-prompt parameter for the same reason. Nothing auto-writes to this file --
a bare Ollama/API chat has no file-write tools to keep it updated itself, so it's
meant to be curated by hand (or by asking Claude Code, which *does* have file access,
to help draft or refresh it).
"""
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import time

CHOICE_PATH = os.path.expanduser("~/.mtdo/ai_backend_choice.json")
MEMORY_PATH = os.path.expanduser("~/.mtdo/memory.md")
_MEMORY_MODELFILE_PATH = os.path.expanduser("~/.mtdo/.ollama_memory_modelfile")

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


def supports_raw_multiline_paste(command):
    """Whether this backend's own CLI reads its terminal input in raw mode -- where
    every keystroke reaches the app immediately and the app itself decides whether an
    embedded newline means "insert a line" or "submit" -- as opposed to canonical/
    line-buffered mode, where the kernel's own tty driver releases each raw "\\n" to
    the reader as its own line the instant it arrives, regardless of what the app
    wants. Used by app.TodoApp._prime_ai_context_if_needed and
    practice_lab_panel.PracticeLabPanel.action_evaluate_code to decide whether a
    message with real line breaks (readable, and necessary for code -- flattening
    would break Python indentation, e.g.) is safe to send, or whether it needs
    PtyPanel.send_text's flatten=True instead to avoid fragmenting into several
    premature partial sends.

    Only Claude Code's Ink-based UI is known to behave this way. A local Ollama
    model's REPL and the API-chat REPL (web_chat.py, a plain input() loop) are both
    canonical/line-buffered."""
    return command == "claude"


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
    poll, not a longer guess.

    If ~/.mtdo/memory.md exists and has content, runs a derived model with it baked
    in as a real system prompt (see module docstring) instead of the bare model --
    falls back to the bare model if building that derived model fails for any reason,
    so a memory.md problem never blocks starting a session at all."""
    run_target = f"ollama run {shlex.quote(model)}"
    memory = _read_memory()
    if memory:
        tag = _memory_model_tag(model)
        if _write_memory_modelfile(model, memory):
            run_target = (
                f"ollama create {shlex.quote(tag)} -f {shlex.quote(_MEMORY_MODELFILE_PATH)} "
                f">/dev/null 2>&1 && ollama run {shlex.quote(tag)} || {run_target}"
            )
    script = (
        "(ollama serve >/dev/null 2>&1 &) ; "
        "for i in $(seq 1 20); do ollama list >/dev/null 2>&1 && break; sleep 0.25; done ; "
        f"{run_target}"
    )
    return f"bash -lc {shlex.quote(script)}"


def _read_memory():
    try:
        with open(MEMORY_PATH) as f:
            content = f.read().strip()
    except OSError:
        return None
    return content or None


def _memory_model_tag(model):
    return f"mtdo-mem-{re.sub(r'[^a-zA-Z0-9_.-]', '-', model)}"


def _write_memory_modelfile(model, memory):
    try:
        os.makedirs(os.path.dirname(_MEMORY_MODELFILE_PATH), exist_ok=True)
        with open(_MEMORY_MODELFILE_PATH, "w") as f:
            f.write(f'FROM {model}\nSYSTEM """{memory}"""\n')
        return True
    except OSError:
        return False


def _pulled_ollama_models():
    """Whatever's already pulled -- and, unlike a single `ollama list` call, actually
    correct when the background service happens to be stopped (e.g. after a reboot,
    or it was never left running). `ollama list` needs the service up to answer at
    all; without this, the picker would silently claim nothing was pulled and offer
    Gemma 3 4B as a fresh "downloads on first run" pick even after it's already on
    disk -- confirmed by hand: stop the service, and a model that's genuinely pulled
    disappears from this list until something starts it again."""
    models = _try_ollama_list()
    if models is not None:
        return models
    try:
        subprocess.Popen(
            ["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return []
    for _ in range(8):
        time.sleep(0.25)
        models = _try_ollama_list()
        if models is not None:
            return models
    return []


def _try_ollama_list():
    """Returns the pulled-model list, or None specifically when the service isn't
    reachable -- distinct from an empty list, which means reachable but genuinely
    nothing pulled yet."""
    try:
        result = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
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
