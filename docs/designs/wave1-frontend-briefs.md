# Wave 1 frontend build briefs — Onboarding, Today, Progress + Record Card

**Status:** ACTIVE
**Owner:** J builds, M owns this doc (dev-split-plan §1: `docs/designs/` is architecture-adjacent,
M keeps it current before announcing a wave "contract locked")
**Related:** `docs/architecture/api.md` §2a/§4, `docs/architecture/schema.md` §2/§4, `DESIGN.md`,
`docs/designs/mtdo-web-dev-split-plan.md`

## Why this doc exists

Three Wave 1 tickets (mtdo-bugs #86, #87, #89) have been open and unbuilt since Wave 1 started.
In the meantime, `feat/theme-studio` (PR #104) landed instead — five alternate full-page visual
directions plus a prototype checkout modal, none of which trace back to a tracker issue, a design
canvas, or `DESIGN.md`. Whatever that PR's fate turns out to be, the actual gap it revealed is
this doc's reason to exist: **the three real Wave 1 screens never had a closed-form brief**, and
the dev-split plan's own §6 rule is explicit that an ambiguous brief — "explore the repo and
figure out what to do" — produces silently-wrong output on a budget that's hard to audit
afterward. This is the brief that should have existed before Wave 1 build started.

**Every screen below builds against `DESIGN.md`'s one aesthetic direction — Ember Graphite,
dark-only for v1.** No new visual system, no alternate theme, no color/typography/motion decision
not already in `DESIGN.md`. If something genuinely isn't covered there, that's a design-canvas
conversation with the user first, not a judgment call mid-build.

---

## 1. Onboarding screen (mtdo-bugs #86)

**Route:** under `web/app/(onboarding)/` (directory doesn't exist yet — create it).

**Purpose:** A new (anonymous-auth) user states a goal and gets a real, persisted study plan.
This is the single most-overdue Wave 1 piece — nothing downstream (Today, Session, Progress) has
real data to show until a plan exists.

**Data contract — `api.md` §2a, already implemented, do not re-derive:**

- Build a form collecting `OnboardingAnswers` (`web/lib/plan-generation/types.ts`): `goalLine`,
  `focusAreas[]`, `experienceLevel`, `weeklyDaysAvailable[]`, optional `appName`/`notes`.
- `POST` that JSON to `/api/onboarding/plan` (already built, M-owned, do not modify).
- Response is NDJSON, not a normal JSON body — read with `response.body.getReader()` and split on
  newlines, not `fetch().json()` and not `EventSource` (this is a POST). Each line is one of:
  - `{"type":"delta","text":string}` — stream these into a "building your plan…" loading state.
  - `{"type":"done","usedFallback":bool,"plan":{...}}` — success. If `usedFallback: true`, this is
    still a real plan the user should see as normal, just less personalized — show something like
    "we started you with a simple plan, you can customize it," never an error state.
  - `{"type":"error","message":string}` — only if generation *and* the fallback both failed to
    persist. This is the one real failure state to design for.
- On `done`, navigate to Today (or the plan's first day) with the returned `plan.categories`.

- **Moving a block into or out of `done` must also emit a ledger event** —
  `recordEvent(supabase, "task_completed", { block_id })` on entering `done`, and
  `"task_regressed"` with the same shape on leaving it (`web/lib/analytics/record-event.ts`,
  already written; both kinds are in `ClientEventKind` and currently have zero call sites).
  **`block_id` is required, not optional:** the `daily_rollups` recompute job reads it to count
  distinct blocks per day, and an event that omits it inflates `blocks_done` rather than
  erroring. Full contract in `docs/architecture/api.md` §2d. This event is the *only* source of
  the Progress heatmap's `blocks_done` — the `.update()` on `blocks.status` does not feed it, by
  design (`blocks` is client-writable, so its timestamps aren't trustworthy for reporting).

**States to design:** empty form → submitting/streaming → success (real plan) → success (fallback
plan, softer messaging) → hard error (retry).

**Boundaries:** no direct table reads/writes to `plans`/`plan_categories`/`curriculum_items` from
this screen — the Route Handler already does the writes. Nothing here calls Supabase directly
except reading the session that `proxy.ts` already guarantees exists.

---

## 2. Today screen (mtdo-bugs #87)

**Route:** under `web/app/(app)/` (directory doesn't exist yet — create it).

**Purpose:** what am I studying right now, today. The kanban-shaped daily view — this is the
screen a returning user actually lands on and lives in.

**Data contract — `schema.md` §2, `blocks` table:**

- `blocks(id, user_id, plan_id, category_id, date, position, text, status, notes, coaching jsonb,
  claimed, started_at, elapsed_seconds, completed_at)` — ordinary client-writable table under RLS
  (own rows only), no RPC needed for reads or status updates on `status`/`notes`/`claimed`.
- `status` is `'todo' | 'in_progress' | 'done'` — this is the kanban column key.
- Query `blocks` filtered to `date = today` and `user_id = auth session user`, ordered by
  `position`. **Answered 2026-09-06 — "today" is the UTC date**, not the browser's local date.
  `daily_rollups.date` is bucketed in UTC for the same reason (no per-user time zone is stored
  anywhere yet — `api.md` §3a), and Today and Progress disagreeing about which day it is would be
  a genuinely confusing bug. Use `new Date().toISOString().slice(0, 10)`, not
  `toLocaleDateString()`. If per-user time zones ever ship, both screens change together;
  `decisions.md`'s "Open, not yet decided" tracks it.
- **`elapsed_seconds` on a block is a client-maintained convenience mirror, explicitly documented
  as NOT the trustworthy focus-time source** (`schema.md` §2) — fine to show as a rough per-task
  number on this screen, but Progress/reporting must never read it as ground truth. If Today needs
  to show "how long did I actually spend," that has to come from `focus_sessions`/the ledger, not
  this column.
- Starting a task's focus block is the existing Session screen's job (`web/app/session/page.tsx`,
  already built) — Today's "begin" action on a block should route into that flow with the
  relevant `block_id`, not reimplement session start here. `start_session`'s `p_block_id` param
  already exists for exactly this (`migrations/0001`/`0004`).

**States to design:** empty (no blocks for today — e.g. plan just created, first day), populated
kanban (todo/in_progress/done columns), a block claimed/in-progress (visually distinct, ties into
Session).

**Boundaries:** block status transitions are direct client `.update()` calls under RLS — no RPC
exists or is needed for this (unlike sessions/ledger). Do not invent one. The ledger event above
is *in addition to* that update, not a replacement for it — the `.update()` is the block's state,
the event is the record that it happened.

---

## 3. Progress heatmap + Record Card export (mtdo-bugs #89)

**Route:** under `web/app/(app)/`, likely alongside or part of Today — exact placement is J's
call within `DESIGN.md`'s layout rules.

**Data contract — `schema.md` §2, `daily_rollups` table:**

- `daily_rollups(id, user_id, date, room_id null, blocks_done, focus_seconds,
  sessions_completed, computed_at)` — **read-only to clients** (`grant select ... to
  authenticated`, no insert/update/delete grant). This is the heatmap's data source.
- **~~Known blocker~~ RESOLVED 2026-09-06 (mtdo-bugs #93):** the recompute job now exists —
  `recompute_daily_rollups()` (`supabase/migrations/0009`) on a pg_cron schedule every ten
  minutes (`0010`). Full contract, including how each column is derived and which day a fact
  lands on: **`docs/architecture/api.md` §3a**. Read that before deciding what the heatmap's
  intensity scale means. Three consequences for this screen:
  - **`focus_seconds` and `sessions_completed` populate immediately** — the session RPCs that
    feed them are already wired.
  - **`blocks_done` will still read `0` for every user**, and that is *not* a bug in the job or
    in your UI. It derives from `task_completed`/`task_regressed` ledger events, which have no
    call site anywhere yet (`api.md` §2c) — the Today kanban (§2 of this brief) is the screen
    that will emit them. Until Today ships, the honest heatmap is focus-time-driven.
  - **`computed_at` distinguishes the two empty states.** A missing row means "nothing happened
    that day"; rows whose `computed_at` is hours stale means the job stopped. Still design an
    explicit empty state, and still don't compute a client-side approximation from
    `activity_events` as a substitute — that's exactly the derived-data reinvention
    `schema.md` §2's "derived, NEVER hand-written (D13)" rule exists to prevent.
- **`date` is a UTC date, for every user, deliberately** (no per-user time zone is stored
  anywhere yet — `api.md` §3a and `decisions.md`'s "Open, not yet decided"). Render the grid from
  the `date` values as given; do **not** re-bucket them into the browser's local time zone
  client-side, or the heatmap will disagree with Today about what "today" is.
- **Heatmap color ramp is already specified, do not invent one:** `DESIGN.md` §Color → "Heatmap
  ramp" — `rgba(255,255,255,.06)` → `#0E7490` → `#0891B2` → `#06B6D4` → `#22D3EE`. "Keep the grid
  DNA (dense, honest, unforgiving); change only the ramp" from the terminal app's GitHub-green
  heatmap.
- **Record Card export**: no export format is specified anywhere yet (not in `api.md`, not in
  `mtdo-web-v1-plan.md` beyond the name). Before building this half, get a one-line confirmation
  from the user on what "export" means here (image download? shareable link? PDF?) — this is
  exactly the kind of unstated decision that produced Theme Studio's scope drift last time.
  Don't guess and build a direction; ask first.

**Hard prohibition specific to this screen, from `DESIGN.md`:** "The app never exaggerates the
user's record. That honesty is inherited from the terminal app and is non-negotiable." No
inflated numbers, no fake progress bars, no gamified framing on top of the honest daily-rollup
counts.

---

## Cross-cutting boundaries (all three screens)

- `DESIGN.md` is dark-only for v1 — "If added later, do not invert: redesign surfaces from
  scratch... reserve the treatment for a v2 theming feature." One theme, not a gallery of themes.
- No payment/checkout UI anywhere in Wave 1 — nothing in `mtdo-web-v1-plan.md`'s Wave 1 scope or
  `DESIGN.md` describes monetization; that's a later-phase, explicitly-scoped decision if it ever
  happens, not something to prototype opportunistically.
- If a screen seems to need a schema/RLS/RPC change, or a design decision `DESIGN.md` doesn't
  cover, that's a message to M before writing code — not a judgment call mid-build (dev-split-plan
  §1's "J files it as a request to M" rule, and §6's "every Codex brief is closed-form" rule both
  exist for exactly this situation).
