# Signal Deck free — onboarding implementation

**Status:** Implemented UI and API integration. Onboarding hands off to the live Today / Work deck.

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
  → Enter Today / Work deck
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
- `done` stores the returned summary in component state and offers **Enter Today**. The handoff
  opens `/architecture-02?deck=work`, the existing live UTC Today board.
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
- `web/app/(marketing)/architecture-02/page.tsx` — adds the entry link and accepts the internal
  `deck=work` handoff used after a persisted plan is ready.

## Current boundary

Onboarding owns only plan creation. It does not directly write plan tables from the client; the
server-side route persists and activates the plan before emitting `done`. The live Work deck then
loads the user's UTC-day blocks and active route under existing RLS. A newly created plan may
honestly have no blocks for today; that empty Today state invites the user to add their first
signal rather than showing fabricated work.
