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
| 2026-09-11 | **The weekly recommendation engine is 100% deterministic and rule-based — zero AI calls in the metrics OR the recommendation path** (`0021`/`0022`, api.md §3f/§3g) | The moat is a rule engine over real behavioural data nobody else has, not a wrapper around a model a user could prompt themselves. Full writeup below |
| 2026-09-12 | **Pause is a sub-state of `running` (`paused_at is not null`), not a fourth `state` value** (`0023`, api.md §3h) | A `'paused'` state would have required changing all four invariants that make §5 trustworthy — `focus_sessions_one_running`, the `state`/`completed_at` CHECK, `settle_session()`'s guard, and `start_session()`'s 55006 probe — and would have silently broken the client's existing `.eq('state','running')` stale-session recovery query, which would stop finding a paused session and start a second timer beside it. As a sub-state, zero invariants change and a session paused two days ago is still recoverable |
| 2026-09-12 | **A break IS a pause — one mechanic with a `reason` tag, not a parallel break-tracking system; but the break *schedule* is persisted** (`0023`, api.md §3h) | Full writeup below |
| 2026-09-12 | **Block-status transitions after a session go through `settle_block_outcome()`, even though `blocks` is freely client-writable** | Full writeup below |
| 2026-09-12 | **One shared `session_focus_seconds()`, replacing the formula spelled out separately in `recompute_daily_rollups()` and `weekly_performance()`** (`0023`) | Pause makes "elapsed" and "focus time" different quantities for the first time. The two existing copies of the old formula had *already* drifted before anything forced them to (different return types, different negative-clamping), which is the argument for consolidating rather than editing both — the next change to this rule cannot now reach one consumer and miss the other |
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

## 2026-09-07 — Theme Studio's fate: paused, Architecture 02 is the sole V1 product

Resolved by the founder, closing the open question from PR #104's unscoped merge (the
five-theme gallery + prototype checkout, see `PARALLEL_AGENTS.md` and the review-authority
addendum in `mtdo-web-dev-split-plan.md` §4).

**Decision, not a compromise between the options considered — a fuller architectural
statement:**

- **Architecture 02 (Signal Deck) is the one and only V1 product.** All new frontend work —
  Onboarding (#86), Today (#87), Progress heatmap + Record Card (#89), and everything after —
  is built inside it. `/architecture-01/03/07/08` and `/theme-studio` get no further V1
  implementation time.
- **Theme Studio is paused, not deleted.** The code stays; it is explicitly not this product's
  Wave 1 concern. Revisit only as a real, separately-scoped feature later.
- **Long-term shape, for whoever eventually picks this back up:** one product, one shared
  backend/data model, with theme/architecture as a presentation-only layer on top — a user's
  tasks, sessions, progress, and plan must read identically regardless of which of the five
  visual directions is selected. This is a reason *not* to build per-architecture data models
  or duplicate backend logic now, even speculatively — the moment this becomes real work, it's
  a UI theming layer over the existing schema, not a new one.
- **No payment UI in Wave 1**, restated from `DESIGN.md`'s own hard prohibitions — applies
  directly to Theme Studio's checkout modal (mtdo-bugs, checkout-honesty fix, in progress
  separately from this decision).
- **`/progress` (the pre-Architecture-02 standalone page) is retired** — already removed in the
  PR #108 revert cycle; nothing further needed here.

**Already resolved, listed here only because the brief that produced this decision assumed
otherwise and a future reader might too:**
- Record Card export format: **decided and shipped** (image download, `html-to-image`,
  DESIGN.md's own 1080×1920 spec) — not an open question.
- Session screen visual review against `DESIGN.md`: **done** (`a7f4630`, "Session screen review
  findings — resume-or-discard, DESIGN.md tokens").

## 2026-09-07 — Curriculum exhaustion: re-onboard, free, no streak bonus

Resolved by the founder, closing the "Open, not yet decided" item below. A generated plan holds
two weeks of content, so the menu legitimately runs dry after two unlock steps — this decides
what happens at that moment.

Three technical findings surfaced while scoping this (from the report that forced this decision
rather than guessing): (1) `plans` no longer holds the original onboarding answers past
generation — `experienceLevel`/`notes` are dropped, only `focusAreas`→categories and
`weeklyDaysAvailable`→`plan_categories.days` survive; (2) an in-place extend RPC would need its
own advisory lock and a real unique constraint on `curriculum_items` (currently just an index) to
be idempotent, the same house pattern as `activate_plan()`/`pick_curriculum_item()`; (3) an
in-place extend has to explicitly advance `menu_unlocked_week_index`/stamp
`menu_unlocked_iso_week` itself, or a user who just asked for more work gets nothing for up to
seven days (the cursor only advances on its normal weekly cadence otherwise).

**Decision: re-onboard, not extend in place.** "Adjust my goal" sends the user back through the
existing onboarding flow to create a new plan. This makes all three findings above moot for
now — no new RPC, no new migration, no cursor logic to get right before beta. `activate_plan()`
(already built, already audited) already does the one thing this needs: retiring the old plan and
activating the new one atomically. Tradeoff accepted knowingly: Progress/Today will read as two
separate plans rather than one continuous journey across the boundary — acceptable for V1, revisit
if it turns out to matter once real usage shows whether that continuity is actually missed.

**Extensions stay free**, not a Pro/paid feature — matches the same "V1 ships the free core loop,
monetization is a W6 concern" position already taken for Theme Studio. The per-ISO-week unlock
pacing was always a cost/abuse guard, not a pricing lever, and stays exactly that.

**No streak bonus** (e.g. 4 weeks instead of 2 for consistent users) — same amount of curriculum
for everyone. Simplest, nothing new to get wrong before beta; revisit later if retention data
suggests it would matter.

**What's actually left to build, given this decision:** a Today empty state for "curriculum
exhausted" (distinct from the ordinary "no blocks yet today" empty state — `api.md` §3b already
says not to treat an empty menu as a failure) with an "Adjust my goal" action that routes into the
existing onboarding flow. No backend work.

## 2026-09-07 — Per-user time zones: full version built, not deferred

Resolved by the founder: given the choice between (1) a safe, additive-only half (store the
preference, build nothing that reads it yet) and (2) the full version (also rewrite
`recompute_daily_rollups()` for genuine per-user bucketing, despite the real risk of regressing an
already-twice-hardened, 106-assertion function right before a beta launch), the founder chose the
full version.

**What shipped** (migrations/0013, 0014):
- `profiles.timezone` — **nullable, no default**. This is the load-bearing design choice, not an
  oversight: NULL means "never set a preference", a real, distinct state from "chose UTC". A
  `NOT NULL DEFAULT 'UTC'` was tried first and caused a real regression (test 14 in
  `03_idempotence_and_windows.sql`, which explicitly passes an override `p_timezone` to prove
  cross-zone bucketing works) — every user would have had a stored `'UTC'` value, so
  `coalesce(profiles.timezone, p_timezone)` would never fall through to the parameter, silently
  breaking any explicit-override caller. Caught by the existing test suite, not by inspection.
- `recompute_daily_rollups()` now buckets each row by `coalesce(profiles.timezone, p_timezone)` —
  a genuinely mixed-timezone user base is bucketed correctly in one recompute call, not one shared
  zone for everyone. The scan window is padded by the full possible UTC-offset range
  (-12:00..+14:00) so the per-user bucketing is never fed a clipped window, while keeping the
  window comparison itself sargable (still a literal-bound comparison, not a function call on the
  indexed column).
- `pick_curriculum_item()` (migrations/0012) also needed the same fix, found while building this,
  not before: it hard-coded UTC for a new block's `date`, which would have silently reintroduced
  the exact "Today and Progress disagree" bug this whole decision exists to close, just moved from
  Progress to Today. Fixed the same way (`coalesce(profiles.timezone, 'UTC')`).
- 8 new SQL assertions added (`07_per_user_timezone.sql`) proving the actual new claim directly —
  three users with three different stored zones (including one deliberately left NULL), aggregated
  in the *same* recompute call, each bucketed by their own zone — not just "the old tests still
  pass". Full suite: 115/115.
- Frontend: `product-data.ts`'s `utcToday()`/`utcDateRange()` now accept an optional `timezone`
  parameter (default `'UTC'`, matching every existing call site's current behavior exactly until
  wired). Deliberately not renamed and the call sites (`today-deck.tsx`, `progress-deck.tsx`) were
  deliberately not touched — those are J's actively-being-edited files (a real merge conflict with
  her Listen-feature branch happened in this exact area the same day), and wiring them needs a
  profile read plus a settings UI to actually let a user set a preference, neither of which exists
  yet. Handed off as a brief rather than risking another collision in files she was shipping to in
  parallel.

**Still open, tracked as the actual remaining work, not silently dropped:** the settings UI to set
`profiles.timezone`, and wiring `today-deck.tsx`/`progress-deck.tsx` to read it and pass it
through. `ensure_curriculum_menu()`'s ISO-week unlock cursor also still advances in UTC regardless
of a user's zone — left alone deliberately (0014's own comment): a coarse, weekly-granularity
nicety, not the sharp daily-date mismatch the rest of this work closes.

## 2026-09-08 — Curriculum exhaustion, reversed again: extend in place, not re-onboard

Reverses **2026-09-07's "re-onboard, free, no streak bonus"** entry above, one day after it was
made. That entry closed with an explicit tradeoff: *"Progress/Today will read as two separate
plans rather than one continuous journey across the boundary — acceptable for V1, revisit if it
turns out to matter."* It turned out to matter sooner than expected: the operating-engine plan's
**Phase 4 (Dynamic Weekly planning mode)** structurally requires generating more content into the
*same* plan on an ongoing basis — streaks, blocks, and rollups all hang off `plan_id`, so a mode
whose entire premise is continuous re-planning cannot be built on top of a flow that quietly forks
a new plan (and a new `plan_id`) every time the menu runs dry. Re-onboard was the right call for a
V1 that ships once and stops; it is the wrong foundation for a product whose next phase is
explicitly about generating more curriculum into an ongoing plan.

**This reversal is decided on that basis, not on a phantom prior decision.** A separate,
never-merged commit (`de9b943`, `docs/designs/curriculum-exhaustion.md`) claimed to have already
recorded "extend in place" as settled — it hadn't; that file was never merged to `main`, and the
commit's own message flagged itself as *"unresolved against main... one of them has to win; that
call is not made here."* Citing it as authority would have been building on a doc that doesn't
exist on this branch. The real justification is the Phase 4 dependency above, confirmed with the
founder before any code was written (not silently overridden by a stale plan file).

**Decision: extend in place**, reopening the exact three costs the 2026-09-07 entry declined to
pay, now paid deliberately:

1. `plans.onboarding_answers jsonb` — persists `experienceLevel`/`notes` (previously dropped after
   generation), so an extension prompt has the same context the original plan generation did.
2. `curriculum_items` gets a real unique constraint `(category_id, week_index, position)` (was
   only an index) — makes an append idempotent under concurrency, not just usually-correct.
3. `extend_plan()` (migrations/0016) — a `security definer` RPC, `pg_advisory_xact_lock`-serialized
   under the same lock key `ensure_curriculum_menu()`/`pick_curriculum_item()` already use for this
   exact (plan_categories cursor, curriculum_items position) invariant pair, so all three can never
   interleave for one user. Computes each category's next `week_index`/`position` from its own
   current max (never trusts a client-supplied value) and, critically, advances
   `menu_unlocked_week_index`/stamps `menu_unlocked_iso_week` for every category it extends **in
   the same transaction** — otherwise a user who just asked for more work gets nothing until the
   cursor's normal weekly cadence catches up, up to seven days later.

**Extensions stay free, no streak bonus** — both still hold from the reversed entry; nothing about
this reversal touches monetization or pacing, only which plan_id new content lands on.

**What's still true from the reversed entry:** `activate_plan()` remains untouched and still does
exactly what it always did (atomic single-active-plan swap) — extension is additive to an existing
active plan, not a new activation event, so this reversal adds a second entry point into
`curriculum_items`/`plan_categories` rather than replacing anything already built.

## 2026-09-11 — A picked block may carry a calendar time; curriculum still isn't scheduled

**Narrows — does not undo — the 2026-09-07 "The curriculum → blocks bridge" entry above.** Read
that entry first. Its load-bearing claim is that *curriculum* reaches the board as an unlocking,
carry-forward weekly **menu the user picks from**, never placed onto calendar dates by a scheduler.
That claim stands, untouched, and the mechanism it protects is byte-for-byte unchanged by this
work: `ensure_curriculum_menu()` still returns a cursor-gated (or `overall`-mode ungated) menu,
`plan_categories.days` is still a *count* and not a weekday filter, `week_index` is still a
sequence position rather than a date, "picked" is still derived from a block's existence, and
**nothing is auto-placed**. No code added here derives a date from `today - plan_start`, and none
ever should.

**What changes is strictly downstream of the pick.** Once the user has explicitly pulled an item
onto the board — once a real `blocks` row exists — that block may *optionally* also be given a
calendar date and a start/end time. The reversal is therefore narrow and one-directional:

| Still true (unchanged) | New as of Phase 6 |
|---|---|
| `curriculum_items` are never scheduled | `blocks` may be scheduled |
| The menu is week-gated, not date-gated | A block's date is user-chosen, never derived |
| Picking is an explicit user action | Scheduling is a second, separate explicit user action |
| A block lands on today by default | …and can be moved to another day afterwards |

The reason is **Phase 6 of the operating-engine plan** ("Time + Google Calendar") — the actual
merged plan phase, cited deliberately rather than a phantom doc, after the Phase 3 experience of
a never-merged design file being cited as settled authority (2026-09-08's entry). Phase 1 already
shipped the Time deck as an honest empty state explicitly pending this phase; this is that.

**The deliberate seam: scheduling is a property of a block, not of curriculum.** Had
`scheduled_start_at` gone on `curriculum_items` instead, generation would have had to invent
dates, and the weekly-menu model would have collapsed into the day-by-day schedule the product
walked away from. On `blocks` it cannot: a block only exists because a human put it there.

**`schedule_block()` exists for the same reason `pick_curriculum_item()` does, not for access
control.** `blocks` stays an ordinary client-writable table. But moving a block to another date
changes `(user_id, date, category_id, position)` — and `blocks_slot_key` is DEFERRABLE, so a
naive client-side move **succeeds at INSERT/UPDATE and fails at COMMIT**, after the transaction
looked fine. Position has to be reallocated inside the RPC under the same per-user advisory lock
key (`mtdo.curriculum_menu:<uid>`) that `ensure_curriculum_menu()`, `pick_curriculum_item()` and
`extend_plan()` already share, so none of the four can interleave for one user.

**`schedule_block()` replaces a schedule, it does not patch one.** Passing NULLs is the
un-schedule call, not "leave it alone" — decided explicitly because the alternative (NULL means
no-op) leaves no way to clear a time at all without a second RPC. `p_date` is the one exception:
`blocks.date` is `NOT NULL`, so there is nothing to clear it *to*, and a NULL `p_date` therefore
means "keep the block on whatever board date it already sits on". Documented in full in api.md §3d
rather than left to be inferred from the function body.

**A block's board date and its calendar window are deliberately not constrained to agree.** A
23:30–00:30 study session is a real thing a user will book, and rejecting it would be a bug, not
a safety rail. Enforcing agreement would also require reading the user's zone at write time, which
turns a cheap constraint into a join. The two fields are related, not redundant.

**Google Calendar is one-way, MTDO → Google, in V1.** Removing a block's schedule deletes the
corresponding Google event; Google-side edits do not flow back. Polling or webhook-receiving is
deferred, and MTDO stays the source of truth — a user's task list and their calendar are allowed
to be separate things. **AI may only ever *suggest* a slot, never create an event unattended.** No
suggestion logic is built in this phase; nothing here blocks a later Route Handler from adding it,
because every write path is an explicit, user-initiated call.

**Refresh tokens are encrypted by the application, not by the database.** This is the one place
this phase departs from the brief it was given, and it is deliberate. The obvious option was
`pgcrypto`'s `pgp_sym_encrypt`/`pgp_sym_decrypt`, but:

1. `0001_seam.sql` states, in its own header, that pgcrypto is *deliberately not installed* —
   installing into `public` trips Supabase's `extension_in_public` advisor. The same paragraph is
   why `set_updated_at()` was hand-written rather than pulled from `moddatetime`. Reaching for the
   extension here would quietly reverse a recorded decision as a side effect of an unrelated one.
2. There is no pgsodium/Vault precedent in this project to be consistent with, and Supabase itself
   has moved away from in-database TCE.
3. Decisively: with no Vault, the symmetric key would have to be passed **into** SQL as an RPC
   argument on every read and write. It would cross the PostgREST boundary and the wire on every
   call, and land wherever request bodies land. AES-256-GCM in the Route Handler
   (`web/lib/calendar/crypto.ts`, Node's built-in `crypto`, `CALENDAR_TOKEN_ENCRYPTION_KEY`) means
   the database never holds or sees the key, so a database dump is not a token compromise — which
   is the actual threat encrypting this column is for.

The column is therefore opaque `text` holding a self-describing `v1:<iv>:<tag>:<ciphertext>`
envelope; the version prefix is what makes key rotation possible later without a schema change.
`calendar_connections` additionally has **no RLS policies at all and `revoke all` from `anon` and
`authenticated`** — the token never reaches a browser, not even its owner's, which is a stronger
posture than any table in this schema has needed before (`tutor_messages`' "nothing" row in
schema.md §6 is the closest precedent).

**Per-block opt-in is derived, not stored.** There is no `blocks.calendar_sync_enabled` column: a
block is synced iff a `calendar_event_links` row exists for it, exactly the way "picked" means "a
block exists with this `curriculum_item_id`" (2026-09-07's entry). A second mutable copy of "is
this on the calendar" can disagree with the calendar, and that failure is invisible.

**Known gap, recorded rather than papered over:** `calendar_event_links` cascades on block delete,
so deleting a *scheduled, synced* block drops the link row and orphans the Google event — Postgres
cannot make an HTTP call from a cascade. The call-site contract (api.md §3e) is therefore "unsync
before deleting"; a real reaper for events orphaned by a client that didn't is not built, and is
named here as debt rather than discovered later.

## 2026-09-11 — The weekly engine is deterministic by design

**This overrides the operating-engine plan's own Phase 7 text**, which described
`generateWeeklyPlanRecommendation()` as an LLM call producing a candidate `WeeklyPlanSchema`
validated after the fact, and paired it with an `aiService.reviewWeek()` natural-language summary.
Decided with the founder before any code was written.

**The decision: no AI anywhere in the metrics path or the recommendation path.** Not as a
temporary state until an API key is topped up — as the product's shape. `aiService.reviewWeek()`
is **not built** in this phase and is explicitly descoped.

**Why, in the founder's own framing:** the point of this engine is precisely that it is *not* a
thin wrapper around a model. A user who wants a language model's opinion on their study week can
open one and ask — that is worth nothing as a product. What nobody else can do is run
deterministic rules over this user's real behavioural history: what they actually picked, what
they actually finished, how long it actually took against what they estimated, what they quietly
stopped opening. That data is the moat; the engine over it is the product.

**The plan already agreed with this in spirit and we extended it one step.** Its own Phase 7
section says *"the metrics must exist and be trusted before AI is allowed near them"* and **"AI
never computes these"**. That sentence was written about the raw metrics. It applies with at least
as much force to the recommendations, which are what actually change a user's plan — so "AI never
computes these" now covers the rule evaluation and the `reason` strings too.

**Three concrete consequences, none of them cosmetic:**

1. **Reproducibility.** The same two weeks of numbers always produce the same classification and
   the same proposal. That is what makes the engine unit-testable at exact boundary values, what
   lets `weekly_plans.metrics` be a meaningful audit record, and what means a user who asks "why
   did it say that?" gets an answer that is actually true rather than reconstructed after the fact.
2. **Every `reason` string is assembled from computed numbers** — "Finished 1 of 4 tasks this week
   (25%) and 2 of 6 the week before (33%) — under half both weeks." A user can check that against
   their own board. A generated sentence cannot be checked, and a plausible-sounding wrong one is
   worse than no sentence at all.
3. **`generated_by` is `'rules_v1'`, not `'ai'`.** True today, versioned, and it leaves room for a
   genuine `'ai_v1'` generator later with no schema change — so this is a decision that can be
   revisited without being unpicked.

### Where the logic lives, and why it is split across SQL and TypeScript

Raw metric computation is in Postgres (`weekly_performance()`, 0021); rule evaluation and proposal
generation are in TypeScript (`web/lib/planning/**`). This follows two precedents already set here
rather than inventing a third arrangement: derived data is computed in the database
(`daily_rollups`, 2026-09-06), and business-rule validation lives in TS
(`plan-generation/parse.ts`). The thresholds also want to be readable and argued about, which they
are not as SQL literals buried in a `CASE`.

**But the hard constraints are enforced in BOTH.** The database does not get to assume its input
came from the real engine: `save_weekly_plan()` re-validates every incoming change against the
same rail `apply_weekly_plan_change()` applies. A stored proposal that violates the cap is a
proposal that fails the instant a user clicks accept, which is the worst possible place to find
out. Two of the four constraints are structural rather than checked — no code path in any of these
functions writes `plans.goal_line` or `plan_categories.days` — and both are pinned by test, so a
future edit that adds such a path fails loudly rather than passing as an ordinary feature.

### `weekly_performance()` is read-computed, not trigger-maintained

Same reasoning as `daily_rollups` (2026-09-06), and it applies more strongly here: a trigger would
put a week-wide aggregation on the user's write path where a failure fails the task write for the
sake of a derived number; and incremental counters cannot self-heal, so a full recompute has to
exist anyway — at which point the trigger is a second, divergeable writer. Unlike `daily_rollups`
there is not even a freshness argument for materializing it: a weekly review is read a handful of
times per user per week, by a human, on demand.

It also deliberately does **not** read `daily_rollups`, which would have given study days and
focus time for free, already bucketed per user zone. That table is a pg_cron job's output, and a
review generated inside the ten-minute gap would quietly under-report work the user did in the
minutes before opening it. It reads the same two source tables `daily_rollups` reads, under the
same day-attribution rules, so the two agree by construction and this one is never stale.

### The lever: a new `weekly_target_blocks`, not `min_blocks`

The brief suggested adjusting `plan_categories.min_blocks`. **It is the wrong lever, and using it
would have shipped a recommendation engine whose accepted changes do nothing.** `min_blocks` is a
per-*day* floor — that is what `prompt.ts` tells every model to write ("floor for counting this
subject 'done' that day, 0-6"), and what `core.py`'s `category_own_complete()` means by it — and
it is read by nothing in the web product. Its real-world values are 0 or 1, so ±25% of it rounds
to no change at all.

So Phase 7 adds `plan_categories.weekly_target_blocks` (nullable, resolving to
`array_length(days,1)`). A genuinely new concept gets a genuinely new column rather than a quiet
redefinition of one the plan-generation prompt still writes with the old meaning.

**It does not violate "never invent availability".** `days` is what the user told us about their
life and stays untouchable; a weekly target is a *goal*. Nothing is auto-placed from it, no date
is derived from it, and `ensure_curriculum_menu()` does not read it.

### The thresholds, and why each number

All evaluated over the **trailing two weeks**, never one — a person has a bad week for reasons
that have nothing to do with their study plan, and an engine that rewrites the plan every time
they do is worse than no engine. These are starting points chosen for defensibility, **not tuned
against real usage data, because there isn't any yet**; that is the first thing to revisit once
there is.

| threshold | value | reasoning |
|---|---|---|
| struggling — completion | `< 0.5` | Below half of *your own* choices, a far stronger signal than missing a number someone else set. Exactly 0.5 does not fire: at exactly half, the plan is not proven too heavy. |
| struggling — pace | `> 1.3` | Estimates are coarse and user/model-supplied; treating a 10% overrun as a problem would fire constantly and mean nothing. |
| coasting | `>= 0.9` **and** `< 0.7` | Both arms required. Finishing everything at a normal pace is just a good week; finishing fast while dropping half the tasks is triage, not spare capacity. |
| avoided | `< 0.3` | Deliberately low: this signal adjusts nothing, it interrupts the user with a question, and a question asked on thin evidence is worse than silence. |
| low-week floor | `< 0.40` overall | Someone who completed under 40% of their plan does not need more of anything — and the category that looks like it has spare capacity is very often the one they retreated into while avoiding the hard one. Suppresses increases everywhere; decreases are always allowed. |
| adjustment step | ±25% | Confirmed from the brief. Large enough to be felt in one week, small enough that two consecutive wrong calls are recoverable. |
| the cap | ±30% **or one whole block, whichever is larger** | The one number changed from the brief, and it had to be — see below. |

**Why the cap needed the "or one whole block" half.** A flat ±30% rail is unimplementable against
small integers. At a target of 3, one extra block is a 33% move, so every proposal would be
rounded back to 3 and the engine would silently never adjust a 3-block category in either
direction — a dead zone indistinguishable from "the rules are broken", and one that would have
shipped looking correct. One block is the smallest expressible change; the proportional rail binds
once targets are large enough for it to mean something (at a target of 10 it allows 7..13, not
9..11). Caught before shipping because the TS generator and the SQL rail were written against each
other: the generator could propose 3 → 4 and the RPC would have rejected it at the moment a user
clicked accept.

**Precedence is `avoided` → `struggling` → `coasting`**, which the brief left open. Engagement is
upstream of everything else: a category someone picks 2 of 10 offered tasks from and then fails
one of satisfies both `avoided` and `struggling`, but easing their weekly target answers a
question they never asked — their target was never the obstacle, they aren't opening the category
at all. Adjusting a number would also *look* like the engine had handled it, which is worse than
doing nothing.

### Two deviations from the brief's metric definitions, both flagged rather than made quietly

1. **`pace_ratio` is a ratio of sums, not a mean of per-task ratios.** The brief said "averaged
   over completed tasks". A mean lets one five-minute task done in fifteen produce a ratio of 3.0
   and swing a whole week's classification. The mean is still computed and exposed as
   `pace_ratio_mean` for display; the classifier reads the robust statistic.
2. **A done task with an estimate but NO settled focus session is excluded from pace entirely**,
   rather than counted as zero minutes. Without this, a user who finishes their work without ever
   starting a timer computes as ~0 minutes against a real estimate, classifies as *coasting*, and
   is handed 25% more work for not using a Pomodoro. That is the most damaging false positive this
   engine can produce, and it is closed in the metric rather than patched around in the rules.

### `menu_offered_count` is an estimate, and the direction of its error is chosen

Nothing records the unlock cursor's *historical* position — `plan_categories` holds only where it
is now and when it last moved. Since the cursor advances at most once per ISO week, walking it
back one per elapsed week gives a **lower bound** on what was unlocked during a past week.
Under-counting what was offered *inflates* `pick_rate`, which makes `avoided` **harder** to
trigger — and since that signal interrupts a user with a question about their own priorities,
biasing against a false accusation is the right way to be wrong.

### Known gap, named rather than discovered later

`postponement_count` captures the two shapes of "postponed" the data can actually express: a
`task_regressed` event inside the week, and an open block dated before the week that is still
unfinished. A block **silently moved forward** by a cross-date `schedule_block()` call leaves no
trace at all — `blocks.date` is mutable and nothing records the move. That third, arguably most
common, shape is therefore not counted. Recording it would need a move history the schema does not
have; it is named here as debt rather than discovered from a number that looks wrong later.

---


## 2026-09-12 — Focus Mode round two: pause, breaks, extension, block outcomes

Migration `0023`. The founder's brief was a product description ("pause session, end session, leave
early; a 45 minute session with 2x5 minute breaks; in the last 5 minutes ask if they need more
time; after it closes ask if anything's left"), and most of the engineering was deciding how few
new mechanisms that actually requires. The answer was: one new accounting concept (paused time),
and no new state machine.

### Breaks are pauses. The schedule is the only thing that's new.

A break and a pause do exactly the same thing to the only quantity the server owns: they stop the
clock. The difference between them is *who decided when* — a break was planned at start, a pause
was chosen in the moment. That is a property of the **reason**, not of the mechanism.

So there is no `start_break`/`end_break` pair. A scheduled break is `pause_session(id, 'break')`,
fired by the client when the plan says one is due, and `resume_session(id)` when it ends. The
alternative — a second interval-tracking system running beside pause — would have needed its own
settle-time cleanup, its own interaction with `focus_seconds`, and its own answer to "what happens
if a break and a manual pause overlap". All three are questions that simply don't arise when
there's one mechanism. The reason is recorded on the ledger event (`session_paused.payload.reason`)
so a future "you skip your breaks" or "you pause a lot" signal has the data without needing the
schema to have guessed at it.

**The break schedule itself is persisted, and this is the half that had a real argument on both
sides.** The brief explicitly offered client-only computation as option (a), and it is genuinely
cheaper: the server needs nothing from the plan to compute focus time correctly, so `break_plan`
buys the *server* nothing at all.

It was persisted anyway, because a session's break points are exactly as much "what this session
is" as `planned_duration_s` is — and `planned_duration_s` is already persisted for one specific
reason: the client is not trusted to remember it across a reload, a phone sleep, or a reconnect
(D12). A user who configures 45min + 2x5min, reloads at minute 30, and finds their breaks silently
gone has hit the *precise* failure this whole subsystem exists to prevent, and would hit it with
the timer still looking perfectly correct. One nullable jsonb column is a very cheap way not to
have that bug. Deciding otherwise would have meant the session survives a reload but the session's
*shape* doesn't, which is a strange line to draw.

**`at_s` is measured in focus seconds, not wall clock.** A break due "15 minutes in" means 15
minutes of *work* in. Measuring from wall clock would mean a manual pause eats a break — the user
pauses for coffee, comes back, and the break they'd planned has already silently passed. This is
the kind of detail that is invisible in review and obvious in use.

Validation lives in `start_session` with readable `22023` errors rather than leaning on the
structural CHECK, for the same reason the block-ownership probe does: a malformed plan is rejected
when the user can still fix it, not discovered as a break that never fires twenty minutes later.
The `at_s >= planned_duration_s` rejection specifically catches a minutes/seconds mix-up, which is
the mistake this shape invites most.

### `settle_block_outcome()` is an RPC, and RLS is not why

The brief asked me to check whether `blocks.status`/`blocks.notes` permit direct client writes
rather than assume the project's RPC-only convention applies. **They do permit them.**
`blocks_owner_all` (0001) is a `for all` policy and `blocks` keeps full CRUD grants;
`session/page.tsx` already does a direct `.update({ claimed: true, status: 'in_progress' })` at
session start. So the established pattern for authority-bearing tables genuinely does not apply
here, and an RPC cannot be justified on access-control grounds.

It is an RPC for a sharper reason found by reading `weekly_performance()` rather than the RLS
policies: **`blocks.status` is not what decides whether a task counts as done.** 0021 reads the
*ledger's* last `task_completed`/`task_regressed` verdict for a block, and falls back to
`blocks.status` only for a block the ledger has never seen. A client that set `status = 'done'`
without minting `task_completed` would therefore be visible on the Kanban board and **invisible to
the weekly engine** for any block the ledger had already touched. The status write and the ledger
event are one fact, and two client calls — which is exactly what `today-deck.tsx` does today — can
half-apply. Putting both in one transaction is the whole value.

**The bug this nearly shipped, and the reason to look closely at what an event *means* before
minting one.** The obvious implementation mints `task_regressed` whenever the user answers
"something's left". But `weekly_performance()` computes `postponement_count` as `regressed_count +
stale_open_count` — so every ordinary, honest unfinished session would permanently inflate that
user's postponement signal. The engine would read someone who works steadily on genuinely hard
tasks as a chronic postponer, and would act on it. `task_regressed` is therefore minted **only on a
real walk-back**: the block was done before (ledger first, `blocks.status` as fallback — 0021's
exact rule, reused rather than re-derived) and is now being reopened. A task that was never done
moving to `in_progress` is not a regression, and the ledger does not claim it is.

**The leftover note appends to `blocks.notes`, it does not overwrite.** `notes` is an ordinary
user-editable column that the Session screen already renders as the task's description — the user
may well have typed it somewhere else entirely, and there is no undo. Appending risks an ugly
growing blob; overwriting risks destroying text the user wrote. Between a cosmetic problem and a
data-loss problem, that's not a close call. Appends are dated (in the user's own
`profiles.timezone`) so a note from three sessions ago reads as history rather than as current
state, and the frontend is free to render only the last paragraph.

A note supplied on the `'done'` path is **rejected**, not silently dropped — if the user typed
something, losing it quietly is the worst available outcome.

### No advisory lock, and the reasoning rather than the omission

The brief asked me to reason about this rather than skip the question. The per-user advisory lock
(`activate_plan`, 0005; the curriculum menu, 0012) exists where one statement must be consistent
against a *set* of the user's rows — exactly one active plan, one coherent menu. Nothing like that
is true here: `settle_block_outcome()` writes one block row and appends one event. Postgres' own
row lock already serializes two concurrent calls, and both orderings end with a status and a
last-ledger-verdict that agree, which is the only property any reader depends on. Taking
`hashtext(uid)` would queue a one-row status update behind plan activation and curriculum picks for
no correctness gain, so it is deliberately not taken.

### Two entry points, one implementation

Two of the three outcomes know the block's fate at click time ("End session" → done, "Leave early" →
in_progress) and fold it into the settle call, so there is no window where the session is over and
the board still says in-progress. The third cannot: the founder's flow is explicit that the session
*closes* and the question is asked afterwards, so natural expiry calls `complete_session()` and then
`settle_block_outcome()` separately.

That could have been two mechanisms. It isn't — `complete_session`'s `p_block_outcome` is a
passthrough to the same `settle_block_outcome()` the deferred path calls. This is the project's own
stated preference for reusing a proven mechanism over inventing a parallel one, applied to a case
where the parallel version would have been genuinely tempting.

**Natural expiry is a `complete_session`, never an `abandon_session`.** The time was legitimately
spent. Whether the *task* is finished is a separate question from whether the *session* was, and
conflating them would have made an honest full session look like a quit.

### "Leave early" reuses `abandon_session` rather than getting its own RPC

Considered and rejected. "Left early" is precisely what abandoning already means, the ledger event
is already `session_abandoned`, and `recompute_daily_rollups()` already has a considered position on
abandoned sessions (their real elapsed time still counts toward `focus_seconds` — the user was
there — but they don't count as a completed session). A third settle state would have needed all of
that re-decided for no new meaning.

### Editable duration was never a backend gap

Confirmed rather than built: `start_session`'s `p_planned_duration_s` has always accepted 1..86400.
The Session screen simply hardcodes `DEFAULT_DURATION_S = 50*60` and ships no time picker. Adding
one is a pure frontend change against a parameter that has existed since 0001.

---


## Open, not yet decided

- Whether the founder-facing analytics need anything beyond PostHog (deferred until W2 has real
  users — don't build speculatively).
- Realtime infrastructure choice for room presence (Supabase Realtime is the working assumption
  from the product plan; not re-validated at the engineering level since rooms are still W4a+).
