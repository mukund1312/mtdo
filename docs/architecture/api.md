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
│   ├── lib/supabase/      # typed client, generated types; service.ts = the service-role
│   │                      # client, Route Handlers ONLY (its own header has the rules)
│   ├── lib/calendar/      # Google Calendar seam (§3e): config/crypto/google/connection.
│   │                      # connection.ts is the only module that touches calendar_connections
│   ├── lib/music/spotify/ # Spotify playback seam (§3i): config/pkce/spotify/connection.
│   │                      # connection.ts is the only module that touches music_connections
│   ├── lib/crypto/        # token-envelope.ts — the ONE AES-256-GCM envelope, shared by
│   │                      # lib/calendar/ and lib/music/spotify/ (decisions.md 2026-09-13)
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

Most tables are read and written directly with the anon-key client under RLS. **Eleven are not**
(`focus_sessions`, `activity_events`, `daily_rollups`, `ai_generations`, `tutor_messages`,
`tutor_memory_summaries`, `calendar_connections`, `calendar_event_links`, `weekly_plans`,
`weekly_plan_changes`, `music_connections`), and this is the part
that is easy to get wrong: they are read-only — or, for `tutor_messages`,
`calendar_connections` and `music_connections`, **no-access** — to clients, and their writes go
through `security definer` RPCs or a service-role backend. (This count said "five" until Phase 6
and was already stale by two: `ai_generations` landed in Phase 2 and `tutor_memory_summaries`
predates both; Phase 7 adds the two weekly-engine tables, and `music_connections` arrived with
Spotify on 2026-09-13. `schema.md` §6's table has always been the authoritative list.) Calling `.insert()` on them does not fail
silently — it returns a `42501` permission error — but the fix is to use the RPC, never to add a
policy or a grant. `schema.md` §6 has the full privilege table.

| Instead of | Call |
|---|---|
| `from('focus_sessions').insert(...)` | `rpc('start_session', { p_planned_duration_s })` — omit `p_block_id` entirely for an unscheduled session; see §3's note below on why passing `null` there won't typecheck |
| `from('focus_sessions').update({ state: 'completed' })` | `rpc('complete_session', { p_id })` — plus `p_block_outcome` to transition the linked block in the same transaction (§3h) |
| `from('focus_sessions').update({ state: 'abandoned' })` | `rpc('abandon_session', { p_id })` |
| pausing/resuming a timer in client state | `rpc('pause_session', { p_id, p_reason })` / `rpc('resume_session', { p_id })` — paused time must not count as focus time, and the client is not the authority on how long it lasted (§3h) |
| `from('focus_sessions').update({ planned_duration_s })` | `rpc('extend_session', { p_id, p_additional_s })` (§3h) |
| `from('blocks').update({ status })` **after a focus session** | `rpc('settle_block_outcome', { p_session_id, p_outcome, p_leftover_note })` — a bare status write is invisible to `weekly_performance()` for any block the ledger has already seen (§3h) |
| `from('activity_events').insert({ kind, occurred_at, payload })` | `rpc('record_event', { p_kind, p_payload })` |
| `from('tutor_messages').select(...)` | `rpc('tutor_context', { p_conversation_id, p_recent_limit })` |
| `from('tutor_messages').insert(...)` | *not available to clients* — the W3b Route Handler (service role) only |
| `from('daily_rollups').insert/update(...)` | *not available* — derived by `recompute_daily_rollups()`, service role only (D13); see §3a |
| `from('blocks').update({ date, position })` (a **cross-date** move) | `rpc('schedule_block', { p_block_id, p_date, p_start_at, p_end_at })` — a client-side cross-date move fails at COMMIT, not at UPDATE, because `blocks_slot_key` is DEFERRABLE; see §3d. A **same-day** reorder stays an ordinary `update`. |
| `from('calendar_connections').select(...)` | *not available to clients at all* — service-role only, the token never reaches a browser (§3e) |
| `from('music_connections').select(...)` | *not available to clients at all* — service-role only. A browser gets a short-lived access token from `GET /api/music/spotify/token` and never the refresh token (§3i) |
| `from('calendar_event_links').insert/update/delete(...)` | `POST /api/calendar/sync` (§3e). Reads are an ordinary RLS-filtered `select`. |
| `from('weekly_plans').insert(...)` | `POST /api/plan/weekly-review` (§3g), which calls `rpc('save_weekly_plan', ...)`. Reads are an ordinary RLS-filtered `select`. |
| `from('weekly_plan_changes').update({ status })` | `rpc('apply_weekly_plan_change', { p_change_id, p_decision, p_new_value })` or `rpc('accept_all_weekly_plan_changes', { p_weekly_plan_id })` (§3g) — a direct update is `42501`, and accepting is what *applies* the change, not just what records it |

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

**The model.** Governed by `plans.planning_mode` (migrations/0017, `dynamic_weekly` default):

- **Unlocking (`dynamic_weekly` only).** Each category unlocks one more week of curriculum per
  ISO week, and only when `ensure_curriculum_menu()` is actually called — so call it from the
  board's load path. Weeks the user is away cost nothing, because nothing advances while nobody
  calls it. The first call ever unlocks week 0 only.
- **`overall` mode**: the menu ignores the unlock cursor entirely and returns every not-yet-picked
  item across every week at once. `menu_unlocked_week_index`/`_iso_week` are **not touched** while
  a plan is in this mode — no free advance happens, so switching back to `dynamic_weekly` later
  resumes from exactly where the cursor was left, not from wherever it would have drifted to had
  it kept advancing unseen. `plans.planning_mode` is an ordinary client-writable column; no RPC
  needed to read or change it.
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
  not a failure. As of Phase 3, this has a real answer — `POST /api/plan/extend` (§3c) generates
  and appends more content once every category's cursor is pinned; `today-deck.tsx` surfaces this
  as a check-in banner rather than requiring the user to notice on their own.
- `pick_curriculum_item()` is **idempotent per (user, item)** — a double-clicked pick returns the
  block the user already has rather than a `23505` you'd have to decode. It allocates `position`
  server-side under an advisory lock.
- It copies `task` → `blocks.text`, `meta` → `blocks.coaching` (empty `meta` becomes `null`), and
  (migrations/0018, Phase 5) `priority`/`estimated_minutes` verbatim. The copy is what lets the
  block survive the curriculum item being edited or deleted; `blocks.curriculum_item_id` is
  `on delete set null`. The idempotent re-pick branch does **not** re-copy — a user's own manual
  re-prioritization of an already-picked block (`blocks.priority` is ordinary client-writable)
  survives a repeat pick of the same item, it isn't silently reset back to the item's value.
- **Blocks land on today by default, in the caller's own zone (migrations/0014)** —
  `coalesce(profiles.timezone, 'UTC')`, same fallback pattern as `recompute_daily_rollups()`
  (§3a). That default is what keeps a freshly-picked block's date agreeing with what the Today
  screen is querying for — Today itself reads a user's real zone too as of Phase 1
  (`today-deck.tsx`'s `fetchProfileTimezone()` call, wired to `utcToday(timezone)`).
- **`p_target_date` (migrations/0019, Phase 6) overrides that default.** Optional, defaults to
  NULL, and NULL means "today in the caller's zone" — so **every pre-0019 one-argument call site
  is unchanged**. Pass it only when the user explicitly chose a day (the Time deck picking
  straight onto a date, rather than picking onto today and then moving it). It is a destination a
  human chose, **never** a date derived from `today - plan_start` and `plan_categories.days` —
  that derivation is still wrong and still forbidden, see the top of this section.
  0019 **drops and recreates** this function rather than overloading it; a defaulted second
  parameter added by `create or replace` would have made every one-argument call ambiguous
  (`42725`, "function is not unique") instead of resolving.
- **A repeat pick does not move an already-picked block**, even with a different `p_target_date`.
  Same rule as the priority copy above: the idempotent branch returns what already exists. Moving
  a block is `schedule_block()`'s job (§3d).
- The item's `meta` is the Learning Coach payload (`focus_points`, `questions`, `mistakes`,
  `tips`, `mental_models`, …) — read it from the menu row for a preview, or from
  `blocks.coaching` once picked.

**The hand-composer race this section used to flag (mtdo-bugs#96) is closed, not just worked
around.** `today-deck.tsx`'s client-side `select max(position)` then `insert` composer — the
concurrency risk `blocks_slot_key`'s DEFERRABLE constraint couldn't catch at INSERT time — no
longer exists: block creation goes exclusively through `pick_curriculum_item()`, which allocates
`position` under `pg_advisory_xact_lock`. Confirmed by inspection of the current file, not
assumed from the original finding.

## 3c. Curriculum check-in and the plan pipeline (Phase 3, operating-engine plan)

**Reverses `decisions.md` 2026-09-07's "re-onboard, not extend in place"** — see the 2026-09-08
entry there for why, and read it before touching `extend_plan()`.

**`POST /api/plan/extend`** — `web/app/api/plan/extend/route.ts`. No request body; eligible
categories (unlock cursor pinned — fully unlocked, nothing left to reveal — and having at least
one generated item) are detected server-side from the caller's own active plan, never trusted
from the client. Builds a prompt per eligible category (`web/lib/plan-generation/
extend-prompt.ts`) carrying a real picked/completed/still-unpicked signal from `blocks`, calls
`aiService.generatePlanExtension()` (non-streaming — this is a background action from an
already-active session, not onboarding's first-run "building your plan…" moment), validates the
response with `parseExtensionResponse()` (a distinct parser from `parseGeneratedPlan` — an
extension has no `app_name`/`days`/`score_weight`, only new items for categories that already
exist), then persists via the `extend_plan()` RPC (migrations/0016):

- `security definer`, `pg_advisory_xact_lock`-serialized under the **same lock key**
  `ensure_curriculum_menu()`/`pick_curriculum_item()` already use (`mtdo.curriculum_menu:<uid>`)
  — all three touch the same (`plan_categories` cursor, `curriculum_items` position) invariant
  pair for one user and must never interleave.
- Computes each category's next `week_index`/`position` from that category's own current max,
  bucketed by `array_length(plan_categories.days, 1)` items per week — never trusts a
  client-supplied value.
- **Advances `menu_unlocked_week_index`/stamps `menu_unlocked_iso_week` in the same transaction**
  as the insert — the exact trap named in the reversal: without this, a user who just asked for
  more work would get nothing until the cursor's ordinary weekly cadence caught up, up to seven
  days later.
- `curriculum_items_category_week_position_key` (0016) backstops the append under concurrency,
  the same role `blocks_curriculum_item_once` plays for picks.

Response: `{ extended: false, reason }` (an honest no-op — no active plan, or nothing is actually
exhausted right now, since the client's own trigger can race a state change) or
`{ extended: true, categories: [{ categoryId, label, addedCount }] }`. `502` if the AI call or its
own retry fail, or the response doesn't parse — **there is no static-fallback equivalent to
onboarding's `buildFallbackPlan()` here**: a generic template doesn't fit an already-personalized
plan's specific categories, so this fails loudly rather than persisting something wrong. This does
not block the core loop — the user's existing board and content are completely unaffected either
way, they just don't get new content added.

**Trigger**: `today-deck.tsx` computes "exhausted" client-side (every category with generated
content has its cursor pinned, and the combined `ensure_curriculum_menu()` result is ≤ 3 items)
and shows a check-in banner; confirming calls the route above and reloads the board.

**The rest of the plan pipeline** (`persistGeneratedPlan()`, `parseGeneratedPlan()`) needed no new
Route Handler — both take an already-constructed `GeneratedPlan`/raw JSON and every write they
perform is an ordinary RLS-scoped client table plus the already-audited `activate_plan()` RPC, so
these run directly from the browser's own authenticated client, the same way `today-deck.tsx`
already writes to `blocks`:

- **Manual Setup** (`web/app/(marketing)/architecture-02/onboarding/manual/page.tsx`) — a
  goal/category/task editor. One task per curriculum day-list slot (`curriculum:
  tasks.map(task => [task])`), so `persistGeneratedPlan()`'s existing `week_index` bucketing
  (`floor(dayListIndex / daysPerWeek)`) assigns weeks correctly without this screen needing to
  think in week/day terms. This is `goal_created`'s first real call site — reserved for exactly
  this since §2's original "not fired alongside `plan_generated`" decision.
- **Import** (`web/app/(marketing)/architecture-02/onboarding/import/page.tsx`) — paste, drag, or
  file-pick a `mtdo.plan.v1` JSON, validated with `parseGeneratedPlan(text, { weekCount: "any" })`
  — import isn't bound to onboarding's fixed-2-weeks AI contract, so this accepts any whole number
  of weeks per category rather than exactly 2 (`ParseGeneratedPlanOptions`, default unchanged for
  every existing caller). Shows a human-readable preview before persisting on confirm.
- **Export**, same page — reads the active plan's categories/`curriculum_items` and reconstructs
  a `mtdo.plan.v1` JSON, one item per day-list slot ordered by `(week_index, position)`. This is
  an honest, not a byte-perfect, reverse: `week_index`/`position` alone don't record which
  original items shared one multi-item day-list entry (only Manual Setup's own one-item-per-slot
  output round-trips byte-for-byte), only the items themselves, correctly ordered and re-bucketed.
- **Setup-method chooser** — a new first step in `web/app/(marketing)/architecture-02/onboarding/
  page.tsx` (`step: "method"`), routing to Guided AI (the existing wizard, unchanged), Manual
  Setup, or Import.
- `PLAN_SCHEMA_VERSION` (`"mtdo.plan.v1"`, `lib/plan-generation/types.ts`) is written by Export and
  validated by `parseGeneratedPlan` on Import — a missing `schema_version` is accepted as this
  version (compatibility with files predating the field, and the terminal app's own `goals.json`,
  which has never carried one); a present-but-different value is rejected outright.

## 3d. Scheduling a block onto a date and time (Phase 6, migrations/0019)

**Narrows `decisions.md` 2026-09-07's "curriculum is never scheduled onto a calendar date"** —
read that entry and the 2026-09-11 one before building against this. The narrowing is one
sentence wide: *curriculum* is still an unlocking, carry-forward menu with no dates in it; a
**block**, which exists only because a human explicitly picked it, may now optionally also carry
a date and time. §3b's mechanism is unchanged.

```sql
public.schedule_block(
  p_block_id uuid,
  p_date     date        default null,
  p_start_at timestamptz default null,
  p_end_at   timestamptz default null
) returns blocks
```

`authenticated`-callable, `security definer`, derives the user from `auth.uid()` and takes no user
id. New columns: `blocks.scheduled_start_at` / `blocks.scheduled_end_at` (both nullable — NULL is
"genuinely unscheduled", the normal case, not midnight).

**It REPLACES a block's schedule. It does not patch it.** This is the part a reader guesses wrong:

| Call | Result |
|---|---|
| `schedule_block(id, '2026-09-14', start, end)` | Moves to that board date **and** sets that window |
| `schedule_block(id, null, start, end)` | Sets the window, keeps the current board date |
| `schedule_block(id, '2026-09-14')` | Moves to that board date, **clears** the window |
| `schedule_block(id)` | **Clears the window**, keeps the board date — this is the un-schedule call |

There is no separate `unschedule_block()`. `p_date` is the one asymmetry: `blocks.date` is
`NOT NULL`, so there is nothing to clear it to, and a NULL `p_date` therefore means "keep it where
it is" rather than "clear it".

⚠️ **The generated-types trap (§3's last two bullets, and it bites here).** All three of
`p_date`/`p_start_at`/`p_end_at` are typed `?:` but **not** unioned with `null`, so
`rpc('schedule_block', { p_block_id, p_start_at: null })` will not typecheck. **Omit the keys
instead** — hitting the SQL `DEFAULT` is runtime-identical to passing `null`. The un-schedule call
is therefore literally `rpc('schedule_block', { p_block_id: id })`.

**Errors.** `22023` for a half-window (one timestamp without the other) or an end at/before the
start — rejected at the argument boundary so the message names the function, rather than falling
through to the `blocks_scheduled_window_paired` / `_ordered` CHECK constraints. `42501` for a
block that isn't yours, deliberately not distinguished from "no such block".

**Why this is an RPC at all**, given `blocks` stays an ordinary client-writable table: the same
reason `pick_curriculum_item()` is one, and it is **not** access control. Moving a block to
another date changes `(user_id, date, category_id, position)` — which is `blocks_slot_key`, and
that constraint is `DEFERRABLE INITIALLY DEFERRED`. A client-side `update blocks set date = ...`
that keeps the old `position` **does not collide at UPDATE time**: it succeeds, the transaction
looks healthy, and it fails at COMMIT with a `23505` nothing in the UI can attribute. The RPC
reallocates `position` server-side under the **same per-user advisory lock**
(`mtdo.curriculum_menu:<uid>`) that `ensure_curriculum_menu()`, `pick_curriculum_item()` and
`extend_plan()` share, so none of the four can interleave for one user.

Allocation rules, exactly:

- **Cross-date move** → `position = max(position) + 1` within `(user_id, target_date, category_id)`,
  or `0` if that lane is empty. `category_id` never changes — a block does not change goal category
  by moving in time. Gaps left behind on the source date are fine; the constraint wants uniqueness,
  not density.
- **Same-date call** → `position` is left exactly as it is. Recomputing would be actively wrong:
  `max()` includes this very row, so every no-op re-schedule would push the block to the end of its
  own lane. **A same-day reorder is still an ordinary client UPDATE of `position`** — the DEFERRABLE
  constraint exists precisely so a two-row swap works inside one transaction. This RPC is for the
  cross-date case a client cannot do safely.

**A block's board date and its calendar window are deliberately not constrained to agree.** A
23:30–00:30 session is legitimate, and rejecting it would be a bug. They are related concepts, not
redundant ones.

## 3e. Google Calendar — one-way sync (Phase 6, migrations/0020)

**Google Calendar is one-way, MTDO → Google, in V1.** Removing a block's schedule removes the
Google event; Google-side edits do **not** flow back, and the next sync of that block overwrites
them. No poll or webhook receiver exists — deferred deliberately, and MTDO stays the source of
truth so a user's task list and their calendar stay separate things. **AI may only ever *suggest*
a slot, never create an event unattended.** No suggestion logic is built yet; every route below is
reached by an explicit user action carrying an explicit block id, which is what keeps that
structural rather than a policy note.

**It is entirely optional, and nothing in the core loop depends on it.** `schedule_block()` (§3d)
works identically whether or not a calendar is connected.

**Tables (`schema.md` has the full shape).**

- `calendar_connections` — **service-role only**: RLS enabled with *no policies* **and** every
  privilege revoked from `anon`/`authenticated`. A browser cannot read it even for its own row.
  `refresh_token_encrypted` is AES-256-GCM ciphertext in a `v1:<iv>:<tag>:<ct>` envelope, encrypted
  **in the Route Handler** (`web/lib/calendar/crypto.ts`, `CALENDAR_TOKEN_ENCRYPTION_KEY`), not by
  the database — see `decisions.md` 2026-09-11 for why not pgcrypto. Access tokens are never
  stored; each sync mints a fresh one from the refresh token.
- `calendar_event_links` — `unique (block_id, provider)`, which is what makes sync idempotent.
  SELECT-own to the client, service-role write. **This table IS the per-block opt-in** — there is
  no `blocks.calendar_sync_enabled` column, the same way "picked" is derived from a block existing
  (§3b).

**Configuration, and what happens without it.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`CALENDAR_TOKEN_ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (optionally
`GOOGLE_OAUTH_REDIRECT_URI`) — all documented in `web/.env.example`. **None of them exist in this
environment**; no Google Cloud project has been created for mtdo yet. That is a supported state,
and it is the state every route below was actually exercised in. `resolveCalendarConfig()`
(`web/lib/calendar/config.ts`) is the single check, modelled directly on `resolveProvider()`
(§2f): a present-but-wrong-length encryption key counts as *not configured*, because the
alternative is discovering it at the moment a real user finishes Google's consent screen.

| Route | Contract |
|---|---|
| `GET /api/calendar/status` | Auth-gated, `no-store`. `{ configured, connected, connection, missing[], provider }`. Unconfigured is a **200** naming the absent variables, never an error. Backs Settings → Calendar. |
| `GET /api/calendar/connect` | Auth-gated. Redirects (307) to Google's consent screen and sets an httpOnly `SameSite=Lax` state cookie. **503 `{ configured: false, missing }`** when unconfigured — never a redirect to a half-built URL. Optional `?next=<path>`, validated same-origin (`lib/safe-redirect.ts`), stored in a second httpOnly cookie (`mtdo-calendar-oauth-next`) the callback below reads. Absent for a plain Settings "Connect" click — only `app/auth/callback/route.ts`'s signup-time prompt sends it (decisions.md, 2026-09-13). |
| `GET /api/calendar/callback` | Verifies the state cookie (CSRF — without it an attacker binds *their* calendar to the victim's account), exchanges the code, stores the encrypted connection. Redirects to the `next`-cookie destination if one was set by `/api/calendar/connect` above, else the default `/architecture-02/settings?calendar=<outcome>`; either way the redirect target is built from this app's own origin and a validated/constant path, never from anything Google round-tripped back (see `app/auth/callback/route.ts` for the open-redirect write-up). Deletes both OAuth cookies on every outcome. Outcomes: `connected`, `declined`, `state-mismatch`, `no-code`, `no-refresh-token`, `exchange-failed`, `not-configured`, `no-session`, `google-error`. |
| `POST /api/calendar/sync` | `{ blockId, enabled }`. `200 { synced: true, eventId, calendarId }` (created or updated) / `200 { synced: false }` (removed, or already absent). `400` malformed body **or** `enabled: true` for a block with no schedule. `401` no session. `404` not your block. `409 { connected: false }`. `502` Google rejected it. `503 { configured: false, missing }`. |
| `POST /api/calendar/disconnect` | Deletes the events mtdo created **before** deleting the connection (the reverse order destroys the only token that could have removed them), then clears the links. `{ disconnected: true, orphanedEvents }` — event deletion is best-effort and non-fatal; a user disconnecting gets disconnected. |

**Call-site contract — read these three, they are where this goes wrong.**

1. **Block ownership is proved with the user's own anon client, never the service client.** The
   routes read `blocks` through the RLS-scoped client to establish ownership, then use the service
   client only for `calendar_*`. A `user_id` from a request body is never trusted.
2. **Un-scheduling a block does not remove its Google event by itself.** Call
   `POST /api/calendar/sync { blockId, enabled: false }` alongside the `schedule_block()` call that
   clears the window. **It is safe to call unconditionally**, and that is a deliberate property of
   the route rather than a happy accident: an already-unsynced block, *and* a user who has no
   calendar connected at all (including one who just disconnected, which already deleted their
   links), both return a plain `{ synced: false }`. No 404, and no 409 telling someone to connect a
   calendar they don't want. `409` is reserved for `enabled: true`, where a connection is genuinely
   required. Neither no-op spends a Google token round trip.
3. **Unsync before deleting a block.** `calendar_event_links` cascades on block delete, so deleting
   a synced block drops the link row and **orphans the Google event** — Postgres cannot make an
   HTTP call from a cascade. There is no reaper for events orphaned by a client that skipped this;
   it is recorded as debt in `decisions.md` 2026-09-11, not a surprise to discover later.

**Scopes.** `https://www.googleapis.com/auth/calendar.events` only — least privilege, and notably
no read scope, because one-way sync never needs to read the user's calendar. The scopes Google
actually *granted* are stored on the connection row (not the ones requested), so a later scope
addition is detectable as missing consent rather than a 403 at event-creation time.

## 3f. `weekly_performance()` — the deterministic weekly metrics (Phase 7, migrations/0021)

**Read `decisions.md` 2026-09-11 "The weekly engine is deterministic by design" first.** Nothing
in this section or §3g calls a model. That is a product decision, not a sequencing accident.

```sql
public.iso_week_start(p_iso_week text) returns date          -- Monday of an ISO week
public.weekly_performance(p_plan_id uuid, p_iso_week text) returns jsonb
```

`authenticated`-callable, `security definer`, `stable`, derives the user from `auth.uid()` and
takes no user id. **Call it with the user's own anon client, never the service client** — a
service-role caller has a null `auth.uid()` and is rejected with `42501`, which is intentional
(same call-site rule as §3e). Writes nothing. Reviewing a **retired** plan is allowed; nothing
here touches the board.

**Errors.** `42501` for a plan that isn't yours (deliberately not distinguished from "no such
plan"). `22023` for a malformed `p_iso_week` — the format is exactly `YYYY-Www`
(`'IYYY-"W"IW'`), the same vocabulary `plan_categories.menu_unlocked_iso_week` already uses.

**It is read-computed, not materialized**, matching `daily_rollups`' precedent (`decisions.md`
2026-09-06) — and it deliberately does **not** read `daily_rollups`, because that table is a
pg_cron job's output and a review generated inside the ten-minute gap would under-report the work
someone just did. It reads the same two source tables (`activity_events`, `focus_sessions`) under
the same day-attribution rules as §3a, so the two agree by construction and this one is never
stale.

**Return shape** (`mtdo.weekly_performance.v1`). TypeScript mirrors of every field, plus a
`asWeeklyPerformance()` narrowing helper, are exported from `web/lib/planning/types.ts` — import
those rather than casting the RPC's generated `Json`.

```jsonc
{
  "schema_version": "mtdo.weekly_performance.v1",
  "plan_id": "…", "iso_week": "2026-W36",
  "week_start": "2026-08-31", "week_end": "2026-09-06",
  "timezone": "UTC", "planning_mode": "dynamic_weekly", "computed_at": "…",
  "plan": {
    "picked_count", "done_count", "completion_rate",
    "estimated_minutes", "actual_minutes", "paced_actual_minutes",
    "paced_task_count", "pace_ratio",
    "menu_offered_count", "menu_picked_count", "pick_rate",
    "regressed_count", "stale_open_count", "postponement_count",
    "backlog_count", "sessions_completed", "study_days",
    "score", "score_max"
  },
  "categories": [{
    "category_id", "name", "label", "sort_order", "min_blocks", "score_weight",
    "days_per_week", "weekly_target_blocks", "current_target",
    "category_created_at", "existed_before_week",
    "picked_count", "done_count", "completion_rate",
    "estimated_minutes", "actual_minutes", "paced_actual_minutes",
    "paced_task_count", "pace_ratio", "pace_ratio_mean",
    "menu_offered_count", "menu_picked_count", "skipped_count", "pick_rate",
    "regressed_count", "stale_open_count", "postponement_count",
    "backlog_count", "sessions_completed", "study_days"
  }]  // one row per category of the plan, INCLUDING ones with no activity,
      // ordered by (sort_order, label)
}
```

⚠️ **EVERY RATE IS `null` WHEN ITS DENOMINATOR IS ZERO, NEVER `0.0`.** This is the single most
important property of the whole subsystem, and a `?? 0` anywhere downstream breaks it:

| field | `null` means |
|---|---|
| `completion_rate` | nothing was picked in this category that week |
| `pace_ratio` / `pace_ratio_mean` | no completed task had **both** an estimate and a real focus session |
| `pick_rate` | the menu offered nothing |

"Picked nothing" and "picked everything and finished none of it" are different facts about a
person. Collapsing both to 0% makes the engine propose cutting the load of a category the user
simply never opened. Counts (`picked_count`, `done_count`, …) are genuinely `0` and are safe to
read as numbers.

**What each number actually means, where it is non-obvious:**

- **"Picked that week" = a block whose board `date` falls in that ISO week.** `blocks` has no
  `created_at`, and this is also the faithful port: `core.py`'s `compute_week_progress()` iterates
  the week's *date keys*. A block moved to another week moves its attribution with it, which is
  the right frame for "what was on my board that week".
- **"Done" is the ledger's verdict, not `blocks.status`.** A block's **last**
  `task_completed`/`task_regressed` event wins (the same last-event-wins rule §3a uses per day,
  applied across the block's whole history — `compute_week_progress()` reads *current* done-ness,
  so a block dated Sunday and finished Monday is genuinely done work for that week). **A block the
  ledger has never seen falls back to `blocks.status`** — a narrow, deliberate fallback, because
  `task_completed` only gained a call site in Phase 1 (§2c/§2d) and every block completed before
  that would otherwise read as permanently unfinished.
- **`pace_ratio` is a ratio of sums** (`paced_actual_minutes / estimated_minutes`), not a mean of
  per-task ratios. `pace_ratio_mean` is the mean, reported for display only. The classifier reads
  the ratio of sums because a mean lets one five-minute task swing a whole week's classification.
- **A task counts toward pace only if it is done, has a non-null `estimated_minutes`, AND has at
  least one settled focus session.** The session requirement is not incidental: without it,
  someone who finishes their work without ever starting a timer computes as ~0 minutes against a
  real estimate, reads as "coasting", and gets handed 25% *more* work for not using a Pomodoro.
  That is the most damaging false positive this engine can produce, and it is closed in the metric.
- **`postponement_count` = `regressed_count` + `stale_open_count`**, the two shapes of
  "postponed" the data can actually express: a `task_regressed` event inside the week, and an open
  block dated *before* the week that is still unfinished. **Known gap, named rather than
  discovered later:** a block silently moved forward by a cross-date `schedule_block()` leaves no
  trace at all, so that third shape is not counted.
- **`menu_offered_count` is the one estimate rather than a measurement.** Nothing records the
  unlock cursor's *historical* position — `plan_categories` holds only where it is now and when it
  last moved. The cursor advances at most once per ISO week (§3b), so walking it back one per
  elapsed week gives a **lower bound** on what was unlocked then. The direction of that error is
  chosen: under-counting what was offered *inflates* `pick_rate`, which makes the "avoided" signal
  harder to trigger — and since that signal interrupts the user with a question, biasing against a
  false accusation is the right way to be wrong. In `overall` planning mode there is no cursor and
  nothing to reconstruct.
- **`score` / `score_max`** port `core.py`'s `compute_daily_score()` to week granularity:
  `sum(round(score_weight × completion_rate))` over categories that were actually picked from.
  Categories nobody touched are skipped entirely (`if not blocks: continue`), so a user is never
  scored against a category that was not on their board.
- **`study_days`** is distinct days with a real completion event or a settled session, scoped to
  this plan. A day on which the user only opened the app is not a study day. A session with a null
  `block_id` is attributable to no plan and counts toward none.
- **`existed_before_week`** is `category_created_at < week_start`, strictly. A category created on
  the Wednesday of the week under review has three days of data, and three days of quiet is not
  evidence — the rules engine excludes it rather than calling it "on track".

## 3g. The weekly engine — proposals and the change-review contract (Phase 7, migrations/0022)

**The rule engine is 100% deterministic. There is no AI anywhere in this path**, and
`weekly_plans.generated_by` is `'rules_v1'` — versioned, true, and leaving room for a real
`'ai_v1'` generator later with no schema change. `aiService.reviewWeek()` is **not built** and is
explicitly out of scope; see `decisions.md` 2026-09-11.

**Where the logic lives**, and the split is deliberate (documented in `decisions.md`):

| layer | file | why there |
|---|---|---|
| raw metrics | `weekly_performance()`, migrations/0021 | derived data is computed in Postgres, matching `daily_rollups`' precedent — not re-derived ad hoc in app code |
| thresholds | `web/lib/planning/thresholds.ts` | every constant in one file with its reasoning attached; a rules engine whose constants are scattered through its branches cannot be argued with or tuned |
| classification | `web/lib/planning/classify.ts` | pure functions, unit-testable at exact boundary values |
| proposal building | `web/lib/planning/propose.ts` | business-rule evaluation in TS, matching `plan-generation/parse.ts`'s precedent |
| ISO-week arithmetic | `web/lib/planning/iso-week.ts` | must agree with `iso_week_start()` exactly; pinned by tests on both sides |
| storage + rails | `save_weekly_plan()` / `apply_weekly_plan_change()`, migrations/0022 | the constraints must hold against a caller that is *not* the engine |

### Classification — trailing **two** weeks, never one

A person has a bad week for reasons that have nothing to do with their study plan. An engine that
rewrites the plan every time they do is worse than no engine.

| signal | fires when, in **both** trailing weeks |
|---|---|
| `avoided` | `pick_rate < 0.3` |
| `struggling` | `completion_rate < 0.5`, **or** `pace_ratio > 1.3` (the same arm must fire in both weeks) |
| `coasting` | `completion_rate >= 0.9` **and** `pace_ratio < 0.7` |
| `on_track` | none of the above |
| `insufficient_data` | either week is unobservable — see below |

**Precedence is `avoided` → `struggling` → `coasting`, and that order is a real decision.**
Engagement is upstream of everything else: a category someone picks 2 of 10 offered tasks from and
then fails one of, satisfies both `avoided` and `struggling` — but "we've eased your weekly target
from 4 to 3" answers a question they never asked. Their target was never the obstacle. Adjusting a
number would also *look* like the engine had handled it, which is worse than doing nothing.

Boundaries are exact and tested at the value and one step either side: `< 0.5`, `> 1.3`, `>= 0.9`,
`< 0.7`, `< 0.3`. So completion of exactly 0.5 is **not** struggling, pace of exactly 0.7 is
**not** coasting, and `pick_rate` of exactly 0.3 is **not** avoided.

**`insufficient_data` — the two gaps that must not read as health.** A week is unobservable for a
category when `existed_before_week` is false, **or** when nothing was offered *and* nothing was
picked. Note the second is not "offered things and picked none" — that **is** behaviour, and is
exactly what `avoided` catches. A plan's first-ever review has no prior week at all, so every
category is `insufficient_data` and **zero changes are proposed — a normal result, not an error**.

### Adjustments

The lever is **`plan_categories.weekly_target_blocks`** and nothing else. It resolves as
`coalesce(weekly_target_blocks, array_length(days,1))`, floored at 1 — that resolved value is
`current_target`, and it is what ±25% is taken of. `struggling` proposes a decrease, `coasting` an
increase, `avoided` a `flag_question` carrying no numbers at all.

**The cap is ±30% of the current target, OR one whole block, whichever is larger.** The
"or one whole block" half is not a loophole — it is what makes the rail implementable against
integers. Real targets are small: at a target of 3, one extra block is a 33% move, so a flat 30%
rail would round every proposal back to 3 and the engine would silently never adjust a 3-block
category in either direction. One block is the smallest expressible change; the proportional rail
binds once targets are large enough to mean something (at 10 it allows 7..13, not 9..11).
**`proposeTarget()` and `apply_weekly_plan_change()` implement this same rule independently and
must agree** — if the generator could propose a value the RPC rejects, every such proposal would
fail the instant a user clicked accept.

If the capped, rounded result equals the current target there is **no change to propose** — the
category still gets an `outcome` (with `suppressed: "capped_to_no_change"`) so the Review deck can
say "we noticed, there is nothing to adjust", but no row is written. A change set full of 4 → 4
rows is noise the user has to read and dismiss.

### The hard constraints, and where each one actually lives

| constraint | enforced |
|---|---|
| never modifies `plans.goal_line` | **structural** — no code path in any of these functions writes it. Pinned by test. |
| never increases `plan_categories.days` | **structural**, same way. `days` is what the user told us about their availability; inventing more of it would be fabricating hours in someone's week. |
| never stacks load after a bad week | `propose.ts` — if the plan's overall `completion_rate` for the reviewed week is `< 0.40` (or `null`, meaning nothing was picked at all), **every increase is withheld, in every category**. Decreases are unaffected: easing off after a bad week is always allowed. Deliberately **not** re-checked at apply time — re-deriving it on every click could flip a proposal while the user is looking at it. |
| ±30%-or-one-block cap | `thresholds.ts` **and independently** `save_weekly_plan()` (so an out-of-rail proposal cannot even be *stored*) **and** `apply_weekly_plan_change()` (so a value the user hand-edits is bounded by the same rail — otherwise every rail would be bypassable by clicking "edit" before "accept"). |
| a weekly target is never below 1 | both RPCs. A target of 0 means "stop doing this category", which is a choice a user makes by answering a flagged question, never something a pace nudge arrives at by arithmetic. |

The suppression of an increase in an **unrelated** category is intentional, not collateral: the
category that looks like it has spare capacity is very often the one the user retreated into while
avoiding the hard one.

### `POST /api/plan/weekly-review` — generate a proposal

`web/app/api/plan/weekly-review/route.ts`. Auth-gated (401 without a session).

**Request:** body optional. `{ "isoWeek": "2026-W36" }` reviews a specific week; omitted, it
defaults to the **most recently completed** week in the caller's own timezone
(`coalesce(profiles.timezone, 'UTC')`). Reviewing a week still in progress would classify on
partial data and call every category struggling by Tuesday. A malformed `isoWeek` is a `400`.

**Response 200** — `{ generated: true, weeklyPlanId, isoWeek, effectiveIsoWeek, changeCount,
changes[], outcomes[], increasesSuppressed, metrics }`.

- `changes[]` — exactly the rows written to `weekly_plan_changes`:
  `{ change_type: "weekly_target_blocks" | "flag_question", target_category_id, old_value,
  new_value, reason, signal }`. `old_value`/`new_value` are `null` for a `flag_question`.
- `outcomes[]` — **one entry per category, whether or not it produced a change**:
  `{ category_id, label, classification, suppressed? }` where `classification` is one of
  `struggling` / `coasting` / `avoided` / `on_track` / `insufficient_data`, and `suppressed` is
  `"low_completion_week"` or `"capped_to_no_change"` when a signal fired but no change was
  proposed. **Render these** — a category the engine looked at and deliberately left alone is
  information, and a Review deck that shows only `changes[]` silently drops it.
- `metrics` — `{ schema_version: "mtdo.weekly_review.v1", current, previous }`, both full
  `weekly_performance()` bodies. `previous` is the prior week, so the deck can show a
  this-week-vs-last-week comparison without a second round trip.

**Response 200, `{ generated: false, reason, weeklyPlanId? }`** — an honest no-op: no active plan,
or this week's review already has decisions recorded against it. Regenerating over a decided
review would destroy the user's decisions *and* re-propose relative to a target they just
accepted, so it is refused in the route and again in `save_weekly_plan()` (`22023`) as a backstop.
A review whose changes are all still `pending` **is** regenerated, replacing them.

**A review that proposes nothing is stored anyway**, with status `accepted` — there is nothing
outstanding, and leaving it `proposed` would make it look like it is waiting on the user.

### Accepting, rejecting, editing — direct RPCs, no Route Handler

These hold no secret and need no server-side logic, so they are called straight from the client
with the anon key, the same way the Time deck calls `schedule_block()` (§3d).

```ts
// one change
rpc('apply_weekly_plan_change', { p_change_id, p_decision: 'accepted' | 'rejected' })
rpc('apply_weekly_plan_change', { p_change_id, p_decision: 'accepted', p_new_value: 5 })  // edit
// the "Accept all" button, one round trip
rpc('accept_all_weekly_plan_changes', { p_weekly_plan_id })  // → { applied, skipped_questions }
```

- **Accepting is what *applies* the change**, not just what records it: it writes
  `plan_categories.weekly_target_blocks` in the same transaction, under the
  `mtdo.curriculum_menu:<uid>` advisory lock the other four board/curriculum writers share.
  Rejecting writes nothing.
- **Passing `p_new_value` makes the status `edited`, not `accepted`**, and `new_value` is rewritten
  to what was actually applied — history must say what happened, not what was suggested.
- **A decision is final.** Re-deciding raises `22023`: accept the same +25% twice and the category
  has quietly gained 56%.
- ⚠️ **`accept_all_weekly_plan_changes()` deliberately SKIPS `flag_question` rows** and returns
  them in `skipped_questions`. "Accept all" means "yes to everything you suggested"; a question's
  honest answer might be no. Those rows stay `pending`, which also keeps the parent review
  `proposed` until they are answered individually. **The UI must surface them** — otherwise a user
  clicks Accept All, sees nothing happen to that category, and has no idea a question is waiting.
- `weekly_plans.status` is **recomputed** from its children after every decision (`proposed` while
  anything is pending → `accepted` / `rejected` / `partial`), so it cannot drift.

**Errors.** `42501` — not yours, or no session (never distinguished from "no such row").
`22023` — an invalid decision word, a re-decision, a value outside the cap or below 1, a
`flag_question` given a value, or a regeneration over a decided review.

## 3h. Focus Mode: pause, breaks, extension, and the block outcome (migrations/0023)

Everything the Session screen needs beyond start/complete/abandon. **This section is the locked
contract** — the Session UI is built against it, not against the migration.

### What was already there

**Editable duration needed no backend work.** `start_session`'s `p_planned_duration_s` has always
taken any value from 1 to 86400; the Session screen simply hardcodes `DEFAULT_DURATION_S = 50*60`
and ships no time picker. Adding one is a pure frontend change against the existing parameter.

### The new columns on `focus_sessions`

All four are SELECT-able by the owner and writable only through the RPCs below.

| Column | Meaning |
|---|---|
| `paused_at timestamptz` | Non-null = the clock is stopped, and *when* it stopped. **A paused session is still `state = 'running'`** (schema.md §5) — do not look for a `'paused'` state, there isn't one. |
| `total_paused_s integer` | Accumulated closed paused intervals. Always 0 on a pre-0023 row, so historical numbers are unchanged. |
| `extended_s integer` | How much of `planned_duration_s` arrived via `extend_session()` rather than being committed to up front. |
| `break_plan jsonb` | The frozen-at-start break schedule, or null. |

**The client's stale-session recovery query must select the new columns.** `session/page.tsx`
currently reads `id, started_at, planned_duration_s`; a session restored after a tab close now also
needs `paused_at, total_paused_s, break_plan` or the restored timer will over-count every pause the
user took before the reload. The `.eq('state','running')` filter itself is still correct and still
finds a paused session — that is exactly why pause is a sub-state.

**Computing the display clock.** The server owns time; the client renders it:

```ts
const focusElapsedS =
  (Date.now() - Date.parse(started_at)) / 1000
  - total_paused_s
  - (paused_at ? (Date.now() - Date.parse(paused_at)) / 1000 : 0);
```

While paused, stop ticking — `focusElapsedS` is already frozen by construction, so EmberMorph's
`elapsedS` simply stops advancing. **EmberMorph needs no change**: its contract (§4.1) is plain
caller-ticked numbers, and a paused session is a caller that stops ticking.

### `pause_session(p_id uuid, p_reason text default 'manual') → focus_sessions`

Stops the clock. `p_reason` is `'manual'` or `'break'`; anything else is `22023`. Refuses with
`42501` if the session is not the caller's, not running, **or already paused** — a double-pause is
an error rather than a silent restamp, because restamping would erase however long the user had
already been away and hand back focus time they didn't earn. Mints `session_paused`.

### `resume_session(p_id uuid) → focus_sessions`

Banks `now() - paused_at` into `total_paused_s` and clears `paused_at`. `42501` if not the
caller's, not running, or not currently paused. Mints `session_resumed`.

### Breaks are scheduled pauses — one mechanic, not two

A break and a pause do the same thing to the only thing the server owns: they stop the clock. The
difference is *who decided when*, which is a property of the reason, not the mechanism. So there is
no `start_break`/`end_break` pair — a scheduled break is `pause_session(id, 'break')` fired by the
client when the plan says one is due, and `resume_session(id)` when it ends.

The **schedule** is persisted on the session, because a session's break points are as much "what
this session is" as `planned_duration_s` is, and the client is not trusted to remember either
across a reload (D12):

```jsonc
// p_break_plan, frozen at start_session() and never mutable afterwards
{ "breaks": [ { "at_s": 900, "duration_s": 300 },
              { "at_s": 1800, "duration_s": 300 } ] }   // 45min work + 2x5min
```

**`at_s` is FOCUS seconds elapsed, not wall clock** — so a manual pause slides the remaining breaks
along with the user instead of consuming one. A break is due when `focusElapsedS >= at_s` for the
first entry not yet taken. The client tracks which breaks it has already fired; the server does not
(it has no opinion about the schedule beyond storing it, and a re-fired break is just a second
pause, which is harmless).

`start_session` validates the plan and rejects with `22023`: a non-object or a missing `breaks`
array, more than 24 breaks, a break missing numeric `at_s`/`duration_s`, an `at_s` outside
`1..planned_duration_s - 1` (which would never fire — almost always a minutes/seconds mix-up),
non-increasing `at_s` values, a non-positive `duration_s`, or work-plus-breaks exceeding 86400.

### `extend_session(p_id uuid, p_additional_s int) → focus_sessions`

Applying an accepted "do you need more time?" answer. **The prompt's timing is entirely a frontend
concern** — the client watches remaining time and decides when to ask; this RPC is only what
"yes, add 10 minutes" calls.

Adds to `planned_duration_s` (the cap every consumer already reads — an accepted extension is real
time the user really committed to) **and** accumulates `extended_s`, so reporting can still tell
"planned 25, then asked for 10 more" from "planned 35". Allowed while paused, deliberately.
`22023` for a non-positive `p_additional_s` or one that would push `planned_duration_s` past 86400
(a readable error rather than the table CHECK surfacing as an opaque `23514`); `42501` if not the
caller's or not running. Mints `session_extended`.

### `settle_block_outcome(p_session_id uuid, p_outcome text, p_leftover_note text default null) → blocks`

The linked block's fate after a session. `p_outcome` is `'done'` or `'in_progress'`.

**Why this is an RPC even though `blocks` is client-writable.** Checked, not assumed:
`blocks_owner_all` is a `for all` policy and `blocks` keeps full CRUD grants — `session/page.tsx`
already does a direct `.update({ claimed, status })` at session start. So this is not an RLS
workaround. It exists because **`blocks.status` is not what decides whether a task counts as done**:
`weekly_performance()` (§3f) reads the *ledger's* last `task_completed`/`task_regressed` verdict and
only falls back to `blocks.status` for a block the ledger has never seen. A client that set
`status = 'done'` without minting `task_completed` would be visible on the Kanban board and
invisible to the weekly engine. The status write and the ledger event are one fact and belong in one
transaction.

**`task_regressed` is minted only on a genuine walk-back.** `weekly_performance()` computes
`postponement_count` as `regressed_count + stale_open_count`. Minting a regression on every
"something's left" answer would permanently inflate that signal for anyone who works steadily on
hard tasks — the engine would read them as a chronic postponer and act on it. So the event fires
only when the block was actually done before (ledger first, `blocks.status` as fallback — 0021's
exact rule) and is now being walked back.

**The leftover note is appended to `blocks.notes`, never overwritten.** `blocks.notes` is an
ordinary user-editable column that the Session screen already renders as the task's description;
clobbering it would destroy text written elsewhere with no undo. Appends are separated by a blank
line and prefixed with the date in the user's own `profiles.timezone`. A note on the `'done'` path
is rejected with `22023` rather than silently dropped (a note saying what's left only makes sense
where something is left); over 2000 characters is also `22023`.

**One consequence for the Session screen.** `session/page.tsx` currently renders the whole of
`blocks.notes` as the task's one-line `detail`. After a few sessions on the same task that field
holds several dated paragraphs, which will read badly in a one-liner. Rendering only the **last**
paragraph (split on the blank line) is the intended shape — the earlier ones are history, available
if the UI wants to show them. Nothing in the RPC assumes either choice.

Returns **NULL for an unlinked session** (Home's generic "Start focus") rather than raising, so the
client can run the same outcome flow for every session without branching first. `42501` if the
session is not the caller's or **is still running** — "what happened to the task" is not a question
about a live session.

**No advisory lock, deliberately.** The per-user lock (`activate_plan`, 0005) exists where one
statement must be consistent against a *set* of a user's rows. This writes one block row and appends
one event; Postgres' own row lock already serializes concurrent calls, and both orderings end with a
status and a last-ledger-verdict that agree — the only property any reader depends on. Taking
`hashtext(uid)` would queue a one-row status update behind plan activation and curriculum picks for
no correctness gain.

### The decision table — what the Session UI calls for each of the three outcomes

| User action | Call | Block ends up | Note |
|---|---|---|---|
| **"End session"** (explicit, mid-session or otherwise) | `rpc('complete_session', { p_id, p_block_outcome: 'done' })` | `'done'` | No further prompt. One atomic call. |
| **"Leave early"** | `rpc('abandon_session', { p_id, p_block_outcome: 'in_progress' })` | `'in_progress'` | No note. Reuses `abandon_session` — "left early" is exactly what abandoning already means, and the ledger event is already `session_abandoned`. |
| **Timer expires** → then "I finished" | `rpc('complete_session', { p_id })`, then `rpc('settle_block_outcome', { p_session_id: p_id, p_outcome: 'done' })` | `'done'` | Two calls **on purpose**: the session closes when time runs out, and the question is asked afterwards. |
| **Timer expires** → then "something's left" | `rpc('complete_session', { p_id })`, then `rpc('settle_block_outcome', { p_session_id: p_id, p_outcome: 'in_progress', p_leftover_note: '…' })` | `'in_progress'` | The note is required by the product flow, optional to the RPC. |

Natural expiry is a **`complete_session`, never an `abandon_session`** — the time was legitimately
spent, and the block's fate is a separate question from the session's.

The two immediate paths fold the block transition into the settle call so there is no window where
the session is over and the board still says in-progress. The expiry paths cannot: the answer does
not exist yet when the session closes. Both routes run the identical function body — the
`p_block_outcome` parameter is a passthrough to `settle_block_outcome()`, not a second
implementation.

### Ledger additions

`session_paused`, `session_resumed`, `session_extended` join the `session_*` family: **server-minted
only**, and deliberately *not* added to `record_event()`'s client-appendable whitelist. Pause is what
makes focus time honest, so a client that could self-report "I resumed" could farm it.

`session_completed`/`session_abandoned` payloads gain three fields. `elapsed_s` keeps its original
wall-clock meaning so a reader is never silently comparing two different quantities under one name;
**`focus_s` is the new pause-aware number and is the one to use.**

```jsonc
{ "block_id": "…", "planned_duration_s": 2100,
  "elapsed_s": 1800,        // wall clock, unchanged meaning
  "focus_s": 1200,          // pause-aware, capped at planned — USE THIS
  "total_paused_s": 600, "extended_s": 600 }
```

## 3i. Spotify playback — the Listen deck's real backend (migrations/0024)

**This section is the locked contract.** The Listen deck's `Spotify.Player` wiring is built
against it, not against the route files. Every shape below is exact.

**It is entirely optional, and nothing in the core loop depends on it.** A user who never
connects Spotify has a fully working board, focus timer, scheduler and calendar. The Listen
deck's other two providers (`apple`, `local` in `listen-data.ts`) are untouched by any of this —
only `spotify` is real.

**THE PREMIUM CONSTRAINT IS PERMANENT, NOT A BUG.** The Spotify Web Playback SDK requires a
Spotify **Premium** account (mobile-only Premium tiers excluded). A free-tier listener cannot get
in-browser playback through this integration, and there is no app-side workaround — it is a
Spotify platform restriction. The backend's job is to report the real signal; `status`'s
`connection.premium` carries it (`true` / `false` / `null` for "tier unknown"), and the deck must
render that as a first-class, honest state rather than a player that silently never plays.
`product` is a **connect-time snapshot** — a user who upgrades later reads stale until they
reconnect (decisions.md 2026-09-13).

**Table (`schema.md` has the full shape).** `music_connections` — **service-role only**: RLS
enabled with *no policies* **and** every privilege revoked from `anon`/`authenticated`. Both
`refresh_token_encrypted` and `access_token_encrypted` are AES-256-GCM ciphertext in a
`v1:<iv>:<tag>:<ct>` envelope, encrypted **in the Route Handler**
(`web/lib/crypto/token-envelope.ts`, `SPOTIFY_TOKEN_ENCRYPTION_KEY`), not by the database.

**Configuration, and what happens without it.** `SPOTIFY_CLIENT_ID`,
`SPOTIFY_TOKEN_ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (optionally
`SPOTIFY_OAUTH_REDIRECT_URI`) — all documented in `web/.env.example`. **There is deliberately no
`SPOTIFY_CLIENT_SECRET`**: this is Authorization Code with **PKCE**, which does not use one, and
requiring it would leave a correctly-configured deployment permanently reporting "unconfigured".
**None of these exist in this environment**; no Spotify developer app has been created for mtdo
yet. That is a supported state, and it is the state every route below was actually exercised in.
`resolveSpotifyConfig()` (`web/lib/music/spotify/config.ts`) is the single check, modelled on
`resolveCalendarConfig()` (§3e): a present-but-wrong-length encryption key counts as *not
configured*.

| Route | Contract |
|---|---|
| `GET /api/music/spotify/status` | Auth-gated, `no-store`. `200 { configured, connected, connection, missing[], provider: "spotify" }`. `connection` is `null` or `{ connectedAt, displayName, expired, premium, product, refreshTokenExpiresAt, scopes[] }` — **no token field of any kind**. Unconfigured is a **200** naming the absent variables, never an error. `401` no session. `500` only if the connection read itself fails. |
| `GET /api/music/spotify/connect` | Auth-gated. Redirects (307) to `accounts.spotify.com/authorize` with `code_challenge_method=S256`, and sets **three** httpOnly `SameSite=Lax` cookies scoped to `/api/music/spotify`: `mtdo-spotify-oauth-state` (CSRF), `mtdo-spotify-oauth-verifier` (the PKCE verifier — no calendar equivalent), and, only when `?next=<path>` is given, `mtdo-spotify-oauth-next` (validated same-origin via `lib/safe-redirect.ts`). **503 `{ configured: false, missing }`** when unconfigured. |
| `GET /api/music/spotify/callback` | Verifies the state cookie (CSRF), reads and shape-validates the PKCE verifier, exchanges the code, stores the encrypted connection. Redirects to the `next`-cookie destination if set, else `/architecture-02/settings`, always with `?spotify=<outcome>`; the target is built from this app's own origin and a validated/constant path, never from anything Spotify round-tripped back. Deletes all three OAuth cookies on **every** outcome. Outcomes: `connected`, `declined`, `state-mismatch`, `missing-verifier`, `no-code`, `no-refresh-token`, `exchange-failed`, `not-configured`, `no-session`, `spotify-error`. |
| `GET /api/music/spotify/token` | **The one the SDK's `getOAuthToken` callback fetches.** Auth-gated, `no-store` on every path. `200 { access_token, expires_in }` (seconds) — serves the cached token, or transparently refreshes server-side first. `401` no session. `409 { connected: false, error }` never connected → offer **Connect**. `409 { connected: true, error, reconnectRequired: true }` the authorization died → offer **Reconnect**. `502 { error }` Spotify is down → **retry, do not re-OAuth**. `503 { configured: false, missing }`. |
| `POST /api/music/spotify/disconnect` | Deletes the connection row. `200 { disconnected: true }`, **idempotent** — disconnecting twice is a 200 both times. `401` no session. `503 { configured: false, missing }`. `500` only if the delete fails. Much simpler than the calendar's disconnect because Spotify playback creates nothing on the user's account to clean up. |

**Call-site contract — read these four.**

1. **`GET /api/music/spotify/token` is the only token source, and it is called repeatedly, not
   once.** Wire it straight into `getOAuthToken: cb => fetch(...).then(r => r.json()).then(d =>
   cb(d.access_token))`. Do **not** cache the token in component state and reuse it past its
   life: the endpoint already caches server-side and refreshes lazily, so calling it whenever the
   SDK asks is both correct and cheap.
2. **The refresh token never reaches the browser, under any circumstance.** Only the short-lived
   access token is ever in a response body. Nothing in the frontend should ever have a variable
   holding a Spotify refresh token; if one appears, something is wrong upstream.
3. **`409` and `502` mean opposite things — do not collapse them.** `409` with
   `reconnectRequired` means the six-month authorization is genuinely dead and the user must redo
   OAuth. `502` means Spotify had a bad moment; sending the user through consent again for that
   is both wrong and annoying. Retry `502`, never auto-retry a `409`.
4. **Spotify refresh tokens expire, and that is normal.** Six months from the original
   authorization, and refreshing an access token does **not** extend it. Every long-lived
   connection ends in `reconnectRequired` eventually — it is an expected end-state to design a UI
   for, not an error condition to treat as exceptional.

**Scopes.** `streaming user-read-email user-read-private` only — the three the Web Playback SDK
requires, and nothing else. No playlist, library, follow or user-modify scope: this app plays
audio, it does not read or alter the user's Spotify account. There is deliberately **no playback
control on the server** — no play/pause/seek route and no call to Spotify's Web API player
endpoints — so nothing unattended can start audio on a user's account. The scopes Spotify
actually *granted* are stored on the connection row, not the ones requested.

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
