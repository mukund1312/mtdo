# MTDO

A terminal task board built around a 4-column Kanban (Backlog / Todo / In Progress / Done),
with a Pomodoro timer, streaks + a GitHub-style heatmap, a Focus Mode, a Career CRM for job
applications, a Knowledge Vault for notes, and Spotify playback controls -- all keyboard-first,
no mouse required.

Everything about *what* you're tracking -- your categories, your curriculum, your goal -- lives
in a config file, not in code. The app ships with a demo config (the plan I actually built this
for) so you can see it working immediately, but it's yours to edit or replace from day one.

## Install

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

## Spotify + animation panel

The Spotify panel is a display-first now-playing box -- song, artist, progress bar -- with
a looping terminal animation (adapted from [anifetch](https://github.com/Notenlish/anifetch)'s
ffmpeg + chafa pipeline) filling the rest of the panel below the progress bar. No icon
buttons or volume bar clutter the display; playback keys still work, they're just not
drawn as a row of icons anymore:

- `m` play/pause, `[` / `]` prev/next, `+` / `-` volume, `P` paste a link and play it
- `g` -- start/stop the animation (plays a default clip on first use if one's set up, see below)
- `G` -- pick a different clip, or add a new one from a file path (optionally set its
  framerate and chafa symbol style, e.g. `-r 20 -ca "--symbols wide --fg-only"` --
  anifetch-style flags. `-W`/`-H`/`-s`/`--sound` are recognized but ignored: render size
  always fits the live panel rather than a fixed resolution, and audio always comes from
  Spotify itself, never extracted from the clip)
- Entering Focus Mode (`f`) auto-starts the animation if nothing's already playing

The animation re-renders itself (from cache when possible) whenever the panel resizes, so
it keeps filling the available space as the terminal grows or shrinks. In Focus Mode the
kanban board, Stats, and Calendar all hide, so Spotify gets the whole right column. In the
normal view, Stats and Calendar are capped to a scrollable ~8 rows each (scroll to see the
rest) so Spotify still gets real room instead of being squeezed to nothing.

This repo doesn't ship a default clip (the original example video's license/source is
unclear, so it stays out of version control). First time you clone: press `G`, choose
"Add new from a file path...", and point it at any video or gif you own. It's copied into
`~/.mtdo/animations/` and every clip you add after that shows up in the `G` picker.

Requires two external CLI tools (not Python packages):

```bash
brew install chafa ffmpeg       # macOS
sudo apt install chafa ffmpeg   # Debian/Ubuntu
```

Without them, pressing `g` shows a toast telling you what's missing instead of failing
silently. Your own clips (any of `.mp4 .mov .avi .mkv .webm .flv .wmv .m4v .gif`) live in
`~/.mtdo/animations/`; rendered frames are cached in `~/.mtdo/anim_cache/` keyed by
(file, size, fps), so replaying the same clip is instant after the first render.

## Platform notes

Core features (Kanban, Pomodoro, streaks, Career CRM, Knowledge Vault) are plain Python/Textual
and should run anywhere Textual runs. Spotify controls use AppleScript, so they're **macOS +
Spotify desktop app only** -- they no-op safely everywhere else. The Animation panel needs
`chafa` + `ffmpeg` on PATH (see above); it degrades to a clear error toast without them.

## Data

State lives in `~/.mtdo/state.json`, config in `~/.mtdo/config.yaml`, daily reports in
`~/.mtdo/reports/`. Nothing leaves your machine.
