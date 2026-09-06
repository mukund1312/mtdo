# Signal Deck free — onboarding implementation

**Status:** Onboarding and the Today board are backed by the product data model. Calendar,
review, focus, tutor, and rooms remain prototype surfaces.

## Goal

Signal Deck is the selected free MTDO direction. Its first production-facing flow is route setup:
a new visitor describes a goal and study rhythm, then receives an active plan through the existing
onboarding plan-generation backend.

## Routes

| Route | Role |
|---|---|
| `/architecture-02` | Signal Deck visual workspace and onboarding entry point |
| `/architecture-02/onboarding` | Free route-setup flow |
| `POST /api/onboarding/plan` | Existing server-side plan-generation endpoint |

The Deck home includes **Set up your route ↗**, which leads to the onboarding route. No payment
or entitlement check is part of this free Signal Deck path.

## Today board (#87)

The **Today** item in the Signal Deck dock, and the **Open today** home card, open a live
three-lane Kanban board. It deliberately uses the `blocks` table rather than a second task
model or the onboarding plan summary.

| Lane | Stored `blocks.status` value | Behaviour |
|---|---|---|
| To do | `todo` | Default state for a new block. |
| In progress | `in_progress` | Work currently being acted on. |
| Done | `done` | Finished work; moving in/out records completion/regression analytics. |

The board reads the active plan, its categories, and only blocks whose `date` equals the
user's current local date. It orders blocks by `position` and is RLS-scoped by the browser's
anonymous/authenticated Supabase session. Users can add a block to an active-plan category,
move it with drag/drop, or use the card's status selector. All status changes update the
real row in `blocks`; an error restores the previous client state and reports the reason.

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
  → Enter Signal Deck
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
- `web/app/(marketing)/architecture-02/onboarding/onboarding.css` — responsive Signal Deck UI.
- `web/app/(marketing)/architecture-02/route-entry.css` — home-screen route-setup entry styling.
- `web/app/(marketing)/architecture-02/today-deck.tsx` — live Today board and `blocks` reads/creates/status updates.
- `web/app/(marketing)/architecture-02/today-deck.css` — responsive Today board styling.
- `web/app/(marketing)/architecture-02/page.tsx` — Signal Deck shell and Today navigation entry.

## Current boundary

Today is the first Signal Deck area reading persisted application data. The remaining Deck
surfaces still use prototype data. The next free-product task is to connect a block to the real
focus-session flow and then replace the calendar and review placeholders with derived data.
