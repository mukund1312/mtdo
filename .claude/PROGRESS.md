# mtdo -- Session Progress Log

Newest entries first. Read this before starting work; append before finishing.
See `~/.claude/agents/mtdo-dev.md` for the full project onboarding/architecture doc.

**Workflow note (2026-08-22 onward):** changes go on a `feature/mu/UAT-<description>`
branch + PR into main, not straight to main -- see the Git workflow section at the bottom.
Add each session's PROGRESS.md entry to the same branch as the code it describes.

---

## 2026-09-03 (PR pending) -- gh58: radio.py checks ffmpeg before spawning mpv, and cleans up mpv if ffmpeg still fails to start

First bug in a new batch of code-audit findings (gh58, gh62, gh64, gh66, gh70),
same style as the earlier gh59-gh74 batch.

**The bug:** `RadioPlayer.start()` only ever checked `has_mpv()` up front.
mpv was spawned first, then the ffmpeg analysis process was spawned right
after with no equivalent check -- if ffmpeg isn't installed,
`subprocess.Popen(["ffmpeg", ...])` raises `FileNotFoundError`, which
propagated straight out of `start()`. At that point mpv was already running
and genuinely playing audio, but `self._mpv_proc` was left holding a live,
untracked process with `self._station_index` never set (still `None` from
before) -- `current_station()` reports nothing selected while mpv keeps
streaming in the background with no clean way for the app to find and stop
it again short of restarting mtdo.

**Fix:** added `has_ffmpeg()` (mirrors `has_mpv()`, `shutil.which("ffmpeg")`)
and check it up front in `start()`, alongside the existing mpv check, before
either process is spawned -- raises the same kind of clear `RuntimeError`
(`FFMPEG_INSTALL_HINT = "brew install ffmpeg"`) that `radio_screen.py`'s
`_play()` already catches and surfaces via `now_line.update()`, so this
needed no UI-side changes at all. Also wrapped the ffmpeg `Popen` call itself
in a `try/except BaseException` that terminates the already-spawned mpv
process, clears `self._mpv_proc`/`self._tmp_dir`/`self._ipc_sock`, and
re-raises -- defense in depth for the TOCTOU gap between the upfront check
and the actual spawn (ffmpeg uninstalled in between, permissions, etc.),
since the upfront check alone only prevents the common case.

Extended `tests/test_radio.py`: `test_start_raises_without_ffmpeg_and_touches_nothing`
(mirrors the existing without-mpv test) and
`test_start_kills_mpv_if_ffmpeg_popen_fails_after_the_upfront_check` (forces
a Popen failure on the ffmpeg call specifically and confirms the already-spawned
mpv mock's `.terminate()` was called, `is_playing()` is `False`, and
`_mpv_proc`/`_tmp_dir` are cleared). Also added `has_ffmpeg` patches (default
`True`) to every existing test that exercises `start()`/`on_list_view_selected`
without one, so the suite no longer silently depends on whether ffmpeg
happens to be installed on whatever machine runs it -- same reasoning as the
existing `has_mpv` patches, and the same kind of gap that caused a real CI-only
failure documented earlier in this file for the mpv check. Ran
`tests/test_radio.py` standalone: 34 passed.

---

## 2026-09-03 (PR pending) -- gh62 (remaining half): cmd_profile_switch's INCOMING write is now atomic too

Second bug in this batch (gh58, gh62, gh64, gh66, gh70). gh62 was already
partly fixed in PR #67 (`c2109ce`, merged 2026-08-30 by Janhvi) --
`profiles.write_goals_and_state()` made the OUTGOING profile's save-away
(goals+state written into its own per-profile encrypted storage) atomic as a
pair. Re-reading `cmd_profile_switch` for this batch found the other half of
the same bug was never actually fixed: after reading the target profile's
goals/state, landing them into the live, unencrypted `~/.mtdo/goals.json`/
`state.json` was still two separate, direct `open(..., "w")` calls -- not
individually crash-safe (opening in `"w"` mode truncates the file to empty
the instant it's opened, before `json.dump` ever runs), and with the exact
same no-rollback gap between the two files as the original bug description.
`tests/test_profile_atomic_writes.py`'s existing coverage only ever checked
what the OUTGOING profile ended up with after a switch, never what actually
landed in the live files for the profile being switched INTO -- so this half
had zero test coverage and nothing would have caught it.

**Fix:** added `config.save_goals()` (new, mirrors `core.save_state`'s
already-existing temp-file + `os.replace()` pattern from gh59 -- same
idiom duplicated rather than shared, matching this codebase's own
"three similar lines beats a shared helper" convention, since
`profiles._atomic_write_bytes` is profile-storage-scoped and private, not a
fit for the plain unencrypted live files). `cmd_profile_switch` now calls
`appconfig.save_goals(goals)` and `core.save_state(state)` back-to-back with
no other I/O in between, instead of the two raw `open()` calls -- same
"prepare/write via the module's own atomic primitive" shape
`write_goals_and_state` already established for the outgoing side.

Extended `tests/test_profile_atomic_writes.py` (not a new file, per this
batch's convention of reusing existing coverage): a direct unit test of the
new `save_goals()` primitive (mid-write failure leaves the original content
untouched, no leftover temp file -- mirrors the existing `_atomic_write_bytes`
test), a first-ever check that the INCOMING profile's data actually lands
correctly in the live files after a real switch, and a regression test that
forces the state write specifically to fail mid-switch (isolated from the
outgoing-save step by using a freshly-created, still-empty active profile so
that step is a no-op) and confirms no truncated/empty `state.json` is left
behind. Ran `tests/test_profile_atomic_writes.py` + `test_profiles_write.py`
+ `test_profiles.py`: 39 passed. Noted one pre-existing, order-dependent
flaky test in this file (`test_switching_away_in_the_live_tui_saves_both_goals_and_state`,
fails when run alone but passes as part of the full suite/file) --
confirmed unrelated to this change by reproducing it identically on the
unmodified branch via `git stash`; not touched here.

---

## 2026-09-03 (no code change) -- gh64: already fixed, verified

Third bug in this batch (gh58, gh62, gh64, gh66, gh70). Per step 1 of this
batch's process ("read the actual current code first -- don't assume the bug
description maps 1:1 to what you find"): music.py's subprocess calls already
all have `timeout=3` (`_run_best_effort`, `_spotify_running`, `_spotify_info`,
`play_spotify_url`, `_apple_script_is_playing`, `_nowplaying_cli_info`) --
fixed in `f0d7649` (PR #60, merged by Janhvi 2026-08-30, before this batch's
branch was created), which explicitly labels the change `gh64` and covers
every subprocess call in the file (confirmed by grepping music.py for both
`subprocess\.(run|check_output|Popen|call)` and `timeout=` -- 6 call sites,
6 timeouts, 1:1).

No code change made. Ran `tests/test_music.py` (added by that same PR) to
confirm it's still green: 22 passed. Flagging per this batch's own
instructions rather than silently no-oping or inventing busywork -- the real
finding here is "already fixed," not a residual gap like gh62 turned out to
have.

---

## 2026-08-30 (PR https://github.com/mukund1312/mtdo/pull/72) -- dashboard freeze: editable controls had no data-id

Directly user-reported ("when i click postpont in the dashboard the netire
dashboard freezes"), not a tracker bug -- no gh<N> issue filed.

**The bug:** the dashboard's status/assign/comment-thread click handlers
address elements via `.dataset.id` (e.g. `target: c.dataset.id`) when
building `api.edit(ops)` calls against the live-doc artifact capability, but
`render_html()` never set a `data-id` attribute on any of the elements those
handlers target -- every edit's `target` was `undefined`. Confirmed by
fetching the real published artifact HTML: exactly one `data-id="..."`
occurrence existed in the whole 371KB page, and it was literal source text
inside the platform's own minified runtime JS (`document.querySelector('[data-id="${o.target}"]')`),
not an attribute on any actual element. This affects all four edit
handlers equally (status, assignment, and posting a thread note), not just
Postpone -- the user likely just happened to try that control first.

**Fix:** added real, unique `data-id` values to the status/assign controls
(the row copy and issue-detail copy are separate elements per issue kept in
sync by the same handler, so each needs its own id: `status-row-<n>` /
`status-detail-<n>` etc.), the `<tr>` row (`row-<n>`), and the comment
thread div (`thread-<n>`, alongside its existing real `id`).

Added `test_render_html_gives_every_editable_control_a_real_data_id` to
`tests/test_dashboard_generate.py` (previously only covered `generate()`'s
gh-CLI-failure resilience, not the HTML/JS content itself). Verified against
the real sandbox dashboard.html after regenerating: 670 `data-id` attributes
across 67 live issues, all unique, all 10 expected ids present per issue.
Republished to the live artifact.

---

## 2026-08-30 (PR pending) -- gh74: plan_wizard.py checks pbcopy's real return code

Ninth and final bug in the autonomous fix-everything-assigned-to-mukund1312
batch. All 9 audit bugs assigned to Mukund are now fixed: gh59, gh60, gh61,
gh63, gh65, gh67, gh68, gh69, gh71, gh72, gh73, gh74 (see the gh59 entry
further down for the audit itself and the batch's own kickoff).

**The bug:** `save_and_copy()` reported `copied = True` based only on whether
the `pbcopy` subprocess call raised, not on its actual return code. If pbcopy
ran but silently failed to set the clipboard, the caller was told it copied
when it didn't -- a minor, low-likelihood UX inaccuracy (the lowest-severity
finding of the whole audit).

**Fix:** check `result.returncode == 0` instead of just "didn't raise."

Added `tests/test_plan_wizard_save_and_copy.py` (zero prior coverage):
success and nonzero-exit-code cases both report the right `copied` value, a
raised exception still reports `False`, and the file is always written to
disk regardless of the clipboard outcome.

---

## 2026-08-30 (PR pending) -- gh73: youtube_notes.py validates the URL is actually YouTube

Eighth bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry further down).

**The bug:** `fetch_transcript()` passed `url` straight to
`yt_dlp.YoutubeDL(...).extract_info()` with no check it's actually a YouTube
link -- yt-dlp supports many non-YouTube sites. A pasted non-YouTube URL in
what's presented as a YouTube-specific Vault feature could "succeed" against
an unrelated site, or fail with a generic yt-dlp error rather than a clear
"that's not a YouTube URL" message.

**Fix:** added `_is_youtube_url()`, checked by hostname against an allowlist
(`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`,
`youtu.be`) rather than a stricter path/ID-shape regex -- real YouTube URLs
come in enough shapes (`watch?v=`, `youtu.be/<id>`, `/shorts/<id>`,
`/live/<id>`) that a hostname check is the more robust, less
guessable-wrong option. Checked after the existing yt-dlp-availability
check (so that failure mode is still reported first, unmasked), before ever
touching yt-dlp.

Added `tests/test_youtube_url_validation.py`: common real YouTube URL shapes
accepted, common non-YouTube URLs (and garbage input) rejected, a rejected
URL never reaches yt-dlp, and the missing-yt-dlp check still takes priority
over the new URL check.

---

## 2026-08-30 (PR pending) -- gh72: bug_sync.py reports a missing gh binary clearly

Seventh bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry further down).

**The bug:** every `_run()` call in `bug_sync.py` assumed `gh` is installed.
A missing `gh` binary raised a raw, uncaught `FileNotFoundError` from
`subprocess.run` in every bug/status-sync code path, instead of a clear
"gh CLI not found, install it" message like every other real failure mode in
this module already gets.

**Fix:** wrapped the `subprocess.run` call in `_run()` with `except
FileNotFoundError`, re-raising as the same kind of actionable `RuntimeError`
the rest of the module uses, pointing at cli.github.com and `gh auth login`.

Added `tests/test_bug_sync_run.py` (zero prior coverage of `_run()` at all):
a missing binary raises a clear, actionable message; a real `gh` failure
(nonzero exit) is unaffected by the fix; a successful call still returns
stdout normally.

---

## 2026-08-30 (PR pending) -- gh71: analytics pruning moved off the main thread

Sixth bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry further down).

**The bug:** `_finish_startup()` called `analytics.prune_older_than(days=180)`
(a DELETE + VACUUM against events.db) synchronously on the main/event-loop
thread at every single app launch. VACUUM rebuilds the whole file and scales
with its size -- harmless today given the 180-day cap and opt-in-off-by-default
keeping `events.db` small, but the one place in this app doing blocking DB
maintenance directly in the startup path instead of off-thread like every
other slow I/O.

**Fix:** wrapped the call in `threading.Thread(target=analytics.prune_older_than,
kwargs={"days": 180}, daemon=True).start()`. Nothing downstream in
`_finish_startup()` depends on its result, so fire-and-forget is safe.

Added `tests/test_analytics_prune_offthread.py`. Notable dead end during
writing this: the first approach called `_finish_startup()` a second time by
hand (with `analytics.prune_older_than` mocked slow) to prove it returned
before the mock finished -- but a second call turned out to be unsafe on a
live app (it re-triggers profile-bootstrap modal logic that assumes it only
ever runs once, crashing on an unrelated `NoMatches` error hunting for
`#profile-name`). Rewrote to instead record every `threading.Thread(...)`
construction `app.py` makes during the app's own single, real startup
sequence, and assert one of them targets `prune_older_than` with the right
kwargs -- exercises the real code path exactly once, like every other test in
this suite already does, rather than inventing a risky second entry point.

---

## 2026-08-30 (PR pending) -- gh69: youtube_notes.py caps transcript length before the AI call

Fifth bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry further down).

**The bug:** `generate_notes_and_quiz()` embedded the full transcript into the
AI prompt with no length cap. A long video (a multi-hour lecture) could
plausibly exceed the active backend's context window -- especially a small
local Ollama model -- either erroring out or silently returning notes based on
a truncated/garbled prompt, with nothing telling the user their transcript
was too long.

**Fix:** added `_MAX_TRANSCRIPT_WORDS = 12000` (~92 minutes of speech at the
130 words/minute estimate this function already used) -- long enough for
nearly any real video, short enough to stay inside even a modest local
model's context. Transcripts longer than that are truncated to the first N
words (kept from the start, not rejected outright, so a very long video's
beginning still gets useful notes), and the returned notes/quiz body says
plainly when this happened rather than silently cutting content.

Added `tests/test_youtube_notes_length_cap.py` (no prior direct test of this
function): a short transcript passes through untouched with no truncation
note; a long one gets truncated before ever reaching the mocked AI call (and
the notes say so); the truncation boundary is exactly `_MAX_TRANSCRIPT_WORDS`.

---

## 2026-08-30 (PR pending) -- gh68: status_sync.py retries on a conflicting concurrent write

Fourth bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry further down).

**The bug:** `set_status()` does a genuine two-writer read-sha/modify/PUT
against GitHub's Contents API, with no lock and no retry. GitHub's API itself
rejects a PUT against a stale sha (a real conflict, not corruption) -- but
`_run()` turns that rejection into a hard `RuntimeError`. If you and Janhwi
both call `mtdo-sandbox working-on "..."` within the same short window, one of
you got a crash instead of the obvious recovery.

**Fix:** wrapped the read/modify/PUT cycle in a bounded retry loop
(`max_attempts=3`, default). On a failed PUT, it re-reads the file (now
reflecting whatever the other person's write already landed), reapplies just
this person's own status on top of the fresh content, and retries -- not a
blind resubmit of the stale copy it started with, which would silently
clobber the other person's concurrent update. After exhausting all attempts,
re-raises the last real error, so a genuinely broken case (bad auth, no
network) still surfaces clearly rather than retrying forever.

Added `tests/test_status_sync.py` (zero prior coverage): first-try success,
retry-after-one-conflict success, a dedicated check that the retry's PUT body
actually contains the other person's fresh status (not the stale pre-conflict
copy), and exhausting all attempts re-raising the last error.

---

## 2026-08-30 (PR pending) -- gh67: dashboard.py degrades gracefully on a gh CLI failure

Third bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry further down for how this batch works).

**The bug:** `dashboard.generate()` calls `bug_sync.sync_dashboard_overrides()`,
`bug_sync.auto_triage_pending()`, `bug_sync.list_all()`, and
`status_sync.get_all_status()` -- all of which go through a `_run()` helper that
raises a bare `RuntimeError` on any nonzero `gh` exit. Every OTHER subprocess
call in this file (`_commit_counts`, `_fetch_remotes_quiet`, `_bug_git_activity`)
already wraps failures and degrades gracefully; this one didn't, so a transient
`gh` hiccup (rate limit, auth expiry, network blip) crashed the whole
regeneration instead of leaving the last-known-good page in place.

**Fix:** wrapped the gh-touching sequence in `generate()` in a `try/except
RuntimeError`, returning `(DASHBOARD_PATH, None)` instead of raising --
`DASHBOARD_PATH` is left untouched (the write only happens after this block
succeeds), and `triaged is None` is the caller-visible signal that generation
was skipped, distinct from `{}` ("ran fine, nothing needed triaging"). Updated
both real callers (`sandbox_entry.py`'s CLI command, `app.py`'s background
sync worker) to check for `None` and say plainly that the refresh was skipped
rather than either crashing or falsely claiming success.

Added `tests/test_dashboard_generate.py` (zero prior coverage of this whole
module): a `gh` failure at the first call and a failure partway through both
return `None` and leave existing content untouched; a fully-mocked success
path still writes fresh content and returns a real triage dict.
`DASHBOARD_PATH` is a real fixed path under `~/.mtdo-sandbox` (like gh60's
`BUGS_PATH`), so every test monkeypatches it to a throwaway path first.

---

## 2026-08-30 (PR pending) -- gh65: pty_panel.py master_fd leak on failed Popen

Second bug in the autonomous fix-everything-assigned-to-mukund1312 batch (see
the gh63 entry just below for how this batch works and why).

**The bug:** `_start_impl()` opens a pty pair (`master_fd`, `slave_fd`) before
spawning the resolved command via `subprocess.Popen`. If Popen raises (most
commonly: the resolved command isn't on PATH -- e.g. a misconfigured AI backend
command), the original code's `finally` only closed `slave_fd`; `self._master_fd`
wasn't assigned until after the whole try/finally, so `master_fd` itself was
never closed on this failure path and leaked for the life of the process.
`start()` already caught and reported the failure to the user, so this was a
pure resource leak, not a visible/crashing bug -- easy to miss without counting
fds, which is presumably how it survived a full manual audit pass unnoticed
until this one.

**Fix:** added an `except BaseException: os.close(master_fd); raise` around the
`Popen` call, alongside the existing `finally: os.close(slave_fd)`.

Added `tests/test_pty_panel_fd_leak.py` (zero prior coverage of this whole
class): spies on `os.openpty()` to capture the real fd number, forces a Popen
failure via `ClaudePanel(command="/definitely/not/a/real/binary-gh65")`, and
asserts `os.fstat()` on the captured fd raises `OSError` afterward -- confirms
the fd was actually closed, not just that the error was reported. Chose
`os.fstat()` over reading `/proc/self/fd` for portability (this repo's CI runs
Ubuntu, but tests should hold locally too, and macOS has no `/proc`).

---

## 2026-08-30 (PR pending) -- gh63: profile-switch epoch guard for in-flight AI generation

Fourth fix from the full-codebase audit (see the gh59 entry further down). This
one kicks off a **batch**: the user explicitly authorized fixing every remaining
open audit bug assigned to them (gh63, gh65, gh67, gh68, gh69, gh71, gh72, gh73,
gh74) and merging each PR directly rather than waiting for review each time --
pull latest -> fix -> test -> PR -> CI green -> merge -> pull latest -> next bug,
repeated through the whole list.

**The bug:** a DSA/coaching AI generation runs in a background thread for up to
90s. If the user switches profiles before it finishes, `_switch_profile`
reassigns `self.state` to a freshly disk-read dict tree -- the `block` dict the
thread closed over belongs to the OLD tree. When the thread finishes,
`_store_generated`/`_store_generated_coaching` mutated that now-orphaned `block`
and saved `self.app.state`, which never contained the mutation: the generated
content vanished silently, and reopening the same task re-triggered (and
re-billed) a fresh generation.

**Fix:** added `self._profile_epoch`, bumped on every real profile switch.
`_render_dsa_mode`/`_render_ai_coaching_mode` capture the epoch when they start a
generation thread; `_store_generated`/`_store_generated_coaching` compare it
against the current epoch before mutating/saving, discarding the result if the
profile changed in the meantime. Deliberately NOT keyed off `id(block)` alone
(the original design) -- CPython can reuse a freed object's address, which could
make a stale result from profile A look like it belongs to a same-address block
in profile B.

Added `tests/test_profile_switch_generation_epoch.py` (zero prior coverage of
this whole code path) -- calls the panel's result-storing methods directly with
a controlled epoch rather than racing real threads/timing (a real generation can
take up to 90s, so timing-based tests would be either slow or flaky).

**A real lesson learned mid-fix, worth flagging for future test files:**
`test_onboarding.py` has tests that assert "analytics hasn't been decided /
no profile exists yet this session" -- true only because it happens to run
before any other file that creates a profile or dismisses the analytics
opt-in, in pytest's alphabetical collection order. The first version of this
file was named `test_learning_coach_epoch.py`, which sorted *before*
`test_onboarding.py` and broke both of those assumptions the moment it ran
(confirmed by removing it and re-running: `test_onboarding.py` passed clean
without it). Fixed two ways: added a local fixture cleaning up
`analytics.json`'s `decided_at`, and renamed the file to
`test_profile_switch_generation_epoch.py` so it sorts after `test_onboarding.py`.
Any new test file that constructs a fresh `TodoApp()` and fully dismisses the
first-run modal chain should be named with this in mind, or `test_onboarding.py`
itself should stop depending on collection order -- whichever a future pass
finds cleaner.

---

## 2026-08-30 (PR https://github.com/mukund1312/mtdo/pull/61) -- gh61: atomic encrypted profile writes

Third fix from the full-codebase audit (see the gh59 entry further down for the
audit itself). Same root cause as gh59/gh60 -- `profiles.py`'s `write_goals`/
`write_state` wrote encrypted goals.json/state.json via a direct
`open(..., "wb")`, which a mid-write crash could leave truncated.

**Different consequence here than gh59/gh60, and a deliberately different fix
shape:** Fernet raises the exact same `InvalidToken` for truncated ciphertext
as for a genuinely wrong password -- by design, it never signals which one
caused the failure, specifically to avoid giving an attacker a decryption
oracle. So a crash mid-write surfaced identically to `WrongPassword`,
misdiagnosing real data corruption as a password problem with no recovery
path. This also means the gh59/gh60 "quarantine the corrupt file and start
fresh" recovery pattern would be actively wrong here: auto-discarding an
encrypted profile on every `InvalidToken` would risk destroying real data on
nothing more than a mistyped password. So the fix is write-side only --
`_atomic_write_bytes()` (temp file + `os.replace()`, same shape as gh59/gh60)
prevents the corruption from ever happening; `WrongPassword` still reports as
`WrongPassword`, untouched.

Added `tests/test_profiles_write.py` (previously zero coverage of
`write_goals`/`write_state`'s encrypted path): round-trip on both protected
and unprotected profiles, no leftover temp files, a second write fully
replacing the first, and confirming a genuinely wrong password still reports
as wrong rather than getting silently "recovered."

**CI flakiness pattern, now worth addressing on its own:** this PR's CI failed
once, on yet a THIRD distinct test unrelated to the change --
`test_profiles.py::test_reselecting_the_same_active_profile_does_not_reset_pomodoro`
(an off-by-one Pomodoro tick count, 41 vs 42 seconds remaining), cleared on a
single rerun. Combined with gh59's PR (`test_radio.py`'s StopIteration) and
gh60's PR (`test_radio.py`'s StopIteration again, then `test_vault.py`'s
spinner-timing assertion), that's three different real-time-sensitive tests
flaking across three different unrelated PRs. This is no longer "one weird
test" -- it looks like CI's runner is consistently slower/more variable than
local, and several tests in this suite make tight real-time assumptions
(sleep-based timing, tick counting, single-`pilot.pause()` scheduling) that
occasionally slip under that variability. Worth a dedicated pass to make
those tests robust to slower schedulers (poll-with-timeout instead of
assert-after-one-pause, where applicable) rather than continuing to rerun
around it PR by PR.

---

## 2026-08-30 (PR https://github.com/mukund1312/mtdo/pull/55) -- visualizer widened to a true half/half split, restyled to match a pasted reference

Direct follow-up to the entry right below (merged as PR #53) -- the user's
real-time reaction after seeing it running: "the ascii dj has been cut down
and also the music graphic should go be like this [image] it should occupy
right half and then the ascii dj should occupy left half." They pasted a
screenshot of the original "cliamp" reference mockup (found via Claude
Code's own image cache, `~/.claude/image-cache/<session>/2.png`, since the
image wasn't inlined as text in the relayed message) showing its bar
visualizer: mostly bright green through the lower portion of each bar,
rising through gold/orange to red only near the tips, with a distinct
dotted/hatched "peak-hold" cap texture at each bar's own top.

**Concurrent-session hazard, handled before touching anything:** partway
through this follow-up, `git status` in `~/mtdo` showed the repo on a
DIFFERENT branch (`feature/mu/UAT-gh59-atomic-state-write`) with staged
`core.py`/`test_core.py` changes neither I nor this session had made --
another Claude Code session was actively working in the same shared,
non-worktree-isolated directory. Rather than risk clobbering that work by
switching branches (which moves the shared repo's single HEAD/index and
would misdirect that other session's next commit), captured this follow-up's
own diff to a patch file, ran `git checkout -- <the 2 files>` to restore the
shared working tree to exactly the state the other session left it in
(confirmed via `git status`), and did the rest of this work in a
`git worktree add`-created isolated worktree off `origin/main` instead --
never touched the other session's branch, staged changes, or HEAD.

**Layout, corrected to an actual half/half split:** previous revision gave
the art 42 cols and the visualizer only 24 (a 42/24 split that was NOT half
and half despite reading as "roughly balanced" at a glance) -- re-cropped
the art down to its center 35 columns and widened the visualizer to 34 bars
(1-col gap between): 35 + 1 + 34 = 70, the panel's full real content width,
an actual even split as asked. Re-verified the crop doesn't break the
existing shine-sweep tests for the same reason as before -- they read
`_SHINE_ART`/`_SHINE_WIDTH` live off the module rather than hardcoding
literals, so a width change alone needed zero test edits there.

**Palette and character work re-tuned to match the pasted image specifically,**
overriding the more cyan-forward ramp the earlier revision used (that ramp
came from the original written spec, before there was a concrete image to
compare against -- once there was one, matched it instead): dropped the
cyan stop, `_VIS_GRADIENT_STOPS` now holds a flat `_GREEN_BRIGHT` plateau
through the bottom 55% of a bar's height, then rises through gold (0.72),
orange (0.88), to coral at the very top (1.0).

**New "peak-hold cap" texture, matching the reference's dotted bar tips:**
`_render_visualizer` now treats a bar's own topmost LIT row (`row == height
- 1` for THAT bar specifically, not a row shared across the whole grid) as
a distinct hatched `"▒"` character in a new `_VIS_PEAK` (`#ff7fa6`) color,
instead of a solid block in the row's gradient color. Confirmed by hand via
a zoomed-in crop of a real screenshot (`vis_zoom.png` in this session's
scratchpad) that the cap genuinely tracks each column's own height
independently -- a short bar's cap sits well below a tall neighbor's, not
smeared across one shared row.

**Tested:** same discipline as the entry below -- `python3 -m py_compile`
clean; full pytest suite run in the isolated worktree's own venv (editable-
installed against the worktree path, not the shared repo, so it genuinely
exercises this branch's code) -- see the immediately-following test-suite
result note appended once that run completed. Updated/added unit tests in
`tests/test_radio.py`: `_gradient_color`/`_VIS_ROW_COLORS` tests rewritten
to read stops live off `radio_screen._VIS_GRADIENT_STOPS` rather than
hardcoding fracs (so a future re-tune, which this session itself is proof
tends to happen, doesn't need fragile test edits); a new
`test_render_visualizer_peak_cap_lands_on_each_bars_own_top_row` computes
expected heights independently via `_interpolate_bars` and asserts the
peak-cap/fill/unlit character and color at every single cell, per column,
for a level shape guaranteed to produce unequal bar heights. Also captured
fresh real headless Pilot screenshots (same wall-clock-tick discipline as
before) confirming visually: a genuine half/half split with the art fully
occupying its half (not visibly cramped), the skyline now dense enough to
show real per-band irregularity, and the peak-cap pink hatch appearing only
at each bar's own real tip.

**Next / open items:** same open items as the entry below still apply
(crop-offset eyeballing, gold/orange/coral untested against a real loud
stream). Branch is `feature/mu/UAT-radio-visualizer-half-split`, built off
`origin/main` (which already has PR #53 merged) via an isolated
`git worktree`, not the shared `~/mtdo` checkout.

---

## 2026-08-30 (PR https://github.com/mukund1312/mtdo/pull/56) -- gh60: atomic bug_log.json writes + corruption recovery

Second fix from the full-codebase audit (see the gh59 entry below for the audit
itself), same root cause and same fix shape as gh59, applied to `bug_log.py`.

`_save()` wrote `bugs.json` via a direct `open(..., "w")`, which a mid-write crash
could leave truncated -- and this module's entire *purpose* is capturing a bug
right before exactly that kind of hard-kill, per its own docstring, so this was
the worst place in the app for a non-atomic write to live. `_load()` then caught
a bare `Exception` and returned `[]` on any failure at all, silently treating a
corrupted file as an *empty* log -- every previously logged bug vanished with
zero indication anything was lost.

**Fix:** `_save()` now writes to a temp file in the same directory before
`os.replace()`-ing it onto the real path (same-filesystem atomic rename, not a
silent copy+delete fallback). `_load()` narrows its catch to
`json.JSONDecodeError` specifically, quarantines the unreadable file to
`bugs.json.corrupt-<timestamp>` (never deletes it -- kept for hand recovery),
logs it via errorlog, and starts fresh instead of discarding everything.

Added `tests/test_bug_log.py` (previously zero coverage): round-trip
correctness, no leftover temp files, and the full corrupt-quarantine-and-recover
cycle, including confirming a new bug can still be logged right after recovery
(the whole point of this module). `BUGS_PATH` is a real fixed path under
`~/.mtdo-sandbox`, not scoped to the MTDO_HOME test sandbox -- every test
monkeypatches it to a throwaway `tmp_path` first; confirmed the real
`~/.mtdo-sandbox/bugs.json` was never touched by the test run.

CI green on the first run this time (full pytest suite: 117 passed, 1 skipped).

---

## 2026-08-30 (PR https://github.com/mukund1312/mtdo/pull/54) -- gh59: atomic state.json writes + corruption recovery

Fixed a real, verified bug from a full codebase audit (see below): `core.py`'s
`save_state()` wrote `state.json` via a direct `open(..., "w")`, which a mid-write
crash (this app is genuinely killed via SIGHUP/hard-kill in real sandbox sessions,
per bug_log.py's own docstring) could leave truncated. `load_state()` had no
`JSONDecodeError` handling at all, so a corrupted file crashed the app on every
subsequent launch with no way back in.

**Fix:** `save_state()` now writes to a temp file in the *same directory* as
`state.json` (so `os.replace()` is a same-filesystem atomic rename, not a silent
copy+delete fallback on a different filesystem) before replacing the real path.
`load_state()` now catches `JSONDecodeError`, quarantines the unreadable file to
`state.json.corrupt-<timestamp>` (never deletes it -- kept for hand recovery),
logs it via errorlog, and starts fresh instead of crashing.

Added `tests/test_core.py` -- there was previously zero direct test coverage of
`load_state`/`save_state` at all. Covers round-trip correctness, no leftover temp
files, and the full corrupt-quarantine-and-recover cycle (including that the app
can save normally again afterward, not just avoid crashing once).

**A full code audit happened earlier this session** (parallel review across all
26 source files, ~13,200 lines) -- found 17 real, verified issues, filed as
mukund1312/mtdo-bugs#58-#74, triaged by severity and split between Mukund/Janhwi
via the existing balanced-assignment logic. gh59 (this entry) was the first one
fixed; #58 and #60 are the other two High-severity ones still open (a missing
ffmpeg check that crashes the app and orphans mpv, and the same non-atomic-write
pattern in bug_log.py causing silent full data loss on corruption).

**CI note:** this PR's own CI run flaked twice before going green on a third
attempt -- `test_radio.py::test_radio_screen_opens_via_keybinding_and_plays_on_enter`
(StopIteration from an exhausted mocked subprocess side_effect list) and
`test_vault.py::test_youtube_flow_shows_spinner_while_running_and_hides_on_success`
(a spinner-visibility timing assertion) failed in different combinations across
the three runs -- confirmed via `git diff origin/main..HEAD --stat` that this
branch touches only core.py/test_core.py, so neither is caused by this fix.
Left both test files untouched (out of this fix's scope) since a clean third
run confirms genuine CI-environment flakiness, not a deterministic failure --
worth a look separately if either keeps recurring.

---

## 2026-08-30 (PR https://github.com/mukund1312/mtdo/pull/53) -- visualizer moved beside the DJ art, made much denser

Real feature request: put the audio visualizer BESIDE the shine-sweep "DJ" art
(`_SHINE_ART`) instead of stacked below it, and make it much richer/denser --
"dozens of narrow vertical bars," a smooth cyan-to-coral color gradient,
LED-matrix block feel.

**Width constraint, and the call made:** at the panel's real content width
(80 - 2 margin*2 - 2 border - 4 padding = 70 cols, same 80-col terminal
assumption PR #48/#49 already worked under for this same panel), the
original 65-wide art plus any real visualizer simply doesn't fit side by
side. Chose to narrow the art rather than starve the visualizer down to a
few columns -- cropped `_SHINE_ART` to its center 42 columns (kept the full
65-wide `_SHINE_ART_FULL` around uncropped, in case a future session wants
to re-tune the crop). Gave the visualizer 24 bars (1 char each, no gaps --
"two dozen," matching "dozens" pretty literally) plus a 2-col gap: 42 + 2 +
24 = 68, leaving 2 spare columns for VerticalScroll's own scrollbar when the
panel overflows a short terminal. Visualizer height set to match the art's
row count exactly (33 rows, `_VIS_ROWS = len(_SHINE_ART)`) so the two read
as one aligned block. Net effect on total panel height: slightly SHORTER
than before, since the old standalone 6-row visualizer block (plus its own
margin) is gone entirely, not added on top of the hero row.

**Cropping the art data itself, not just the widget's rendered width,**
was deliberate: _render_shine_art's circular-wrap sweep math is defined in
terms of the art's own width, so cropping only the display (e.g. via a
fixed-width Static and CSS overflow) would have made the highlight band
invisible most of the time -- it would sweep in and out of a narrower
visible window rather than always being on-screen. Cropping `_SHINE_ART`
itself keeps the existing sweep logic correct by construction, and (since
the existing shine-sweep tests all read live off `radio_screen._SHINE_ART`/
`_SHINE_WIDTH` rather than hardcoded literals) needed zero test changes to
stay green.

**Density, without faking anything:** `radio.py`'s `RadioPlayer.get_levels()`
is still the only real audio data that exists -- 8 bands, no finer real
signal to read. Subdividing 8 real values into 24 dense bars uses Catmull-
Rom spline interpolation (`_interpolate_bars`), not linear -- a spline's
curvature between control points is itself derived from the real
neighboring bands' slopes, so the "skyline" texture between bars comes
honestly from real spectral shape rather than decorative randomness (kept
this reasoning in the module comments, matching the file's existing "EQ
honesty" standard). Verified directly: at a bar position that lands exactly
on a real band, the spline reproduces that band's own value exactly
(`test_interpolate_bars_reproduces_real_band_values_at_their_own_positions`).

**Color:** new `_gradient_color()` linearly interpolates RGB across five
stops -- neon cyan (`_VIS_CYAN`, bottom) -> mint (`_GREEN_BRIGHT`, reused)
-> gold (`_VIS_GOLD`) -> orange (`_ORANGE`, reused) -> hot coral
(`_VIS_CORAL`, only the very top row) -- precomputed once per row into
`_VIS_ROW_COLORS` at import time (color depends only on row position, never
on live data, so no reason to recompute per frame). Character-wise: kept
this file's existing █ (lit) / ░ (unlit) convention rather than inventing a
new one.

**Freeze/pause/stop semantics, mirrored from the shine-sweep exactly:**
while genuinely playing, pull fresh real levels each redraw; frozen in
place on pause; parked at an explicit all-zero rest baseline once stopped.
Turned out this needed a real fix, not just cosmetic parity: `radio.py`'s
analysis ffmpeg process reads the stream independently of mpv's own pause
IPC command, so `get_levels()` keeps returning fresh real values even while
audibly paused -- without explicit freeze logic the visualizer would keep
moving to sound the user can no longer hear. `_redraw_visualizer` now caches
`self._last_vis_levels` and only refreshes it when actually playing and
unpaused, same `self._last_paused` cache `_advance_shine` already reads.

**Tested:** full pytest suite green, 103 passed + 1 skipped (the pre-existing
vinyl-extra skip), in a scratch venv built from `pip install -e ".[dev]"`.
`python3 -m py_compile` clean. New unit tests in `tests/test_radio.py`
directly exercise `_interpolate_bars` (exact reproduction at real band
positions, unit-range clamping, flat-input flatness, more-resolution-than-8-
bands) and `_gradient_color`/`_render_visualizer` (span/color inspection at
known fracs, silence-is-all-unlit, full-volume-lights-every-row-cyan-to-
coral) as pure functions -- no player/screen mocking needed for that layer.
A screen-level test (`test_visualizer_freezes_on_pause_parks_on_stop_resumes_on_play`)
drives `_redraw_visualizer()` directly and asserts relative before/after
behavior across play -> pause -> resume -> stop, same pattern the existing
shine-sweep screen test already uses (the screen's own real `set_interval`
races manual calls, so relative deltas are asserted, not exact tick counts).

Also captured real headless Pilot screenshots (`App.export_screenshot()`)
across genuine wall-clock ticks (`asyncio.sleep` + `pilot.pause()`, not a
manual `.update()` poke -- PR #48 already found that shortcut produces
false-negative identical screenshots) while feeding synthetic-but-realistic
varying 8-band levels through the real `RadioPlayer._levels` list. Confirmed
by hand: the visualizer sits cleanly beside the cropped art at the same
height inside the panel border with no clipping; the "skyline" shows a real
irregular dip driven by a real quiet band in one frame, not a flat repeated-
chunk look; cyan at the bottom shading up through mint (gold/orange/coral
didn't appear in these particular synthetic frames since none of the test
levels sustained a true 0dBFS peak long enough -- expected, matches the
"coral only at the very top peaks" design intent, not a bug). Four
screenshots across the level-change sequence all hashed different from each
other, confirming genuine per-tick redraws through the real render path.

**Next / open items:** the crop offset (`_SHINE_CROP_START = 11`) was chosen
by centering, not by inspecting what the art actually depicts at that
position -- worth a human glance to confirm nothing important got cropped
off. Gold/orange/coral stops are unverified against a real loud stream (only
exercised via synthetic level injection here, since real mpv/ffmpeg aren't
available in this sandboxed dev environment) -- worth a quick live look once
merged. PR not yet opened as of writing this entry; branch is
`feature/mu/UAT-radio-visualizer-beside-art`.

---

## 2026-08-27 (PR https://github.com/mukund1312/mtdo/pull/49) -- radio panel scrolling

Follow-up to PR #48: the shine-sweep art is 33 rows tall on its own, and once
stacked with the rest of the radio panel's content (title, now-playing, time,
visualizer, EQ/VOL, playlist header, 11-station list), total height easily
exceeds a shorter terminal's viewport. User reported "not able to scroll
down" -- the panel was a plain `Vertical` with no scroll capability, so
`#radio-list`'s `height: 1fr` just got squeezed toward zero instead of the
panel scrolling, making the playlist unreachable on a short terminal.

**Fix:** swapped `Vertical` for Textual's `VerticalScroll` container (mouse
wheel/PageUp/PageDown/Home/End all work automatically) and changed
`#radio-list`'s height from `1fr` to `auto` so it sizes to its actual 11
items rather than competing for leftover space in a scrollable container,
where "leftover space" isn't a well-defined concept.

**Verified headlessly** at a deliberately short terminal (40 rows, shorter
than the art alone): `max_scroll_y` is a real nonzero value (33) and
`scroll_y` moves through the full range via `scroll_home`/`scroll_end`/
relative scroll, confirmed against matching screenshots (art visible at the
top when scrolled home, full playlist visible at the bottom when scrolled to
end). Also confirmed Textual's default focus-follow behavior auto-scrolls
the newly-focused station list into view on mount, so the playlist is
immediately reachable without the user needing to discover the scrollbar
themselves. At a tall terminal where everything already fits, `max_scroll_y`
is 0 -- no spurious scrollbar. Full pytest suite green (95 passed, 1
skipped); PR #49's own CI green.

---

## 2026-08-27 (PR https://github.com/mukund1312/mtdo/pull/48) -- shine-sweep replaces the vinyl-spin visual

The spinning-vinyl feature from PR #47 (below) shipped, then got direct
negative feedback: "use this instead of the vinyl lopp it looks horeble." The
user pasted a static Braille-block ASCII image (a 33-row, 65-column piece of
art, no source video) and asked to "animate this into a loop."

**Category difference from the vinyl feature, flagged before writing any
code:** the vinyl spinner had real source frames (a video) to cycle through.
This is one static image with no motion source at all -- "looping" it can
only mean synthesizing motion on top of a fixed character grid, not decoding
anything. Asked the user to choose a synthesis style (`AskUserQuestion`):
glowing color pulse, shine sweep, or gentle bounce/scale. User picked **shine
sweep** -- a bright highlight band sweeping across the art on a loop, "like
light catching a spinning surface."

**Why shine sweep specifically avoids repeating the vinyl mistake:** pure
color modulation over an unchanged character grid can never distort or
garble the art, unlike a rotate/scale/reshape approach applied to
pre-rendered block characters (a real risk for Braille-block art, and
plausibly part of why the vinyl rendering looked bad in the first place).

**Implementation (`radio_screen.py`):** `_render_shine_art(position)` renders
the fixed `_SHINE_ART` grid with a highlight color band centered at
`position`, using **circular distance** (`min(abs(col - position), width -
abs(col - position))`) so the sweep wraps seamlessly with no visible jump at
the edges. Built with run-length-grouped style spans per row rather than one
`.append()` per character, to stay cheap at the 20/sec redraw rate. Advances
only while a station is genuinely playing, freezes in place on pause, and
parks back at position 0 once stopped -- carrying forward the exact
play/pause/stop interaction the vinyl spinner used.

**Full removal of the vinyl feature's surface area**, not just its call
site: `radio.py`'s vinyl helpers (`has_vinyl_support`, `extract_vinyl_frames`,
related constants), the bundled `vinyl.mp4` asset, the `vinyl` optional-
dependency group, and the `*.mp4` package-data glob in `pyproject.toml` are
all gone. The shine-sweep needs zero image-rendering dependencies --
`textual-image`/Pillow/ffmpeg-for-frames are no longer used anywhere in this
codebase.

**Verification:** confirmed all 33 rows of the pasted art are exactly 65
characters wide (a transcription-length mismatch would have produced ragged/
misaligned art); new unit tests for `_render_shine_art`'s band placement and
circular wrap-around; a screen-level test for the play/pause/stop-driven
advance logic (written against relative position deltas, not exact tick
counts, since the screen's own real `set_interval` races manual test calls);
headless Pilot screenshots confirmed the art renders intact with the rest of
the layout undisturbed, and direct span inspection confirmed the highlight
band's position and wrap-around math. Screenshots taken across real wall-
clock time (through the actual `set_interval` tick, not a manual `.update()`
poke) differed frame to frame, confirming the sweep genuinely animates in the
running app -- an earlier attempt at manually poking `.update()` without
going through a real render/compositor cycle produced identical screenshots
and would have been a false negative if trusted. Full pytest suite (95
passed, 1 skipped) green in a fresh venv built from CI's exact
`pip install -e ".[dev]"`; PR #48's own CI run green.

---

## 2026-08-27 (PR https://github.com/mukund1312/mtdo/pull/47) -- spinning-vinyl visual on the radio screen

User re-shared the cliamp mockup asking for "this exact" UI (already matched
closely by PR #44), plus a new ask: a spinning-vinyl loop next to it "for
relaxation," providing a real ~5s `vinyl.mp4` clip.

**Technical spike before committing to an approach** -- terminal video
rendering is a genuinely different kind of feature from CSS/layout work, not
something to guess at:
- Confirmed `textual-image` (already available in this environment, added as
  a new soft `vinyl` optional-dependency group) can render a `PIL.Image`
  inside a real Textual widget, and that reassigning `.image` after mount
  triggers an actual re-render -- verified via a real SVG-exported screenshot
  of a live widget, not just reading the package's docs.
- Extracted the bundled clip into a handful of low-res PIL frames via
  `ffmpeg` (already a hard dependency of `radio.py` for the audio-level
  analysis) -- confirmed live: ~0.1s for the whole clip, cached under
  `APP_DIR` afterward so it's not redone on every screen open.
- **Deliberately used `HalfcellImage`, not `AutoImage`.** `AutoImage`
  auto-detects Kitty/iTerm2/Sixel graphics protocols for sharper rendering
  where a terminal supports one, but there's no way to verify those actually
  render correctly for everyone from this sandboxed dev environment -- an
  early integration test using `AutoImage` came back as a broken monochrome
  block image under the headless test harness's SVG export, while the exact
  same frame via `HalfcellImage` rendered with real, correct color. A
  slightly-blockier-but-guaranteed-working image beats a sharper one that
  might come back blank or garbled on some terminals.

**Implementation:** `radio.py` gains `has_vinyl_support()`,
`extract_vinyl_frames()` (cached PIL frame list), and the bundled
`vinyl.mp4` asset (`pyproject.toml`'s `package-data` extended to `*.mp4`).
`radio_screen.py`'s header row gains a vinyl widget to the left of the
existing song/status info when support is available -- frames cycle on a
timer, but only actually *advance* while a station is genuinely playing:
frozen exactly in place on pause (like a real turntable needle stopping
where it is, not resetting), parked back on frame 0 once nothing is playing
at all. Soft dependency throughout -- `has_vinyl_support()` checks
`textual-image`, Pillow (pulled in transitively), `ffmpeg`, and the bundled
asset are all genuinely available, and the screen just omits the widget
entirely otherwise; station playback itself never depends on any of it.

**One real bug caught and fixed before shipping:** the new frame-advance
tick (running at 8/sec) initially called `player.is_paused()` directly --
the same "frequent blocking IPC round trip on Textual's own event-loop
thread" concern `_update_status`'s own docstring already warns against,
just reintroduced at a faster rate. Fixed by reusing `_update_status`'s
already-cached pause state instead of querying mpv's socket a second time
every tick.

**A second real gap caught via the exact CI-mismatch lesson from PR #43:**
the first version of the new tests called `radio.extract_vinyl_frames()`
unconditionally, assuming a real `ffmpeg` (fine) and `textual-image`/Pillow
(NOT fine -- CI's `pip install -e ".[dev]"` deliberately doesn't pull in the
new `vinyl` extra, since it's a soft, decorative-only dependency). Caught
this locally *before* pushing, by actually reproducing CI's real dependency
set in a fresh venv rather than assuming -- fixed by gating the three tests
that need real extraction behind `pytest.mark.skipif(not
radio.has_vinyl_support(), ...)`, the same real condition the production
code itself checks, verified to skip cleanly (not fail) under that exact
simulated environment before ever pushing.

**Tested:** live verification via real SVG-exported renders throughout --
vinyl genuinely spinning through real, colorful frames while a station
plays, alongside correct real station/EQ/VOL data; confirmed the freeze-on-
pause and park-on-stop behavior; confirmed clean process shutdown (no
orphaned mpv/ffmpeg) via the real `action_quit()` path; confirmed graceful
degradation with `textual-image` not installed at all (screen still opens
and plays fine, `vinyl_widget` stays `None`). 6 new tests in `test_radio.py`.
Full suite passes both with and without the `vinyl` extra installed. **CI
(GitHub Actions) confirmed green before merging.**

No tracker bug for this -- came directly from the user in chat, nothing to
close.

---

## 2026-08-27 (no code change -- asset capture only) -- real screenshots for the docs/redesign landing pages

User feedback on the two hand-drawn HTML mockups at `docs/redesign/option-a-landing.html`
/ `option-b-storytelling.html`: the fake `.kgrid`/`.mini-pipeline`/fake-code-block mockups
"don't look alike to the actual app ... like false advertising." Asked for genuine
screenshots of the real running app instead. This session only produced the screenshot
assets -- the HTML rewrite itself is the user's to do.

Captured via Textual's `App.export_screenshot()` (real SVG, text-selectable) driven
through `TodoApp().run_test()`, same Pilot pattern `tests/test_smoke.py` already uses.
One-off script (not added to the repo, lived in the session scratchpad) that:
- Set `MTDO_HOME` to a scratch dir *before* importing `mtdo` (same ordering constraint
  `tests/conftest.py` documents -- `config.APP_DIR` is computed once at import time).
- Seeded the scratch config from the real shipped demo plan
  (`appconfig.init_config(fresh=False)` -> `demo_config.yaml`), not an empty board --
  the whole point was genuine shipped content, not fabricated card names.
- Called `appconfig.mark_onboarded()` / `mark_plan_configured()` to skip straight to the
  real board instead of the first-run walkthrough/wizard.
- One deliberate scratch-only config tweak: the shipped `demo_config.yaml`'s `dsa`
  category has no `topic_type` set, so the AI-generated-problem view never actually
  triggers from the demo as shipped (confirmed by reading `coaching.py`/`app.py` --
  `has_generated_problem_support` gates strictly on `topic_type`). Added
  `topic_type: dsa` to the scratch copy only (never touched the repo's real
  `demo_config.yaml`) so the Learning Coach screenshot could show a real, live
  AI-generated problem using the same real curriculum item names ("Two Sum" etc.) --
  not a fabricated feature, just flipping on a real flag the demo leaves off.
- Learned along the way: curriculum categories (dsa/backend/sysdesign) start each day
  **blank** on the board (`core.ensure_day_registered`) -- the board only gets a card
  once you pick one off that week's menu (`core.get_weekly_menu`/`pick_menu_item`), same
  as the real 'a' add-card flow. First capture attempt skipped that and got an empty
  "No task in progress" Learning Coach in both Focus Mode screenshots; fixed by calling
  `pick_menu_item` then `advance_status` twice (todo -> in_progress) before entering
  Focus Mode, mirroring the real UI's own state-transition functions rather than
  fabricating state by hand.
- The DSA problem generation is a real, live `claude -p` subprocess call
  (`ai_ask.ask` -> `ai_backend.detect()`, picked "Claude Code" automatically since
  nothing was pre-selected in the scratch profile) -- genuinely returned a real "Two
  Sum" problem statement + examples, confirmed by extracting the SVG's text content,
  not just checking file size.

**Captured (all 9 requested), saved to `~/mtdo/docs/redesign/screens/`:**
- `board.svg` -- default Kanban board
- `focus.svg` -- Focus Mode (before a task was in progress)
- `coach.svg` -- Learning Coach with a real generated "Two Sum" problem showing
- `lab.svg` -- Practice Lab (Shift+T) alongside the Learning Coach, in Focus Mode
- `crm.svg` -- Career CRM (press c) -- genuinely empty (0 in every stage), since the
  scratch profile has no applications and the demo config's `jobs` category has no
  curriculum to seed one from. Left authentically empty rather than inventing a fake
  company name -- same "no fabricated content" principle as the DSA-problem tweak above.
- `vault.svg` -- Knowledge Vault (press v) -- genuinely empty, same reasoning
- `ai.svg` -- AI Assistant panel (Shift+C) -- captured the real `AIBackendPickScreen`
  (Claude Code, several real local Ollama models, API options) since no backend was
  pre-chosen in the scratch profile; matches what the task explicitly said was fine
  ("a backend picker ... whatever's actually true")
- `profiles.svg` -- Profile menu (U) -- genuinely "No profiles yet" empty state
- `keys.svg` -- full `?` keybindings cheat sheet

**Tested:** ran the capture script twice (first run caught the blank-curriculum-board
bug above via empty Learning Coach output), verified every SVG has a proper
`<svg>...</svg>` envelope and non-trivial size, and spot-checked extracted text content
(not just file size) for board/focus/coach/lab/crm/vault/ai/profiles/keys to confirm
each shows the real intended screen rather than a stale/duplicate capture. Confirmed
real `~/.mtdo/config.yaml` mtime unchanged after the whole session (untouched, per the
usual sandbox discipline -- `MTDO_HOME` was only ever set inside the throwaway script's
own process, never exported into this shell).

**Next / open items:** the actual `docs/redesign/*.html` rewrite to embed these SVGs
belongs to the user ("Don't touch the docs/redesign HTML files yourself -- that part's
mine"). If a next session picks this up: crm.svg/vault.svg being empty-state is
accurate-but-maybe-underwhelming for a marketing page -- worth asking the user whether
they'd rather add a couple of their own real CRM/vault entries to their real profile (or
a sandbox instance) and recapture those two specifically, rather than this session
inventing placeholder company/note names.

---

## 2026-08-27 (bug gh57, GH mukund1312/mtdo-bugs#57, PR https://github.com/mukund1312/mtdo/pull/46) -- profile switch left Pomodoro/task state leaking, new profiles skipped the setup wizard

Bug, verbatim: "when i switch to the next profile then everything should be
fresh from that goals setup manual or guided, all the pomodoro and everything
else should be reset and saved for each profile... each profile should be
unique to its own... nothing of the other profiles seeps in... goals setup
manual or guided should be asked for each [profile]... password protected
the same password for the profile."

Three distinct sub-asks, investigated separately:

1. **Pomodoro/task bookkeeping leaked across profiles -- confirmed live.**
   Pomodoro's running/elapsed/duration state (`PomodoroPanel.running`/
   `on_break`/`remaining`/`work_minutes`/`break_minutes`) and the Learning
   Coach's DSA/AI-priming in-flight bookkeeping
   (`current_dsa_ref`/`dsa_generating`/`coaching_generating`/`ai_primed_ref`/
   `_hint_prompt_open`) are all plain runtime attributes on
   `TodoApp`/`PomodoroPanel` -- never part of `goals.json`/`state.json` at
   all -- so `_switch_profile` never touched any of it. Reproduced live: a
   Pomodoro left running with custom 50/15 durations in profile A kept
   ticking under those same durations after switching to profile B. **Fix:**
   reset all of it in `_switch_profile`, right before `reload_from_goals()`
   re-renders every side panel (so that render already reflects the fresh
   values), only when actually switching to a genuinely *different* profile
   -- re-selecting the one you're already in leaves an active Pomodoro alone,
   confirmed via a dedicated regression test. Deliberately did NOT reset
   `focus_mode` -- a view preference, not profile data, nothing here reads or
   writes through it in a way that could leak between profiles.

2. **New profiles never got the goals-setup wizard -- confirmed live.**
   `_finish_startup`'s auto-launch check for the wizard
   (`appconfig.has_configured_plan()`) is a single, app-wide marker file, not
   per-profile, AND is only ever checked at app startup -- creating an
   additional profile via "Add Profile" never consulted it at all, so it
   switched straight into a silently empty board with no prompt to fill it
   in, unlike a genuine first run or a manual `g` re-run. **Fix:** added
   `_on_profile_created_manual`, a new handler used only by
   `action_create_profile()` ("Add Profile"), which triggers
   `_begin_setup_flow()` right after the actual switch (correctly ordered
   whether or not a recovery-code screen appears in between for a protected
   profile). Deliberately kept **separate** from the existing
   `_on_profile_created` -- that one is *also* reached internally from
   `_begin_setup_flow`'s own first-run bootstrapping branch (when zero
   profiles exist yet), which already chains straight into
   `_pick_populate_method` itself; making `_on_profile_created` trigger
   `_begin_setup_flow()` too would have double-fired the wizard (an extra,
   redundant `ProfileMenuScreen` step) for a brand-new install. Confirmed
   live: creating profile #2 now correctly chains into the same wizard `g`
   re-runs; a genuine first run (zero profiles) still goes straight from
   `ProfileCreateScreen` to `ChoicePickScreen`, unaffected.

3. **"password protected the same password for the profile"** -- already
   fully satisfied by `profiles.py`'s existing envelope-encryption model
   (verified by re-reading it, not assumed): `write_goals`/`write_state` for
   a given profile are always wrapped under exactly that profile's own
   password. No code change needed.

**Tested:** live repro before fixing (Pomodoro state genuinely survived a
switch untouched), live verification after (resets to defaults on a real
switch, left alone on a same-profile re-select), live verification of the
new-profile wizard trigger and the first-run-path non-regression. Added 4 new
regression tests to `test_profiles.py`. One test-isolation lesson caught
along the way: an initial version of the first-run-boundary test tried to
force `pf.list_profiles()` empty through the pilot, which can't be relied on
in the shared `MTDO_HOME` test session (other tests' profiles already exist
by the time it runs) -- rewritten to verify the boundary directly against
the handler (mocking `_begin_setup_flow` and asserting it's never called from
`_on_profile_created`) instead. Full suite: 92 passed, 1 skipped, in a
scratch venv. **CI (GitHub Actions) confirmed green before merging** --
continuing the practice established after PR #43's CI-debugging saga.

---

## 2026-08-27 (PR https://github.com/mukund1312/mtdo/pull/44) -- redesign the radio screen to match the user's cliamp mockup

User provided a specific reference mockup (a fictional "cliamp" retro-terminal
radio player screenshot) and asked for that exact UI. Rebuilt `RadioScreen`'s
layout/styling to match: a fake `$ cliamp --provider radio ... tty1` terminal
prompt bar, a bordered CLIAMP panel with a song/state line, a green monochrome
audio-reactive visualizer, a `STREAMING`/`PAUSED`/`STOPPED` divider, an EQ
readout, a volume bar, a `Playlist -- [Shuffle][Repeat][idx/total]` header,
numbered station rows, and key-cap-styled hint chips at the bottom (solid-
background text spans faking a bordered key, since Rich/Textual can only
border a whole widget, never a span within a line).

**One deliberate departure, discussed with the user first via
`AskUserQuestion`** before building anything: the mockup's `EQ [ Rock ]` row
implies a genre EQ preset that actually reshapes the sound -- a real audio-
processing feature (mpv's superequalizer filter, switchable presets), not a
UI concern. Presented three options (real band levels / build a real genre
EQ / purely decorative); the user chose real band levels. That row now shows
the same real per-band levels already driving the visualizer, labeled `EQ
[Live]` rather than a fake preset name -- honest instead of decorative, and
no new audio-processing feature was needed. Also dropped two mockup elements
with no real backing data in this app (a `SRC 1/9` source counter, a `SPD
[1x]`/bandwidth footer) rather than fabricate plausible-looking numbers for
either.

Added `radio.RadioPlayer.get_volume()` (mirrors the existing
`get_position()`/`is_paused()` pattern) so the new volume bar reflects mpv's
real current volume via IPC, not a hardcoded value.

**Tested:** live verification throughout -- real playback, real audio-
reactive EQ/visualizer values changing with actual loudness, pause/resume
correctly reflected across all the new status lines (now/time/state/
divider/topbar icon), favoriting still works and persists. Confirmed clean
process shutdown via the real `action_quit()` path with a proper wait before
checking `pgrep` (an immediate check can false-positive on a just-issued
SIGKILL the OS hasn't finished reaping yet -- caught this exact false alarm
once during this work, then re-verified properly). Also found and killed one
genuinely stray leftover process from much earlier in this session's
original radio-feature build (28 minutes old, unrelated to this change) that
had escaped an earlier cleanup check -- a reminder to wait a beat before
trusting an immediate post-quit `pgrep`. Full pytest suite: 88 passed, 1
skipped, in a scratch venv. **CI (GitHub Actions) confirmed green on this PR
before calling it done** -- the previous PR (#43) revealed this repo has real
CI that hadn't been checked all session (main happened to stay green through
every earlier merge regardless), and needed three follow-up pushes before it
actually passed there, so this one was watched through to a real green run
first rather than trusting local-only verification again.

---

## 2026-08-27 (PR https://github.com/mukund1312/mtdo/pull/43) -- retro-terminal internet-radio player (CLIAMP-style)

User's ask: "a touch of coolness" in the music integration, inspired by a
retro-terminal music player mockup (CLIAMP: neon colors, ASCII visualizer,
station playlist, shuffle/repeat, favorites, keyboard hints). Scoped through
discussion (`AskUserQuestion`, twice) into: not a reskin of the existing
`NowPlayingPanel`; a genuine, self-contained internal radio player; real
audio-reactive visualizer, not a fake idle animation; reachable "with a
click" as a session you dip in and out of, separate from the existing
external-player remote control (which stays completely untouched).

**Architecture, verified live piece by piece before writing any UI code**
(matching this whole session's established practice -- see PLAN at
`~/.claude/plans/mossy-wandering-lighthouse.md` for the full design writeup):

- `mpv` (installed via `brew install mpv` for this work) does the real
  playback, controlled entirely via its `--input-ipc-server` JSON socket --
  confirmed live: connect, `{"command":["cycle","pause"]}`,
  `{"command":["get_property","time-pos"]}` all work exactly as documented
  against a real SomaFM stream.
- The audio-reactive visualizer needed a second, silent `ffmpeg` process
  against the *same* stream, split into 8 frequency bands each metered with
  `astats`. Two real bugs found and fixed during this verification, not
  guessed at from docs: (1) `ametadata`'s `file=` target buffers and never
  flushes for an indefinite (never-exits) run -- every real radio stream --
  so writing per-band level files looked like it worked in a short, bounded
  test (`-t 8`, which flushes cleanly on exit) but produced nothing at all
  during real, ongoing playback; switched to reading each band's
  `Parsed_ametadata_<N>` output straight off ffmpeg's own stderr, confirmed
  live to flush continuously (hundreds of samples/sec) while the process
  keeps running. (2) band instance numbers aren't 1,2,3 -- discovered and
  mapped in first-seen order instead of hardcoded, confirmed correct against
  real audio (bass ~-16dB, mid ~-33dB, treble ~-51dB, on the same instant).
- 11 stations (`radio.py`'s `STATIONS`), all real, all verified via `curl`
  (HTTP 200) before being added -- SomaFM and Nightride FM, both of which
  publish direct stream URLs specifically for third-party player
  integration, unlike the mockup's fictional "NCS Radio" stations, which
  don't correspond to any real 24/7 stream.

**New files:** `radio.py` (`RadioPlayer` -- owns the mpv+ffmpeg subprocess
pair per active station, IPC control, thread-safe level snapshots, SIGTERM-
then-SIGKILL shutdown mirroring `pty_panel.py`'s own two-step process
teardown), `radio_screen.py` (`RadioScreen`, a full `Screen` mirroring
`VaultScreen`'s pattern -- station list, live visualizer, favorites/shuffle/
repeat). `config.py` gains `radio_state.json` (favorites/last-station/
shuffle/repeat), following the existing `goals.json`/`state.json` plain-JSON
idiom rather than the marker-file pattern (doesn't fit a list+index+enum
shape). `app.py` owns one shared `RadioPlayer` for the whole app run --
reached via a new `R` keybinding or a clickable "🎧 Enter Radio Session"
button mounted right after the existing `NowPlayingPanel` -- and stops it
explicitly on quit (`_stop_claude_and_exit`), alongside the existing
`claude_panel.stop()` call.

**Two more real bugs caught by testing the actual new UI code, both fixed
before shipping:** (1) `StationItem`'s own helper was named `_render()`,
silently overriding `Widget`'s internal `_render()` (different signature) --
crashed on the very next real paint with a `TypeError` deep inside Textual's
own rendering internals. Renamed to `_build_label`. (2) `ListView`'s built-in
Enter binding intercepted the key before a same-named `RadioScreen`-level
binding ever fired -- confirmed live, Enter silently did nothing. Same class
of bug `pty_panel.py`'s own docstring already warns about for
`PracticeLabPanel` (a focused child widget's bindings win over an ancestor's
for the same key). Fixed by handling `ListView.Selected` instead of trying to
intercept "enter" at the Screen level.

**Tested:** full live end-to-end runs against real stations throughout
(navigation, playback, pause/resume via IPC, real audio-reactive visualizer
bars matching actual per-band levels, favorites/shuffle/repeat persisting
across closing/reopening the screen and a full app restart). Verified via the
*real* `action_quit()` path -- not just calling `stop()` directly -- that no
`mpv`/`ffmpeg` process survives mtdo exiting (`pgrep` empty afterward), the
single biggest risk this whole feature carries. 19 new tests in
`test_radio.py` (mocked `subprocess.Popen`/IPC socket, synthetic
ffmpeg-stderr parsing fed through the real parsing function, config
round-trips, 3 Textual-pilot screen tests) -- no real subprocess, audio, or
network touched anywhere in the suite. Full suite: 82 passed, 1 skipped, in a
scratch venv. Real `~/.mtdo` never touched -- all repro/testing used scratch
`MTDO_HOME`s.

No tracker bug for this -- came directly from the user in chat, nothing to
close.

---

## 2026-08-27 (bug gh55, GH mukund1312/mtdo-bugs#55, PR https://github.com/mukund1312/mtdo/pull/42) -- now-playing timer kept advancing while paused, then jumped back on resume

Bug, verbatim: "even when i stop the music player by pressing m the time goes
on and then when i play the song again the timer again back where it paused
previously and then start playing the time has to stop when i pause and start
when i play."

Root-caused live against a real, currently-playing Spotify session -- not
simulated. `nowplaying-cli get-raw`'s `PlaybackRate` key is present (e.g. `1`)
while genuinely playing and **disappears from the payload entirely** while
paused, confirmed by toggling real play/pause via `nowplaying-cli` and diffing
`get-raw`'s output each time. gh18's fallback-clock logic (2026-08-25) treated
a missing `PlaybackRate` as "assume playing," based on that commit's own
hand-testing at the time concluding Spotify never publishes one at all --
apparently true then, not true now (a Spotify update, a macOS change, or just
incomplete original testing; either way, today's ground truth is what matters).
That "assume playing" default made the position keep advancing via our own
gh18 extrapolation clock for the entire time a track was actually paused --
`m` correctly paused real playback but the *displayed* timer had no idea --
then visibly snapped back down to the real position once a fresh, correct
elapsed value arrived on resume. Exactly the reported symptom, reproduced
byte-for-byte before writing any fix.

**Fix (`music.py`):** added `_APPLESCRIPT_PLAYER_APPS` (Spotify, Apple Music)
and `_apple_script_is_playing(bundle_id)`, which asks the app directly via
`player state as string` -- confirmed live this correctly reports "paused" and
"playing" at the exact moments `get-raw`'s own payload can't tell the
difference. `_nowplaying_cli_info()` now calls this only when `PlaybackRate` is
absent, overriding the "assume playing" guess with real ground truth for these
two apps; anything else (e.g. a WebKit browser tab -- gh18's actual original
case, no AppleScript equivalent to ask) keeps the old guess unchanged, since
there's genuinely no better signal available for it.

**Tested:** live end-to-end against the real, currently-playing Spotify
session: paused via `music.play_pause()`, polled `music.now_playing()` every
~2s for 10s -- position stayed frozen exactly (previously climbed
continuously) -- then resumed and confirmed it continued from that exact
frozen point with no backward jump. Added 6 new regression tests to
`test_music.py`, matching its existing mocked style (real playback state isn't
reproducible in CI): `_apple_script_is_playing`'s three outcomes, paused-
Spotify-freezes, resumed-Spotify-advances, and unknown-app-still-assumes-
playing (confirms gh18's original WebKit case is unaffected). Full suite: 69
passed, 1 skipped, in a scratch venv.

---

## 2026-08-27 (bug gh53, GH mukund1312/mtdo-bugs#53, PR https://github.com/mukund1312/mtdo/pull/41) -- offer to save the recovery code locally, protected or not

Bug, verbatim: "user should be given choice to save the recovery code in local
with password protection or without the password protection and if selected
for password protection and let them set it and if no password just save it in
local and if doesnt want to save in local just move ahead after showing them
the recovery password." A genuinely well-specified three-way UX ask, not a
vague one -- implemented exactly as described, no clarifying questions needed.

**RecoveryCodeScreen** (shown once, right after creating a password-protected
profile) now follows up the code display with that exact choice: save a local
copy protected by its own separate password (set right there), save it as
plain text, or don't save one and just proceed (the only behavior that existed
before this). The local save is deliberately independent of the profile's own
password/data-key envelope -- gating the one thing meant to survive forgetting
that password behind that same password would defeat the entire point of a
recovery code.

Also added the natural read-back half: Manage Profiles' new "View Recovery
Code" button, shown only once `pf.has_local_recovery_code(slug)` is true --
without it, saving a copy would be write-only and pointless. Deliberately NOT
gated behind `_with_profile_auth` (the profile's own password, used for
rename/delete) for the same reason as above; the local save's own password (if
it has one) is the real gate. CLI gets the same choice in `profile create
--password`, plus a new `profile view-recovery-code <name>` command -- same
dual TUI+CLI treatment as gh51.

New `profiles.py` functions: `save_recovery_code_locally`,
`has_local_recovery_code`, `local_recovery_code_protected`,
`read_local_recovery_code` -- same PBKDF2+Fernet scheme as everything else in
the module, own random salt, stored as `recovery_code.json` inside the
profile's own directory so `delete_profile`'s existing `rmtree` already cleans
it up with no extra teardown needed.

**Two real bugs caught by testing my own new code, both fixed before
shipping:** (1) calling `.focus()` on a Button immediately after mounting it
inside `on_mount()` raised `NoMatches` -- a freshly-mounted Button isn't
reliably queryable in the same call that mounts it (Input doesn't have this
problem, which is why `ProfileCreateScreen`'s analogous step never hit it).
Fixed by not auto-focusing those buttons, matching `ProfileCreateScreen`'s own
convention for its structurally identical on-mount step. (2) reusing the same
widget id for the explanatory text across two different steps raised
`DuplicateIds`, since `.remove()` doesn't complete synchronously before the
next `.mount()` runs -- fixed by using a shared CSS class instead of a
repeated id.

**Tested:** live headless-pilot repro of all three save choices, a back-
navigation, and a mismatched-password retry, before writing permanent tests.
Confirmed the local save's password is genuinely independent -- the profile's
own password does not unlock a protected local save and vice versa. Confirmed
`delete_profile` cleans up the local save too. Verified the CLI path (create +
view-recovery-code, correct and wrong password) end-to-end via subprocess.
Added 4 new permanent regression tests. Full suite: 63 passed, 1 skipped, in a
scratch venv. Real `~/.mtdo` never touched -- all repro/testing used scratch
`MTDO_HOME`s.

---

## 2026-08-27 (bug gh52, GH mukund1312/mtdo-bugs#52, PR https://github.com/mukund1312/mtdo/pull/40) -- switching profiles auto-saves the outgoing one instead of re-prompting

Bug, verbatim (Janhwi): "while switchign the profile there should be auto save
instead of asking password again to save."

Root cause: switching from protected profile A to protected profile B asked for a
password *twice* -- once (correctly, per gh49's "ask every time" rule) to switch
into B, and once more purely to auto-save A on the way out via
`_save_current_profile()`, even though A's password had already been proven to
unlock it earlier in the same session (at startup or an earlier switch into it).
gh49 deliberately removed a cross-switch password cache, but that was about not
letting you skip re-entry when switching *into* a profile you'd visited before --
it was never about the profile you're *already, currently* in needing to reprove
itself just to be saved.

**Fix:** added `self._active_profile_password`, cached the moment a protected
profile's password is actually verified (startup unlock in `on_mount`, or a
successful `_switch_profile` call), cleared implicitly whenever a different
profile becomes active. `_save_current_profile()` now uses that cached password
directly instead of prompting, falling back to the old prompt only if the cache is
somehow unset (defensive, shouldn't happen in practice). This cache never touches
the switch-in path -- `target.get("protected") and password is None` still always
prompts, so gh49's protection is fully intact.

**Tested:** live headless-pilot repro before the fix confirmed 3 total password
prompts across one A -> B switch (unlock A at launch, switch into B, save A on the
way out); after the fix, exactly 1 (B's own). Verified A's data is genuinely
persisted correctly during the auto-save (wrote a marker into `state.json` while
active in A, read it back via `pf.read_state(slug_a, "pw-a")` after switching to
B). Confirmed gh49's own regression test
(`test_switching_to_protected_profile_always_reprompts_even_if_unlocked_earlier`)
still passes unchanged. Added a new permanent regression test,
`test_switching_away_auto_saves_without_reprompting`. Full suite: 59 passed, 1
skipped, in a scratch venv. Real `~/.mtdo` never touched -- all repro/testing used
a scratch `MTDO_HOME`.

---

## 2026-08-27 (bug gh51, GH mukund1312/mtdo-bugs#51, PR https://github.com/mukund1312/mtdo/pull/39) -- recovery-code reset validated too late

Bug, verbatim: "can change password and modify the profile with wrong reovery
code but it is on the top it says wrong recovery code but allows to change
password."

Reproduced live before touching anything (headless Textual pilot against a real
protected profile): the reset flow -- reached from either ProfileUnlockScreen's
"Forgot password?" or ProfileManageScreen's "Reset Password", and the CLI's
`profile recover` -- asks for the recovery code, then a new password, then a
confirmation, and only calls `pf.recover_profile()` (which is where the code
actually gets checked) at the very end. A wrong code still walked the user
through both password prompts before failing. The underlying reset was never
actually vulnerable -- `check_password`/`recover_profile` confirmed the
password never changes on a wrong code -- but the UX is indistinguishable from
"it let me change the password": the app doesn't say the code was wrong until
after you've already typed and confirmed a brand-new one.

**Fix:** added `profiles.check_recovery_code(slug, code)`, mirroring the
existing `check_password()` -- unwraps the recovery-wrapped data key without
rewrapping anything, i.e. a pure yes/no check. Both `app._reset_profile_password`
(TUI) and `cli.cmd_profile_recover` now call it immediately after the code is
entered, before asking for a new password at all. `recover_profile()` still
re-validates the code itself at the end (belt and suspenders, e.g. against the
profile record changing between the check and the actual reset).

**Tested:** live headless-pilot repro confirmed the bug (wrong code reached the
"New password" prompt) before the fix and confirmed the fix (wrong code now
rejects immediately, never leaving the lock screen) after. Happy path (correct
code) re-verified end-to-end: still resets and unlocks in one flow. Added
`test_forgot_password_rejects_wrong_recovery_code_immediately` as a permanent
regression test next to the existing happy-path test. Full suite: 59 passed, 1
skipped, in a scratch venv (repo has no pytest installed globally --
created and discarded `/tmp/mtdo_test_venv2`, same throwaway-venv convention as
before). Real `~/.mtdo` never touched -- all repro/testing used a scratch
`MTDO_HOME`.

---

## 2026-08-27 (PR https://github.com/mukund1312/mtdo/pull/38) -- dashboard: postponed status + durable notes sync

User's ask, verbatim: "asing it between me and janhwi and also give me an option to
chnage between the options like open fixed and postpon and also when i am leave a note
and janhwi is leaving a note we r not able to see it" -- three parts.

**"Assign whatever's unassigned between us"**: needed no code change. Checked directly --
`distribute_pending()` already keeps every *open* bug assigned; the only unassigned issues
on the tracker (#5-#9, #12-#16) are old, already-closed ones that predate the
auto-triage/distribution automation and were never re-touched. Confirmed by re-running
`distribute_pending()`, which returned `{'mukund1312': 0, 'janhwirai': 0}` -- nothing to do.

**Root cause of "we can't see each other's notes"**: not a live-sync bug. The dashboard's
`.assign-control`/`.thread-post` live-doc wiring (via the `artifact` capability's
`api.edit()`) is correct and does sync in real time between simultaneous viewers. The
actual gap: notes only ever lived in ephemeral live-doc DOM state, with no durable backing
store. Any republish of the artifact -- by this session or another -- replaces the entire
page and silently discards that state unless the publisher explicitly re-threads it via
`generate(overrides=...)`, which wasn't happening reliably (this same session saw five
rapid "republished by another session" notifications shortly before this fix, almost
certainly the actual mechanism that ate real notes).

**Fix, `bug_sync.py`**:
- `list_all()` now bundles `comments` into its existing bulk `--json` field list (`gh issue
  list` returns full comment bodies for every issue in one call, not just a count --
  confirmed empirically), so nothing needs an extra per-issue round trip.
- `bug_status(issue)` derives a 3-way status from GitHub's binary open/closed: `"fixed"` if
  closed, `"postponed"` if open with a new `status:postponed` label, else `"open"`.
- `set_status(number, status)` applies that back to real GitHub state (close/reopen +
  add/remove the label; closing always clears `postponed`, since closed+postponed is
  meaningless).
- `sync_dashboard_overrides(overrides)`: the actual durability fix. Given whatever changed
  live on the currently-published page, pushes status/assignment changes to real GitHub
  state and posts new notes as real `gh issue comment`s (skipping ones already posted, so
  it's safe to call repeatedly with the same overrides). Best-effort per issue/field so one
  failure doesn't block the rest.

**Fix, `dashboard.py`**:
- `generate()` now calls `bug_sync.sync_dashboard_overrides(overrides)` *before*
  re-fetching fresh issue state -- so the very same call that could otherwise discard live
  state now durably preserves it first, regardless of whether the caller remembers to do
  anything special.
- Notes render from real GitHub comments (`_render_comment_notes`) instead of purely from
  `overrides["notes"]`, so they survive a page reload/republish either way. A comment
  that's a synced note carries its real author inside the body text itself (`"Mukund:
  ..."`) since the `gh` CLI that posts it always runs as whoever's machine ran the sync,
  not whoever typed it in the browser -- rendered as-is; anything else (a plain GitHub
  comment) gets its author from the real comment metadata instead.
- Added a status control (`_render_status_control`) in the issues table and issue detail
  view, matching the existing assignment-picker's exact interaction pattern (click to open,
  click an option, live-doc edit ops, immediate visual update).
- `getRowsData()` switched from inferring open/closed by sniffing for a `.pill-open` CSS
  class to explicit `data-state`/`data-status` attributes set directly at render time --
  the old sniffing would have silently misclassified postponed bugs as closed, since a
  postponed row has no element matching `.pill-open` once the pill became a dynamically
  classed button. Caught by reasoning before shipping, not live.

**Tested:** Full pytest suite (54 passed, 1 skipped) against current `main` in a scratch
venv (repo has no pytest installed globally; created and discarded `/tmp/mtdo_test_venv`,
matching the project's established throwaway-venv convention). `bug_status`/`set_status`
transitions (open -> postponed -> fixed -> open) and `sync_dashboard_overrides` (status +
assignment + notes, idempotent on repeat) verified live against a real disposable GitHub
issue, created then deleted. End-to-end `dashboard.generate()` verified to post a note
through to a real GitHub comment and render it back correctly. Checked the live artifact
for pending notes immediately before republishing (none existed, so nothing was at risk of
being lost by this regeneration). Real `~/.mtdo/{goals.json,state.json}` untouched
throughout -- confirmed unchanged mtimes.

No local bug_log/tracker issue closed for this piece of work -- it came directly from the
user in chat, not through the dashboard's own bug-report flow, so there was no tracker
issue to close.

---

## 2026-08-25 (bug gh28, GH mukund1312/mtdo-bugs#28) -- walkthrough reordered, and a shared "Setup N of M" indicator across the whole first-run sequence

Bug's literal mechanism no longer exists: it described a gap while waiting on
an in-app AI call during onboarding, but gh47 (2026-08-24) already removed
that AI call entirely -- setup is now export/paste-to-any-AI/import, nothing
in-app blocks on a network call. Confirmed live before touching anything:
dismissing the walkthrough transitions directly into the next modal
(ProfileCreateScreen), never exposing the bare empty board for even a frame.
Superseded, same situation as bugs #6/#13 earlier this session.

The user's real ask in the same message: make the walkthrough more intuitive,
gave ideas, asked for scoping questions first. Presented two concrete,
grounded options (not generic advice) and let the user pick:

1. **Reorder the walkthrough's 10 steps** so the ones most people act on right
   away (Board, Adding Cards, Focus Mode, the always-on Learning Coach/AI
   panel) come before the more specialized/optional ones -- Practice Lab
   (DSA/SQL practice specifically) and Career CRM (job-hunting specifically)
   now sit right before the closing step instead of interrupting the core
   flow, with Pomodoro & Music and Stats moved earlier since they're more
   universally relevant. User picked "reorder, keep all 10 steps" over
   trimming the walkthrough's length.
2. **A shared "Setup N of M" progress indicator across the whole first-run
   sequence** -- previously the walkthrough (with its own internal "Walkthrough
   n/11" numbering), the automatic profile step (gh48), and "how do you want to
   build your plan" (gh47) had no sense of being one continuous setup; each
   felt like an unrelated new screen. User picked adding it.

**What shipped:** `OnboardingScreen`, `ProfileCreateScreen`, `ProfileMenuScreen`,
and `ChoicePickScreen` (all four reused elsewhere in the app outside
onboarding -- the footer profile badge, 'g'/`action_plan_wizard`, 'w'/
`action_replay_walkthrough`) each gained an optional `step_label=None`
constructor param, defaulting to no change anywhere else they're used.
`_begin_setup_flow(step_offset=0, total_steps=2)` and `_pick_populate_method`
now compute and pass the right label at each of their three real entry
points: the genuine first-run trigger (`on_mount`, walkthrough included --
offset=1, total=3, so the sequence reads 1/3 -> 2/3 -> 3/3), a manual re-run
via 'g' (no walkthrough -- the defaults, 1/2 -> 2/2), and "onboarded before,
never configured" (same 2-step case). A standalone walkthrough replay via 'w'
passes no label at all, correctly, since it isn't part of a larger sequence.

**Verified for real, at every entry point, not just the one that's exercised
most often:** a live headless run confirmed the new step order
(`ONBOARDING_STEPS` titles printed in sequence) and the full 1/3 -> 2/3 -> 3/3
labeling through a real first-run walkthrough-skip -> profile-create ->
populate-method-choice chain with real key dispatch. Separately confirmed the
manual 'g' path reads 1/2 -> 2/2 (not 1/3 -> 2/3, which would have been wrong
-- no walkthrough precedes it there) and that 'w' shows no label at all.
Formalized all three as permanent regression tests in a new
`tests/test_onboarding.py` -- the first-run test specifically has to remove
and restore `conftest.py`'s session-wide "onboarded" marker (pre-set once so
every *other* test in the shared session doesn't hit the walkthrough) to
actually exercise a genuine first run; caught this the hard way when the test
first failed by landing straight on `ProfileCreateScreen` instead of
`OnboardingScreen`, confirming the marker really was shared across the whole
suite as conftest.py's own docstring says. 36/36 tests pass (33 previous + 3
new), including a repeat full-suite run to rule out state leakage from the
marker-file manipulation. Real `~/.mtdo/goals.json`/`state.json` mtimes
unchanged throughout.

---

## 2026-08-25 (bug gh37, GH mukund1312/mtdo-bugs#37) -- added CONTRIBUTING.md

Docs-only bug: no `CONTRIBUTING.md`, so an outside contributor had no doc
explaining the `core.py`/`app.py` architecture split or how to actually submit
a change.

Wrote `CONTRIBUTING.md` for a human external contributor specifically --
deliberately not a trim of `~/.claude/agents/mtdo-dev.md` (that file's
audience is this AI agent across sessions: "read PROGRESS.md first," internal
gotchas, the private bug-tracker workflow). Covers: the `core.py` (UI-agnostic
model) vs `app.py` (Textual presentation) split and *why* it matters in
practice (grounded in the real reason -- `cli.py`'s scriptable subcommands
reuse `core.py` directly with zero Textual involved; logic that leaks into
`app.py` silently breaks that second consumer and becomes untestable without a
running app), a trimmed module map, local setup via `mtdo-sandbox` (never real
`~/.mtdo`), how to run tests, this repo's actual code conventions, and a
fork+branch+PR submission flow appropriate for an external contributor (not
the internal `mu`/`UAT` branch-naming shorthand, which is Mukund/Janhwi-
specific and meaningless to anyone else). Pointed bug reports at this public
repo's own GitHub Issues -- **deliberately never named the private
mukund1312/mtdo-bugs tracker anywhere in this doc**, checked explicitly before
publishing, since that repo's entire reason for existing is that internal
testing bugs stay private even though mtdo itself is public; naming it in a
public-facing doc would defeat that. Added a one-line pointer from README.md
so the doc is actually discoverable.

Found, didn't touch: a pre-existing `GITHUB_SYNC_WORKFLOW.md` at the repo root
describes the *old*, pre-2026-08-22 direct-push-to-main workflow, which
directly contradicts the current feature-branch+PR convention this very
CONTRIBUTING.md documents. Left it alone rather than unilaterally deleting or
rewriting a file outside this bug's actual scope -- flagged to the user
instead, since a contributor who finds that file instead of (or in addition
to) CONTRIBUTING.md would get actively wrong instructions.

**Verified for real:** confirmed every specific claim (`core.configure()`,
`goals_to_config()`, `cli.py`'s subcommand list, `code_runner.py`'s
sandboxing docstring, `config.ConfigError`, `tests/conftest.py`'s throwaway
`MTDO_HOME`, `.github/workflows/ci.yml`'s `ubuntu-latest` runner, the public
repo's Issues actually being enabled) against the real current code/repo
state rather than writing from memory or convention. Ran the full test suite
as a sanity check for a docs-only change (33/33 pass) and grepped the new
file for any accidental reference to the private bug tracker before
publishing. Real `~/.mtdo/goals.json`/`state.json` mtimes unchanged.

---

## 2026-08-25 (bug gh18, GH mukund1312/mtdo-bugs#18) -- now-playing position no longer freezes for YouTube Music (or anything else in a browser tab)

Root cause found live, on real data, before writing any fix: polled the real
MediaRemote session on this machine while a browser tab was actively playing
at 2x rate. `kMRMediaRemoteNowPlayingInfoElapsedTime` sat at a literally
identical value across 9+ seconds of continuous polling, and
`kMRMediaRemoteNowPlayingInfoTimestamp` was never present in the dict at all.
music.py's existing extrapolation logic (added for exactly this class of
problem) only engages when both Timestamp and PlaybackRate are present -- a
browser/WebKit source (YouTube Music, or anything else playing in a tab)
never publishes Timestamp, so that logic never activated for it and the
displayed position just sat frozen between MediaRemote's own infrequent,
source-controlled snapshot pushes.

**What shipped:** a fallback extrapolation path in `_nowplaying_cli_info()`
for when the source doesn't supply its own Timestamp -- track our own
wall-clock moment (`time.monotonic()`) we first observe each distinct
`elapsed` value for a given track (`_fallback_snapshot`, module-level, keyed
on UniqueIdentifier + elapsed), and extrapolate position forward from that
using our own clock instead, scaled by whatever PlaybackRate the source
reports (assume 1x if it reports none at all, matching the existing "assume
playing" convention elsewhere in this function). A genuinely new snapshot
from the source (a real position jump, a seek, or MediaRemote occasionally
pushing an actual update) resets the baseline instead of compounding drift on
top of a stale one. Paused (rate 0) correctly freezes exactly at the reported
elapsed value, same as before -- only advances while actually playing. Also,
as a side effect (not the reported bug, but the same underlying gap): this
also smooths Spotify's own between-snapshot staleness, since Spotify's raw
MediaRemote entries include neither Timestamp nor a useful Rate either --
noted honestly in the docstring as a bonus, not claimed as something
separately verified for Spotify specifically.

**Verified for real, against actual live playback, not synthetic data
first:** watched the real raw MediaRemote elapsed value stay frozen at 76.72
for a genuinely-playing 2x-rate browser session across three real 3-second
polls before touching any code, to confirm the root cause precisely. After
the fix, polled the same live session six times over ~10 real seconds and
watched position actually advance -- 76.72 -> 81.21 -> 85.69 -> 90.15 ->
94.61 -> 99.10s -- while the underlying raw elapsed value it's built on
stayed frozen at 76.720 the entire time, confirming the fix operates
correctly on top of the real, still-broken MediaRemote data rather than
depending on that data somehow being fixed. Separately confirmed live that
pausing the real session correctly freezes position exactly where it was
(no drift while paused). Then, since real playback state isn't reproducible
in CI, formalized the exact scenarios as 4 deterministic regression tests in
a new `tests/test_music.py` (mocked `subprocess.run` output + monkeypatched
`time.monotonic` so the extrapolation math is checked exactly, not just "a
plausible number came out"): frozen-elapsed-advances-in-real-time (the gh18
case), paused-stays-frozen, a-genuinely-new-snapshot-resets-the-baseline, and
source-provided-Timestamp-still-preferred-when-present (confirming the
fallback is additive, doesn't change existing native-app behavior). 33/33
tests pass (29 previous + 4 new). Real `~/.mtdo/goals.json`/`state.json`
mtimes unchanged throughout.

---

## 2026-08-25 (bug gh38, GH mukund1312/mtdo-bugs#38) -- Practice Lab code execution now has real, verified sandboxing

Unlike the other bugs this session, this wasn't a UI/discoverability gap -- it
was a genuine "how much security engineering is proportionate for a personal
terminal app" question. `code_runner.run()` executed submitted code via plain
`subprocess.run()` with mtdo's own full user permissions, no isolation
whatsoever; the module's own docstring just said "don't paste code here you
wouldn't otherwise just run" and left it there. Asked the user to pick a real
scope before touching anything: OS-level sandbox + resource limits (macOS
Seatbelt + POSIX rlimits, no new dependency), resource-limits-only with a
louder warning, or full Docker-based isolation (real cost: a hard new
dependency and a much slower run loop). They picked the first.

**What shipped, in `code_runner.py`:**
- On macOS: every run wrapped in `sandbox-exec` (Apple's built-in Seatbelt
  profile mechanism) with a deny-by-default profile -- all network access
  denied outright, writes confined to the practice directory plus this
  process's own session temp dir (both resolved via `os.path.realpath`, since
  Seatbelt matches post-symlink paths and /tmp and the macOS temp dir are both
  symlinks into /private). File reads stay open -- interpreters/compilers need
  broad read access to function at all -- documented as an explicit, honest
  limit, not hidden.
- On every platform (including when sandbox-exec isn't available, e.g. Linux):
  POSIX resource limits via a `preexec_fn` -- CPU time, max file size, process
  count -- as an independent backstop.
- `sandbox_status()` reports exactly which of the above is actually active,
  shown directly in the Practice Lab's output panel every run (not just
  documented in source) -- the disclosure is in front of the user every time,
  matching the actual macOS-mockup preview the user approved when scoping this.
- `_java_home()`: resolves JAVA_HOME once, unsandboxed, and invokes javac/java
  by their real binary path -- `/usr/libexec/java_home` itself doesn't function
  correctly from inside the restrictive Seatbelt profile (confirmed by hand:
  "Unable to locate a Java Runtime" even with every write path it could
  plausibly need already granted), so this sidesteps its own lookup entirely
  rather than chasing down exactly which grant it was missing.

**Three real bugs found and fixed only because this was tested against the
actual toolchains before shipping, not just written and assumed correct:**
1. A first Seatbelt profile draft broke javac/gcc/g++ outright ("unable to
   make temporary file" / "Unable to locate a Java Runtime") -- all three need
   to write scratch files under $TMPDIR, which the first draft didn't grant.
2. Generalizing from "this specific test subdirectory needs write access" (what
   was actually verified) to "allow bare /tmp and /var/folders broadly" (what
   got written into the real implementation) silently defeated the actual
   write-confinement guarantee -- a test deliberately checking the DENY path
   (not just that the happy path still ran) caught a file writing successfully
   to /tmp when it should have been refused.
3. RLIMIT_NPROC=100 broke gcc/g++/javac's own internal posix_spawn calls on
   this ordinary dev machine, which already had ~400 processes running for the
   user across everything else open -- RLIMIT_NPROC is a per-real-UID limit,
   not scoped to the subprocess's own tree, so a small absolute cap collides
   with normal background load. Raised to 1000 (comfortable headroom above
   real usage, still fast against a genuine exponential fork bomb). Separately,
   the CPU time limit was originally derived from each call's own wall-clock
   timeout (`timeout + 2`), which by construction can never fire before that
   timeout -- dead code for every call. Fixed to a fixed, timeout-independent
   constant (`_CPU_TIME_LIMIT_SECONDS`), confirmed by deliberately loosening
   the wall-clock timeout to 30s specifically to prove the CPU limit is the one
   that actually kills it (it now does, at ~15s).

**Verified for real, exhaustively, before and after each fix:** every claim
above was checked against real subprocesses on this machine, not assumed from
reading Seatbelt documentation -- python3/javac+java/gcc/g++/sqlite3 all run
correctly under the final profile; a real network connection attempt is
denied; a write to a path deliberately outside every allowed directory is
denied AND confirmed the file was never created; a CPU-bound busy loop is
killed independent of the wall-clock timeout; `explain_sql`'s two subprocess
calls (also user-supplied SQL) got the same treatment. All of this then
formalized as 9 permanent regression tests in a new
`tests/test_code_runner_sandbox.py`, including regression tests for both of
the real bugs found while building this (bug 2's write-confinement test
deliberately avoids pytest's own `tmp_path` fixture, since that lives inside
the same session temp dir the sandbox legitimately grants -- using it would
have passed for the wrong reason). macOS-only assertions are skipped on CI
(ubuntu-latest) by design, matching that this protection genuinely is
macOS-only; language tests skip individually if a toolchain isn't installed
on whatever machine runs them. 29/29 tests pass (20 previous + 9 new). Real
`~/.mtdo/goals.json`/`state.json` mtimes unchanged throughout.

**CI-only follow-up, same day, before merge:** PR's actual CI run (ubuntu-
latest) failed on two things neither Mac testing above could have caught:

1. `test_java_runs_correctly_under_the_sandbox` -- the JVM itself failed to
   start ("Could not create G1ServiceThread", pthread_create EAGAIN).
   RLIMIT_NPROC=1000 (raised from 100 earlier the same day specifically to fix
   a *different* per-real-UID collision on a Mac -- see above) turned out to
   have a second, unrelated failure mode on Linux: RLIMIT_NPROC there also
   counts threads (NPTL implements each as its own kernel task), and a JVM's
   own GC/service/JIT threads at startup can eat a meaningful chunk of
   whatever number gets picked, stacked on top of a CI container's own
   different baseline. No single absolute value is confirmed safe against both
   failure modes (a real dev machine's per-UID process count, and a
   container's per-process thread count) -- dropped RLIMIT_NPROC entirely
   rather than ship a third guess. Fork-bomb impact is still bounded by
   RLIMIT_CPU (shared across every descendant) and the wall-clock timeout,
   just not as immediately as a hard process cap would have been.
2. `test_manage_profiles_reset_button_says_reset_password` (from an earlier,
   already-merged PR) failed with `NoMatches: ClockHeader` inside
   `on_second_tick`. Confirmed this wasn't pre-existing -- `main`'s own CI runs
   were green through every merge up to and including this PR's base commit --
   so today's new, genuinely slow subprocess-heavy tests (java/gcc/g++
   compiles, a real ~15s CPU-limit test) shifted CI's timing enough to expose
   a latent race for the first time: a previous test's `set_interval` timer,
   still scheduled at the moment its app exited, firing once more into an
   already-torn-down screen stack. Fixed defensively rather than chasing the
   exact scheduling race: both `on_second_tick` and `check_goals_file` (the
   app's only two ambient interval callbacks) now check `self.is_running`
   first and no-op if the app has already exited.

Re-ran the full suite locally after both fixes (29/29 still pass) before
pushing. Pushed, re-ran CI: the ClockHeader fix worked, but Java still
failed with the exact same error -- RLIMIT_NPROC was never actually the
cause. The real culprit was RLIMIT_AS (1.5GB), which had silently never
applied on macOS the entire time it was "confirmed working" there (the same
Darwin/XNU quirk noted when it was first added: setrlimit refuses to lower
it from unlimited) -- every earlier Mac test run was unknowingly running
with zero memory cap. On Linux it's fully enforced, and a JVM reserves
several GB of virtual address space upfront even for a trivial program, so
a cap that had never once actually been exercised against real Java startup
broke it immediately in CI. No size is plausibly safe against both "small
enough to matter as a real cap" and "large enough for whatever a JVM
reserves on a bigger host" without testing combinations this can't cover --
dropped RLIMIT_AS entirely too, for the same reason RLIMIT_NPROC was
dropped. What's left (RLIMIT_CPU + RLIMIT_FSIZE) are the two limits
actually confirmed to do something real, on both platforms, without
breaking any of the five languages. Pushed again; CI passed clean on this
second follow-up commit, full green including Java. Genuine lesson from
this whole detour: a limit that silently never applies on your only test
platform isn't verified, it's untested, and macOS's specific RLIMIT_AS
quirk actively hid that distinction.

---

## 2026-08-25 (bug gh39, GH mukund1312/mtdo-bugs#39) -- a bad goals.json/config.yaml now fails with a clear message instead of a raw traceback

Bug's own framing: a malformed hand-edit doesn't corrupt history (state.json
etc. stay untouched either way -- confirmed still true), but gives "just a
Python exception" instead of a clear error. Traced the three real places this
actually happens: `config.load_goals()`'s `json.load` (bad JSON syntax),
`config.goals_to_config()`'s category loop (`cat_def["name"]` -- a category
missing its name), and `core.configure()`'s per-category dict access
(`meta["label"]`, `meta["days"]`) -- the last of which is the *exact* crash
(`KeyError: 'label'`) hit live earlier this same session while testing an
unrelated fix with an oversimplified test goals.json, which turned out to be
a perfect live reproduction of this bug rather than just a test-script mistake.

**What shipped:** a new `config.ConfigError` -- callers catch this specifically
and show `str(e)` directly (already written for a person, not a traceback).
Added validation + clear messages at all three real failure points, plus
`config.load_config()`'s `yaml.safe_load` (bad YAML) for parity. Wired into
both places that actually load config:
- `cli.py cmd_run` (CLI startup, before the TUI or its own crash screen even
  exists): catches `ConfigError`, prints a clean two-line message, exits
  cleanly instead of a raw traceback dumped straight to the terminal.
- `app.py TodoApp.reload_from_goals()` (live in-app reload -- `check_goals_
  file` polls every 2s for external edits): this is the sharper failure mode --
  a bad hand-edit made *while the app is already running* used to crash the
  whole session almost immediately after the bad save. Now catches `ConfigError`
  at every stage of the pipeline, keeps showing whatever config was last
  successfully loaded, and toasts a clear red error (regardless of the
  `toast_on_change` flag -- that only ever gated the cosmetic "reloaded"
  message, a real problem needs to surface either way). Recovers automatically
  once the file's fixed, same as any other external edit.

Real bonus fix found while rewriting `core.configure()`: it used to reset
`CATEGORY_META = {}` and populate it one category at a time in a loop, so a
crash partway through (the old unguarded `KeyError`, or now a validation
failure) left it *half*-populated -- some categories present, others silently
gone, for the rest of the running session, on top of the raw-traceback problem.
Rewrote it to build everything into locals first and only assign the module's
globals at the very end, atomically -- a failed reload now leaves the app
exactly as it was, not almost as it was.

**Verified for real:** all three original crash points reproduced directly
against real malformed input (bad JSON syntax, wrong top-level JSON shape,
categories not a list, a category missing "name", a category missing "label")
and confirmed each now raises `ConfigError` with a specific, readable message.
Then the two integration points: `cli.main()` invoked with a broken goals.json
on a bare `mtdo` startup -- clean two-line message, exit 1, no traceback. Then,
more importantly, a full headless `App.run_test()` Pilot run: a real running
app with valid state, hand-edit goals.json to garbage mid-session, trigger the
same `check_goals_file` path the poll would, confirm the app is still running
(not crashed), confirm the previous category state survived untouched, confirm
a clear toast appeared, then fix the file and confirm the app picks the fix
back up automatically -- repeated for both the JSON-syntax failure and the
missing-required-field failure (the exact `KeyError: 'label'` scenario).
Formalized as 7 permanent regression tests in a new `tests/test_config_
validation.py`. 20/20 tests pass (13 previous + 7 new). Real `~/.mtdo/goals.
json`/`state.json` mtimes unchanged throughout.

---

## 2026-08-25 (gh49, second follow-up) -- fixed a real lockout bug in the launch lock screen, relabeled "Reset" to "Reset Password"

The user pointed out `ProfileUnlockScreen` (shipped earlier the same day) had
no "forgot password" path at all. Checked the code to confirm rather than take
it on faith: correct -- that screen blocks on_mount *before* the rest of the
app even constructs, and the only place the recovery-code reset flow lived was
Manage Profiles, which is unreachable if you can't get past the lock screen in
the first place. Someone who genuinely forgot their password, even holding
their real recovery code, had no way back in through the app at all -- the
lock screen I shipped earlier today had accidentally made the whole recovery-
code system (gh40) unreachable for its actual intended use case. A second,
smaller ask in the same message: rename Manage Profiles' "Reset" button to
"Reset Password" -- a bare "Reset" reads as wiping the profile back to empty.

**What shipped:**
- Added a "Forgot password?" button to `ProfileUnlockScreen`, wired through
  the same `TodoApp._reset_profile_password` Manage Profiles already used.
  Added an `on_done(new_password)` callback param to that method (default
  None, so Manage Profiles' existing call is unaffected and just toasts) --
  the lock screen's button passes `self.dismiss` directly as `on_done`, so a
  successful reset unlocks straight into the app with the new password
  instead of making the user retype it.
- Renamed the Manage Profiles row button from "Reset" to "Reset Password"
  (new CSS class `.profile-row-action-wide`, width 18, since "Reset Password"
  doesn't fit the other rows' width-10 buttons).

**Verified for real:** a from-scratch headless Pilot script simulating the
actual failure mode -- launch into the lock screen, deliberately never try the
real password, Tab straight to "Forgot password?", walk the recovery-code ->
new-password -> confirm chain with real key dispatch, confirm it lands
unlocked in the running app (not back at the lock screen or stuck on a
prompt), confirm the new password works and the old one doesn't. Then the
label change, confirmed via `Button.label` on the actual mounted widget, not
just reading the source. Both formalized as permanent pytest regression tests.
13/13 tests pass (11 previous + 2 new). Real `~/.mtdo/goals.json`/`state.json`
mtimes unchanged throughout.

---

## 2026-08-25 (gh49 follow-up) -- password protection now gates app launch, every switch, and rename/delete/authenticated Manage Profiles actions

Re-raised after gh44/gh49 shipped: the user asked for three more specific
gates, in their own words -- (1) switching between profiles inside a running
app should ask for the password every time, not just once; (2) rename/delete/
reset in Manage Profiles should require the password first, "if not anyone
can delete my profile"; (3) launching the app should show a login-style gate
for the active profile if it's protected, not boot straight into its data.
Explicitly invited scoping questions ("if any doubts ask me"), so before
writing anything: laid out the two real tradeoffs and asked.

Tradeoff 1 -- how far the launch gate goes. A "lock screen" only closes "the
app itself opens with no password"; a true fix (nothing plaintext persists
between runs) needs wiping/re-encrypting the working copy on quit, and mtdo
has no crash hook, so a crash would still leave plaintext behind regardless.
User picked the lock-screen-only option, with that limitation understood.

Tradeoff 2 -- whether a password is remembered for the rest of a running
session after the first entry, or asked on literally every switch. User
picked "always re-ask," the stronger/more literal reading of "each time."

**What shipped:**
- `ProfileUnlockScreen` (new): blocks `on_mount` before any of the rest of
  startup runs (moved into a new `_finish_startup()`) if the active profile is
  protected. No Escape-to-bypass, unlike every other modal in the app --
  quitting (Ctrl+C) is the only way out besides the right password.
- Removed `self._profile_passwords` entirely (was a `{slug: password}` cache
  reused across separate switch/save calls within one running session).
  `_switch_profile` and `_save_current_profile` now always prompt fresh for a
  protected profile's password, every time -- including switching back to a
  profile that was already unlocked once earlier in the same session. Also
  fixed a latent bug while in there: canceling the switch-password prompt
  (Escape) used to recurse back into asking again forever instead of actually
  canceling the switch.
- `_with_profile_auth()` (new): gates Manage Profiles' Rename and Delete
  behind the profile's own password when it's protected -- before this,
  either worked with zero authentication, so anyone at the app could rename,
  or permanently delete (encrypted files, recovery-code envelope, all of it,
  via `delete_profile`'s `shutil.rmtree`), a protected profile without ever
  knowing its password. Unprotected profiles are untouched by this --
  Deliberately did NOT gate Reset the same way: it's already gated by the
  recovery code, which is the whole point of a flow that exists precisely for
  when you've lost the password -- requiring the old password there would
  defeat it.

**Two real bugs found while building this, both fixed before shipping:**
1. `ProfileUnlockScreen.__init__` did `self.name = name` -- collides with
   Widget/Screen's own read-only `name` property, crashing on mount
   (`AttributeError: property 'name' ... has no setter`). Renamed to
   `self.profile_name`.
2. The launch-gate feature exposed a real test-isolation gap: `conftest.py`'s
   shared-MTDO_HOME-across-tests design only ever guaranteed profile *names*
   stayed unique per test, not which profile was *active* -- that never
   mattered until a protected active profile could now block the very next
   test's `TodoApp()` construction on launch. Fixed with a new
   `profiles.clear_active()` plus an autouse `_clear_active_profile` pytest
   fixture that resets it after every test.

**Verified for real:** a from-scratch headless `App.run_test()` Pilot script
(not the pytest suite yet at that point) walking through all five scenarios
with real key dispatch and two real profiles (one protected, one not): launch
blocked and rejects a wrong password, unlocks on the right one; switching to
an unprotected profile is silent, switching back to the one already unlocked
at launch still re-prompts; Delete on a protected profile is blocked on a
wrong password and the profile survives, then actually deletes with the right
password + existing name-confirmation step; Rename is gated the same way and
succeeds with the right password. Then formalized as three permanent pytest
regression tests. 11/11 tests pass (8 previous + 3 new). Real
`~/.mtdo/goals.json`/`state.json` mtimes unchanged throughout (still 17 Aug /
20 Aug) -- and confirmed the real machine has no profiles at all yet, so none
of this could have touched real data even accidentally.

---

## 2026-08-25 (bugs gh44 + gh49, GH mukund1312/mtdo-bugs#44 #49) -- profile password protection is now an explicit choice, not a skippable field

Two independent testers, same underlying confusion: switching profiles never
asked for a password, and (gh44) what happens if you forget it -- but the second
half was already answered by gh40's recovery code, shipped just before gh49 was
even filed. Investigated live before writing any code (per the user's standing
instruction to actually test, not assume): created an unprotected profile and a
protected one directly against `profiles.py`, read both goals.json files off
disk. Protected one was real Fernet ciphertext, unreadable outside the app;
unprotected one was plain JSON -- the encryption mechanism was already correct
and already covered goals.json, exactly what gh49 was asking for. So the gap
wasn't the crypto, it was `ProfileCreateScreen`: password protection was a
"Password (optional)" text input with zero explanation, sitting right next to
the Save button -- trivial to blow past without registering it as a decision,
which is exactly what both testers apparently did.

Asked the user how far to take the fix: make protection mandatory for every
profile, or keep it optional but turn it into a real explained decision instead
of a field. They picked the latter.

**What shipped:** `ProfileCreateScreen` now shows the profile name field, then a
mandatory Yes/No step with the actual consequence spelled out ("Without one,
this profile's goals/state files are stored as plain, readable JSON -- anyone
with access to this computer can open and read them directly"). "No" finishes
immediately -- the explanation was already on screen at the moment of that
choice, which is the actual fix; a second confirmation screen would just be
friction, not more informed consent. "Yes" reveals password + confirm inputs
(new: a confirm field didn't exist before at all -- a typo used to just become
your new permanent password with no way to catch it), Save creates the profile
and shows RecoveryCodeScreen (gh40) same as before. Mismatched passwords toast
and let you retry rather than silently using one of the two typed values.

The old 2-tab "skip the password field" muscle memory still works by design --
name, tab, tab lands on "No, keep it unprotected", enter -- same keystrokes as
before, now landing on an explicit decision instead of an empty field. Verified
this deliberately, not by accident: it's what let the pre-existing
`test_creating_profile_updates_header_immediately` keep passing unmodified.

CLI parity: `mtdo profile create` without `--password` (already an explicit flag,
not a skippable field, so no UI change needed there) now prints a one-line note
that the profile's files will be plain JSON and how to fix it.

**Verified for real:** the on-disk plaintext-vs-ciphertext check above before
touching anything; then three full headless `App.run_test()` Pilot runs through
real key dispatch: (1) the old 2-tab shortcut still produces an unprotected
profile, (2) the new Yes path types a password+confirm, creates a protected
profile, and shows a real recovery code, (3) mismatched passwords toast, refuse
to create the profile, and let the screen stay open for a retry. All three
added as permanent regression tests (`test_creating_profile_with_password_shows_
recovery_code`, `test_creating_profile_mismatched_passwords_does_not_create_it`).
8/8 tests pass. Real `~/.mtdo/goals.json`/`state.json` mtimes unchanged (17 Aug /
20 Aug) throughout.

---

## 2026-08-25 (bug gh40, GH mukund1312/mtdo-bugs#40) -- password-protected profiles can now be recovered via a one-time recovery code

Bug: forgetting a protected profile's password destroyed the profile's data
permanently, by design -- the module docstring said as much explicitly. The
tester's own logged note on the bug: "ok genuinely understandable i will take
care of this" -- an acknowledged tradeoff, not dismissed as fine as-is. Asked the
user how to handle it (real recovery path vs. just a stronger warning vs. a
weaker security-question fallback); they picked the recovery-code option.

**What shipped:** envelope encryption. `create_profile()` now generates a random
per-profile data key (what goals.json/state.json are actually Fernet-encrypted
with) and wraps it twice -- once under a key derived from the password, once
under a key derived from a randomly generated recovery code shown to the user
exactly once, right after creation (`RecoveryCodeScreen` in the TUI, printed
directly in the CLI). Either secret independently unwraps the same data key, so
forgetting the password no longer means losing the data, as long as the recovery
code was saved -- while mtdo still never stores anything that alone decrypts a
profile (no server-side escrow, same guarantee as before). Losing *both* secrets
is still unrecoverable, which is the honest remaining tradeoff of real local
encryption -- now documented in profiles.py's module docstring in place of the
old "no recovery mechanism" language.

Replaced the old separate "verifier" token (an encrypted known constant, only
used to check a password) with the wrapped-key unwrap itself doing double duty --
one less thing stored, one less thing that could drift from the real key.
`check_password()`'s behavior/signature is unchanged.

New: `profiles.recover_profile(slug, recovery_code, new_password)` -- rewraps the
data key under a new password-derived key without touching goals.json/state.json
(they're encrypted with the data key, never with either wrapped copy directly),
and without needing the old password. The recovery code stays valid afterward
(not single-use) -- losing a password a second time is exactly as forgivable as
the first. Wired into the TUI as a "Reset" button on ProfileManageScreen's row for
protected profiles (recovery code -> new password -> confirm, three chained
`TextPromptScreen`s via `_push_modal`, same dismiss-then-push hazard as
rename/delete), and into the CLI as `mtdo profile recover <name>`.

`create_profile()`'s return value changed from `slug` to `(slug, recovery_code)`
(`recovery_code` is `None` for unprotected profiles) -- updated all three call
sites (`cli.py`, `app.py`, and the three `tests/test_profiles.py` calls that
didn't care about the second value).

**Verified for real, not assumed:** checked both `~/.mtdo/profiles/index.json`
(doesn't exist -- no real profiles yet) and every sandbox instance's
`profiles/index.json` for any pre-existing password-protected profile under the
old schema before touching the format -- found none, so no migration path was
needed (would have had to be written first if any existed, since the old
schema's protected profiles would otherwise become permanently unreadable by the
new code). Ran a full plain-Python reproduction against real `cryptography`
primitives (create protected profile -> write real goals/state -> confirm wrong
password is rejected and data is unreadable -> confirm a garbage recovery code
is rejected without mutating anything -> recover for real -> confirm old
password now fails, new password decrypts the *same* data -> confirm the
recovery code still works a second time -> confirm code normalization handles
lowercase/no-dashes/stray-spaces). Then a full headless `App.run_test()` Pilot
run through the actual TUI: create a protected profile through
`ProfileCreateScreen`, confirm `RecoveryCodeScreen` shows the real code and
acknowledging it proceeds into the app, then open Manage Profiles, press Reset,
type the code and a new password through real key dispatch, confirm the toast
and that `check_password` flips old-password-false/new-password-true. All 6
existing tests still pass. Confirmed real `~/.mtdo/goals.json`/`state.json`
mtimes unchanged by any of this (17 Aug / 20 Aug, from before this session).

---

## 2026-08-25 (bug gh41, GH mukund1312/mtdo-bugs#41) -- API keys now go into the OS keychain, not a plaintext file

Bug's own framing: chmod 600 is a defensible model, "have your one-line answer
ready." Asked the user how far to take it before building anything, since real
encryption-at-rest vs. just hardening/documenting the existing model are genuinely
different-sized changes with different UX tradeoffs (a new master password just to
store API keys is real friction). User: they're planning to redeploy to a larger
user base, asked me to pick the best option.

**Recommendation and what shipped:** the OS keychain (macOS Keychain / Windows
Credential Locker / Linux Secret Service) via the `keyring` package -- real
encryption at rest, with zero new password prompt of mtdo's own, since the already-
unlocked OS session is what protects it. Same model `gh`/`aws`/1Password's CLIs
default to. Made it a soft dependency (added to the `webchat` extra): if it's not
installed, or installed with no usable backend (some headless Linux boxes with no
Secret Service/dbus running), everything falls back to the original chmod-600 file
-- itself hardened while I was in there: the file used to be written with the
default umask then chmod'd only afterward, a real (if narrow) window where a
crash mid-write could leave it world-readable; now created at 0600 from the first
byte via `os.open` with an explicit mode. An existing key already sitting in the
plaintext file gets migrated into the keychain transparently the first time it's
read (then erased from the file), so nobody with keys already saved has to
re-enter them.

**Verified live against the real macOS Keychain, not just in a venv:** installed
`keyring` into a throwaway venv, saved a real test credential, confirmed via
`security find-generic-password` that it genuinely landed in
`~/Library/Keychains/login.keychain-db` and was NOT in the plaintext file, then
deleted it (`security delete-generic-password`) and confirmed removal. Separately
tested the migration path: pre-seeded the legacy plaintext file, called
`get_api_key()`, confirmed it moved into the keychain and was cleared from the
file -- cleaned up that test credential too. Also tested the fallback path with no
`keyring` installed at all (this environment's normal state) -- confirmed it still
works exactly as before, file created at mode 0600. Re-ran the full test suite
afterward (6/6 pass, nothing else broke). Confirmed real `~/.mtdo/goals.json`/
`state.json` untouched, and real `~/.mtdo/secrets.json` doesn't even exist (no web-
chat keys configured on this machine) -- every test ran against throwaway
`MTDO_HOME` temp dirs.

Marked local bug #35 fixed and closed GH #41 via `bug_sync.mark_fixed_and_close`.

---

## 2026-08-25 -- fixed a real regression my own PR #20 caused in Janhwi's newly-merged CI tests

Ran the test suite (just added in PR #19, merged just before my PR #20) as due
diligence while working on something unrelated -- 3 of 6 tests in
`tests/test_profiles.py` were failing on `main` as of `9415761`. Confirmed with
`git stash` that this wasn't caused by my current uncommitted work; traced it to
gh48's automatic Profiles step (my own PR #20, merged right after PR #19) breaking
the tests' shared `_dismiss_first_run_prompts` helper, which only knew about the
older name-prompt/persona-picker flow gh47 had already removed before PR #19 was
even written.

**Real underlying bug, not just a test problem:** `ProfileMenuScreen`,
`ProfileCreateScreen`, and `ProfileManageScreen` never supported Escape-to-cancel at
all -- every other modal in the app does (`TextPromptScreen`, `ChoicePickScreen`,
`PersonaPickScreen`'s old form, ...). Nobody had noticed because until gh48 these
screens were only ever reached by deliberate mouse/keyboard navigation, never
auto-shown in a chain a test (or a user hitting Escape repeatedly) would walk
through.

**Did:** added `on_key` (Escape -> `self.dismiss(None)`) to all three, matching the
established convention. Rewrote `_dismiss_first_run_prompts` to loop
`while isinstance(app.screen, ModalScreen): press escape` instead of hard-coding a
specific chain shape -- more robust to the fact this chain has already changed shape
twice (gh47 removed two steps, gh48 added one back). Re-ran the full suite: 6/6 pass.

(Installed pytest/pytest-asyncio into a throwaway venv at `/tmp/mtdo_test_venv` to
actually run these -- they're declared as `dev` extras in `pyproject.toml` but not
present in the normal editable install; removed the venv afterward.)

---

## 2026-08-25 -- dashboard: bug descriptions were silently truncated at 200 characters, unrecoverable from GitHub

User: "the whole bugs should be visible now its truncated for some reason."

**Root cause:** `bug_sync.sync_pending()` filed every bug's GitHub issue with
`title = f"[{label}] {text}"[:200]` and a generic, fixed `body` ("Found while testing
instance X...") that never included the actual bug text at all. Anything past 200
characters was silently dropped -- not stored anywhere on GitHub, only ever
recoverable by reading the local, untruncated `bug_log.json` by hand (which is
exactly what I'd been doing all session whenever a bug's title looked cut off, e.g.
gh47/gh48 earlier today -- never flagged it as the actual bug it was until now).

**Did:**
- `bug_sync.py`: extracted `_issue_body(bug)` -- puts the full bug text first, then
  the found-at metadata, as the issue body (GitHub issue bodies have no comparable
  length cap). Title stays short/truncated (conventional for issue titles, and still
  usable for scanning the Issues table), but now nothing is actually *lost* -- the
  full text lives in the body, which `dashboard.py`'s Description section already
  reads (`issue.get("body")`), so no dashboard.py change was needed at all.
- `backfill_full_text_bodies()`: one-time repair for every issue filed before this
  fix -- rewrites each one's body from the matching local `bug_log.json` entry's
  (never-truncated) `text`. Idempotent (skips already-correct bodies), so safe to
  re-run. Ran it live against the real tracker: 42 issues backfilled on the first
  run, 0 on a second run confirming idempotency. Verified issue #47's body directly
  via `gh issue view` -- full text now present, previously cut off mid-sentence.

Synced (1 new bug already triaged), regenerated, and republished the dashboard --
confirmed the Description section on the generated HTML shows the full text for a
previously-truncated bug. Real `~/.mtdo/goals.json`/`state.json` untouched
throughout.

---

## 2026-08-25 (bugs gh19 + gh48, GH mukund1312/mtdo-bugs#19/#48) -- profile switching didn't actually isolate data; no automatic profile step

User asked to combine #19 ("implement profiles and profile switching") and #48 ("the
profile thing should happen as soon as the walkthrough is done") into one piece of work,
and explicitly asked me to test profile isolation myself rather than trust the existing
code: "when i am in a profile and my application is populated with one goals.jason the
another profile should be populated with another goals.jsaon."

**Found a real, serious bug by testing it, not by inspection.** Wrote a headless
`App.run_test()` test (create Profile A with field_a_only, switch to it, create empty
Profile B, switch to it, populate B with field_b_only, switch back and forth) --
confirmed live: switching to a brand-new empty profile did NOT clear the board (kept
showing the previous profile's fields), and after populating and switching to that
profile a second time, it showed **both** profiles' fields merged together, not just its
own. Reduced this to a minimal 6-line repro with zero Textual/App involvement, proving
it wasn't specific to profile-switching at all.

**Root cause:** `config.py`'s `goals_to_config(goals, existing_cfg=None)` built its
starting config via `cfg = dict(_EMPTY_CONFIG)` -- a *shallow* copy. `_EMPTY_CONFIG`'s
own `"categories"`/`"category_order"`/`"streak_categories"` values are a dict and two
lists; `dict(...)` only copies the top-level mapping, so `cfg["categories"]` etc. were
literally the SAME objects as `_EMPTY_CONFIG`'s. Every subsequent line that mutated them
in place (`cfg["categories"][name] = ...`, `.append(name)`) was permanently polluting
the module-level "constant" itself -- every later call with `existing_cfg=None`
(*every* fresh reload: profile switches, `check_goals_file`'s live-reload polling,
anything) inherited every category any earlier call in the process's lifetime had ever
added. This bug predates profiles entirely; profile-switching was just the first thing
to exercise "load an entirely different goals.json" enough times in one session to make
it obvious.

**Second, related bug:** `app.py`'s `reload_from_goals()` just `return`ed early on
`FileNotFoundError` (no goals.json for the newly active profile) -- doing nothing at
all, so the board kept showing whatever was loaded before instead of going empty. Also
affected the already-existing "delete your last profile" path, which explicitly deletes
goals.json/state.json expecting this function to clear the board.

**Did:**
- `config.py`: added `empty_config()` (a proper `copy.deepcopy(_EMPTY_CONFIG)`, always a
  fresh independent object), used it both in `goals_to_config` and the fix below.
- `app.py`: `reload_from_goals()` now calls `tc.configure(appconfig.empty_config())` on
  `FileNotFoundError` instead of silently returning, so the board actually goes empty.
- `app.py`: `_begin_setup_flow()` (gh48) now shows an actual Profiles step right after
  the walkthrough -- confirmed live that this had never actually been automatic, only
  reachable manually via the footer badge, despite gh47's own flow description assuming
  it already happened here. No profiles yet -> straight to `ProfileCreateScreen`
  (a picker with nothing in it would be a dead end); profiles exist -> `ProfileMenuScreen`
  to pick/switch/add. Either way chains into `_pick_populate_method()` next. Used
  `_push_modal` (not `push_screen`) for both, since `_begin_setup_flow` is itself reached
  from inside `OnboardingScreen`'s own dismiss-then-push chain -- the exact case
  `_push_modal`'s docstring says a plain callback would silently never fire for.

**Verified live (tmux + headless, both):** re-ran the headless isolation test after each
fix -- confirmed empty-profile switch now correctly shows zero categories, and the
merge-across-profiles case is fully gone (A shows only A, B shows only B, switching back
and forth repeatedly stays correct). Separately confirmed `state.json` (streaks) was
never affected by this bug -- checked directly, plain per-profile serialization, no
shared-default-object pattern there. Live tmux test of the gh48 fix: fresh instance,
skipped walkthrough, confirmed "Create Profile" now appears automatically (previously
went straight to "How do you want to build your plan?" with no profile step at all),
created a profile, confirmed it chained correctly into the populate-method screen, and
confirmed the footer showed "👤 Good morning, Test Profile 1" afterward. Real
`~/.mtdo/goals.json`/`state.json` confirmed untouched throughout.

Marked local bugs #15/#40 (GH issues #19/#48) fixed and closed both via
`bug_sync.mark_fixed_and_close`.

---

## 2026-08-24 (bug gh47, GH mukund1312/mtdo-bugs#47) -- guided setup reworked: no in-app questions, no AI called by mtdo

User's bug: "major rework the Final Flow" -- drop the name+persona questions after
Profiles Section entirely, and replace Guided Setup's persona-driven in-app AI Q&A
("mtdo's built-in AI" vs "an AI I already use", then a bespoke question list) with:
export the template, hand it to any AI the user already uses, import the goals.json it
gives back. No questions asked anywhere in this flow.

This directly supersedes bugs #6/#13 (see [[bugs_6_13_ai_automation_on_hold]], on hold
since 2026-08-23) rather than resuming them -- and turns out to sidestep their two
hardest open questions entirely: #6/#13 wanted mtdo to call an AI itself automatically
(untested non-interactive long-form AI call; no API access at all for "an AI I already
use" backends), which is why they were paused. This design needs neither -- it's a
manual copy-out/copy-in flow, and goals_template.json already turned out to be fully
self-documenting (its own `_instructions`/`_read_this_first` keys are written to be
pasted straight into an AI), so mtdo's job shrank to export/prompt/import, not "act as
an AI orchestrator."

**Checked before making irreversible-feeling calls:** whether persona was used anywhere
outside the wizard (grepped -- no, config.py/plan_wizard.py/app.py only, safe to drop
entirely) and whether removing the name-prompt would break the new time-of-day greeting
Janhwi just added in PR #14 (checked ClockHeader.update_clock -- it already prefers the
active profile's name over get_user_name(), only falling back to the latter, so nothing
broke; removing the name question is actually a net improvement, not a regression).

**Did:**
- `config.py`: `has_configured_plan()`/`mark_plan_configured()` -- new gate for
  auto-launching the wizard on startup, replacing `get_user_name() is None` (which no
  longer applies now that nothing asks for a name).
- `plan_wizard.py`: rewritten. Dropped `PERSONAS`/`QUESTIONS`/`questions_for`/
  `build_prompt` (all now-dead persona/Q&A machinery). Added `GUIDED_SETUP_PROMPT` (one
  fixed, generic prompt -- no persona, no per-user Q&A baked in; any personalization
  happens in the user's own conversation with their AI, which the template's rule_8
  already anticipates) and `export_template()` (copies goals_template.json to
  ~/Downloads, never overwrites an existing copy there). Kept `save_and_copy()` as-is,
  it was already generic.
- `app.py`: `_begin_setup_flow()` collapsed from a 5-step chain (name -> persona ->
  populate-method -> AI-choice -> persona Q&A -> finish) down to one step
  (`_pick_populate_method`, no persona param). Deleted `PersonaPickScreen`,
  `_wizard_ask_name`, `_pick_persona_for_setup`, `_pick_ai_choice`,
  `_ask_plan_wizard_questions`, `_finish_plan_wizard`, and the now-unused
  `_wizard_stack`/`_wizard_go_back` back-navigation machinery (kept `WIZARD_BACK` and
  `show_back` on the reusable `TextPromptScreen`/`ChoicePickScreen` themselves -- generic,
  not dead). Added `GuidedSetupScreen` (three actions -- export, copy prompt, import --
  stays open across all three instead of dismissing after one) and
  `GoalsFilePickScreen` (a `DirectoryTree`-based file browser, arrow keys + Enter, no
  path to type -- a terminal app has no native OS file-picker, this is the closest real
  equivalent; starts in ~/Downloads). Import calls the existing
  `appconfig.import_goals()`, unchanged -- the same function the CLI's `mtdo import`
  already used.

**Verified live, not just written (tmux, real ~/Downloads):** fresh instance, skipped
walkthrough, confirmed the populate-method screen shows with NO name/persona prompt
first. Picked Guided setup -- confirmed the intro text and three actions render.
Ran "Export the template" -- confirmed `goals_template.json` genuinely landed in
`~/Downloads` (`ls` after, not just the toast). Ran "Copy the AI prompt" -- confirmed
via `pbpaste` that the real prompt text was on the clipboard. Opened "Import" -- confirmed
the file browser lists real `~/Downloads` contents and navigates with arrow keys.
Directly tested `appconfig.import_goals()` against the running session's actual scratch
`MTDO_HOME` with a hand-built test goals.json -- confirmed the category was added, then
confirmed the RUNNING app live-reloaded it within ~2 seconds ("goals.json changed --
reloaded" toast, new field visible in the This Week panel at 0/1) -- the full pipeline,
not just its pieces. Cleaned up test files from `~/Downloads` afterward. Real
`~/.mtdo/goals.json`/`state.json` confirmed untouched throughout (this only ever ran
against the sandbox's own scratch dir).

Marked local bug #39 fixed and closed GH issue #47 via `bug_sync.mark_fixed_and_close`.

---

## 2026-08-24 -- dashboard: fixed "Related git activity" showing actively wrong commits

User spotted it live: bug #10's ("AI-config walkthrough steps") detail page showed
"Related git activity" with 3 commits that had nothing to do with that bug --
`e54ca2b Merge pull request #10 from ...` and `08ee560 Merge pull request #8 from ...`
(this repo's own PR merge numbers) and `c800e53 Make fresh_config.yaml genuinely empty
(bug #10)` (an OLD, informal "(bug #N)" numbering convention used in commit messages
before the mtdo-bugs GitHub tracker existed -- an entirely different, unrelated bug that
happened to also be called "#10" back then).

**Root cause:** `_bug_git_activity()`'s original match was a bare `#<issue_number>` --
which was never going to stay unique. Two independent numbering spaces both produce
`#<small-number>` constantly: GitHub's own auto-generated "Merge pull request #N"
messages (PR numbers in THIS repo, unrelated to issue numbers in the separate mtdo-bugs
repo), and this project's own pre-tracker commit-message convention. Once the tracker's
issue numbers grew past ~10, collisions with both became inevitable and, worse, silent --
nothing would have caught this without someone actually reading the section and
recognizing the commits didn't match.

**Fix:** convention changed to `gh<issue_number>` (e.g. `gh42`) instead of a bare `#N` --
verified via unit test that this does NOT match either false-positive pattern
(`Merge pull request #10 from ...`, `(bug #10)`) while correctly matching the intended
new form (`Fixes gh10`, `gh10: ...`). Also added `--no-merges` to the git log call as a
second line of defense, and switched from `git log --grep` (git's own regex engine) to
fetching all non-merge commits and filtering with the same Python regex used for
branches, so there's exactly one source of truth for the match logic instead of two
regex flavors that could drift apart. Updated the "no activity yet" fallback text and
both docstrings to describe the new convention.

Confirmed live: `_bug_git_activity()` now returns empty for every real issue number
(correct -- nothing has used the new convention yet, and empty is the honest answer,
not a guess). Regenerated, checked the live artifact for uncommitted comments first
(none), republished. Real `~/.mtdo/goals.json`/`state.json` untouched throughout.

---

## 2026-08-24 -- dashboard: sortable Priority/Age columns (click to sort, click again to reverse)

**Caught a real, pre-existing correctness issue while implementing this, not by
inspection:** sorting means reordering `<tr>` elements in the DOM via a click -- and per
the artifact live-doc rules, "whatever a writer's own click... does to the DOM... is
appended to the document... and reaches every other view." That means the EXISTING
found-by/assigned-to/priority filter (`row.style.display = 'none'`, triggered by a
`<select>` change event) was almost certainly already being captured and synced to every
other viewer -- one person filtering their own view would have silently changed what
everyone else saw too. Never caught because nobody had two browser tabs open comparing
views while testing it.

**Fix, covering both:** added `artifact-local` to `#bug-table`'s `<tbody>`. Per the
capability docs this only suppresses IMPLICIT gesture-capture for that region -- it does
NOT affect the explicit `artifact.edit()` calls the assign-to reassignment already uses
(those are id-addressed and independent of local/sync marking), so reassignment inside
the table keeps syncing correctly; only row order and visibility (filter + the new sort)
become genuinely per-viewer, which is what they should have been all along.

**Did:**
- `dashboard.py`: `_age_days(iso_ts)` alongside the existing `_age()` (refactored to share
  the same day-count) -- age needs a raw sortable number, not just the display string.
  Each `<tr>` gets `data-age-days`. `<th>` for Priority/Age are now `class="sortable"
  data-sort="..."` with a small arrow indicator.
- JS: `applySort(column)` re-sorts the row array (priority via a rank map high<medium<
  low<untriaged, age via the raw day count) and re-appends in order; click same column
  again to reverse. Verified the comparator logic offline (Node, synthetic rows, both
  columns, both directions) before wiring it into the DOM version.

Regenerated, checked the live artifact for uncommitted comments/reassignments first (none
-- safe to republish directly), republished. Real `~/.mtdo/goals.json`/`state.json`
confirmed untouched throughout, as always.

---

## 2026-08-24 -- Shift+B now fires sync/triage/dashboard entirely in the background

Follow-up to the auto-triage work below: user wanted the whole 3-command flow (`bugs
sync` / `gh issue list` / `dashboard`) to happen automatically the moment a dev presses
Shift+B and saves a bug, not run by hand afterward.

**Did:**
- `bug_sync.sync_and_triage(instance=None)`: `sync_pending()` + `auto_triage_pending()` in
  one call -- the shared entry point both the CLI and the in-app trigger use now.
- `dashboard.generate()` now returns `(path, triaged)` instead of just `path` -- its
  internal safety-net triage pass turned out to matter in practice, not just in theory
  (see below), so callers that want an accurate "N triaged" count need that second
  value. Updated its two callers (`sandbox_entry._dashboard_command`, app.py's new
  background worker) for the new signature.
- `app.py`: `action_report_bug`'s save callback now calls a new
  `TodoApp._sync_bug_in_background()` right after `bug_log.add_bug()` -- spawns a daemon
  thread (same pattern already used by `action_toggle_claude`'s backend loading) that
  runs `sync_and_triage()` then `dashboard.generate()`, then reports the result via a
  toast using `self.call_from_thread` (required for any Textual UI call made from a
  background thread). Never blocks the UI (these are all network/`gh` calls) and never
  risks the bug report itself -- `bug_log.add_bug()` already wrote it durably to disk
  before this thread is even started, so a failure here just means the tracker/dashboard
  are stale until the next successful run, not that anything is lost. Gated behind
  `SANDBOX_INSTANCE_MODE` same as the rest of bug reporting (the 'B' binding only exists
  there), so this can't touch the real `mtdo` app.

**Verified live (tmux, real tracker, cleaned up after):** launched `mtdo-sandbox`, pressed
Shift+B, saved a test bug -- confirmed via a companion script that the bug was filed to
GitHub, triaged (priority + assignee), and the dashboard file regenerated, ALL within
seconds and with zero manual commands. Closed the 2 test GitHub issues (#45, #46) and
marked the matching local bug_log entries fixed afterward; real `~/.mtdo/goals.json`/
`state.json` confirmed untouched throughout (this whole feature only ever touches
`~/.mtdo-sandbox/*` and the private tracker repo).

**Real bug caught by this live test, not by inspection:** the first live run showed the
toast "Synced 1 bug(s), triaged 0" even though the bug WAS correctly triaged moments
later -- `sync_and_triage()`'s own `auto_triage_pending()` call sometimes runs before
GitHub's issue-list endpoint has caught up with an issue `gh issue create` JUST returned
(a real, observed propagation lag, not theoretical), so it can legitimately see zero
work to do on the very newest issue. `dashboard.generate()`'s existing safety-net triage
pass (running slightly later, after more `gh` calls have elapsed) is what actually caught
it. Fixed by having `generate()` surface what it triaged and merging both results before
building the toast message -- verified with a second live test that the toast now
correctly reads "Synced 1 bug(s), triaged 1."

---

## 2026-08-24 -- bug_sync: fully automatic triage, no Claude Code session needed

User's explicit ask: pressing Shift+B to log a bug, then running the existing 3-command
flow (`mtdo-sandbox bugs sync`, `gh issue list ...`, `mtdo-sandbox dashboard`) should
result in every bug getting a priority and an assignee on its own -- "i dont need claude
code to do it for me." Every triage pass up to now (the full 25-bug pass, then #43/#44)
was me reading each bug's text and making a judgment call -- not something the CLI could
do by itself. This converts that into a deterministic heuristic baked into bug_sync.py.

**Did:**
- `bug_sync._guess_priority(title, body)`: keyword match against the bug's title --
  crash/security/data-loss/broken-feature language (`crash`, `password`, `plaintext`,
  `sandbox`, `traceback`, `broken`, ...) -> high; README/positioning/docs/idea language
  (`readme`, `contributing.md`, `not a bug`, `cosmetic`, ...) -> low; else medium. Unit
  tested against 9 real bug titles from this tracker (crash/security/auth/no-tests all
  correctly high, README/CONTRIBUTING/feature-idea all correctly low, ordinary bugs
  medium) -- all 9 matched expectation.
- `bug_sync.auto_triage_pending()`: the unattended version of `apply_triage()` -- guesses
  a priority for anything missing one, then assigns anything unassigned to whoever
  currently has FEWER bugs at that same priority level (not just fewer total), so both
  devs keep getting a mix of urgent/non-urgent work rather than one person accumulating
  every high-priority bug. Verified the balancing logic in isolation (offline simulation,
  no real API calls) before wiring it in. Leaves anything already carrying both a
  priority and an assignee completely alone -- safe to call on every run.
- Wired into `sandbox_entry.py`: `mtdo-sandbox bugs sync` calls it right after filing new
  issues (prints which bugs got auto-triaged and how); `mtdo-sandbox dashboard` also
  calls it first as a safety net (covers a bug created some other way, or `dashboard` run
  without `sync` first) -- both no-op instantly once nothing's left untriaged, confirmed
  live (ran `bugs sync` and `dashboard` for real; both correctly did nothing since the
  25+2 already-triaged bugs from the manual passes were still fully triaged).

**Explicitly NOT automated:** matching a bug to whoever's code it actually touches (what
made #43's assignment-to-Janhwi a good call, tying it to her just-merged PR #11) needs
real reading comprehension of both the bug and the codebase -- a keyword heuristic can't
do that. `auto_triage_pending()` only automates the *balancing* half of the original
manual process, not the *subsystem-matching* half. Mis-triaged bugs are still fixable by
hand any time via `bug_sync.apply_triage({number: {...}})`.

---

## 2026-08-24 -- triage bugs #43/#44 (2 new bugs found after the dashboard branch merged)

Two new bugs came in after PR #9 (dashboard) and PR #11 (Janhwi's profile-menu-crash fix,
`feature/jr_uat_test`) both merged to `main`: #43 "adding a field to a to-do errors, no
../goals.json" and #44 "switching profiles doesn't ask for a password." Both High priority
-- #43 breaks a core feature outright, #44 is a real auth/access gap on profile switching.

Checked what PR #11 actually touched before assigning (`git show --stat`): 413 lines in
app.py + 20 in profiles.py, authored by Janhwi. That's an actual ownership signal, unlike
the earlier full-board triage where no such signal existed yet.
- **#43 -> Janhwi:** the `../goals.json` path error is plausibly a regression from her
  just-merged app.py changes -- she has the freshest context to debug it.
- **#44 -> Mukund:** password/auth logic is his (profiles.py's encryption model,
  same reasoning as bug #40's assignment) even though PR #11 touched profiles.py too --
  the auth *model* itself predates that PR.

Applied via `bug_sync.apply_triage()`, regenerated, republished (no live edits existed on
the page since the last publish to lose -- checked via WebFetch first, same as every
republish now). Split stayed close to even: Mukund 13, Janhwi 14 of 27 open.

---

## 2026-08-24 (PR https://github.com/mukund1312/mtdo/pull/9) -- bug_sync: priority labels + full triage pass on all 25 open bugs

User asked to (1) give Janhwi read/write access to the dashboard, (2) add priority to
every bug, and (3) reassign all bugs "according to what you feel is right now."

(1) is not something a tool call can do -- there's no API for granting an artifact
collaborator/editor access, only the artifact's own share menu (told the user directly,
pointed at the share menu in the top-right of the artifact view).

(2)/(3), did:
- `bug_sync.py`: `PRIORITY_PREFIX`/`PRIORITIES` + `bug_priority(issue)` (parses a
  `priority:<level>` label, same pattern as `assigned_person`), `_ensure_priority_labels()`,
  and `apply_triage(plan)` -- a bulk `{number: {"priority":.., "assigned_to":..}}` applier,
  the deliberate-judgment counterpart to `distribute_pending()`'s blanks-only fill. Only
  edits an issue when something in the plan actually differs from its current labels, so
  re-running the same plan is a no-op.
- Checked git history first for an ownership signal before reassigning -- found none:
  every file touched so far (profiles.py, practice_lab_panel.py, etc.) is 100% Mukund's
  commits; Janhwi's few commits don't concentrate anywhere yet. So the reassignment isn't
  based on subsystem expertise (there isn't one to point to yet) -- it's split by
  internals-depth: bugs that need deep knowledge of code Mukund already wrote (profiles.py,
  Practice Lab sandboxing, config validation, the AI-config wizard, the plaintext-key file)
  stayed/moved to him; bugs that are externally observable without deep internals knowledge
  (README/positioning, wizard UX, tests+CI as a pair, the onboarding-pacing bug Janhwi
  herself found) went to her. Priority: High = #19 (profiles), #38 (Practice Lab sandbox,
  genuine code-execution safety gap), #34+#35 (no tests, no CI -- real regression risk,
  paired to one owner), #42 (onboarding shows too much at once, Janhwi's own recent find).
  Medium = 11 bugs (real but not urgent -- music player timer, config-crash hardening,
  forgotten-password data loss warning, API-key file review, README/pitch/positioning/
  packaging). Low = 9 bugs, mostly the #6/#13 scoping fragments (#24/25/26/27/28 -- see
  [[bugs_6_13_ai_automation_on_hold]], these describe on-hold work, not independent asks),
  plus cosmetic/large-uncertain-scope items (version tags, CONTRIBUTING.md, web sign-in,
  Alexa/Siri idea). Final split: Mukund 12 bugs (2 High/6 Medium/4 Low), Janhwi 13 (3
  High/5 Medium/5 Low) -- close to even, both get a real mix of priorities, not all the
  urgent work dumped on one person.
  Applied via one `apply_triage()` call against the live tracker -- all 25 planned changes
  landed (verified via `bug_sync.bug_priority`/`assigned_person` spot-checks after).
- `dashboard.py`: priority pill (`pill-priority-high/medium/low`, new `--danger` theme
  token defined in all three theme blocks per the light/dark/explicit-toggle pattern) in
  the Issues table and the issue detail page, plus a Priority filter alongside the
  existing found-by/assigned-to ones. Priority is currently read-only/computed from the
  GitHub label each regeneration -- unlike assigned-to, it isn't live-editable from the
  page yet (natural fast-follow if wanted, same `artifact.edit()` pattern already used
  for reassignment).

**Incidental, unrelated, disclosed for context:** partway through this turn, `dashboard.py`
and `PROGRESS.md` briefly reverted to their pre-redesign contents on disk -- turned out to
be a concurrent session doing the bug #7 fix on `feature/mu/UAT-focus-mode-ai-crash-guard`
(cut from `main` before this dashboard work merged), sharing this same `~/mtdo` checkout.
That branch's work was already fully committed and pushed, so nothing was lost -- just
`git checkout`'d back to this branch and continued. The live published dashboard itself was
never affected, since nothing publishes to it automatically; only this session's own
`Artifact` tool calls do that.

---

## 2026-08-24 (PR https://github.com/mukund1312/mtdo/pull/9) -- dashboard: comment-count badge on the Issues table

User asked how they'd know a dev had posted a conversation note without opening every
bug's detail page one by one -- real gap, there was no indicator. Added a small "💬 N"
badge next to the bug title in the Issues table, computed from that bug's actual thread
element (`refreshCommentBadges()`, run on load and after posting), so it stays correct
even as comments get added live by either viewer without a republish.

---

## 2026-08-24 (PR https://github.com/mukund1312/mtdo/pull/9) -- dashboard: editable assignment/description/conversation via the `artifact` live-doc capability + git activity per bug

Follow-up to the Linear redesign below: user wanted the "assigned to" field editable
everywhere, the description editable per bug, real git branch/commit history shown per
bug, and a two-way conversation textbox per bug (either dev writes a note, the other
replies).

**Architecture decision:** the first three (assign/description/notes) are genuinely
mutable, low-stakes fields -- exactly what the Artifact platform's `artifact` capability
live-doc mode is for ("polls, sign-up sheets, checklists, trackers -- the page is the
record", per the artifact-capabilities skill). Declared `capabilities: {"artifact": {}}`
on publish; a viewer's click/keystroke on the page is captured and saved automatically
(or via an explicit `artifact.edit()` call for things that aren't native input gestures,
like the custom assign-to dropdown and posting a new comment) and reaches every other
open view immediately -- no republish needed for these three fields specifically.

**Did:**
- `dashboard.py`: every issue now gets a real server-rendered detail section (not
  JS-templated from a JSON blob like the last redesign -- had to drop that entirely,
  since live-doc capture only works on content actually served in the page, not markup a
  script builds after load). Assign-to is a custom dropdown (`<select>` values aren't
  gesture-captured per the platform's rules) reused in both the issues table row and the
  detail page, updated via one `artifact.edit()` call touching both copies at once so
  they can't disagree. Description is a plain `contenteditable` div (auto-captured,
  no explicit call needed). Conversation is a flat per-issue comment thread; posting
  calls `create-element` to append a `<p>`, attributed by whichever name is picked in the
  existing "Viewing as" selector (still no real auth on a static page).
  `_bug_git_activity(issue_number)`: branches/commits containing "#<number>" as a whole
  token, read from `git log --all` / `git branch -a` against this checkout (a naming
  convention, not an enforced link) -- shown read-only on the detail page. Added a
  best-effort `git fetch --all --quiet` before generating so a branch pushed from the
  other machine shows up too.
- Read-only handling: `getArtifact()`/`withWriter()` wrap every write call; a
  `not_writer`/`not_granted` rejection (or `window.claude` missing at all) shows a
  banner and disables every edit affordance, rather than silently failing.
- Search and the "assigned to me" list now read live off the DOM (`getRowsData()`)
  instead of a static snapshot, so they stay correct after a live reassignment.

**Real tradeoff, disclosed to the user, not yet solved:** publishing new HTML (the
`mtdo-sandbox dashboard` + republish flow, still the only way found-by/fixed/commit
stats and brand-new bugs get pulled in) replaces the whole page, which would wipe any
assignment/description/note edits made since the last publish. `generate(overrides=...)`
exists so whoever republishes can read back the current live state first (e.g. via
WebFetch) and pass it in to preserve it, but nothing automates that read-back yet --
it's a manual step for whichever Claude Code session does the next regeneration.
Also: reassigning on the dashboard does NOT change the `assigned:<login>` GitHub label
`bug_sync.distribute_pending()`/`rebalance()` use, so the two can drift apart until
someone reconciles them by hand.

---

## 2026-08-24 (PR https://github.com/mukund1312/mtdo/pull/9) -- dashboard: Linear-style redesign (nav, issue detail, team, search)

User pasted a full ASCII mockup of Linear's UI and asked for it "in the current dashboard
webapp." Scoped it down to the parts backed by real data in the tracker -- Cycles/Sprints,
Projects, Roadmap, Inbox, and Goals don't map onto anything GitHub Issues here actually
has (no priority/sprint/project field), so building decorative UI for those would just be
empty chrome; flagged that to the user rather than building it.

**Did:**
- `bug_sync.list_all()`: added `body`/`updatedAt` to the fetched `--json` fields -- needed
  so a real issue detail page can show the actual bug description, not just the title.
- `dashboard.py`: rewrote `render_html` as a small client-side SPA over one embedded JSON
  array of issues (`_issue_payload` per issue) -- hash-based routing (`#/dashboard`,
  `#/issues`, `#/issue/<n>`, `#/team`), sidebar nav, a "Viewing as" `localStorage` selector
  (there's no real per-viewer auth on a static snapshot page) driving a personalized
  greeting + "assigned to me" list, a real issue detail view using the new `body`/
  `updatedAt` fields, a Team view with commit-count velocity bars, and a Cmd+K search
  modal (substring match over titles, plus an `assigned:me` query) -- all still generated
  once server-side; nothing on the page fetches anything live (same hard CSP constraint as
  before). Kept the existing found-by/assigned-to table filters, now with clickable rows
  routing to the issue detail view.
- Escaped `</script` in the embedded JSON payload (`_json_for_script`) -- a bug title or
  body containing that literal string would otherwise truncate the page early.
- Regenerated via `mtdo-sandbox dashboard`, verified structurally (nav routes, whoami/
  filter options, one intact `<script>` tag, no `</script` splitting), and republished to
  the existing Artifact link (same URL, no new share needed).

**Not built (flagged to user, not yet confirmed as wanted):** Cycles/Sprints, Projects,
Roadmap, Inbox/notifications, Goals, Settings -- no corresponding data model exists yet.
**Still open:** whether the Artifact share menu can grant a second person write/editor
access -- needed before a real per-bug conversation/notes feature (would require the
`artifact` live-doc capability, a different mechanism from this snapshot-publish model).

---

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/9) -- dashboard: commit counts + bug distribution/rebalancing

User asked for three things on the shared dashboard: (1) fix it -- it should "work
properly", (2) track commit counts per dev, (3) a real bug-distribution system: split
pending bugs between the two devs, and if one finishes their batch first, automatically
move a few of the other's over so neither runs dry.

**Bug found while checking "should work properly":** Janhvi didn't appear on the
dashboard *at all* -- the person list only ever included logins with existing activity
(found/fixed/status), and every bug synced so far was authored under mukund1312 (nobody's
run `bugs sync`/`working-on` from her machine yet). Fixed by always showing both known
people from `bug_sync.PEOPLE`, even at zero.

**Did:**
- `bug_sync.py`: `PEOPLE`/`DISPLAY_NAMES`/`PERSON_COLOR_VAR` moved here from dashboard.py
  (single source of truth, since assignment needs the roster too) plus `GIT_EMAILS` --
  each person has multiple git identities across machines (`git shortlog` showed 4
  fragmented names/emails for 2 real people) that all need to count as one person.
  `assigned_person(issue)` reads an `assigned:<login>` label -- deliberately NOT the
  `assignees` field, which `mark_fixed_and_close` already uses to mean "who fixed it" at
  close time; a second label keeps those two concepts from colliding.
  `distribute_pending()` assigns every unassigned open bug to whoever currently has
  fewer (safe to re-run as new bugs come in). `rebalance(fixer_login)`, called
  automatically at the end of `mark_fixed_and_close`: if the fixer just cleared their
  whole assigned queue while the other person still has one, moves up to 3 of the
  other's over. `assignment_summary()` for the CLI/dashboard.
- `mtdo-sandbox bugs distribute` / `mtdo-sandbox bugs assignments` (sandbox_entry.py).
- `dashboard.py`: commit counts (`git log --all --pretty=%ae` against this file's own
  repo root, mapped through `GIT_EMAILS` -- counts every branch, not just main, since
  this is an activity signal, not a "what shipped" one), an "assigned to them" count per
  person, and an "Assigned to" column on the bug table.

**Tested (real, against the real tracker, not mocked):** `distribute` on the 6 real open
bugs split them 3/3. Rebalancing tested with 2 throwaway test issues (created, assigned,
deleted after) plus temporarily relabeling the real 3 assigned to Mukund over to Janhvi
to simulate "he just finished" -- confirmed `rebalance('mukund1312')` moved exactly 3
back, and correctly no-ops on a second call once he has bugs again. Restored the real
distribution to a clean 3/3 split afterward. Commit counts verified correct after
manually cross-checking `git shortlog -sn --all` (86 for Mukund across 2 fragmented
identities, 2 for Janhvi across hers). Dashboard regenerated and republished to the
existing Artifact URL (`.../fc424e3e-...`) -- confirmed via the rendered HTML that both
people now show up, with correct found/fixed/commits/assigned numbers and the new
"Assigned to" column. Real `~/.mtdo` untouched throughout.

**Next / open items:** Janhvi still needs to actually run `mtdo-sandbox bugs sync` /
`working-on` from her own machine at least once for her "found"/status numbers to become
real instead of zero -- the fix here just makes sure she *shows up* even before that.

---

## 2026-08-24 (PR https://github.com/mukund1312/mtdo/pull/10) -- Focus Mode / AI-panel priming had no crash guard (bug #7)

Bug #7 (GH mukund1312/mtdo-bugs#11): "the AI we are using in focus mode is crashing
again and again" -- no repro steps, no stack trace, and `~/.mtdo/error.log` /
every `~/.mtdo-sandbox/instances/*/error.log` had nothing from around when it was
filed, despite nearly every AI-panel code path already logging failures via
errorlog.py, AND `TodoApp._handle_exception` overriding Textual's own hook to log
literally any uncaught exception reachable through the message pump (action_/on_/
timer callbacks -- confirmed by reading Textual's own source, message_pump.py/
worker.py/timer.py all route through it). That combination is what actually
narrowed this down: the crash had to be in one of the only spots NOT covered.

**Root cause (best-supported, not proven with a live repro):**
`TodoApp.action_toggle_focus_mode` ('f') and `_prime_ai_context_if_needed` (primes
the embedded AI panel with the active task's context) had no try/except of their
own -- the one pair of AI-panel entry points not wrapped, unlike `action_toggle_claude`
right next to them. Confirmed via a headless `App.run_test()` with a deliberately
malformed active task that a crash CAN reach these two unguarded (though a block
missing `"text"` specifically turned out to crash much earlier/more broadly --
kanban card render, the active-task panel -- ruling that exact malformation out as
the real trigger, but proving the principle: nothing stopped some other bad state
reaching these two from taking the whole app down silently).

**Did:** wrapped both in try/except (`app_log.exception` + toast, same pattern as
`action_toggle_claude`), hardened `active["block"]["text"]` to `.get("text", "")` in
the priming message. Also found and fixed `PtyPanel.on_mouse_scroll_up`/
`on_mouse_scroll_down` (mouse-wheel scroll in the AI panel) -- the only two handlers
in `pty_panel.py` missing the same guard every other handler there already has.

**Tested:** `py_compile` both files; headless `App.run_test()` twice -- once with a
malformed active task (confirmed the guard doesn't mask anything new, the real
crash surface for that specific malformation is elsewhere), once with realistic
data pressing `f` twice (Focus Mode toggles cleanly both ways, `ai_primed_ref` sets
correctly, nothing new logged). Could not get a live repro of the actual reported
crash itself.

**Incident during this session, disclosed here on purpose:** while trying to
reproduce live via tmux, ran `pkill -f "/opt/homebrew/bin/mtdo$"` to clean up a
debug process and it matched far more broadly than intended -- it killed two
long-running real `mtdo` processes (PIDs 21403 and 21646, both up since Tue 7PM),
one of which was hosted in a tmux session called "mt6" that has since closed as a
result. mtdo writes state.json on every mutation already (not just on exit), so
tracked task/streak data itself should be safe, but any live unsaved AI-panel
conversation in those sessions is gone, and the "mt6" terminal window itself is
gone. Told the user directly in the session this happened in. **Lesson for next
time: never `pkill`/`kill` by a pattern that matches the plain `mtdo`/`mtdo-sandbox`
binary path -- it matches every running instance, not just ones this session
started. Kill only an exact PID captured right after spawning it yourself.**

Bug #7 marked fixed in `~/.mtdo-sandbox/bugs.json` and GH issue #11 closed via
`bug_sync.mark_fixed_and_close` (this branch was cut from `main`, pre-dashboard-PR,
so that function's older form here has no rebalance step -- not a bug, just an
older version of bug_sync.py than the still-unmerged dashboard branch has).

---

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/8) -- fresh_config.yaml was never actually empty (bug #10)

Bug #10 originally asked for an in-app upload/download screen for the "Manual" populate
path. Before building that, asked the user to clarify -- turned out "Manual" was always
meant as "use the app genuinely blank, add fields yourself via 'a'", not "hand-edit
goals.json". No upload/download UI needed at all.

Checking that surfaced the *real* bug: `fresh_config.yaml` (what `init_config(fresh=True)`
actually writes) shipped with 3 placeholder categories (work/personal/health -- health
even had a `fixed_labels: ["Move your body today"]` auto-generating a card), not truly
empty. So picking "Manual" never actually gave a blank board.

**Did:** Rewrote `fresh_config.yaml` to `category_order: []`, `categories: {}` -- genuinely
zero categories, matching `config._EMPTY_CONFIG`'s intent (the Option-A equivalent, used
elsewhere). Updated the wizard's "Manual" option label and confirmation toast to say what
it actually does (press 'a' to add fields) instead of implying JSON editing.

**Tested (real tmux pty):** confirmed the app renders correctly with zero categories --
`Backlog (0) Todo (0) In Progress (0) Done (0)`, no crash, every side panel (stats,
calendar, pomodoro, now playing, coach) renders its empty state correctly. Confirmed 'a'
(add field) still works from this genuinely blank state. Real `~/.mtdo` untouched; 8 real
saved instances present throughout (several created by the user concurrently during this
session), none touched -- net zero change from my own test instance (created, then
discarded).

**Next / open items:** bugs #6 and #13 (AI-config walkthrough + full automation of the AI
hand-off) still need a scoping conversation before code -- next up.

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/7) -- Ctrl+B back-navigation through the setup wizard (bugs #11, #12)

Bugs #11/#12: no way to go back and edit an earlier answer anywhere in the setup wizard's
question sequence (name, persona, populate-method, AI-choice, and each individual Q&A
question) -- once answered, it was answered, and an accidental Escape lost everything
with no way back in short of restarting the whole thing via `g`.

**Did:** `WIZARD_BACK` sentinel (an `object()`, not a string -- can never collide with a
real typed answer) plumbed through `TextPromptScreen`, `ChoicePickScreen`, and
`PersonaPickScreen` -- each gains a `show_back` param that adds a "Ctrl+B back" hint and
binding only when there's actually a previous step to return to. `TodoApp` maintains
`self._wizard_stack`, a list of zero-arg closures, each "how to redisplay the step before
this one, pre-filled with what was answered there." Every wizard step callback: handle
`WIZARD_BACK` first (pop and call the top closure), then push its own redo-closure before
advancing forward. `_ask_plan_wizard_questions` switched from slicing the question list
(`questions[1:]`) to an explicit `index` parameter, since slicing throws away the
information needed to redisplay "the question before this one."

Changing an earlier answer just works without special-casing: since every forward step
always recomputes "what's next" from current state (e.g. `plan_wizard.questions_for(persona)`
called fresh each time), going back to persona and picking a different one naturally
serves that persona's own question set on the way back down -- no stale state to clear.

**Caught and fixed one real bug during implementation, not before shipping it:** initially
wrote two separate `on_key` methods on `ChoicePickScreen` (one for Escape, one for the new
Ctrl+B) -- Python silently keeps only the last one defined, so Ctrl+B would have been dead
code, never actually callable. Caught by grepping for duplicate `on_key` definitions
during testing, before it ever reached a user; merged into one method.

**Tested (real tmux pty, thorough):** back from persona to name (pre-filled correctly);
answered 2 questions deep into a persona's Q&A, went back twice in a row (question 2 ->
question 1, pre-filled -- then question 1 -> AI-choice), continued back through
populate-method -> persona -> name (each pre-filled), confirmed the true first step
renders no back hint at all (nothing to go back to, not even a broken no-op affordance).
Separately verified that going back to persona and picking a *different* one correctly
served that new persona's own question set going forward (School's "academic goal"
question vs. College's "main goal" question). 6 real saved instances present in the
picker throughout, none touched. Real `~/.mtdo` untouched.

**Next / open items:** bug #10 (in-app upload/download screen for the manual-populate
path) is next. Bug #13 (fully automate the AI hand-off, no manual copy-paste) still needs
a scoping conversation before code -- significantly overlaps the still-unstarted PR C
(bug #6).

---

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/6) -- wizard free-text answers get a scrollable box too (bug #8)

Bug tracker triage session: went through all bugs logged to date. Closed #1, #9 (empty,
no content), and marked #2-#5 fixed (already resolved by the merged setup-wizard PR).
Bug #8 ("the bug capturing window has not been fixed and there is no scrolling") looked
like a regression at first, but re-testing confirmed the actual `B` bug-report screen
(fixed earlier) still works correctly -- the real culprit was a *different* screen: the
setup wizard's free-text questions (e.g. "What's your academic goal?") still used the
old single-line `Input`.

**Did:** `TextPromptScreen` gains `multiline=True` (same `TextArea` approach as
`BugReportScreen` -- ~12 lines visible, scroll, Ctrl+S to save instead of Enter, since
Enter means newline in a TextArea). Applied only to the wizard's free-text question
branch in `_ask_plan_wizard_questions` -- left as single-line everywhere else
(names, card titles, pomodoro settings, etc) where that's the correct, unsurprising
affordance and Enter-to-submit is worth keeping.

**Tested (real tmux pty):** confirmed the large scrollable box now shows for a wizard
free-text question, typed a long multi-sentence answer, Ctrl+S advanced correctly to the
next question (still showing the fix), then to a multiple-choice question after that --
full chain intact. Escape correctly cancels the whole wizard with "Setup cancelled --
nothing written." Real `~/.mtdo` and all real saved instances (several now, users are
actively testing) confirmed untouched throughout.

**Next / open items:** Bugs #10-#13 came in during this session (real, substantial):
back-navigation through wizard questions (#11, #12 -- generalized to "everywhere with a
question sequence"), an in-app upload/download screen for the manual goals.json path
(#10), and a large one (#13) asking for the AI hand-off to become fully automatic --
no manual copy-paste into Focus Mode, incremental week-1-then-week-2 plan building, the
AI reading the template and answers itself and writing goals.json behind the scenes.
#13 significantly overlaps with the still-unstarted PR C (bug #6, the step-by-step
AI-config walkthrough) -- likely need to treat them as one combined design rather than
two separate features. Needs a scoping conversation with the user before writing code,
same as the original wizard redesign did.

---

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/4) -- confirm-gated instance delete

A raw `rm -rf` on `~/.mtdo-sandbox/instances/` during test cleanup (in this same session)
deleted a real, user-named saved instance ("found few bugs related to the setup of the
app when opened for the 1st time") along with the agent's own test data -- there was no
dedicated deletion command, only ever a blanket shell command with no way to tell
"obviously mine" apart from "somebody's real saved work". Caught and disclosed
immediately after; the instance's board/task state is unrecoverable, though the actual
bug *reports* from it survived independently (bug capture is already decoupled from
instance lifecycle, see the 2026-08-22 durability fix below).

**Did:**
- `instance_store.delete_instance(slug)` -- raises `FileNotFoundError` on an unknown slug
  rather than silently no-oping.
- `mtdo-sandbox instance list` / `mtdo-sandbox instance delete <slug>` -- shows what it's
  about to delete, requires typing the exact slug back to confirm (same pattern as
  `mtdo-sandbox reset` requiring the word "reset").
- Documented as the one sanctioned way to remove an instance, in this file, in
  `mtdo-dev.md`, and as a standing personal-conduct memory: never `rm -rf` under
  `~/.mtdo-sandbox/instances/` (or any real user data) during cleanup without explicit
  confirmation -- treat a real, specific name/description as a strong signal of real user
  work, not disposable test debris, unless it's something created in the same session.

**Tested (real):** created a genuine test instance, confirmed `instance list` shows it;
wrong confirmation text declined and left it untouched; correct confirmation (the slug)
deleted it, confirmed gone. Real `~/.mtdo` untouched throughout.

**Next / open items:** none. If this comes up again: check `instance list` and confirm
with the user before touching anything that isn't unambiguously a same-session test
artifact.

---

## 2026-08-23 (PR https://github.com/mukund1312/mtdo/pull/3, rewritten) -- in-app setup wizard, bespoke per-persona Q&A

This PR was originally a CLI-level (`input()`, pre-boot) wizard -- see the superseded
description this replaces below, kept for history. User feedback reversed that
architecture on purpose ("the app boots up and only then the questioning should start")
and supplied a complete, bespoke, mostly-multiple-choice question set for all 5 personas,
replacing the old shared-core-plus-persona-extras model entirely. Nothing was merged yet,
so this branch was reworked in place rather than left stale. **This absorbed PR #5's
functionality too (populate-method + AI-choice questions) -- #5 was closed as superseded,
its content is now part of this single flow.**

**Did:**
- `plan_wizard.py`: `QUESTIONS` replaces `CORE_QUESTIONS`/`PERSONA_QUESTIONS` --
  each persona (including "Just Exploring the App", which used to skip the Q&A
  entirely and just load the demo) has its own complete, bespoke question list, per
  exact user specification. Each question is now `(key, prompt_text, choices)` --
  `choices` is `None` for free text or a list of options for single-select multiple
  choice, instead of every question being free text.
- `app.py`: new `ChoicePickScreen` (generic multiple-choice modal, same `VimListView`
  pattern as the existing `PersonaPickScreen`/`CategoryPickScreen`). The wizard chain
  (`_begin_setup_flow` -> `_pick_persona_for_setup` -> `_pick_populate_method` ->
  `_pick_ai_choice` -> `_ask_plan_wizard_questions` -> `_finish_plan_wizard`) now runs
  entirely in-app, triggered automatically right after the feature walkthrough dismisses
  on a genuine first run (`on_mount`), reusing the exact same chain for the manual `g`
  re-run -- one flow, two entry points, instead of a separate CLI version and in-app
  version. `_ask_plan_wizard_questions` branches per-question between `ChoicePickScreen`
  (has `choices`) and `TextPromptScreen` (free text).
- `cli.py`: `_run_first_run_wizard()` and `_pick_number()` removed entirely.
  `cmd_run`'s fallback now unconditionally writes a genuinely empty config
  (`init_config(fresh=True)`) when none exists and starts the app -- no CLI-level
  prompting at all anymore.

**Tested (real tmux pty, full flow):** fresh instance -> boots straight into the feature
walkthrough (no CLI prompts beforehand) -> setup wizard chains in automatically after --
name -> all 5 personas render with correct new labels -> picked "Just Exploring the App"
(the one whose behavior changed most) -> populate-method question -> AI-choice question
-> all 7 of its bespoke questions asked in order, correctly alternating between
`TextPromptScreen` (free text) and `ChoicePickScreen` (multiple choice, all option lists
rendered correctly) -> prompt built and saved with every answer mapped to its exact
question text -> tailored "press C" message shown for the built-in-AI choice. Separately
verified the "Manual" populate-method path stops immediately with the right message and
no further questions. `user_name` file confirmed written correctly. Two real saved
instances present in the picker throughout (a user-named one and one from a prior
session) were deliberately never touched. Real `~/.mtdo` untouched.

**Next / open items:** PR C (bug #6 -- detailed step-by-step AI config with pros/cons for
each backend option) is still pending, stacking on top of this reworked version.

<details>
<summary>Superseded original entry (CLI-level version, before this rewrite)</summary>

Real bugs from testing: a fresh install silently populated itself with demo/example
categories instead of starting empty, and there was no first-run flow asking who the user
is or what they want out of the app.

Did: `cli._run_first_run_wizard()` -- plain `input()` prompts (name, then what you're
using this for), run once, before any config exists at all, deliberately CLI-level to
avoid hot-reloading a running app's category structure. New "Just exploring the app"
persona loaded the demo plan as an explicit choice. `config.get_user_name()`/
`set_user_name()` added.

Superseded because the user explicitly asked for the app to boot first and ask
questions in-app afterward, and supplied a much more detailed, bespoke, mostly
multiple-choice question set per persona -- see the current entry above.
</details>

---

## 2026-08-22 (PR https://github.com/mukund1312/mtdo/pull/2) -- scrollable multi-line bug-report input

User feedback from real testing: the bug-report box (`B` while testing) used a single-line
`Input`, making it hard to see what you'd already typed once a description ran past a few
words -- wanted at least 10 lines visible with scroll.

**Did:** new `BugReportScreen` (app.py) replaces `TextPromptScreen` for this one case --
`TextArea` sized to show ~12 lines with a visible scrollbar for anything longer, Ctrl+S to
save / Escape to cancel. `action_report_bug` updated to push it instead.

**Tested (real tmux pty):** confirmed ~12 lines visible; typed a 15-line description,
confirmed auto-scroll and that the full text (all 15 lines, newlines intact) landed
correctly in bugs.json; confirmed Ctrl+S saves + toasts, Escape cancels without logging
anything. Real `~/.mtdo` untouched.

**Next / open items:** none.

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
