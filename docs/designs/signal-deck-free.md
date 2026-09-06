# Architecture 02 V1 — onboarding and Today implementation

**Status:** Architecture 02 is the V1 product route. Onboarding, Today, linked focus-session
entry, and Progress are backed by the shared product data model. See also
`architecture-02-v1.md` and `wave1-frontend-briefs.md`.

## Goal

Architecture 02 is the selected V1 MTDO direction. Its first production-facing flow is route setup:
a new visitor describes a goal and study rhythm, then receives an active plan through the existing
onboarding plan-generation backend.

## Routes

| Route | Role |
|---|---|
| `/architecture-02` | V1 workspace: Today and Progress |
| `/architecture-02/onboarding` | Free route-setup flow |
| `POST /api/onboarding/plan` | Existing server-side plan-generation endpoint |

The V1 navigation includes **Set up route**, which leads to onboarding. No payment or entitlement
check is part of Wave 1.

## Today board (#87)

The **Today** view opens a live three-lane Kanban board. It deliberately uses the `blocks` table
rather than a second task model or the onboarding plan summary.

| Lane | Stored `blocks.status` value | Behaviour |
|---|---|---|
| To do | `todo` | Default state for a new block. |
| In progress | `in_progress` | Work currently being acted on. |
| Done | `done` | Finished work; moving in/out records completion/regression analytics. |

The board reads the active plan, its categories, and blocks ordered by `position`; RLS scopes
every read/write to the browser's anonymous/authenticated session. Users can add a block to an
active-plan category, move it with drag/drop, or use the card's status selector. All status
changes update the real row in `blocks`; an error restores the previous client state and reports
the reason. **Open decision:** the Wave 1 brief requires a server-defined “today”, while the
current app has no such API/RPC; the temporary browser-date query must be replaced once M/Mukund
locks that boundary.

Onboarding creates a plan and curriculum, not scheduled daily blocks. Therefore a newly
onboarded user sees an honest empty Today board until they add their first block. The UI also
has distinct states for no active plan and absent Supabase configuration; it never fills a
production board with sample tasks.

## User flow

```text
Signal Deck
  → Set up your route
  → Intent: goal + one to six focus areas
  → Rhythm: experience level + available weekdays + optional context/name
  → Stream plan generation
  → Persisted plan summary
  → Enter Today
```

### Input contract

The UI sends `OnboardingAnswers` to `/api/onboarding/plan`:

- `goalLine` — required, non-blank.
- `focusAreas` — one to six areas.
- `experienceLevel` — beginner, intermediate, or advanced.
- `weeklyDaysAvailable` — at least one day, using `0=Monday` through `6=Sunday`.
- `notes` and `appName` — optional.

This matches `web/lib/plan-generation/types.ts` and the API contract in
`docs/architecture/api.md` §2a.

### Generation behavior

The client reads the API's NDJSON stream using `response.body.getReader()`.

- `delta` events update the visible route-generation status.
- `done` stores the returned summary in component state and offers **Enter Signal Deck**.
- `error`, malformed responses, unavailable auth, and streams that end without `done` return the
  user to the rhythm step with a readable error.
- The API itself falls back to a static starter plan when Anthropic generation fails, so the UI
  still treats `done` as a successful route.

The plan is persisted by the server before `done` is emitted. A local `mtdo-active-plan` cache is
best-effort only; failing browser storage never changes onboarding success.

## Implementation files

- `web/app/(marketing)/architecture-02/onboarding/page.tsx` — stateful client onboarding flow.
- `web/app/(marketing)/architecture-02/onboarding/onboarding.css` — responsive Ember Graphite UI.
- `web/app/(marketing)/architecture-02/today-deck.tsx` — live Today board and `blocks` reads/creates/status updates.
- `web/app/(marketing)/architecture-02/today-deck.css` — responsive Today board styling.
- `web/app/(marketing)/architecture-02/progress-deck.tsx` — read-only `daily_rollups` heatmap and Record Card preview.
- `web/app/(marketing)/architecture-02/page.tsx` — Architecture 02 V1 shell and navigation.

## Current boundary

Today links an owned block to `/session?blockId=…`; Session passes that ID to `start_session` and
marks the block in progress only after the RPC succeeds. Progress is intentionally empty until
the #93 daily-rollup recompute service is available. Record Card export remains pending the
product decision on image, link, or PDF.
