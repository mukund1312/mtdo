# mtdo web — architecture decisions log

**Status:** ACTIVE. **Created:** 2026-09-04.

Durable record of engineering-layer decisions that don't fit `DESIGN.md` (visual) or the product
plan docs (`docs/designs/*.md`). Each entry: the call, and the reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-09-04 | **Monorepo** — web app lives at `web/` inside `~/mtdo`, not a separate repo | `DESIGN.md` and both product-plan docs already live here; Phase W5's `mtdo serve --bridge` couples web to the Python app |
| 2026-09-04 | **Shared seam designed now, room-only tables deferred** (`schema.md` §1-2) | D12-D14 force the ledger/session shape regardless of when rooms ship; room-only tables' shapes depend on real ledger data per D17 |
| 2026-09-04 | **Supabase anonymous auth from first visit**, upgraded in place | Every `activity_events` row needs a real `user_id` from event #1 for RLS to work uniformly and for the product's "delayed signup" goal (only prompt when there's a streak worth losing) to not create a data gap in exactly the window activation data matters most |
| 2026-09-04 | **Sessions are server-authoritative** (D12) | Synchronized group sessions are a core ritual; client-led timers are too fragile under phone sleep, reconnects, and clock drift. Building this into the solo path from day one means the room version later is the same code path, not a rewrite |
| 2026-09-04 | **AI Tutor scope upgraded to real cross-session memory**, not prompt polish | `coaching.py` is stateless; a flagship-marketed AI tutor needs to remember what a user struggled with. Requires new schema (`schema.md` §3) and a deliberate retrieval strategy (rolling summary, not full-history replay) to keep cost bounded |
| 2026-09-04 | **Soft free-tier tutor-message cap**, enforced via ledger counts, ahead of Stripe (W6) | A stateful, per-message-cost AI feature running unmetered against free users for months is a real bill. Cheap now (a `WHERE` clause over an existing table); expensive to discover the need for later |
| 2026-09-04 | **EmberMorph built as a standalone, importable component**, not inlined in the session route | The marketing site's web↔terminal showcase reuses this exact component rather than a second bespoke build — one animation, two contexts, no drift between "what marketing shows" and "what the product does" |
| 2026-09-04 | **Design is per-wave, drafted as a Claude Design canvas from `DESIGN.md`**, not one upfront design phase | Approving a design in the abstract (spec text) vs. a real clickable draft is the actual blocker for someone new to design; a canvas per wave means never approving screens for work that's months out, and never building a screen twice |
| 2026-09-04 | **Codex (CLI, confirmed installed) takes isolated, already-contracted screen builds; Claude keeps schema/RLS/ledger/session-authority/AI backend** | A wrong decision in the Claude-owned surfaces cascades into every feature built on top; a wrong decision in an isolated screen is local and cheap to redo. See the delivery plan for the full per-surface model assignment (`claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5-20251001` / Codex's `gpt-5.6-terra` / `gpt-5.4-mini`) |
| 2026-09-04 | **`ci.yml` split with path filters**, new `ci-web.yml` added | `ci.yml` ran the full ~4-minute pytest suite on every PR regardless of what changed; `web/` PRs now run `ci-web.yml` (typecheck+lint+build) instead |
| 2026-09-04 | **`typescript` pinned to `6.0.3`, not the latest `7.0.2`** | TypeScript 7 is a real, current stable release (the native-compiler rewrite), but `typescript-eslint@8.69.0` (bundled by `eslint-config-next@16.3.4`) hard-fails on it (`typescript-eslint does not support TS 7.0`) — not a warning, a crash. 6.0.3 is the highest version the actual installed toolchain supports (`typescript-eslint`'s declared peer range is `>=4.8.4 <6.1.0`). Revisit once `eslint-config-next` ships a `typescript-eslint` version that supports TS 7 |
| 2026-09-04 | **`eslint` pinned to `9.39.5`, not the latest `10.x`** | ESLint 10 breaks `eslint-config-next@16.3.4`'s bundled `eslint-plugin-react` two different ways: `FlatCompat` produces a circular-JSON crash, and after switching to the config's native flat-config exports (`eslint-config-next/core-web-vitals` + `/typescript`, no `FlatCompat` needed), `eslint-plugin-react`'s `react/display-name` rule still crashes on every file (`contextOrFilename.getFilename is not a function` — ESLint 10 removed `context.getFilename()`). 9.39.5 is EOL (no more security patches) but is what this config package's bundled plugins were actually built against, and the config is now native-flat (no `@eslint/eslintrc`/`FlatCompat` dependency). Revisit once `eslint-config-next` updates for ESLint 10's API |
| 2026-09-04 | **`next lint` removed from scripts**, calls `eslint .` directly | Next.js 16 removed the `next lint` subcommand entirely (`next --help` no longer lists it) |
| 2026-09-04 | **`middleware.ts` written as `proxy.ts`** | Next.js 16 renamed the file convention (function export also renamed `middleware` → `proxy`); functionality is unchanged, only the name |
| 2026-09-04 | **Server-authoritative writes are `security definer` RPCs, not RLS policies** (sessions, ledger); client tables carry explicit `REVOKE`s, not just missing policies | Full writeup below — an adversarial audit found D12/D13/D14/D17/D21 were unenforced and the ledger forgeable |
| 2026-09-04 | **Every pinned version and config choice above was verified**, not assumed | `npm view <pkg> version`/`versions` for real current releases, then a full `rm -rf node_modules && npm ci` + `tsc --noEmit` + `eslint .` + `next build` pass before committing — three real, current ecosystem incompatibilities (TS7, FlatCompat, `getFilename`) were caught this way and would otherwise have shipped broken |
| 2026-09-06 | **`EmberMorph` takes plain `sessionId`/`plannedDurationS`/`elapsedS`/`originRect` values via a `phase`-tagged `trigger` prop, never a `focus_sessions` row or a Supabase client** (`api.md` §4.1) | The marketing showcase has no auth and no real session, so the component can't assume either; a `phase` union plus an `onExitComplete` callback also means neither caller has to separately track "is the reverse animation still playing" |
| 2026-09-06 | **`daily_rollups` is materialized by a scheduled full recompute (pg_cron), not by a trigger on the ledger** (`0009`/`0010`, api.md §3a) | A trigger would put aggregation on the user's write path, where a failure fails the session or task write for the sake of a derived number; and incremental counters cannot self-heal, so a full recompute has to exist anyway — at which point the trigger is a second, divergeable writer into a table whose whole rule is "derived, NEVER hand-written". `computed_at` ("how stale is this row") is job-shaped and meaningless under a trigger. In-database cron over an Edge Function or a Vercel cron route because the aggregation is one SQL statement over data already in Postgres: no network hop, no service-role key in a second platform's environment, no third deploy target to keep in step with the migration |
| 2026-09-07 | **Curriculum reaches the board as an unlocking, carry-forward weekly menu the user picks from — it is never scheduled onto a calendar date** (`0012`, api.md §3b) | `prompt.ts` rule 2, `core.py`'s `categories_for_day()` and `types.ts` all already say curriculum is "not locked to a specific calendar day"; `plan_categories.days` is a COUNT for curriculum categories (`days.length` = day-lists per week), not a weekday filter. A `floor((today - plan_start)/7)` bridge would have looked right and quietly rebuilt the day-by-day schedule the product abandoned. Carry-forward rather than the terminal app's use-it-or-lose-it because a generated plan holds exactly two weeks of content, so one missed week would cost half the plan |

---

## 2026-09-04 — Adversarial schema/RLS audit, and the rewrite it forced

An Opus adversarial audit was run against `0001_seam.sql` / `0002_tutor_memory.sql` before
anything was deployed (no Supabase project existed yet, so both files were corrected in place
rather than patched by an `0003`). The question it asked of every policy was not "does this look
right" but **"what can a malicious authenticated client actually do, given exactly the policy as
written"**. The answer was: quite a lot. Four findings were blocking.

**What it found**

1. **`focus_sessions` was fully client-writable, so D12 was a comment, not a rule.** The policy
   was `for all using (auth.uid() = user_id)`, and `started_at` was only a `default now()` —
   which is not a stamp. A client could insert a fabricated multi-hour `completed` session, or
   `UPDATE` a running session's start time. Every "server-authoritative" claim downstream rested
   on this and was false.
2. **The ledger was forgeable.** `activity_events`' insert policy validated only
   `auth.uid() = user_id`; the client chose `occurred_at`, `kind` and `payload` freely. Since
   UPDATE/DELETE are (correctly) denied, a forged row was *permanent*. This broke D13 (derived
   rollups), D17/D21 (rank must be ledger-derived and unfarmable), and the tutor cap at once.
3. **`tutor_messages` let clients write `role='assistant'`,** and the free-tier cap was
   unenforceable. Forged assistant turns get folded into the rolling summary and fed back to the
   model as its own prior words — prompt injection laundered through memory. The cap depended on
   the client honestly emitting `tutor_message_sent` alongside its own insert; not emitting it
   was the entire bypass.
4. **`daily_rollups`' `(user_id, date)` primary key could not absorb a nullable `room_id`** — the
   seam had simply not been applied to the derived table, and that gets structurally harder to
   fix once the table holds data.

Plus a long tail: `on delete cascade` from `plans` meant retiring a goal would wipe all
historical `blocks` (against the free tier's "30 days of history" promise); ownership was checked
only via `user_id` while every *other* FK on `blocks`/`focus_sessions`/`proofs` went unvalidated;
nothing prevented two simultaneous `running` sessions; and a dozen invariants documented in prose
had no constraint behind them.

**What changed**

| Area | Change |
|---|---|
| Session writes | `focus_sessions` is **SELECT-only** to clients. Writes go through `security definer` RPCs `start_session` / `complete_session` / `abandon_session`, which derive `user_id` from `auth.uid()` and stamp `started_at`/`completed_at` from the server clock — none of the four is a parameter. Owner and `state = 'running'` are re-checked inside each function. A partial unique index enforces one running session per user. |
| Ledger writes | `activity_events` is **SELECT-only** to clients. `record_event(p_kind, p_payload)` is the only append path: it sets `user_id` and `occurred_at` internally, validates `kind` against a client-appendable whitelist, and caps payloads at 4 KB. `session_*` and `tutor_message_sent` are deliberately **outside** that whitelist — they are minted by the session RPCs and by the tutor backend, which is what makes focus time and metered AI usage unfarmable and the cap enforceable. |
| Tutor | `tutor_messages` is revoked entirely from clients (reads included); `tutor_context()` is the sanctioned read path, returning summary + a bounded recent window in one call. `source_message_count` → `summarized_through timestamptz`, because a count cannot identify *which* messages a summary covered. |
| `daily_rollups` | Surrogate `id` PK, nullable `room_id`, `computed_at`, and `unique nulls not distinct (user_id, date, room_id)`. |
| Ownership | Composite FKs throughout: a block's plan and category, a session's block, a proof's session and block must all belong to the same user. Not exploitable while ids are unguessable UUIDs — exploitable the moment room members can see each other's ids (W4a), which is exactly when it would be hardest to retrofit. |
| History | No DELETE policy on `plans`/`plan_categories`; `blocks` references them `on delete restrict`. Retiring a goal is `is_active = false`. |
| Constraints/indexes | Duration bounds, `state`↔`completed_at` agreement, non-negative counters, non-blank proof bodies, a `kind` whitelist, one active plan per user, a deferrable slot key so drag-and-drop reorders work, and indexes on every FK and hot path. |

**Two decisions worth their own note.**

*Grants, not just policies.* Supabase's default privileges grant `all` on tables *and functions*
to `anon`/`authenticated`, so "no policy for that command" is an incidental denial that a future
`for all` policy added by copy-paste habit would silently undo. Every server-authoritative table
now carries an explicit `REVOKE`. Two consequences fell out that the audit had not listed:
`revoke execute … from public` is **not** enough to hide an internal function (the roles hold
their own grants and must be named), and `grant all on tables` includes **TRUNCATE**, which is
not subject to RLS — one `TRUNCATE` would have emptied the append-only ledger for every user.
Both are now revoked, and TRUNCATE/REFERENCES/TRIGGER are removed from the default privileges for
future tables.

*Verified by execution, not by reading.* The audit's own instruction was to verify by careful
manual reading, since no Supabase project exists. A local PostgreSQL 18 cluster was used instead:
both migrations were run against a stubbed `auth` schema and Supabase's real default-privilege
configuration, then attacked from `authenticated`, `anon` and `service_role` sessions — roughly
sixty assertions covering every finding above. Two things this caught that reading would not
have. First, the audit specified `for select, insert, update` as one policy; Postgres allows only
one command per policy, so it is three. Second, `on delete restrict` on `blocks.plan_id` looked
like it would break GDPR account deletion (the `auth.users` cascade deletes plans, whose blocks
restrict the delete) — it does not, because the cascade removes plans and blocks inside one
statement and RI checks drain at the end of it. That was worth proving rather than reasoning
about, since being wrong would have meant an undeletable account.

**Explicitly not fixed, and why.** `profiles.is_anonymous` remains client-updatable — it is
informational, nothing depends on it as an auth signal, and reworking it to derive from
`auth.jwt()` is scope creep with no current security consequence. It carries a comment saying so.
The anonymous-user-cleanup vs. activation-funnel tension (`on delete cascade` from `auth.users`
would delete exactly the never-signed-up visitors that D1/D7 retention is measured over) is a
product decision, not a schema one; it is flagged in a prominent comment on `activity_events` and
`daily_rollups` rather than pre-empted.

---

## 2026-09-06 — `daily_rollups` recompute job (mtdo-bugs #93)

`0001_seam.sql` shipped the table, its RLS and its grants with a comment saying it would be
"written by a future service-role recompute job". Nothing ever was. Found while writing the
Wave 1 frontend briefs: the Progress heatmap (mtdo-bugs #89) could be built perfectly and would
still read empty, and "empty table" is indistinguishable from "broken UI" for whoever builds it.

**The decisions that were not obvious.**

*Sessions are read from `focus_sessions`, not from the `session_*` ledger events*, which is a
deliberate departure from the issue's own wording ("aggregates `activity_events`"). The two
cannot disagree — `settle_session()` writes the row and appends the event in one transaction, and
neither table has a client write path — so this is the same source of truth in its typed form.
The events do not carry `started_at` at all, which is the timestamp the job actually needs, and
`elapsed_s`/`planned_duration_s` live in an unconstrained `jsonb` payload where a shape change
would turn into silent nulls. A heatmap that quietly reads zero is the worst failure this table
has. `blocks.status`/`blocks.elapsed_seconds` were never candidates: `blocks` is ordinary
client-writable data, so its timestamps are whatever the client says.

*Focus time is attributed to the day the session **started**.* The alternative — the day it
settled — gets two real cases wrong in the same direction: a session across midnight, and the
session left running overnight that `start_session()`'s `55006` recovery contract has the user
abandon the next morning, which would credit yesterday's work to today.

*Elapsed is capped at `planned_duration_s`.* `settle_session()`'s own comment anticipated this
("so the job can decide its own policy"). A 25-minute block whose tab stayed open for nine hours
is 25 minutes of focus. `DESIGN.md`'s "the app never exaggerates the user's record" is the rule.

*`blocks_done` counts distinct blocks, last event of the day wins.* Counting `task_completed`
rows would let a double-fired click or an over-eager re-render inflate the number, and would let
a complete-then-regress pair still read as a completion. A regression on a *later* day
deliberately does not rewrite the earlier day: Monday's record is that a block was finished on
Monday, and past heatmap cells should not silently change. This puts a requirement on the Today
screen that did not exist before — `task_completed`/`task_regressed` must carry
`payload.block_id` (api.md §2d).

*The bucketing time zone is UTC and is a property of the table, not of a call.* No per-user time
zone is stored anywhere (`profiles` has no such column), and adding one needs a UI to set it.
UTC matches the "use the date the server considers today" convention already handed to the Today
screen. It is a genuine limitation for users far from UTC and is the first thing to revisit if
the heatmap looks shifted; the zone is a function parameter so that upgrade is a join, not a
rewrite. Running the job in a *second* zone over an already-computed window does not migrate the
old rows — it writes new ones under new dates and leaves the originals, counting one event on two
days. That is pinned by test, and changing the zone is a delete-then-backfill.

*Verified by execution again, and the harness was kept this time.* The 2026-09-04 audit used a
local cluster with a stubbed `auth` schema and Supabase's real default privileges, then threw it
away; it had to be rebuilt from scratch to validate this. `supabase/tests/run.sh` is that setup,
committed — 63 assertions over a local PostgreSQL 18, covering the aggregation rules above,
idempotence, that a correction can move a number *down*, window bounds, the privilege surface
from `authenticated`/`anon`/`service_role`, that the window predicates actually become index
conditions rather than per-row filters, and the advisory lock. No Docker required, runs in about
a second. **Not covered:** `0010`'s pg_cron path — pg_cron is not in a stock Homebrew Postgres,
so the suite exercises that migration's "extension unavailable" branch and runs the scheduled
statement directly. Confirm the job registered after the first `db push`:
`select jobname, schedule, active from cron.job where jobname = 'mtdo-daily-rollups';`

**Still empty after this ships, and not a bug in it:** `blocks_done` stays `0` for every user
until the Today kanban wires `task_completed`/`task_regressed`, which have no call site anywhere
yet (api.md §2c). `focus_seconds` and `sessions_completed` populate immediately — the session
RPCs are already wired.

---

## 2026-09-07 — The curriculum → blocks bridge

`curriculum_items` had been written by onboarding since W1 and read by nothing at all. Today's
board (`today-deck.tsx`) creates blocks only through a hand-composer, so the AI-generated
curriculum — the thing the product plan calls the actual wedge ("the wedge is coaching +
curriculum, not the focus timer") — never reached a user.

**The decision that mattered was refusing the obvious one.** The natural bridge is a scheduler:
derive a week from `today - plan_start`, then place blocks on dates whose weekday appears in
`plan_categories.days`. It is wrong on every axis, and the repo already said so in three places
written at different times — the prompt that generates every plan ("`curriculum` is a WEEKLY MENU,
not a day-by-day schedule … it is not locked to a specific calendar day"), `core.py`'s
`categories_for_day()` ("curriculum content is no longer tied to specific calendar days at all"),
and `types.ts` on `GeneratedCurriculumDay`. For a curriculum category `days` is a **count** —
`days.length` is how many day-lists make one week of content, which is exactly how `week_index`
was assigned at import. Reading it as a weekday filter would have compiled, passed review, and
rebuilt the schedule the product deliberately moved away from.

**What `week_index` actually is:** a sequence position in the curriculum. Which calendar week it
surfaces in depends on the user's unlock cursor, never on today's date.

**Two places this deliberately diverges from the terminal app.**

*Unpicked items carry forward.* `_ensure_weekly_menu()` drops them when the cursor advances. A
generated web plan holds exactly two weeks of content (`prompt.ts` rule 2 writes
`days.length * 2` inner lists), so use-it-or-lose-it means one missed week costs half the plan.
On a terminal opened daily that is a nudge; on the web it is data loss. The cursor still advances
at most once per ISO week, and only when the user shows up — weeks away cost nothing, same
laziness as the terminal app.

*"Picked" is derived, not stored.* It means a block exists with that `curriculum_item_id`. The
terminal app keeps a `picked` flag inside `_meta.weekly_menu`; a second mutable copy of "is this
on the board" can disagree with the board, and the failure is invisible. Deleting a block puts the
item back on the menu, which is what a user would predict anyway.

**Why RPCs for tables that stay client-writable.** Neither `ensure_curriculum_menu()` nor
`pick_curriculum_item()` fences anything off — `blocks`, `plan_categories` and `curriculum_items`
keep full client CRUD, and a user rewriting their own unlock cursor is self-service on their own
plan that nothing downstream derives from. They exist because two operations are genuinely unsafe
from a client: advancing the cursor (two tabs both see "new ISO week" and each advance it) and
allocating `blocks.position` by `select max(position) + 1` — `blocks_slot_key` is DEFERRABLE, so
concurrent inserts don't collide on INSERT, they both succeed and one fails at COMMIT after the
transaction looked fine. That second one is a live latent bug in `today-deck.tsx`'s composer,
which allocates position exactly that way; the RPC avoids it, the composer still has it, and it's
filed as a follow-up rather than fixed here.

**Found while building this, and fixed:** `supabase/tests/run.sh` piped `psql` into `grep` and
appended `|| true` in its migration loop, so a migration that failed outright was silently skipped
and the suite still reported success. `0012` failing to apply passed green until an assertion
happened to touch it. The loop now fails hard and prints the error. Worth noting that this had
been true since the harness landed — every "all assertions passed" before this only proved the
assertions ran, not that the migrations applied.

Suite is 106 assertions. The pg_cron caveat from the 2026-09-06 entry still stands.

---

## Open, not yet decided

- Whether the founder-facing analytics need anything beyond PostHog (deferred until W2 has real
  users — don't build speculatively).
- Realtime infrastructure choice for room presence (Supabase Realtime is the working assumption
  from the product plan; not re-validated at the engineering level since rooms are still W4a+).
- **Curriculum exhaustion.** A generated plan holds two weeks of content, so the weekly menu
  legitimately runs dry after two unlock steps. There is no regeneration or plan-extension flow —
  the menu simply goes empty, which the terminal app handles with a "time for a check-in" nudge
  (`cli.py`, `PLAN_END`). What the web does at that moment is a product decision, not a schema
  one; `api.md` §3b tells the screen not to treat it as a failure in the meantime.
- **Per-user time zones.** `daily_rollups.date` (and `blocks.date`, and anything else that means
  "a day") is currently a UTC date for every user. Fixing it properly means a `profiles` column,
  a UI to set it, a decision about what happens to already-computed rollups when a user changes
  it, and agreement with `blocks.date` so Today and Progress cannot disagree about what "today"
  is. Deliberately not pre-empted — it is a product decision with a schema consequence, and UTC
  is coherent until there are users far enough from it to notice.
