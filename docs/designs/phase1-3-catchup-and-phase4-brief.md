# Catch-up (Phases 1-3) + Phase 4 frontend brief

**Status:** ACTIVE
**Owner:** M owns this doc (dev-split-plan §1) — built while J was unavailable; frontend
ownership reverts to J starting Phase 4.
**Related:** `~/.claude/plans/role-you-are-keen-avalanche.md` (the full 8-phase plan),
`docs/architecture/{schema,api,decisions}.md`, `DESIGN.md`

## Why this doc exists

J was unavailable for Phases 1-3, so M built both backend and frontend for all three (Sonnet
throughout — none of it was schema/RLS/session-authority *design*, just implementation against
already-decided shapes). J is back. Part 1 below is the catch-up: what shipped, where it lives,
and two things worth knowing before touching any of it. Part 2 is Phase 4's actual frontend
brief, closed-form, per the dev-split plan's own rule against "explore the repo and figure out
what to do."

---

## Part 1 — Catch-up: Phases 1-3 (all merged to `main`)

### Phase 1 — PR #141: made Home/Session/Time honest

Every hardcoded literal ("Two Sum", "3h 20m", "Make joins feel obvious") on Home and Session is
gone, replaced with real data. If you're touching `page.tsx`'s `HomeDeck`, `session/page.tsx`, or
`today-deck.tsx`/`progress-deck.tsx`, **read the diff first** — the shape of several things
changed:

- `HomeDeck` is now a real fetch (active plan, today's blocks, running session, streaks,
  `daily_rollups`). The fake `FocusChamber` overlay is gone entirely — Home's focus button now
  routes straight to the real `/session` screen.
- New files: `web/lib/coaching/build-coaching-content.ts` (ports `coaching.py`'s three-tier merge
  for the session coach rail), `web/app/(marketing)/architecture-02/streak.ts` (read-time streak
  math, no new column), `profile-timezone.ts` (shared `fetchProfileTimezone()` helper — Today,
  Progress, and Home all use it now).
- Marketing root (`/`) has a real "Open the app" link now.

### Phase 2 — PR #142: AI provider abstraction, `Settings → AI`

Backend-only in substance (`web/lib/ai/**`, migration 0015), but it did add one new screen:
`web/app/(marketing)/architecture-02/settings/page.tsx`. **It's deliberately read-only** — it
shows the live-resolved AI provider/reachability/models from `GET /api/ai/status`, but there's no
provider-switcher control, because `ai_provider_settings` (the per-user override table) isn't
consulted by provider selection yet. Don't add a write control there without checking with M
first — it would be a real, live control with no backend effect, which is exactly the class of
fake surface Phase 1 spent its whole scope removing.

The previously-dead "More" dock button now navigates there.

### Phase 3 — PR #143: the plan pipeline (manual setup, import/export, curriculum check-in)

**Read `docs/architecture/decisions.md`'s 2026-09-08 entry before touching curriculum-exhaustion
UI at all** — it reverses the entry right above it (`2026-09-07`, "re-onboard"). Current, real
behavior: a plan is **extended in place** when it runs low, not replaced by re-onboarding.

New screens, all under `web/app/(marketing)/architecture-02/onboarding/`:

- **`onboarding/page.tsx`** — gained a new first step, `step: "method"`, before the existing
  Guided AI wizard (unchanged). Three choices: Guided AI / Manual setup / Import.
- **`onboarding/manual/`** — a goal/category/task editor. Persists directly through the existing
  `persistGeneratedPlan()` (no Route Handler — every write is an RLS-scoped client table).
- **`onboarding/import/`** — one page, two tabs (Import / Export). Import validates against
  `parseGeneratedPlan(text, { weekCount: "any" })`; Export reconstructs a `mtdo.plan.v1` JSON from
  the DB. Export is **documented as an honest, not byte-perfect, reverse** for AI-generated
  content (multi-item day-lists can't be reconstructed exactly from `week_index`/`position`
  alone) — don't "fix" this without reading that file's own comment on why.
- **`today-deck.tsx`** gained a check-in banner (shows when every category with content is fully
  unlocked and the menu is down to ≤3 items), which calls the new `POST /api/plan/extend`.

**One real, previously-latent bug fixed along the way, worth knowing about**: the walkthrough
tour's own step-1 effect used to silently override a `?deck=work` handoff (onboarding → Today)
for any first-time visitor who hadn't already dismissed the tour. Fixed in `page.tsx` — a `?deck`
handoff now always wins over the tour auto-opening. If you're touching the tour or the deck
routing, know this interaction exists.

**Everything in Phases 1-3 has real Playwright coverage** (`web/e2e/*.spec.ts`) run against a
real production build with a real anonymous Supabase session — not mocked. If you change any of
the screens above, run `npx playwright test` before pushing, not just `tsc`/`lint`.

---

## Part 2 — Phase 4 (planning mode): frontend brief

**Contract status: locked, migration 0017 is live.** Build against the shape below now.

### What this phase is

A plan can run in one of two modes:

- **`dynamic_weekly`** (the default, current behavior, unchanged) — the menu unlocks one more
  week per category per ISO week the user shows up (`ensure_curriculum_menu()`'s existing cursor
  logic).
- **`overall`** (new) — the whole plan's curriculum is visible on the menu at once, no weekly
  drip-feed. For a user who wants to see and pick from everything up front rather than being paced.

### The backend contract

- `plans.planning_mode text not null default 'dynamic_weekly' check in ('dynamic_weekly',
  'overall')` — a plain column, client-readable/writable like the rest of `plans` (no RPC needed
  to read or write it).
- `ensure_curriculum_menu()`'s return shape is **unchanged** — same columns, same RPC name. Only
  its internal behavior branches: `dynamic_weekly` keeps today's cursor-gated logic exactly as is;
  `overall` returns every unpicked item regardless of `menu_unlocked_week_index`.
- **The unlock cursor is never touched while a plan is in `overall` mode** — switching back to
  `dynamic_weekly` later resumes from exactly where it was left, not from wherever it would have
  drifted to had it silently kept advancing while unseen. If you build a "your progress" or
  "weeks unlocked" indicator anywhere, know that this number is frozen, not stale, while a plan
  is in `overall` mode.
- **If you touch the curriculum check-in banner (`today-deck.tsx`) or its route
  (`/api/plan/extend`)**: both already handle both modes correctly (fixed as part of locking this
  contract — the original Phase 3 exhaustion check assumed `dynamic_weekly`'s cursor semantics
  and would have silently never fired for an `overall`-mode plan). Nothing for you to do here,
  just know the mode-awareness already exists if you're reading that code.

### Two screens

1. **Mode selector in onboarding.** Add a step (or a field on an existing step — your call on
   placement, this isn't prescribed) letting a new user choose Dynamic Weekly or Overall.
   `dynamic_weekly` should be visually the recommended/default choice (it's what `persist.ts`'s
   insert defaults to if omitted, so "no explicit answer" is a safe, correct outcome either way).
   Wire the choice into whichever persistence path the plan goes through
   (`persistGeneratedPlan()` already inserts `plans` — the new field just needs including in that
   insert call, which M can help wire if it touches shared code).
2. **Switchable later in Settings.** Add a "Planning" section to the existing
   `architecture-02/settings/page.tsx` (alongside the AI section from Phase 2) showing the
   active plan's current mode with a toggle/selector to change it — a plain `.update()` on
   `plans`, same RLS-scoped pattern as everything else on that page.

### Model / effort (Codex)

| # | Title | Description | Model | Effort |
|---|---|---|---|---|
| 1 | Onboarding mode selector | New step or field in the Guided AI / Manual Setup flows letting a user pick `dynamic_weekly` vs `overall`. | `gpt-5.6-terra` | Small — real state, but a two-option choice, not a complex flow |
| 2 | Settings → Planning mode switch | New section on the existing Settings page, reads + writes `plans.planning_mode`. | `gpt-5.6-terra` | Small |

Both are "real state/logic" tier (they read and write actual plan data, not static copy), so
`terra` for both — no `mini`-tier work in this phase.

---

## Backend (M) — model / effort

| # | Title | Description | Model | Effort |
|---|---|---|---|---|
| 1 | Migration 0017 | `plans.planning_mode` column + branch `ensure_curriculum_menu()` on it. This modifies an already-hardened, already-tested function (115+ assertions depend on its current behavior) — new assertions get added *before* changing the function, full suite re-run after, same discipline as every other change to this function so far. | Sonnet (current) | Small-medium — small diff, but touching a hardened function warrants care |
| 2 | Docs | `schema.md` (`planning_mode` column), `api.md` §3b (the mode branch), regenerate types. | Sonnet | Trivial |

No Opus anywhere in Phase 4 — this is "one small change to one function," per the plan's own
description, not new schema/RLS/session-authority design.

---

## Verification, once both sides are done

- SQL: new assertions proving both modes' menu behavior, and that switching modes mid-plan
  behaves sanely (an already-unlocked `dynamic_weekly` category's progress isn't lost when
  switching to `overall`, and vice versa).
- Playwright: pick a mode in onboarding, confirm the menu behavior matches; switch it in Settings,
  confirm the menu behavior changes accordingly.
- `git log --stat` on both PRs should show ownership held — M's PR touches only
  `supabase/migrations/**` + docs, J's PR touches only the two screens above.
