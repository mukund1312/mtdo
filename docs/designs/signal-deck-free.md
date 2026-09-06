# Signal Deck free — onboarding implementation

**Status:** Implemented UI and API integration; the Deck itself is still prototype data.

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
- `web/app/(marketing)/architecture-02/page.tsx` — adds the entry link only.

## Current boundary

This completes onboarding UI, but does **not** yet make the main Signal Deck read the newly
persisted plan. Architecture 02 still uses prototype task/calendar/review data. The next free
product task is to load the active plan and materialized daily blocks into the Deck home and Work
views.
