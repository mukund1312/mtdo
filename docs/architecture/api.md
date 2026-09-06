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
(schema.md §6) — no RPC, insert directly under the user's RLS session via `lib/supabase/server.ts`.
`persist.ts` deactivates any existing active plan first (`plans_one_active`), then does exactly
three insert statements (plan → categories batch → curriculum_items batch), each atomic on its own
table but **not atomic across all three** — there is no security-definer RPC for this because these
tables don't need one. If categories or curriculum_items fail to insert after the plan row exists,
`persist.ts` marks that plan `is_active: false` (there's no DELETE path — `schema.md`'s "no DELETE
policy on plans" — so this is the only cleanup available) rather than leaving a half-written plan
active. `week_index`/`position` on `curriculum_items` are derived, not model-supplied: every
`category.days.length` consecutive `curriculum` entries are one week (`week_index = floor(dayListIndex
/ category.days.length)`), and `position` is a running counter across the whole flattened curriculum
for that category — this is the concrete mapping schema.md §2 left implicit.

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
| `from('focus_sessions').insert(...)` | `rpc('start_session', { p_block_id, p_planned_duration_s })` |
| `from('focus_sessions').update({ state: 'completed' })` | `rpc('complete_session', { p_id })` |
| `from('focus_sessions').update({ state: 'abandoned' })` | `rpc('abandon_session', { p_id })` |
| `from('activity_events').insert({ kind, occurred_at, payload })` | `rpc('record_event', { p_kind, p_payload })` |
| `from('tutor_messages').select(...)` | `rpc('tutor_context', { p_conversation_id, p_recent_limit })` |
| `from('tutor_messages').insert(...)` | *not available to clients* — the W3b Route Handler (service role) only |
| `from('daily_rollups').insert/update(...)` | *not available* — derived by a service-role recompute job (D13) |

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
- **Generated types** (`web/lib/supabase/`) should be regenerated after any migration change so
  the RPC signatures above are typed rather than stringly-called.

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
