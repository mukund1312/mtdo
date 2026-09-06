# Architecture 02 — Signal Deck walkthrough

## Purpose

The Signal Deck walkthrough is a short first-run guide for the free Architecture 02
product. It explains the real V1 loop without replacing the existing route-setup
questionnaire or making promises for unbuilt product areas.

```text
Goal route setup → Today / Work → Focus timer → Review / Record Card
```

## Steps

| Step | Surface | What it explains |
|---|---|---|
| 01 · Give the work a route | Signal Deck home | A user provides a goal, focus areas, and available days through the existing route setup; `/api/onboarding/plan` persists the resulting route. |
| 02 · Keep today in motion | Work deck | Real UTC-day blocks live in Backlog, Todo, In progress, and Done. Moving a signal changes its real state and the completion ledger records the transition. |
| 03 · Make room for one thing | Signal Deck / Session entry | Opening a signal and launching focus sends its owned block id to the existing session flow. |
| 04 · Let the record stay honest | Review deck | The six-week review is derived from settled `daily_rollups`; Record Card exports the displayed record as an image. |

The previews are illustrative interface diagrams only. They contain no synthetic user
tasks, scores, session totals, or activity history.

## Behaviour

- It opens once per browser profile on `/architecture-02`, after hydration, using
  `mtdo:signal-deck:walkthrough:v1` in local storage.
- **Guide** in the Signal Deck header, or the `?` shortcut outside form fields, reopens it.
- **Next**, **Back**, **Skip**, and **Close** are available at every appropriate point.
- Arrow keys move between steps and Escape dismisses. Standard Tab/Enter controls remain
  available for every button; the dialog traps Tab focus while open.
- Each step brings the matching existing deck underneath the overlay into view. The walkthrough
  never changes product data, calls the onboarding API, or writes to Supabase.

## Visual and accessibility constraints

- The overlay uses Architecture 02's established Signal Deck surface tokens, type treatment,
  grid texture, and high-contrast control style. It does not create a competing theme.
- Fade, slide, scale, and preview transitions are intentionally brief; they are disabled under
  `prefers-reduced-motion`.
- All controls have visible focus treatment, dialog semantics, a descriptive accessible label,
  and keyboard access.
- Dismissal is a best-effort local preference only. If browser storage is blocked, the user can
  still close the walkthrough and use the application normally.

## Implementation

- `web/app/(marketing)/architecture-02/signal-deck-walkthrough.tsx`
- `web/app/(marketing)/architecture-02/signal-deck-walkthrough.css`
- `web/app/(marketing)/architecture-02/walkthrough-data.ts`
- `web/app/(marketing)/architecture-02/page.tsx`

`walkthrough-data.test.ts` protects the order and ensures the tour targets only existing
Architecture 02 decks.
