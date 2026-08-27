# MTDO

**A terminal practice system for interview and skill prep.** Track what you're studying
today, get coached through it instead of just checking it off, and see proof you're
actually improving -- all in one keyboard-driven session, without switching between a
to-do app, a study guide, an AI chat tab, and a code sandbox.

It does that with a 4-column Kanban (Backlog / Todo / In Progress / Done), a Pomodoro
timer, streaks + a GitHub-style heatmap, a Focus Mode, a Career CRM for job
applications, a Knowledge Vault for notes, a Learning Coach panel that surfaces study and
interview-prep guidance (and, for DSA/SQL, generates an actual practice problem) for
whatever task is in progress, an embedded AI assistant panel that already knows what
you're working on, a real Practice Lab (Python/Java/C/C++/SQL, real execution, a real
sqlite3 database), and now-playing music controls -- all keyboard-first, no mouse required.

There's no animation/video panel and never will be; screen space goes to coaching
content instead -- every panel here exists to help you learn, retain, and get
interview-ready faster, not to entertain you.

Everything about *what* you're tracking -- your categories, your curriculum, your goal -- lives
in a config file, not in code. The app ships with a demo config (the plan I actually built this
for) so you can see it working immediately, but it's yours to edit or replace from day one.

## Install

```bash
git clone https://github.com/mukund1312/mtdo.git
cd mtdo
./install.sh
```

`install.sh` checks everything mtdo actually needs (git, Python 3.10+, sqlite3, and on
macOS, Xcode Command Line Tools) up front, with a specific fix for whichever one is
missing, instead of failing partway through a pip install with no clear next step. It
sets up its own virtual environment (`.venv`) rather than touching your system Python.

Already have everything installed and would rather do it by hand?

```bash
pip install -e .          # from a clone of this repo
```

## Quickstart

```bash
mtdo          # first run auto-creates ~/.mtdo/config.yaml from the demo plan
```

Press `?` inside the app any time for the full keybindings cheat sheet.

Want to start from an empty template instead of the demo plan?

```bash
mtdo init --fresh
mtdo
```

## Personalizing it -- the easy way

You don't have to hand-write YAML. Generate a goals JSON, fill it in yourself or hand it to an
AI assistant along with a description of your goals, then import it:

```bash
mtdo template goals.json     # writes a filled-out example schema
# ... edit goals.json yourself, or paste it + your goals to an AI assistant and ask it to fill it in ...
mtdo import goals.json       # builds/updates config.yaml from it
```

`import` is safe to run repeatedly and safe to run after you've already been using the app for
weeks:

- New categories in the JSON get added.
- An existing category's `curriculum` gets **appended to**, never replaced or reordered -- this
  is how you hand it "week 2" once week 1 runs out, without touching anything you've already
  tracked. See "What happens when curriculum runs out" below for exactly how that works.
- It never opens `state.json`. Importing new goals cannot lose or alter your tracked history --
  only which categories exist and what *future* days look like.

## Personalizing it -- by hand

Edit `~/.mtdo/config.yaml` directly instead, if you'd rather. Each category looks like:

```yaml
categories:
  dsa:
    label: "DSA / Problem Solving"
    days: [0, 1, 2, 3, 4, 5]      # 0=Monday .. 6=Sunday, which days this category shows up
    min_blocks: 4                 # floor for "complete" -- 0 means no floor
    addable: true                 # can you add cards beyond the prefill?
    deletable: true
    notes: true
    score_weight: 25              # contribution to the daily 0-100 score
    curriculum:                   # optional: pre-filled content, one list per scheduled day,
      - ["Two Sum", "Contains Duplicate", "Valid Anagram"]   # consumed in order from day 1
      - ["Group Anagrams", "Top K Frequent Elements"]
```

Categories with `fixed_labels` instead of `curriculum` (like a daily gym check-in) always show
the same fixed set of cards rather than sequencing through content:

```yaml
  gym:
    label: "Gym"
    fixed_labels: ["Cardio + gym"]
    addable: false
    deletable: false
```

`plan_start: null` (the default) means your curriculum sequencing locks to the first day *you*
open the app -- not a date baked into the demo file.

## What happens when curriculum runs out

Each category has its own cursor into its `curriculum` list, stored in `state.json` (not in the
config). The cursor only advances on a day where it actually had real content to hand out. If
you open the app on a day past the end of your curriculum, that day just gets empty slots (you
fill them in yourself) -- the cursor does **not** move.

So: if you're a day late importing "week 2", nothing is lost. The first day you open the app
*after* importing picks up exactly where the cursor left off -- the content you were "owed" on
the day curriculum ran dry is still there waiting, not skipped.

The one thing that's genuinely final: once a day is opened for the first time, its block *text*
is written into `state.json` and frozen -- editing the config afterward never rewrites a day
that's already been registered. You can still edit that day's text yourself by hand in the app
(`t` on a card) if you want to.

## Where your data lives, and what's safe to touch

| File | What it is | Editing/replacing it |
|---|---|---|
| `~/.mtdo/config.yaml` | The plan: categories, curriculum, goal, weights | Always safe. This is "what future days look like," never your history. |
| `~/.mtdo/state.json` | Your actual history: every day's cards and their status, streaks, focus time, Career CRM, Knowledge Vault notes | This *is* your tracked progress. Back it up before hand-editing it; nothing else in this app writes to it except through the normal task actions. |
| `~/.mtdo/reports/` | Auto-saved daily text reports | Just an export, safe to delete/ignore. |

`mtdo import` and hand-editing `config.yaml` only ever touch the config file. Neither one
opens, reads, or writes `state.json` -- so your streaks, done/in-progress cards, Career CRM
pipeline, and notes are never at risk from changing your plan. The only category-deletion
caveat: if you remove a category from config.yaml that has history in `state.json`, that old
data isn't deleted -- it just stops showing up (the app no longer knows the category exists).
Add the category name back and it reappears.

## Command line

```bash
mtdo init [--fresh] [--force]   # (re)create the config
mtdo template [goals.json]       # write a goals JSON template to fill in (by hand or via AI)
mtdo import <goals.json>         # build/update config.yaml from a filled-in goals JSON
mtdo status                      # print today's basket as markdown -- for scripting or
                                       # wiring into an AI assistant's tool-use
mtdo done <task_id> [date]       # mark a task done by ID (IDs come from `status`)
```

## Focus Mode

Press `f` to hide the board and weekly stats and give the whole screen to deep work: your
Active Task, Pomodoro (auto-starts a 45/10 work/break split), Music, the Learning Coach,
and an optional row alongside the Coach for the embedded **AI Assistant panel** (`C`) and
the **Practice Lab** (`Shift+T`). `f` again to leave; nothing running gets stopped, it's
just hidden until you come back.

## Learning Coach panel

MTDO isn't for entertainment -- there's no animation, GIF, or video panel, and there never
will be. The space that would occupy goes to a Learning Coach panel instead: whenever a
card is `in_progress`, this panel shows coaching content for it --

- **Focus On** -- what to understand before moving on
- **Ask Yourself** -- active-recall questions (topic-appropriate: DSA gets brute-force/
  complexity/edge-case questions, Backend gets scaling/failure-mode questions, Database
  gets query/index/execution-plan questions, System Design gets the requirements-through-
  tradeoffs checklist)
- **Interview Check** -- what an interviewer would actually ask
- **Common Mistakes**, **Mental Models**, and a rotating **Pro Tip**
- A closing prompt: could you explain this for 5 minutes without notes right now?

Any curriculum task in `goals.json` can carry this content directly (`focus_points`,
`questions`, `interview_questions`, `mistakes`, `tips`, `mental_models`, ... -- see
`goals_template.json`'s `rule_9`), which is what an AI generating your curriculum should
fill in. Tasks without that metadata still get a full, topic-appropriate coaching
framework automatically (set a category's `topic_type` to `dsa`, `backend`, `database`, or
`system_design` in `goals.json` to pick which one) -- so the coach never has nothing to say.

**DSA and SQL (`database`) fields get more than guidance in Focus Mode:** instead of the
content above, the Coach has the AI generate an actual practice problem for the task -- a
LeetCode-style problem for DSA, or a plain-English SQL question answerable against the
Practice Lab's own sample database for `database`. It won't hand you the solution, only
the problem. Every 10 minutes spent on it, a popup offers the next hint (never forced,
never the answer outright) from a set generated alongside the problem. The regular
coaching content above unlocks once the card is marked done, for review.

## AI Assistant panel

Press `C` in Focus Mode to start (or refocus) a real, embedded terminal session --
[Claude Code](https://claude.com/product/claude-code) if it's installed, else a local
[Ollama](https://ollama.com) model, else a minimal API-key chat against
Claude/ChatGPT/Gemini directly, your pick from a menu the first time. Double-tap `Escape`
(or `F2`) to release keyboard focus back to mtdo without ending the session.

It doesn't start cold: the moment a session starts, or you switch which task is active,
mtdo sends it the active task's text, field, and the generated DSA/SQL problem if there is
one -- typed into the same visible chat, nothing hidden or out-of-band -- so you never have
to explain your own problem to it. It's also told, once, how to teach: don't hand over the
answer immediately, ask guiding questions first, teach from problem to need to solution
rather than definition-first, and use progressive hints (a nudge, then a technique, then
the approach, only the full answer as a last resort) -- adapted to whatever you're actually
working on (DSA/SQL/backend/system design).

## Practice Lab

An optional column next to the Learning Coach and AI panel in Focus Mode (`Shift+T` to
show/hide it) -- a real language picker (Python / Java / C / C++ / SQL), a code editor,
and real execution, nothing simulated:

- `Ctrl+R` -- run the code (or query) and see real output and real run time.
- `Ctrl+B` -- for code, an AI time/space complexity estimate; for SQL, a **real**
  `EXPLAIN QUERY PLAN` plus a real row count from sqlite3 instead (Big-O doesn't mean much
  for a query the way it does for an algorithm).
- `Ctrl+A` -- send the current code to the AI panel next to it for a review: not a verdict
  or a fix, a nudge toward wherever your approach is going wrong.
- `Ctrl+N` -- reset the current language's buffer to its starter template.

SQL runs against a real SQLite database, seeded once at `~/.mtdo/practice/sample.db` with
sample `departments` / `employees` / `orders` tables (deliberate duplicate salaries and
employees with zero orders, so interview-style questions like "2nd highest salary per
department" are actually meaningful) -- `sqlite3` is the real engine, not something mtdo
reimplements.

## Radio

`R` opens a retro-terminal internet-radio session -- a genuine built-in player (11 curated
stations across lofi/synthwave/house/dubstep/drum & bass/vaporwave/pop/etc.), separate from
the "Now Playing" panel above (that one only ever remote-controls something *already*
playing externally; this one streams and decodes its own audio). `↑↓` to browse, `Enter` to
play, `Space` to pause/resume, `f` to favorite, `s`/`r` for shuffle/repeat, `n`/`p` for
next/previous station, `q`/`Escape` to leave -- closing the screen doesn't stop playback,
it's a session you can dip in and out of. The visualizer is genuinely audio-reactive (real
per-band levels off the actual stream, not a canned animation). Favorites/shuffle/repeat
persist in `~/.mtdo/radio_state.json`. Needs [mpv](https://mpv.io) (`brew install mpv`) --
mtdo tells you plainly if it's missing rather than showing a broken screen.

## Platform notes

Core features (Kanban, Pomodoro, streaks, Career CRM, Knowledge Vault, Learning Coach) are
plain Python/Textual and should run anywhere Textual runs.

Music controls use [nowplaying-cli](https://github.com/kirtan-shah/nowplaying-cli)
(`brew install nowplaying-cli`) if it's installed, which works for whatever app currently
owns "Now Playing" on macOS -- YouTube Music, Apple Music, Spotify, anything. Without it,
they fall back to Spotify-specific AppleScript. Either way, **macOS only** -- they no-op
safely everywhere else.

The Radio (`R`) needs [mpv](https://mpv.io) (`brew install mpv`) for actual playback, and
uses `ffmpeg` (usually already present, e.g. via `brew install ffmpeg`) purely to compute
the visualizer's real audio levels -- a silent, separate analysis pass that never touches
what's actually being played. This one isn't macOS-specific; it should work anywhere both
tools are installed.

The AI panel needs at least one backend actually available: the `claude` CLI installed, a
running [Ollama](https://ollama.com) with a model pulled, or an API key for
Anthropic/OpenAI/Gemini (it'll offer to install the SDK and prompt for the key the first
time you pick that option). The Practice Lab's Run/Ctrl+B need the relevant tool on PATH
per language -- `python3`; `javac`+`java`; `gcc`/`g++`; `sqlite3` for SQL (preinstalled on
most Mac/Linux systems, otherwise `brew install sqlite3` / `apt install sqlite3`) -- and
tells you plainly what's missing rather than failing silently if one isn't.

## Data

State lives in `~/.mtdo/state.json`, config in `~/.mtdo/config.yaml`, daily reports in
`~/.mtdo/reports/`. The board, streaks, Career CRM, and Knowledge Vault never leave your
machine. The one exception is the AI Assistant panel: if you pick an API-based backend
(Claude/ChatGPT/Gemini) or Claude Code, whatever you send it -- including the task context
mtdo primes it with -- goes to that provider, same as using their CLI/API directly. A local
Ollama model keeps everything on-machine.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture (in particular, the
`core.py`/`app.py` split), local setup, and how to submit a change.
