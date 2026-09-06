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
- Query `blocks` filtered to `date = today` (server timezone vs. client timezone: use the date the
  server considers "today" — if this needs a decision, ask M, don't guess) and `user_id = auth
  session user`, ordered by `position`.
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
exists or is needed for this (unlike sessions/ledger). Do not invent one.

---

## 3. Progress heatmap + Record Card export (mtdo-bugs #89)

**Route:** under `web/app/(app)/`, likely alongside or part of Today — exact placement is J's
call within `DESIGN.md`'s layout rules.

**Data contract — `schema.md` §2, `daily_rollups` table:**

- `daily_rollups(id, user_id, date, room_id null, blocks_done, focus_seconds,
  sessions_completed, computed_at)` — **read-only to clients** (`grant select ... to
  authenticated`, no insert/update/delete grant). This is the heatmap's data source.
- **Known blocker, not yet resolved on the backend side:** nothing computes `daily_rollups` yet.
  `schema.md`'s own comment says it's "written by a future service-role recompute job" — that job
  does not exist in this repo as of this doc. Build the heatmap UI against the documented
  `daily_rollups` shape now (so the screen is ready the moment real rows exist), but expect an
  **empty table** in dev/staging until that job ships. Design an explicit empty state for this —
  don't treat "no rollup rows yet" as a bug to work around client-side, and don't compute a
  client-side approximation from `activity_events` directly as a substitute (that's exactly the
  kind of derived-data reinvention `schema.md` §2's "derived, NEVER hand-written (D13)" rule
  exists to prevent). Filed as mtdo-bugs #93 (M-owned, backend) — flag M if it's still unresolved
  when this screen is otherwise ready to ship.
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
