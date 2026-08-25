# Contributing to mtdo

Thanks for looking at this. mtdo is a config-driven terminal task board built with
Python and [Textual](https://textual.textualize.io/) -- see the [README](README.md)
for what it actually does. This doc is about the codebase itself: how it's laid out,
and how to get a change from your machine into `main`.

## Architecture: `core.py` vs `app.py`

The split that matters most in this codebase is between the task/state model and the
terminal UI that presents it:

- **`src/mtdo/core.py`** is the model: categories, cards ("blocks"), daily state,
  streaks, backlog carry-forward, weekly reports. It has **no dependency on Textual,
  or on any UI at all** -- it's plain Python operating on plain dicts, configured once
  via `core.configure(cfg)` and then queried/mutated through its own functions.
- **`src/mtdo/app.py`** is the Textual TUI: the Kanban board, Focus Mode, the panels,
  key bindings, `TodoApp` itself. It imports `core.py` (as `tc`) and renders what's in
  it -- it never duplicates model logic that belongs in `core.py`.

Why this matters in practice: `core.py` being UI-agnostic is what lets `cli.py`'s
scriptable subcommands (`mtdo status`, `mtdo done <id>`, ...) operate on the exact same
task model as the interactive TUI, with zero Textual involved -- these commands exist
specifically so an external tool (a script, an AI assistant) can read or update your
board without opening the app. If task logic creeps into `app.py` instead of `core.py`,
that second consumer silently stops working, and the logic becomes untestable without a
running Textual app. When you add or change task/state behavior, ask "does this belong
in the model, or is it actually about how something is drawn?" -- and put it in
`core.py` unless it's genuinely the latter.

The same principle extends to config: **`goals.json` is the single source of truth**
(`config.py`'s "Option A" mode). `config.yaml` is *derived* from it via
`config.goals_to_config()` and then loaded into `core.py` via `core.configure()` --
don't hand-edit `config.yaml` in code paths that assume goals.json is authoritative,
and don't add a second place that computes category/state derivations `core.py`
already owns.

## Module map

A quick orientation to the rest of `src/mtdo/`, roughly grouped:

- `cli.py` -- the `mtdo` command: `init`, `template`, `import`, `run`, `status`,
  `done`, `snapshots`, `snapshot-diff`, `profile`.
- `config.py` -- where `~/.mtdo`'s files live, loading/validation (`ConfigError` for a
  malformed goals.json/config.yaml -- see its module docstring), goals.json <->
  config.yaml conversion.
- `profiles.py` -- multiple isolated profiles (separate goals/state per profile,
  optional Fernet+PBKDF2 encryption at rest with a one-time recovery code).
- `coaching.py` -- Learning Coach content: static topic frameworks, AI-generated
  DSA/SQL problems and coaching text, the tutor-framework prompt for the embedded AI
  panel.
- `claude_panel.py` / `pty_panel.py` -- the embedded live AI terminal (a real pty +
  `pyte` for terminal emulation).
- `practice_lab_panel.py` / `code_runner.py` -- the in-app code editor/runner
  (Python/Java/C/C++/SQL) and its sandboxing (see `code_runner.py`'s module docstring
  for exactly what protection is and isn't provided, and on which platforms).
- `ai_backend.py` / `ai_ask.py` / `web_chat.py` -- AI backend detection (Claude Code /
  Ollama / API keys) and both interactive and one-shot query paths.
- `music.py` -- now-playing display/controls (nowplaying-cli when installed, for
  whatever's currently playing anywhere on macOS; Spotify-specific AppleScript as a
  fallback).
- `dashboard.py`, `bug_sync.py`, `bug_log.py`, `status_sync.py`, `sandbox_entry.py`,
  `instance_store.py` -- internal tooling for this project's own maintainers (a
  sandboxed test-instance system and a private bug-tracking workflow). Not part of the
  app a user installs; you generally won't need to touch these for a feature or
  bug-fix contribution.

## Setting up

```bash
git clone https://github.com/mukund1312/mtdo.git
cd mtdo
python3 -m pip install -e ".[dev]"
```

Run it:

```bash
mtdo
```

**Never run the app or its CLI against real `~/.mtdo` data while developing against a
change you're not sure about.** Use the sandboxed entry point instead -- a completely
separate `~/.mtdo-sandbox` data directory that's safe to reset or break:

```bash
mtdo-sandbox              # picker: resume a saved test instance, or start a fresh one
mtdo-sandbox reset        # wipes ~/.mtdo-sandbox back to nothing
```

Every `mtdo` subcommand works the same way under `mtdo-sandbox` (`mtdo-sandbox status`,
`mtdo-sandbox profile ...`, etc.) against the sandboxed directory instead of your real
one.

## Running tests

```bash
python3 -m pytest tests/
```

Tests run against a throwaway `MTDO_HOME` (set up once in `tests/conftest.py`), never
your real `~/.mtdo`. CI (`.github/workflows/ci.yml`) runs the same suite on every pull
request, on Linux -- if you're on macOS and your change touches something
platform-specific (see `code_runner.py`'s sandboxing, for example), don't assume a
green run locally means it's green everywhere; say so in your PR if you can't verify
the other platform yourself.

## Code conventions

- **Docstrings explain *why*, not *what*.** A non-obvious constraint, a past bug a
  piece of code exists to prevent, a design tradeoff -- not a restatement of what the
  code already says in its own names. Match this style in anything you add.
- **Minimal diffs.** No premature abstraction, no speculative config for hypothetical
  future needs. Three similar lines beats a shared helper nobody asked for yet.
- **Don't add error handling for scenarios that can't happen.** Trust internal
  invariants; validate at real boundaries (user input, external processes, file I/O),
  not everywhere defensively.

## Submitting a change

1. Fork the repo and create a branch off `main`.
2. Make your change, following the conventions above.
3. Run the test suite locally; add tests for new behavior or a bug fix where it's
   practical to do so (see `tests/` for the existing style -- most bug-fix tests here
   reproduce the exact real failure first, not just a synthetic version of it).
4. Open a pull request against `main`. Describe what changed and why, and how you
   verified it (a passing test suite is good; if you exercised something live -- ran
   the app, tried the actual failure scenario -- say so, since some behavior here
   genuinely can't be caught by tests alone, e.g. anything platform- or
   terminal-specific).
5. CI needs to pass. A maintainer will review from there -- please don't merge your own
   PR.

For anything bigger than a small fix -- a new panel, a change to the config schema, a
new subcommand -- consider opening an issue first to talk through the approach before
investing time in the implementation.

## Reporting bugs / requesting features

Use this repo's [GitHub Issues](https://github.com/mukund1312/mtdo/issues). Include
what you expected, what actually happened, and your platform (mtdo is developed on
macOS; some features, like Spotify/now-playing controls and the Practice Lab's
sandboxing, are macOS-specific by nature and behave differently, or not at all, on
Linux).
