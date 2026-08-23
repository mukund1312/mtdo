# mtdo -- Session Progress Log

Newest entries first. Read this before starting work; append before finishing.
See `~/.claude/agents/mtdo-dev.md` for the full project onboarding/architecture doc.

**Workflow note (2026-08-22 onward):** changes go on a `feature/mu/UAT-<description>`
branch + PR into main, not straight to main -- see the Git workflow section at the bottom.
Add each session's PROGRESS.md entry to the same branch as the code it describes.

---

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/3) -- first-run setup wizard, no more silent demo data

Real bugs from testing: a fresh install silently populated itself with demo/example
categories instead of starting empty, and there was no first-run flow asking who the user
is or what they want out of the app. Investigated before writing anything -- a lot of this
already existed (`mtdo init --fresh`, the `g`-triggered `plan_wizard.py` Q&A-to-AI-prompt
flow, `mtdo template`/`mtdo import`) just not wired up as the automatic first-run path.

**Did:**
- `cli._run_first_run_wizard()`: plain `input()` prompts (name, then what you're using
  this for), run once, before any config exists at all -- deliberately CLI-level, not a
  Textual screen, since it decides which config to bootstrap *before* `TodoApp` is
  constructed (its board layout is built once from whatever config existed at that
  point -- doing this as an in-app screen afterward would mean hot-reloading a running
  app's whole category structure for a one-time event, which nothing in this codebase
  does outside of goals.json's own change-polling).
- New "Just exploring the app" persona (`plan_wizard.PERSONAS`) -- loading the demo plan
  is now an explicit choice, not the silent default. Real personas start genuinely empty
  and route into the existing AI-prompt-building flow, unchanged.
- `config.get_user_name()`/`set_user_name()` -- plain marker file (same pattern as
  `has_onboarded()`), shown in the header once set. The in-app `g` wizard also gained the
  new persona (a no-op toast there -- nothing to load over an already-running session).

**Tested (real tmux pty):** fresh instance -> wizard triggers automatically; "Just
exploring" -> demo config loaded, all 5 options rendered correctly; a real persona (job
switch) -> all 11 questions asked/answered correctly, prompt built and saved with accurate
content, empty board loaded after. `get_user_name()`/`set_user_name()` round-trip verified
directly. Real `~/.mtdo` untouched throughout.

**Known follow-up, not blocking:** the header (where the name would show) doesn't appear
to render in ANY tmux pty capture across this whole project's testing history -- looks
like a pre-existing, unrelated display issue, not something this PR introduced. Worth its
own investigation later.

---

## 2026-08-22 (update 3) -- fix: real data loss from an app freeze + hard-killed terminal

User hit a real bug while testing (an unspecified freeze -- app stopped responding) and
had to force-kill the terminal to get out. Every bug they'd logged with `B` in that
session was lost -- gone for good, nothing recoverable, since the old design only made a
bug durable when the *instance* got saved (an explicit Save, or the SIGHUP/SIGTERM
autosave fallback). A true freeze can prevent even that fallback from ever running --
Python only services a signal handler between bytecode instructions on the main thread, so
a genuinely hung main thread may never reach it, and a straight `kill -9`/force-quit can't
be caught by any handler at all, by OS design. This was a real architectural gap, not a
one-off -- the fix had to make bug capture itself durable, not the safety net around it.

**Did:**
- **`bug_log.py` rewritten**: `BUGS_PATH` is now a FIXED path,
  `~/.mtdo-sandbox/bugs.json`, no longer derived from `config.APP_DIR`/`MTDO_HOME` (which
  points at the current session's *scratch* copy -- the thing that can vanish on a hard
  kill). `add_bug()` writes synchronously the instant `B` is pressed, completely
  independent of the current instance's scratch dir, save/discard flow, or the
  SIGHUP/SIGTERM autosave -- nothing after that write can lose the bug. Each bug now
  records its own `instance` field (from `MTDO_INSTANCE_NAME`/`MTDO_INSTANCE_SLUG`, falls
  back to `"unsaved session"`) so "which instance was this found in" isn't lost even
  though storage is no longer instance-scoped. `list_bugs(instance=...)` filters by that
  field instead of by which directory happened to hold the file.
- **`bug_sync.sync_pending()`** no longer takes a required instance label -- reads each
  bug's own `instance` field, and can optionally filter to just one via `instance=`.
- **`sandbox_entry.py`**: `mtdo-sandbox bugs` now lists everything ever logged (or
  `mtdo-sandbox bugs <instance-name>` to filter) straight from the fixed file -- no more
  `MTDO_HOME` pointing at a specific saved instance's directory, since there's only ever
  one bugs.json now. `mtdo-sandbox bugs sync [instance-name]` matches.

**Tested (the actual failure scenario, not a milder stand-in):** real tmux pty, pressed
`B` and logged a bug, then found the live process PID and ran `kill -KILL` on it directly
-- the one signal that cannot be caught or blocked by any handler, strictly worse than
what the user hit (their freeze at least might have eventually responded to SIGHUP; SIGKILL
never gives any code a chance to run). Confirmed the bug was still intact on disk
afterward, byte for byte, with the process fully gone. `mtdo-sandbox bugs` and `bugs sync`
both worked correctly against it afterward (filed as a real GitHub issue). Cleaned up the
test bug/issue/orphaned scratch dirs after. Real `~/.mtdo` mtimes confirmed untouched.

**Not fixed / can't be:** the bugs the user actually lost before this fix existed are
unrecoverable -- nothing was ever written to durable storage for them, so there's no
backup to restore from. They'll need to re-log them under the new (now durable) version.
Also not investigated: what actually caused the freeze in the first place -- the user
didn't say what they were doing when it happened, and the freeze itself was never
described in enough detail to reproduce. Worth asking about if it comes up again.

---

## 2026-08-22 (update 2) -- shared dashboard: status lines + bug board as an Artifact

Added the last two pieces from the plan: a "what am I working on" status line per person,
and a visual dashboard combining that with the bug scoreboard, published somewhere both
Mukund and Janhvi can open. Also onboarded Janhvi as a real second collaborator this
session: invited to both `mukund1312/mtdo-bugs` (bug tracker) and `mukund1312/mtdo` (code,
after she'd initially set up a fork -- added as a direct collaborator instead so
`git push origin main` from her machine goes to the real repo, matching the existing
single-repo workflow rather than switching to fork+PR).

**Did:**
- **`status_sync.py`** (new): `set_status(text)` / `get_all_status()`, storing one
  `status.json` in the private `mukund1312/mtdo-bugs` repo via the GitHub Contents API
  (`gh api ... -X PUT`, base64-encoded content, tracking the file's `sha` so updates don't
  clobber each other) -- no local clone of mtdo-bugs needed, it's issues+this one small
  file, not a codebase. Keyed by whoever's `gh` identity ran the command
  (`bug_sync.whoami()`), not a manually-typed name.
- **`mtdo-sandbox working-on "..."`** -- deliberately *not* named `status`: `mtdo status`
  is already a real subcommand (prints today's board) and `mtdo-sandbox status` would have
  silently shadowed it. Caught this before shipping it, not after.
- **Real "fixed by" attribution, not guessed:** `gh issue list --json` has no `closedBy`
  field (confirmed by actually calling it and reading the error's field list, not assumed).
  Fixed via `bug_sync.mark_fixed_and_close`: now runs `gh issue edit --add-assignee <closer>`
  right before closing, so a closed issue's `assignees[0]` is real, queryable attribution.
  "Found by" attribution was already free -- `issue.author.login`, since each person
  authenticates `gh` as themselves.
- **`dashboard.py`** (new) + **`mtdo-sandbox dashboard`**: pulls `bug_sync.list_all()` +
  `status_sync.get_all_status()`, tallies found/fixed per person, and renders a static
  HTML page (design: extends the existing docs/index.html brand -- same dark terminal
  palette/IBM Plex Mono, paired with IBM Plex Sans for headings -- as a real dashboard
  layout instead of the fake-terminal gimmick, since this one is scanned/operated, not
  read) to `~/.mtdo-sandbox/dashboard.html`.
- **Published as a Claude Artifact**, not a live-fetching page: the Artifact CSP blocks a
  published page from ever calling GitHub's API itself, and embedding a token in a
  shareable link would leak private-repo access to anyone holding the URL -- confirmed
  this was a hard constraint (loaded the artifact-capabilities skill) before designing
  around it, rather than promising a live dashboard and failing to deliver one. Refreshing
  means: run `mtdo-sandbox dashboard` again, then republish the same file path/URL from a
  Claude Code session -- documented on the page itself, not just here.

**Tested (real, against the real tracker repo):** posted a real status via `working-on`,
confirmed `status.json` landed correctly in `mukund1312/mtdo-bugs` via the Contents API;
ran a full bug through `add_bug` -> `sync_pending` -> `mark_fixed_and_close` and confirmed
on GitHub that the closed issue actually got assigned to `mukund1312` (attribution
verified, not assumed); generated the dashboard and confirmed the rendered numbers matched
(3 found / 3 fixed / 0 open across 3 test issues, with the per-person tally correctly
showing only 1 of those 3 as "fixed by mukund1312" since the other 2 were closed by an
earlier test run before assignee-tracking existed -- exactly the expected result, not a
bug). Deleted the 3 fabricated test issues afterward so the tracker starts clean; kept the
real status line since it was accurate. Published to
`https://claude.ai/code/artifact/fc424e3e-1eb0-4c81-b025-7c35b893f89e` (private -- user
needs to share it with Janhvi via the page's share menu, not something this session should
do unilaterally). Real `~/.mtdo` mtimes confirmed untouched throughout.

**Next / open items:**
- User needs to share the dashboard Artifact URL with Janhvi.
- To refresh the dashboard later: `mtdo-sandbox dashboard`, then republish
  `~/.mtdo-sandbox/dashboard.html` to the same Artifact URL above (pass `url=` if doing it
  from a different conversation than this one).
- Janhvi still needs to confirm her local clone now points at `mukund1312/mtdo` directly
  (not her fork) -- see the instructions given to her this session.

---

## 2026-08-22 (update) -- cross-machine bug sync + scoreboard via a private tracker repo

User works from two Macs and wanted a *shared* view of bugs found/fixed across both --
local `bugs.json` (previous entry below) can't do that on its own since `~/.mtdo-sandbox`
is deliberately never git-synced. Discussed options; user chose a private tracker repo
over making the main `mtdo` repo private (mtdo stays public/open-source as already set up)
or a manual folder-sync approach.

**Did:**
- **Created `mukund1312/mtdo-bugs`** (private GitHub repo, issues only, no code) via
  `gh repo create`, with a `sandbox-bug` label. Explicitly confirmed with the user before
  creating anything on their GitHub account.
- **`bug_sync.py`** (new): `sync_pending(instance_label)` files every bug in the current
  instance that doesn't have a `github_issue` yet as one GitHub issue (title prefixed with
  the instance name, labeled `sandbox-bug`), then stamps the returned issue number back
  onto the local bug via `bug_log.set_github_issue` -- makes sync idempotent, safe to
  re-run. `mark_fixed_and_close(id, note)` is now *the* function to call when fixing a
  bug: marks it fixed locally (via `bug_log.mark_fixed`) and, if it has a linked issue,
  closes it on GitHub with the fix note as the closing comment. `board()` returns
  (open, closed) counts across everything synced -- the found/fixed scoreboard.
- **`bug_log.py`**: `add_bug` now also stores `github_issue: None`; added
  `set_github_issue(id, number)`.
- **`sandbox_entry.py`**: `mtdo-sandbox bugs sync <slug>` and `mtdo-sandbox bugs board`
  (alongside the existing `mtdo-sandbox bugs <slug>` viewer, which now also shows each
  bug's `gh#<n>` if synced).

**Tested (real, against the real private repo -- not mocked):** captured 2 bugs live in a
fresh sandbox instance via `B`, saved it, ran `bugs sync` -- both landed as real GitHub
issues on `mukund1312/mtdo-bugs` (verified via `gh issue list`); re-ran sync and confirmed
"Nothing new to sync" (no duplicates); called `mark_fixed_and_close` on one -- confirmed
the GitHub issue actually closed (`gh issue view` -> CLOSED) *and* the local bug list
showed `[x] ... (gh#1)` with the fix note; `mtdo-sandbox bugs board` correctly reported
`Found: 2  Fixed: 1  Open: 1`. Cleaned up the test issues/instance afterward. Real
`~/.mtdo` mtimes confirmed untouched throughout, as always.

**Next / open items:**
- The second Mac needs `gh auth login` done once (separate from git's own auth) before
  `bugs sync`/`bugs board` will work there -- not yet confirmed done.
- When asked to "fix the bugs in <instance>" going forward: use
  `bug_sync.mark_fixed_and_close(id, note)`, not `bug_log.mark_fixed` directly -- the
  former is a strict superset (closes the GitHub issue too, when there is one) and is
  always safe to call even for bugs that were never synced.

---

## 2026-08-22 -- per-instance bug log (`B` to capture, `mtdo-sandbox bugs` to review)

User wanted a way to note bugs the moment they're found while testing in `mtdo-sandbox`,
without breaking flow, that travels with the instance and gives Claude Code a clear
pending/fixed worklist to act on later.

**Did:**
- **`bug_log.py`** (new): `bugs.json` stored via the same `appconfig.APP_DIR` pattern as
  every other data file (goals.json, state.json, ...) -- means it automatically rides
  along whenever `instance_store.py` copies or deletes an instance's directory, no
  special-casing needed. `add_bug(text)` appends `{id, text, status: "pending", found_at,
  fixed_at, fix_note}`; `mark_fixed(id, fix_note)` is what a later Claude Code session
  calls after actually fixing something.
- **`app.py`**: `B` is bound to `action_report_bug` (pushes the existing `TextPromptScreen`
  for a quick one-line description, toasts "Bug #N logged -- keep testing" on save) --
  but only added to `BINDINGS` at all when `SANDBOX_INSTANCE_MODE` is on, so it doesn't
  show up or do anything under real `mtdo` (this is a UAT/dev-only tool, not a real-data
  feature).
- **`mtdo-sandbox bugs <slug>`**: prints a saved instance's bug list (pending vs fixed,
  with fix notes) without needing to relaunch the TUI -- `mtdo-sandbox bugs` with no slug
  lists saved instances as a reminder of valid names.

**Bug found and fixed during this work (real, not hypothetical):** the `bugs` subcommand
initially imported `bug_log` (which derives `BUGS_PATH` from `config.APP_DIR` at import
time) *before* setting `MTDO_HOME` to the target instance's dir -- same "must set env var
before first import" rule documented elsewhere in this file, just missed here. Result: it
silently read/wrote the wrong path and always reported "No bugs logged" even when
bugs.json had real entries. Fixed by moving the `bug_log` import to after the `MTDO_HOME`
assignment; re-verified against a real saved instance with two logged bugs.

**Tested (real tmux pty + real CLI invocation):** captured two bugs live via `B` while
testing a fresh instance, confirmed the toast and the log's actual content; saved the
instance and confirmed `bugs.json` was included alongside the usual files; ran
`mtdo-sandbox bugs <slug>` and saw both entries; called `bug_log.mark_fixed()` directly
(simulating what a fix-it session would do) and confirmed the CLI viewer reflected the
fixed status and fix note correctly. Real `~/.mtdo` mtimes confirmed untouched.

**Next / open items:**
- None outstanding. When the user asks to "fix the bugs in <instance>": read
  `~/.mtdo-sandbox/instances/<slug>/bugs.json` (or run `mtdo-sandbox bugs <slug>`), fix
  each pending issue in the source, then call `bug_log.mark_fixed(id, "what was done")`
  with `MTDO_HOME` set to that instance's dir (see the one-liner used to verify this
  above) -- don't hand-edit bugs.json's JSON directly, the module handles the schema.

---

## 2026-08-21 -- named, disposable `mtdo-sandbox` instances (save/discard on quit)

User wanted more than a single fixed sandbox: the ability to create any number of fresh,
throwaway test sessions, name+describe the ones worth keeping, and re-enter them later --
with an explicit choice to save or discard whenever a session ends.

**Did:**
- **`instance_store.py`** (new): storage layer independent of `MTDO_HOME`/`config.APP_DIR`
  (those now point at a *scratch* copy during a session, not the sandbox root). Layout:
  `~/.mtdo-sandbox/instances/<slug>/` (saved instance data) + `<slug>.meta.json`
  (name/description/created_at/updated_at) sitting next to it, and
  `~/.mtdo-sandbox/.scratch/<tmp>/` (the live working copy for a session that hasn't been
  saved/discarded yet). `save_scratch()` promotes scratch -> instances/<slug> and always
  deletes scratch after; `discard_scratch()` just deletes it; `autosave_scratch()` is the
  fallback used when there was no chance to ask (see below).
- **`sandbox_entry.py`** rewritten: bare `mtdo-sandbox` (no args) now shows a small Textual
  picker app (`+ New instance` plus each saved instance with its name/description/last-used)
  *before* the real app even starts, then points `MTDO_HOME` at a scratch copy (fresh, or a
  copy of the chosen saved instance) and hands off to `cli.main()`. `mtdo-sandbox <subcommand>
  ...` (reset, profile, status, ...) is unchanged -- bypasses the picker entirely and runs
  straight against the flat `~/.mtdo-sandbox` root, exactly as before this feature existed
  (`reset` now naturally wipes `instances/`/`.scratch/` too, since they live under that same
  root -- no cli.py changes needed).
- **`app.py`**: `SANDBOX_INSTANCE_MODE` (env-var gated, always False for real `mtdo`) makes
  `action_quit` push a new `SaveInstanceScreen` modal instead of exiting directly -- Save
  (prompts for name+description if this was a brand-new instance, otherwise just confirms
  the existing name), Discard (deletes the scratch copy, saved instance if any is untouched),
  or Cancel (dismisses the modal, stays in the running app, nothing touched).
- **Abrupt-termination safety net**: if the terminal closes (SIGHUP) or the process is
  killed (SIGTERM) before the quit prompt can ever show, `sandbox_entry.py` autosaves the
  scratch copy silently instead of losing it -- an existing instance keeps its name, a
  never-named one gets `"Unsaved session <timestamp>"`. Uses `os._exit(0)` after the
  autosave (not `sys.exit`) since a signal handler firing mid-await inside Textual's asyncio
  loop unwinds messily through `sys.exit`/SystemExit otherwise (harmless but noisy
  traceback -- fixed after first observing it live).

**Tested (real tmux pty, not just code review):** picker renders and lists saved instances
correctly; "+ New instance" launches a real fresh onboarding flow; quitting a new instance
shows the name+description modal, saves it, and `instances/<slug>/` + its `.meta.json` land
correctly; re-entering that saved instance resumes the exact same board state; quitting an
existing instance shows the confirm-only modal; Cancel returns to the running app (process
stays alive, verified via `ps`); Discard exits cleanly, deletes the scratch dir, and leaves
the saved instance's `.meta.json` byte-identical (md5-verified); a real `kill -TERM` mid-session
autosaved an unnamed new instance under an auto-generated name and left no scratch dir behind,
both before and after the `os._exit` fix (traceback gone the second time). `mtdo-sandbox reset`
still wipes the whole tree and declines on anything but typing `reset`. Real `~/.mtdo`
`goals.json`/`state.json` mtimes confirmed untouched throughout (checked before and after).
One caught-and-fixed bug along the way: `color: grey58` isn't a valid Textual color name
(crashed on launch) -- changed to `grey`.

**Next / open items:**
- None outstanding. If ever wanted: renaming/deleting a saved instance from the picker
  itself (currently only possible by hand-editing/deleting under `~/.mtdo-sandbox/instances/`),
  or an instance-scoped `profile` command (not requested).

---

## 2026-08-20 (update -- separate `mtdo-sandbox` command for testing, isolated from real data)

User asked for a genuine dev/test instance of the app, separate from the real one --
"test app vs PROD app" was the framing. The scratch-`HOME` approach used earlier that
same day for the live AI-coaching test was a one-off workaround, not something usable
day to day, and it had a real downside: overriding `$HOME` also breaks whatever else
reads `$HOME` (it broke the `claude` CLI's own credential lookup during that test). This
needed a real fix, not another one-off.

**Did:**
- **Root cause / fix:** 8 modules independently hardcoded `os.path.expanduser("~/.mtdo/...")`
  for their own path constants (`config.py`, `profiles.py`, `ai_backend.py`, `errorlog.py`,
  `code_runner.py`, `plan_wizard.py`, `web_chat.py`, `pty_panel.py`) -- no single source of
  truth, so nothing could relocate "mtdo's data" as one unit. Changed `config.APP_DIR` to
  `os.environ.get("MTDO_HOME") or os.path.expanduser("~/.mtdo")` (default behavior
  unchanged for every existing install) and refactored the other 7 modules to derive their
  constants from `appconfig.APP_DIR` instead of recomputing their own `expanduser` calls.
- **New `mtdo-sandbox` command** (`sandbox_entry.py`, registered in `pyproject.toml`'s
  `[project.scripts]`): sets `MTDO_HOME=~/.mtdo-sandbox` via `os.environ.setdefault`
  *before* importing `cli` (has to happen first -- those path constants are computed once
  at import time, so setting the env var from inside an already-imported module would be
  too late). Fully separate goals/state/profiles/error.log/memory.md/secrets/practice/
  transcripts from the real `mtdo` -- confirmed nothing is shared.
- **`mtdo reset` / `mtdo-sandbox reset`** (`cli.cmd_reset`): wipes the *current* app dir
  and starts fresh. Hard safety guard -- refuses unconditionally if `appconfig.APP_DIR`
  resolves to the real `~/.mtdo`, regardless of how it was invoked, so this can never
  wipe real data even by mistake. Requires typing `reset` to confirm on top of that.
- Fixed several hardcoded `"~/.mtdo/goals.json"`-style strings in `cli.py`'s user-facing
  profile messages (were misleading under `mtdo-sandbox` -- would claim to be touching
  `~/.mtdo` while actually operating on `~/.mtdo-sandbox`) to display the real resolved
  path with `$HOME` collapsed back to `~`. Also added `_PROG` (derived from
  `os.path.basename(sys.argv[0])`) so "run `mtdo` to start" style messages correctly say
  `mtdo-sandbox` when that's what was actually run -- otherwise a sandbox session would
  tell the user to run plain `mtdo`, which silently switches back to real prod data.
- Reinstalled editable (`--break-system-packages`, same interpreter/reason as the
  `cryptography` install earlier today) so the new console script actually exists on PATH.

**Tested (real, not just code review):** `mtdo-sandbox` launched in a real tmux pty --
confirmed it shows the first-run onboarding walkthrough and the built-in demo config
(generic "Cardio + gym" etc, not Mukund's real curriculum), and that it wrote
`config.yaml`/`state.json`/`error.log`/`onboarded` under `~/.mtdo-sandbox` while real
`~/.mtdo/goals.json` and `config.yaml` mtimes stayed untouched (from Aug 17, before this
session). Verified `mtdo reset` refuses on real prod with the exact guard message, that
`mtdo-sandbox reset` requires typing `reset` and declines on any other input, and that a
correct confirmation actually removes `~/.mtdo-sandbox` while leaving `~/.mtdo` alone.
Verified profile create/list/delete under `mtdo-sandbox` show `~/.mtdo-sandbox/...` and
`mtdo-sandbox ...` in their messages (not `~/.mtdo`/`mtdo`), and that plain `mtdo`
commands still show the real paths/program name unchanged. All 8 touched modules import
cleanly with no circular-import issues; full `python3 -m py_compile` pass.

**Next / open items:**
- None outstanding for this feature. If ever wanted: a `--sandbox` flag as an alternative
  to a separate binary, or extending profile-style isolation *within* the sandbox (not
  requested).

---

## 2026-08-20 (update -- live-tested the AI coaching panel)

Committed and pushed the 2026-08-20 changes below (commit `ab35750`, already synced with
origin/main). Then did what the prior entry flagged as untested: live-verified the
AI-coaching-generation panel.

**How:** Real `claude -p` via a real tmux pty against a scratch `HOME`/goals.json (a bare
"gym" fixed_labels category, no topic_type/coaching_framework) confirmed the actual
failure path end-to-end -- trigger fired automatically on the in_progress gym task,
background thread ran, `claude -p` was actually invoked, its error ("Not logged in" --
an artifact of overriding `$HOME`, which also breaks the `claude` CLI's own credential
lookup, not an app bug) was caught, logged to `~/.mtdo/error.log`, cached as
`ai_coaching: false`, and the static fallback panel rendered correctly with the updated
"AI couldn't generate any either" copy. Then used Textual's `App.run_test()` headless
harness (same real `TodoApp`, same real background-thread/`call_from_thread` path, just
`ai_ask.ask` monkeypatched to a canned response instead of needing live external auth) to
verify the success path: transient "Asking the AI to tailor coaching notes..." panel while
in flight, `ai_ask.ask` called exactly once, response parsed correctly by
`parse_ai_coaching_response`, cached onto `block["ai_coaching"]`, panel re-rendered with
"AI-tailored for this task" and all six sections populated, and a second
`refresh_side_panels()` call confirmed the cache is respected (no duplicate AI call).

**Verdict: working as expected**, all three states (generating / success / failure)
confirmed in a real running app, not just unit tests. Real `~/.mtdo` was never touched --
scratch `HOME` throughout, cleaned up after.

**Did (original entry, 2026-08-20):**
- **Learning Coach AI customization** (`coaching.py`, `app.py`): fields with no static
  coaching setup (no `topic_type`/`coaching_framework` -- e.g. Gym, Job Applications) now
  get AI-generated coaching content (Focus On / Ask Yourself / Interview Check / Mistakes
  / Mental Models / Pro Tip), tailored to the exact task text. Triggers automatically the
  first time such a task becomes active in Focus Mode (background thread, same pattern as
  the existing DSA/SQL problem generator), cached onto `block["ai_coaching"]` so it's not
  regenerated on every render. Falls back to the old static "nothing set up" panel if no
  AI backend is configured or the response is unusable. DSA/backend/database/system_design
  fields were deliberately left untouched -- scope was "fill the gaps only", not "make
  every field task-specific" (user's explicit choice).
- **Profiles CLI wiring** (`cli.py`): `profiles.py` existed as a complete data/crypto
  layer but was never wired into anything. Added `mtdo profile list|current|create
  [--password] [--from-current]|switch|delete [--force]|import`. `switch` saves the
  outgoing profile's live `~/.mtdo/{goals.json,state.json}` back into its own (possibly
  encrypted) storage before loading the incoming profile's data, prompts for passwords
  with a 3-attempt retry limit, and refuses to silently clobber an existing *unmanaged*
  `~/.mtdo/goals.json` (i.e. one never adopted into a profile) -- tells the user to run
  `create --from-current` first. Deliberately CLI-only for v1 (user's choice) -- no
  in-app/TUI profile switcher yet.
- Installed `cryptography` (was a declared but never-installed dependency -- pre-existing
  gap, not caused by this session's changes) via
  `/opt/homebrew/opt/python@3.14/bin/python3.14 -m pip install -e . --break-system-packages`
  from `~/mtdo`, with explicit user approval for overriding Homebrew's PEP 668 protection.
  Without it, `--password` profiles fail with a clear ProfileError (not a crash).
- Created this agent (`~/.claude/agents/mtdo-dev.md`) and this progress log per user
  request, so mtdo work can resume without re-briefing.

**Tested:** All profile CLI paths (create/list/current/switch/delete, including
password-protected create+switch, wrong-password retry-then-fail, `--from-current`
adoption, active-profile delete guard, confirmation-name mismatch) exercised end-to-end
against a scratch `HOME`, never the real `~/.mtdo`. `coaching.parse_ai_coaching_response`
unit-tested against a realistic sample response. All touched files pass
`python3 -m py_compile`. AI-coaching-generation path now live-tested too -- see the
update entry above.

**Committed and pushed** -- commit `ab35750`, confirmed in sync with origin/main.

**Next / open items:**
- If ever wanted later (not requested yet): a TUI-side profile switcher, and/or extending
  AI customization to make DSA/backend/etc. content task-specific instead of shared
  generic buckets (both were explicitly deferred by the user on 2026-08-20).
