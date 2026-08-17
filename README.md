# MTDO

A terminal task board built around a 4-column Kanban (Backlog / Todo / In Progress / Done),
with a Pomodoro timer, streaks + a GitHub-style heatmap, a Focus Mode, a Career CRM for job
applications, a Knowledge Vault for notes, a Learning Coach panel that surfaces study and
interview-prep guidance for whatever task is in progress, and Spotify playback controls --
all keyboard-first, no mouse required.

MTDO is built for deliberate practice, not entertainment -- every panel exists to help you
learn, retain, and get interview-ready faster. There's no animation/video panel and never
will be; screen space goes to coaching content instead.

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

## Platform notes

Core features (Kanban, Pomodoro, streaks, Career CRM, Knowledge Vault, Learning Coach) are
plain Python/Textual and should run anywhere Textual runs. Spotify controls use
AppleScript, so they're **macOS + Spotify desktop app only** -- they no-op safely
everywhere else.

## Data

State lives in `~/.mtdo/state.json`, config in `~/.mtdo/config.yaml`, daily reports in
`~/.mtdo/reports/`. Nothing leaves your machine.
