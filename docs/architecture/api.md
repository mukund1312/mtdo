# mtdo web — API surface & component contracts

**Status:** ACTIVE. **Created:** 2026-09-04.
**Last revised:** 2026-09-06 (§2a added — onboarding plan-generation Route Handler contract, implemented).
Previously revised 2026-09-04 (adversarial schema/RLS audit — §3 is new; see `decisions.md`).
**Related:** `schema.md`, `DESIGN.md`.

## 1. Repo layout

```
mtdo/
├── src/mtdo/              # unchanged Python TUI
├── tests/                 # unchanged pytest
├── web/                   # ← new
│   ├── app/
│   │   ├── (marketing)/   # landing pages
│   │   ├── (onboarding)/  # goal → AI plan
│   │   ├── (app)/         # today, session, progress, vault, kanban
│   │   └── styles/tokens.css
│   ├── app/api/           # Route Handlers holding secrets (M-owned regardless of path —
│   │   │                  # ownership is by content, not directory; see split-plan §1).
│   │   │                  # e.g. api/onboarding/plan/route.ts (§2 below).
│   ├── components/        # primitives built from DESIGN.md
│   ├── lib/supabase/      # typed client, generated types
│   ├── lib/plan-generation/  # pure prompt/parse/persist helpers for onboarding plan generation (§2)
│   ├── lib/copy.ts        # the web↔terminal vocabulary dictionary (DESIGN.md §Vocabulary)
│   └── package.json
├── supabase/migrations/   # SQL, source of truth for schema (see schema.md)
└── docs/architecture/     # this directory
```

`ci.yml` currently runs the full pytest suite on every PR with no path filter. Split it:
`paths: ['src/**','tests/**']` for the Python job, `paths: ['web/**']` for a new web job — without
this, a CSS-only PR costs four minutes of unrelated Python CI.

## 2. AI integration

- **Plan generation** (onboarding): Route Handler → Anthropic API, streamed. One-time and
  user-facing, so a loading state is acceptable here. **Implemented** — full contract below.
- **Coaching content**: mostly *not* an AI call. `curriculum_items.meta` and
  `plan_categories.coaching_framework` (schema.md §2) carry real authored content — the terminal
  app already renders full coaching with no AI backend configured at all. Preserve that failure
  contract on web: coaching must degrade to static content, never block the core loop.
- **AI Tutor Memory chat** (W3b): built against the retrieval strategy in `schema.md` §3. Never
  replays full history; reads the rolling summary plus recent messages only. **This must be a
  Route Handler using the service-role key** — `tutor_messages` is not client-writable, by
  design (see §3 below and `schema.md` §3). It is the only component that may write there, and
  it must check the free-tier cap against `activity_events` *and* write the
  `tutor_message_sent` event itself, in the same transaction as the message rows.
- **AI manager** (rooms, W4b, per group-study D15): **async only** — Vercel Cron or `pg_cron` →
  job row → worker reads `activity_events` → writes a summary row. Never in a request path, never
  a chatbot.

## 2a. Onboarding plan generation — contract (Wave 1, implemented)

`POST /api/onboarding/plan` — `web/app/api/onboarding/plan/route.ts`. Placed under `app/api/`
(not literally inside the `(onboarding)` route group) because a route group doesn't affect the
URL, and a Route Handler holding `ANTHROPIC_API_KEY` is M-owned regardless of directory (split-plan
§1) — `app/api/**` is the convention going forward for any Route Handler with a secret, so it
never collides with a page route J adds under `(onboarding)/`.

**Ported vs. written fresh.** The terminal app's `plan_wizard.py` (PERSONAS/QUESTIONS/build_prompt
design) is superseded — it now just hands `goals_template.json` to whatever AI the user already
has open (see that file's own module docstring, `gh47`). What *is* ported: `goals_template.json`'s
`_read_this_first` rules (one-subject-per-category, curriculum-as-weekly-menu, rich per-task
coaching metadata — rules 1/5/9/9b/9c) into `web/lib/plan-generation/prompt.ts`'s prompt, and
`config.py`'s `goals_to_config()` shape (categories → curriculum → rich task objects) into the
`GeneratedPlan`/`GeneratedCategory`/`GeneratedTask` types and the DB-row mapping in
`web/lib/plan-generation/persist.ts`. The onboarding **questionnaire itself** (`OnboardingAnswers`:
`goalLine`, `focusAreas[]`, `experienceLevel`, `weeklyDaysAvailable[]`, optional `appName`/`notes`)
is written fresh — there's no existing structured Q&A to port, since `plan_wizard.py`'s original
persona/question design was already retired before this session. J builds the onboarding form
against `OnboardingAnswers` (`web/lib/plan-generation/types.ts`).

**Request:** JSON body matching `OnboardingAnswers`. 400 (plain JSON, not streamed) if malformed.
401 (plain JSON) if there's no authenticated session — the anonymous-auth proxy (`proxy.ts`)
already guarantees one exists by the time onboarding runs, so this should not happen in practice.

**Response:** `200`, `Content-Type: application/x-ndjson`, one JSON object per line (read with
`response.body.getReader()` + a line splitter — not `EventSource`, since this is a `POST`):

| line | when | shape |
|---|---|---|
| `delta` | streamed as the model generates | `{"type":"delta","text":string}` — raw text chunks, for a live "building your plan…" loading state (api.md §2's "loading state is acceptable") |
| `done` | exactly once, at the end, on success | `{"type":"done","usedFallback":bool,"plan":{"planId","appName","goalLine","categories":[{"id","name","label"}]}}` |
| `error` | only if generation *and* the fallback plan both failed to persist | `{"type":"error","message":string}` |

**Failure contract.** If the Anthropic call errors, times out, or its output doesn't parse into a
valid plan (`web/lib/plan-generation/parse.ts` validates every field), the route falls back to a
static two-category starter plan (`web/lib/plan-generation/fallback.ts`) and still returns a
`done` event with `usedFallback: true` — onboarding never dead-ends a new user on an AI failure,
extending the existing "coaching degrades to static content" contract to plan *generation* too.
J's onboarding UI should treat `usedFallback: true` as a real, if less personalized, plan (e.g. a
one-line "we started you with a simple plan — you can customize it" note), not an error state.

**Writes.** `plans`/`plan_categories`/`curriculum_items` are ordinary client-writable tables
(schema.md §6) — the three *inserts* need no RPC, and go directly under the user's RLS session via
`lib/supabase/server.ts`. `persist.ts` inserts the plan `is_active: false`, then does exactly three
insert statements (plan → categories batch → curriculum_items batch), each atomic on its own table
but **not atomic across all three**. If categories or curriculum_items fail to insert after the plan
row exists, `persist.ts` marks that plan `is_active: false` again (there's no DELETE path —
`schema.md`'s "no DELETE policy on plans" — so this is the only cleanup available) rather than
leaving a half-written plan active. `week_index`/`position` on `curriculum_items` are derived, not
model-supplied: every `category.days.length` consecutive `curriculum` entries are one week
(`week_index = floor(dayListIndex / category.days.length)`), and `position` is a running counter
across the whole flattened curriculum for that category — this is the concrete mapping schema.md §2
left implicit.

**Activating the plan is an RPC, unlike the inserts above (gh90).** Once all three inserts succeed,
`persist.ts` calls `activate_plan(p_plan_id)` (`migrations/0005`) rather than a raw `.update()` —
two independent PostgREST round trips deciding "which plan is active" is a genuine, unclosable data
race between concurrent requests for the same user (verified by hand-tracing a reviewed-and-rejected
fix attempt, PR #95). `activate_plan()` holds `pg_advisory_xact_lock` for its own deactivate+activate
pair, serializing concurrent calls per user. This closes the *write* race; it does not and cannot
retroactively un-send an HTTP response a loser's request already returned before a winner's call
superseded it — that's a client double-submission problem, not a database one (see the migration's
own comment).

**Model:** `claude-sonnet-5` (split-plan §5: Sonnet for Route Handlers/RPC-shaped implementation
work against an already-decided shape; Opus is reserved for schema/RLS/session-authority/tutor-
retrieval design, which this task wasn't).

## 2b. Feedback widget — insert path (Wave W2, implemented)

`web/lib/feedback.ts` — `submitFeedback(supabase, { screen, message })`. Inserts one row into
`feedback` (`schema.md`'s new table, `supabase/migrations/0003_feedback.sql`), capturing the
current user (`supabase.auth.getUser()`) and the screen/route the widget was opened from.

**Not a Route Handler, not an RPC.** Unlike the tutor chat backend or the session RPCs, this
insert holds no secret and nothing downstream treats `feedback` as unforgeable — the ordinary
anon-key client plus RLS's `with check ((select auth.uid()) = user_id)` is the whole access
control, the same pattern `plans`/`notes`/`companies` already use. `submitFeedback()` takes an
already-constructed `SupabaseClient` (browser or server) rather than importing one itself, so
J's widget can call it from a Client Component using `lib/supabase/client.ts`, or from a Server
Action/Route Handler using `lib/supabase/server.ts` — whichever fits where the widget is mounted.

**Call site contract:**

```ts
import { submitFeedback, SubmitFeedbackError } from "@/lib/feedback";

try {
  await submitFeedback(supabase, { screen: pathname, message: text });
} catch (e) {
  if (e instanceof SubmitFeedbackError) { /* show inline error, don't crash the widget */ }
}
```

- `screen` is free text (not an enum) — pass whatever route/screen identifier the caller already
  has, e.g. `window.location.pathname` or a neutral screen key. Nothing branches on its value
  server-side.
- `message` is trimmed and rejected client-side if blank or over 4 KB before the round trip; the
  DB enforces the same bounds (`feedback_message_not_blank`, `feedback_message_bounded`) as a
  backstop, not as the primary UX.
- No update/delete path exists (by design — see `schema.md`'s `feedback` entry) — a widget that
  wants "edit my last feedback" is a new feature request, not a bug in this contract.

## 2c. Event instrumentation wiring status (Wave 2, `web/lib/analytics/record-event.ts`)

`record_event()` (schema.md §4) existed from W0 with no client call sites. This wave wired the
ones with a real trigger point in the app as it exists today and deliberately left the rest
unwired rather than fabricating a UI moment for them.

**Wired:**

| `kind` | Call site | Note |
|---|---|---|
| `screen_opened` | `web/app/session/page.tsx`, on mount (`useEffect`, empty deps) | `payload: { screen: "session" }`. Only the session screen — no other real screen exists in M's scope; `(marketing)/page.tsx` is J-owned UI (split-plan §1) and wasn't touched. If J wants marketing-page `screen_opened`, that's J calling `recordEvent()` from `lib/analytics/record-event.ts` directly, not a new RPC or schema change. |
| `plan_generated` | `web/app/api/onboarding/plan/route.ts`, right after `persistGeneratedPlan()` resolves (both the primary path and the fallback-after-persist-failure path) | Fired once, after persistence succeeds, not before — a persist failure that falls through to fallback doesn't double-count. |

**Decided: `goal_created` is not fired alongside `plan_generated`.** Onboarding creates exactly
one plan at exactly one moment; firing both kinds there would be two names for the identical
fact, which is the divergent-second-source-of-truth problem §4 rule 1 already warns about.
`goal_created` stays reserved for a future flow that creates/edits a goal without going through
AI plan generation (e.g. a manual goal editor, if one is ever built) — wire it there, not here.

**Decided: `focus_mode_toggled` is not wired.** `web/app/session/page.tsx` has no independent
"focus mode" toggle — its `phase` state (`ready → starting → active → exiting`) is exactly the
session lifecycle already captured by the server-minted `session_started`/`session_completed`/
`session_abandoned` events. Firing `focus_mode_toggled` at the same transitions would be a
client-side duplicate of facts the server already records authoritatively, not a genuinely new
fact (§4 rule 1). This differs from the terminal app's `analytics.record("focus_mode_toggled", …)`
(`src/mtdo/app.py`), which toggles a UI panel layout independent of any Pomodoro session — the web
product has no equivalent independent toggle yet. Revisit if/when the web UI grows a Focus-Mode-
as-a-layout-setting distinct from an active session.

**Left unwired — no UI trigger exists yet, do not fabricate one:** `signup`, `task_completed`,
`task_regressed`, `proof_submitted`, `note_created`, `paywall_viewed`. There is no kanban board,
notes UI, proof-submission flow, upgrade/signup-conversion UI, or paywall surface built yet. All
six stay in `ClientEventKind` (`web/lib/analytics/record-event.ts`) so the type is still the
single source of truth for what `record_event()` accepts, but have zero call sites. Wire each one
from the screen that actually emits it, when that screen exists — don't retrofit a trigger into
an unrelated component just to close this list out.

`session_started`/`session_completed`/`session_abandoned` need no client wiring — they're minted
server-side inside `start_session()`/`complete_session()`/`abandon_session()` (schema.md §5),
already called from `web/app/session/page.tsx`.

## 2d. Ledger payload contracts — what the rollup job reads

Most ledger payloads are free-form: nothing downstream reads them, so a call site can put
whatever is useful for later analysis in there. **Two kinds are different**, because
`recompute_daily_rollups()` (§3a) reads their payload to produce `daily_rollups.blocks_done`:

| `kind` | Required payload | Read by |
|---|---|---|
| `task_completed` | `{ block_id: string }` — the `blocks.id` that was completed | the recompute job's per-day dedup key |
| `task_regressed` | `{ block_id: string }` — the `blocks.id` that was un-completed | same |

**Why it matters, concretely.** The job counts *distinct blocks* per day, taking each block's
last event of that day. Without `block_id` it cannot tell a double-fired completion of one block
from two genuine completions of two blocks, and it cannot tell that a later `task_regressed`
cancels an earlier `task_completed` for the same block. An event that omits it is not dropped —
it falls back to the ledger row's own id and counts as one standalone completion — so a missing
`block_id` fails *loudly in the number*, by inflating `blocks_done`, rather than by erroring.
`DESIGN.md`'s "the app never exaggerates the user's record" is the rule this protects, so treat
the field as required, not optional.

Send the raw `blocks.id` UUID as a string. Nothing else in the payload is read by anything.

**Now wired** (as of `feat: wire Signal Deck today and progress`, PR #116) — the Today screen
(`web/app/(marketing)/architecture-02/today-deck.tsx`) emits `task_completed`/`task_regressed`
with `payload.block_id` when a block's status changes, matching the contract above. `blocks_done`
populates for real going forward; `focus_seconds` and `sessions_completed` were already wired via
the session RPCs.

## 2e. Observability — Sentry + PostHog (wired, Wave 1 follow-up)

`web/instrumentation.ts` (server/edge, Next.js's own instrumentation convention) and
`web/instrumentation-client.ts` (client, the `instrumentation-client` convention — see that file's
header comment for why this isn't wired through `app/layout.tsx`) initialize Sentry and PostHog.
Both read `NEXT_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_POSTHOG_KEY`+`NEXT_PUBLIC_POSTHOG_HOST` and
degrade silently when unset — same failure contract as every other integration in this product,
never a startup error. `web/app/global-error.tsx` is the root error boundary that reports
uncaught client errors to Sentry (required by Next.js to catch an error thrown by the root layout
itself, which is why it renders its own `<html>/<body>` rather than composing with `layout.tsx`).

PostHog's autocapture (`capture_pageview: true`) is supplementary product analytics (funnels,
heatmaps) — it does not replace the `activity_events` ledger (`schema.md` §4) as the source of
truth; `record-event.ts`'s explicit event vocabulary stays canonical for anything the product
itself reads back (rollups, coaching, retention).

Not done: source-map upload to Sentry on build (needs `SENTRY_AUTH_TOKEN` + org/project config,
not yet provisioned) and a `withSentryConfig` wrap of `next.config.ts`. Neither blocks error
capture working today; both are a later, low-urgency polish pass.

## 2f. AI provider abstraction (Phase 2, operating-engine plan)

`web/lib/ai/` is the one seam any UI component or Route Handler is allowed to import AI
generation from — nothing outside `service.ts` imports a concrete provider directly.

```
provider.ts            AIProvider interface: generateText / streamText / healthCheck / listModels
providers/anthropic.ts wraps @anthropic-ai/sdk — the exact call shape §2a's route used inline
                        before this existed, moved not changed
providers/ollama.ts     /api/chat (stream + format:"json"), /api/version, /api/tags — no SDK dep
service.ts              resolveProvider() + generateGoalPlan(); the only exported surface
```

**Selection is server-env-driven**, not per-request: `AI_PROVIDER` (`"anthropic"` default |
`"ollama"`), `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`. If `AI_PROVIDER=ollama` and its `healthCheck()`
fails, `resolveProvider()` falls back to Anthropic; if the resolved provider fails mid-stream,
`generateGoalPlan()` falls back to Anthropic once more before giving up — extending, not
changing, the existing "never block the core loop" failure contract (§2a's static-plan fallback
is still the last resort after that).

`migrations/0015`: `ai_provider_settings` (schema.md — per-user override row for self-hosters,
**not yet consulted by `resolveProvider()`**; write-only from the client today, a real effect on
selection is a follow-up, not built here) and `ai_generations` (schema.md — append-only audit
trail, service-role insert only). Neither table's presence changes selection behavior yet.

**`GET /api/ai/status`** — `web/app/api/ai/status/route.ts`. Authenticated (401 without a
session, same as §2a). Read-only, no body. Reports what `resolveProvider()` resolves to *right
now*, not a stored preference:

```json
{ "provider": "anthropic", "reachable": true, "models": ["claude-sonnet-5"] }
```

Backs the Settings → AI panel (`web/app/(marketing)/architecture-02/settings/page.tsx`), which is
currently a status display only — provider switching is still an env var, not a per-user control,
for the same reason `ai_provider_settings` isn't consulted yet (above).

**§2a's onboarding route** now calls `generateGoalPlan()` instead of the Anthropic SDK directly —
its documented contract (request/response shape, failure contract) is unchanged; only what's
inside the Route Handler moved. Its 17 tests (`route.test.ts`) are the regression gate for that
refactor and were required to pass unchanged, not rewritten to match the new internals.

**Not built yet:** `schemas.ts` (deferred — no domain method beyond `generateGoalPlan` exists to
need one), and the other `service.ts` domain methods the operating-engine plan's Phase 2 section
lists (`generateWeeklyPlanRecommendation`, `reviewWeek`, etc.) — those arrive with the phases that
actually call them (7, 8), not speculatively here.

## 3. How the app talks to the database

Most tables are read and written directly with the anon-key client under RLS. **Five are not**
(`focus_sessions`, `activity_events`, `daily_rollups`, `tutor_messages`,
`tutor_memory_summaries`), and this is the part that is easy to get wrong: they are read-only —
or, for `tutor_messages`, no-access — to clients, and their writes go through `security definer`
RPCs or a service-role backend. Calling `.insert()` on them does not fail
silently — it returns a `42501` permission error — but the fix is to use the RPC, never to add a
policy or a grant. `schema.md` §6 has the full privilege table.

| Instead of | Call |
|---|---|
| `from('focus_sessions').insert(...)` | `rpc('start_session', { p_planned_duration_s })` — omit `p_block_id` entirely for an unscheduled session; see §3's note below on why passing `null` there won't typecheck |
| `from('focus_sessions').update({ state: 'completed' })` | `rpc('complete_session', { p_id })` |
| `from('focus_sessions').update({ state: 'abandoned' })` | `rpc('abandon_session', { p_id })` |
| `from('activity_events').insert({ kind, occurred_at, payload })` | `rpc('record_event', { p_kind, p_payload })` |
| `from('tutor_messages').select(...)` | `rpc('tutor_context', { p_conversation_id, p_recent_limit })` |
| `from('tutor_messages').insert(...)` | *not available to clients* — the W3b Route Handler (service role) only |
| `from('daily_rollups').insert/update(...)` | *not available* — derived by `recompute_daily_rollups()`, service role only (D13); see §3a |

Reads of `focus_sessions`, `activity_events` and `daily_rollups` are ordinary RLS-filtered
`select`s and need no RPC.

Notes for call sites:

- **Never send `user_id`, `occurred_at`, `started_at` or `completed_at`** to these RPCs. They are
  not parameters; the functions derive them from `auth.uid()` and the server clock. That is the
  whole point of the indirection (D12, D14).
- **`record_event` accepts only client-appendable kinds** (`schema.md` §4). `session_*` and
  `tutor_message_sent` are server-minted and will be rejected with `22023` — the session RPCs
  already emit their own ledger events, so do not emit them yourself. Payloads must be JSON
  objects, ≤ 4 KB.
- **`start_session` returns `55006`** when a session is already running. Branch on it: `select`
  the running session and offer resume-or-discard, then `abandon_session()` before retrying. Do
  not treat it as a generic failure.
- **Upserts on `blocks` cannot use `ON CONFLICT`** against `blocks_slot_key` — it is a deferrable
  constraint, which Postgres will not use for conflict inference. Write update-then-insert.
- **Retiring a goal is `update plans set is_active = false`.** There is no delete path;
  `.delete()` on `plans` or `plan_categories` silently affects zero rows (RLS makes them
  invisible to the DELETE), which is a confusing thing to debug if you expected an error.
- **Generated types** (`web/lib/supabase/database.types.ts`, wired into `client.ts`/`server.ts`
  via `createBrowserClient<Database>`/`createServerClient<Database>`) exist now — regenerate with
  `supabase gen types typescript --linked > web/lib/supabase/database.types.ts` after any migration
  change. It's a plain generated file, not committed-then-diffed by hand — just overwrite it.
- **A generated RPC arg is marked optional (`?:`) whenever its SQL parameter has a `DEFAULT`, but
  the generator does not union the type with `null`, even when the function body genuinely accepts
  a null value for that argument** (e.g. `start_session`'s `p_block_id`, migrations/0004). Passing
  `{ p_block_id: null }` explicitly will not typecheck. The fix is at the call site, not the
  generated file: omit the key entirely rather than passing `null` — hitting the SQL `DEFAULT` this
  way is runtime-identical to passing `null` explicitly (see `web/app/session/page.tsx`'s
  `startSession`).
- **The reverse gotcha, same root cause:** `start_session`'s `p_planned_duration_s` is a genuinely
  *required* argument (the function's first check rejects a null one with a `22023` error) but is
  typed `p_planned_duration_s?: number` — optional — anyway, because Postgres only allows `DEFAULT`
  on trailing parameters, and `p_block_id` (which needs one) comes first, so `p_planned_duration_s`
  got a `default null` it doesn't semantically want just to satisfy that ordering rule
  (`migrations/0004`). TypeScript will not catch a call site that omits `p_planned_duration_s` — a
  `22023` at runtime is the only thing that will. There is no generated-types fix for this; it's a
  gap between "has a SQL default" and "is optional in practice" that the generator can't see past.
  Always pass it explicitly, and don't trust `?:` on an RPC arg as "safe to omit" without checking
  the actual function body first.

## 3a. `daily_rollups` — the recompute job (mtdo-bugs #93)

`daily_rollups` is derived and never hand-written (D13). `supabase/migrations/0009` supplies the
job that materializes it and `0010` schedules it; before those, the table had a shape, RLS and
grants but no writer at all, so the Progress heatmap could only ever render its empty state.

```sql
public.recompute_daily_rollups(
  p_from date default null,     -- default: p_to - 2
  p_to   date default null,     -- default: today, in p_timezone
  p_timezone text default 'UTC'
) returns integer                -- rollup rows written
```

Service role only — `EXECUTE` is revoked from `public`, `anon` and `authenticated`. Clients read
`daily_rollups` under RLS and never call this.

**Per-user time zones (migrations/0013).** `p_timezone` is a fallback, not the zone every row is
bucketed by. Each row's actual local date uses `coalesce(profiles.timezone, p_timezone)` — a user
with a stored preference is bucketed by *their own* zone regardless of what `p_timezone` the
caller (cron, currently `'UTC'`) passes; only a user who never set one falls back to it. The scan
window (`v_lo`/`v_hi`) is padded by the full possible UTC-offset range (-12:00..+14:00) so no
user's real local-date range is ever clipped by the window before the per-user bucketing runs —
this keeps the window comparison sargable (still a plain literal-bound comparison, not a function
call on the indexed column) while supporting a genuinely mixed-timezone user base in one call.

**Where the numbers come from.**

| Column | Source | Rule |
|---|---|---|
| `blocks_done` | `activity_events` (`task_completed` / `task_regressed`) | Distinct blocks per day, **last event of that day wins**. Re-completing one block counts once; complete-then-regress within the day counts zero. A regression on a *later* day does not retroactively change the earlier day. |
| `focus_seconds` | `focus_sessions` | `sum(least(completed_at - started_at, planned_duration_s))` over `completed` **and** `abandoned` sessions. Abandoned time is real time and counts; the cap keeps a tab left open for nine hours from reporting nine hours of focus. |
| `sessions_completed` | `focus_sessions` | `state = 'completed'` only. |

**Which day a fact lands on.** Tasks use the event's server-stamped `occurred_at`. Sessions use
`started_at`, *not* the settle time — a session spanning midnight counts whole on the day the
work began, and a session left running overnight and abandoned the next morning (the `55006`
recovery contract, §3) is credited to the day it was actually worked.

**Why sessions come from `focus_sessions` and not from the `session_*` ledger events.** They
cannot disagree: `settle_session()` writes the row and appends the event inside one transaction,
and neither table has a client write path. What the table has that the events do not is
`started_at` (the events don't carry it at all) and typed, constraint-backed columns instead of
a `jsonb` payload — reading focus time out of `payload->>'elapsed_s'` would start silently
producing nulls the day that payload's shape changed, and a heatmap that quietly reads zero is
the worst available failure mode for this table. `blocks.status`/`blocks.elapsed_seconds` are
*not* used for either: `blocks` is ordinary client-writable data under RLS, so its timestamps are
whatever the client says they are.

**It is a full replace, not an increment.** Every run rewrites each in-window
`(user_id, date, room_id)` row from source. That is what lets a number go *down* when a
correction arrives, and what makes the job self-healing — there is no drift state to repair.
`computed_at` is bumped on every run even when the numbers are unchanged, so a reader can answer
"how fresh is this row" (which is what it's for) rather than "when did it last change".

**Scheduling.** `0010` registers a pg_cron job, `mtdo-daily-rollups`, running
`select public.recompute_daily_rollups(null, null, 'UTC')` every ten minutes. If pg_cron is not
enabled on the project, that migration prints a notice and does nothing rather than failing —
check for it after a `db push`:

```sql
select jobname, schedule, active from cron.job where jobname = 'mtdo-daily-rollups';
```

If pg_cron is unavailable, drive the identical function from any service-role caller (a Supabase
Edge Function on a schedule, or a Next.js Route Handler behind Vercel cron holding the service
key — note `web/lib/supabase/server.ts` is the anon client and must not gain that key). Nothing
about the aggregation changes; only the trigger does.

**Backfilling.** After importing history, or the first time the job is enabled on a project that
already has a ledger:

```sql
select public.recompute_daily_rollups('2026-01-01', current_date, 'UTC');
```

Runs serialize against each other on an advisory lock, so a backfill and a cron tick cannot
interleave; the backfill waits rather than being skipped.

**The time zone is per-user now, not a property of the whole table (migrations/0013).**
`daily_rollups.date` means "the local date in *that user's* zone" — `profiles.timezone` when a
user has one set, `p_timezone` (the cron default is `'UTC'`) for a user who has never set one.
This replaces the earlier single-shared-zone design; the historical note that used to live here
("there is no per-user zone stored anywhere yet... the upgrade is to join it") is now the current
behavior, not a future one. **Backfilling a specific window still runs it once per relevant
zone-owning user's actual data, not per zone** — the function already does that internally per
row; a caller only needs to pick a `p_from`/`p_to` wide enough to cover the backfill, same as
before. Changing a *specific user's* zone after rows already exist under their old one still
needs a manual correction (delete that user's affected rows, re-run the window) — the function
does not migrate historical rows when a user changes `profiles.timezone`, it only affects rows
written from that point forward.

## 3b. Curriculum → blocks: the weekly menu (migrations/0012)

`curriculum_items` was written by onboarding from W1 and read by nothing. This is the path from
generated curriculum to a card on the Today board.

**Read this before building against it: curriculum is not scheduled onto calendar dates.** The
obvious bridge — `week_index = floor((today - plan_start) / 7)`, place a block on every date whose
weekday is in `plan_categories.days` — is wrong, and three places already say so: `prompt.ts`
rule 2 ("`curriculum` is a WEEKLY MENU, not a day-by-day schedule … it is not locked to a specific
calendar day"), `src/mtdo/core.py`'s `categories_for_day()`, and `types.ts` on
`GeneratedCurriculumDay`.

**So `plan_categories.days` means two different things and you need the right one.** On the
onboarding *input* it is the weekdays the user said they can study
(`OnboardingAnswers.weeklyDaysAvailable`). For a *curriculum* category, only `days.length`
survives into the model — it is how many day-lists make up one week of content, which is exactly
how `week_index` was assigned at import (§2a). It is **not** a set of weekdays to schedule on.
Reading it as one rebuilds the day-by-day schedule the product deliberately abandoned.

```sql
public.ensure_curriculum_menu()
  returns table (category_id, category_name, category_label, category_sort_order,
                 curriculum_item_id, week_index, item_position, task, meta)

public.pick_curriculum_item(p_item_id uuid) returns blocks
```

Both are `authenticated`-callable; both derive the user from `auth.uid()` and take no user id.

**The model.**

- **Unlocking.** Each category unlocks one more week of curriculum per ISO week, and only when
  `ensure_curriculum_menu()` is actually called — so call it from the board's load path. Weeks
  the user is away cost nothing, because nothing advances while nobody calls it. The first call
  ever unlocks week 0 only.
- **Carry-forward.** The menu is every unlocked item not yet pulled onto a board, not just the
  current week's slice. Unpicked items persist. This is a deliberate divergence from the terminal
  app (which drops them): a generated plan holds exactly **two weeks** of content, so
  use-it-or-lose-it would mean one missed week costs half the plan.
- **"Picked" is derived, never stored** — it means *a block exists with this
  `curriculum_item_id`*. Delete the block and the item returns to the menu. There is no picked
  flag to keep in sync.
- **Nothing is auto-placed.** Picking is an explicit user action. The board does not fill itself.

**Notes for call sites.**

- `ensure_curriculum_menu()` **writes** (it advances the cursor), so it is a `POST`-shaped call
  despite reading like a query. Don't call it from a render path you expect to be idempotent-free;
  it *is* idempotent within an ISO week, but it is not read-only.
- **No active plan returns an empty set, not an error** — that's onboarding-incomplete, a normal
  state. Same for a retired plan.
- **An empty menu is also the normal end state.** Two weeks of content means the menu legitimately
  runs dry after two unlock steps. Design for it: it means "time for a check-in / extend the plan",
  not a failure. There is no auto-regeneration yet.
- `pick_curriculum_item()` is **idempotent per (user, item)** — a double-clicked pick returns the
  block the user already has rather than a `23505` you'd have to decode. It allocates `position`
  server-side under an advisory lock.
- It copies `task` → `blocks.text` and `meta` → `blocks.coaching` (empty `meta` becomes `null`).
  The copy is what lets the block survive the curriculum item being edited or deleted;
  `blocks.curriculum_item_id` is `on delete set null`.
- **Blocks land on today, in the caller's own zone (migrations/0014)** —
  `coalesce(profiles.timezone, 'UTC')`, same fallback pattern as `recompute_daily_rollups()`
  (§3a). There is no target-date parameter; this is what keeps a freshly-picked block's date
  agreeing with what the Today screen is querying for, once Today itself reads a user's real
  zone too (`web/lib/product-data.ts`'s `utcToday(timezone)` — not yet wired to a profile read at
  the call site as of this writing, tracked separately from the backend work).
- The item's `meta` is the Learning Coach payload (`focus_points`, `questions`, `mistakes`,
  `tips`, `mental_models`, …) — read it from the menu row for a preview, or from
  `blocks.coaching` once picked.

**The hand-composer race this section used to flag (mtdo-bugs#96) is closed, not just worked
around.** `today-deck.tsx`'s client-side `select max(position)` then `insert` composer — the
concurrency risk `blocks_slot_key`'s DEFERRABLE constraint couldn't catch at INSERT time — no
longer exists: block creation goes exclusively through `pick_curriculum_item()`, which allocates
`position` under `pg_advisory_xact_lock`. Confirmed by inspection of the current file, not
assumed from the original finding.

## 4. The EmberMorph component contract

`DESIGN.md` §Motion specifies the morph itself (`Graphite home → ember bloom → terminal focus
shell`). The engineering contract on top of that:

- **Ships as a standalone component**, not logic inlined into the session route:
  `<EmberMorph trigger={...} />`, importable and triggerable from outside the session page.
- **Why this matters beyond W1:** the marketing site (`WM`, see the delivery plan) reuses this
  exact component for its web↔terminal showcase, rather than building a second, separately
  maintained transition. WM's showcase section is blocked until this component exists.
- Respects `prefers-reduced-motion` internally — collapses to an instant state change, never a
  blank screen. Callers should not need to handle this themselves.

### 4.1 Trigger prop shape — locked

The hard constraint driving this shape: the marketing showcase must be able to play the exact
same component with **no session, no auth, and no Supabase import inside EmberMorph at all**.
So EmberMorph takes plain values, never a `focus_sessions` row, never a Supabase client, and
never calls `start_session`/`complete_session`/`abandon_session` itself — the caller (Session
screen or marketing page) owns the RPC calls and the client-side elapsed clock, and just feeds
EmberMorph the result each tick.

```ts
type EmberMorphTrigger =
  | { phase: "idle" }
  | {
      phase: "active";
      sessionId: string;                    // opaque; stable across ticks, changes only on a
                                             // genuinely new session (real or demo)
      plannedDurationS: number;             // > 0; mirrors focus_sessions.planned_duration_s
      elapsedS: number;                     // caller ticks this (e.g. setInterval); EmberMorph
                                             // runs no clock of its own and never derives this
                                             // from started_at/now() itself
      originRect: DOMRectReadOnly | null;   // bloom's expand-from point — the rect of the
                                             // "start" control that was clicked; null falls
                                             // back to viewport center
    }
  | {
      // set by the caller when the user ends the session (complete or abandon); EmberMorph
      // plays the faster reverse-bloom and then fires onExitComplete — it does not decide
      // when a session ends
      phase: "exiting";
      sessionId: string;
      plannedDurationS: number;
      elapsedS: number;
    };

interface EmberMorphProps {
  trigger: EmberMorphTrigger;
  /** Rendered inside the settled terminal focus shell: task context, pause/complete/abandon
   *  controls, whatever the caller wants alongside the timer. The real Session screen wires
   *  these to the session RPCs; the marketing showcase wires them to no-ops or fake state.
   *  EmberMorph itself only renders the shell chrome and the timer readout computed from
   *  elapsedS/plannedDurationS — it never reaches into `focus_sessions` or any RPC. */
  children?: React.ReactNode;
  /** Fires once the reverse-bloom finishes settling back on the `idle` visual. This is the
   *  caller's cue to unmount/navigate away — without it there's no way to know the "coming up"
   *  exit animation (DESIGN.md §Motion) has actually finished versus been cut short. */
  onExitComplete?: () => void;
  className?: string;
}
```

- **`sessionId` is a key, not a lookup.** EmberMorph never fetches anything by it. Its only job
  is telling EmberMorph "this is still the same session" across re-renders (so an `elapsedS`
  tick doesn't replay the entrance bloom) versus "a new session started" (so it should). The
  marketing showcase can pass any stable string, e.g. `"demo"`.
- **`elapsedS` is caller-owned and caller-ticked.** Session screen derives it from the real
  session's `started_at` (server-stamped, per §3) on its own interval; the showcase can just
  increment a `useState` counter. EmberMorph only ever reads it to compute the timer readout and
  progress ring — it does not validate it against `plannedDurationS` or treat overrun specially
  beyond display (no session-authority logic belongs in a presentational component).
- **`originRect` is what makes the bloom "expand from the timer's origin point"** (DESIGN.md).
  Callers get it from the triggering control via `element.getBoundingClientRect()` at click time
  and pass a snapshot, not a live ref — EmberMorph must not depend on the trigger element still
  existing after the page it lived on unmounts.
- **Entering vs. exiting is a `phase` transition, not a boolean.** A `boolean isOpen` prop would
  force the caller to also track "is a reverse animation currently playing," which is exactly the
  state `onExitComplete` exists to make unnecessary — the caller sets `phase: "exiting"` once, and
  waits for the callback rather than guessing a duration.
- **No `prefers-reduced-motion` prop.** It's a media query EmberMorph checks internally
  (matches the `.rv`/`prefers-reduced-motion` handling already in `tokens.css`); exposing it as a
  prop would let a caller accidentally override an accessibility requirement.

## 5. Dual vocabulary — presentation layer only

Full table and rules in `DESIGN.md` §Vocabulary. Enforcement note for the API layer:
**schema, route, and component names stay neutral** (`plans`, `focus_sessions`, `rooms`, `notes`)
regardless of what the UI copy calls them (`mission_compiler`, `mesh_signal`, etc.). The mapping
lives in exactly one file, `web/lib/copy.ts` — no marketing term ever appears in a table name,
column name, or route segment.

## 6. What ships to Codex vs. stays with Claude

See the delivery plan (`~/.claude/plans/compressed-humming-sunrise.md`) for the full per-surface
model table. The boundary that matters for API design: **anything in this file or `schema.md` is
Claude-owned.** A Codex brief should never include a request to add a column, change an RLS
policy, or alter the ledger shape — it should cite this file and build against it as fixed.
