# mtdo web — Learner Evidence Layer: the M / J split

**Status:** Phase G merged/in review; H–I not started. **Created:** 2026-09-16
**Owner:** Mukund (backend, Claude Code) + Janhwi (frontend, Codex)
**Related:** `mtdo-web-dev-split-plan.md` (§1 ownership, §2 branches, §3 handoff — **this doc adds
no new rules, it only maps an existing plan onto them**), `mtdo-web-review-study-profile-plan.md`
(Phases A–E, shipped — not reopened), `DESIGN.md`.

The plan being divided is the **Learner Evidence Layer** (Phases G–I now, J–P designed-later): the
wave that captures the observations MTDO is currently destroying on every edit, so that planning
calibration, start discipline and friction become measurable later. **It builds evidence and
semantics, not new scores.**

---

## 1. Why this needs an explicit split

The evidence layer is backend-first by nature — its substance is migrations, RPCs and ledger
semantics. That creates two specific risks the generic ownership table doesn't resolve on its own:

1. **Migration numbering.** This repo has already had **two** numbering collisions from concurrent
   PRs. Only M writes migrations, ever — §1's "never edited by J" line is doubly load-bearing here.
2. **`web/app/session/page.tsx`.** Phase G already edited it (three status-write call sites), and
   Phase I needs a check-in prompt on that same screen. Left unmanaged, both devs rewrite one file.

---

## 2. Ownership for this wave

Follows `mtdo-web-dev-split-plan.md` §1 exactly; listed here only where this wave adds a surface.

| Surface | Owner |
|---|---|
| `supabase/migrations/**`, all new RPCs, `supabase/tests/**` | **M** |
| `docs/architecture/{schema,api,decisions}.md`, `web/lib/supabase/database.types.ts` | **M** |
| `web/lib/review/types.ts`, `web/lib/plan-generation/**` — TS mirrors of a DB contract | **M** |
| Ledger instrumentation with **no visual surface** (the `visibilitychange` listener) | **M** — §1 assigns "analytics/ledger patterns" to M |
| `web/app/(marketing)/architecture-02/**` screens, `web/components/**`, tokens/DESIGN.md work | **J** |
| The post-session check-in **component** | **J** builds, **M** defines the props contract |

### The `session/page.tsx` collision, resolved

Use the **EmberMorph precedent** already in §1 ("J builds it, M defines the trigger contract"):
J builds `web/components/SessionCheckIn.tsx` standalone against a props contract M locks first, and
adds only a minimal mount point to `session/page.tsx`. M owns the `visibilitychange` listener in
that file, since it is pure ledger instrumentation with no UI. **Neither dev restructures that file.**

---

## 3. Wave pipeline

Per §3, serialization is **per wave, not global** — J is never idle waiting on M.

| Wave | M (Claude Code) | J (Codex) |
|---|---|---|
| **1 — now** | Land **G**; then **H backend**: `topics` (+`parent_topic_id`), `curriculum_items.topic_id`/`blocks.topic_id`, `plans.target_date` + `plan_target_changed`, `category_target_changed`, `focus_sessions` attribution snapshots | **Review evidence-disclosure UI** — deliberately chosen to need **no new contract**: `study_profile()` already returns `sample_size`/`window_days`/`confidence` today |
| **2** | **I backend**: `activity_events.client_event_id` + unique index, `record_session_check_in()`, `check_in_state`, server-minted check-in kinds + sampling provenance, `session_visibility_changed` | **H frontend**: goal target-date UI, topic entry in manual setup |
| **3** | **J backend**: `evidence` + `coverage` objects on `study_profile()` (**changes a shipped contract** — flag as modifying a live surface) | **I frontend**: `SessionCheckIn` component |

J's Wave-1 scope is designed so the disclosure affordance can absorb `evidence`/`coverage` in Wave 3
**without a redesign** — that is the point of doing it first.

---

## 4. J's Wave-1 brief (on record)

**Branch** `feature/j/evidence-review-ui` → PR into `main`. `.claude/PROGRESS.md` entry as the
**last commit before opening the PR only** — two people append to that file (§2).

**Design canvas: deliberately waived for this wave** (user decision, 2026-09-16). §3 normally
requires a canvas before J builds any wave containing a screen. This wave adds a small affordance
to *existing*, already-approved Review cards rather than introducing a screen, so `DESIGN.md` plus
the shipped card styling is sufficient constraint. Recorded so the skip reads as a decision, not an
oversight — the next wave with a genuinely new surface gets a canvas as normal.

1. **"Why am I seeing this?" disclosure.** A reusable affordance revealing, per stat: sample size,
   window, confidence. A stat at `insufficient_data` says so and **renders no number** — the backend
   returns `null` rather than guessing and the UI must not paper over it. Must accept a future
   `evidence` object and `coverage` ratio without redesign.
2. **The range tabs.** `review-deck.tsx` (~121–127) renders "Coming soon" for Week/Month/6 Weeks/
   Year. Implement only where an RPC genuinely supports the range; otherwise an honest empty state
   naming what is missing. **Never aggregate client-side to fake a range** — `api.md` §3f's "no
   metric has two implementations" rule.
3. **Dead code.** `review-time-behavior.tsx`'s `ReviewTimeBehavior()` is never mounted; only its
   helpers are imported. Mount it or delete it — don't leave it ambiguous.

**Boundaries:** no migrations/RPCs/RLS ever (file a request to M instead); no edits to
`supabase/**`, `docs/architecture/**`, `database.types.ts`, `web/lib/review/types.ts`,
`web/lib/plan-generation/**`, or `web/app/session/page.tsx`.

---

## 5. Operational notes (hard-won, save the rediscovery)

- **E2E against the shared Supabase project is rate-limited.** Every fresh browser context becomes a
  new anonymous user (`playwright.config.ts` says so). Running specs repeatedly in quick succession
  exhausts the anonymous-auth limit and produces failures that look like product bugs — the classic
  symptom is a redirect to `/architecture-02/onboarding/manual` where a route should have been
  created. Space runs out; don't chase it as a regression.
- **`npm install` before assuming a build break.** Dependencies land on `main` regularly; a stale
  `node_modules` presents as unrelated module-not-found errors.
- **Check the migration number immediately before writing one** (`supabase migration list`), not at
  the start of a session. Two collisions have already happened this way.
- **e2e runs against the live shared Supabase project, so any PR adding an RPC the frontend calls
  cannot pass CI until its migration is applied live.** The order is always: push migration → CI
  can go green → merge. Phase G's `web-e2e` failed with a silent no-op drag purely because
  `transition_block_status()` did not yet exist remotely, while `supabase-tests` passed (it runs
  migrations against a fresh local postgres, not the shared project) — that gap is exactly why this
  note exists. This affects Phase H and Phase I too, since both add RPCs the frontend calls
  (`set_plan_target_date()`/`set_category_target()`/`create_topic()` for H) — do not merge a PR for
  either phase before its migration has actually been pushed to the live project.
