# Architecture 02 — V1 product implementation

## Product boundary

Architecture 02 at `/architecture-02` is the only active V1 product surface. It owns the
presentation layer for onboarding, Today, and Progress; it does not own a separate database
schema, API contract, or user state.

Architecture 01, 03, 04, and 05 remain visual explorations. When their product work begins,
they must consume the same neutral data contracts rather than duplicate tables or API routes.

```text
Supabase + Route Handlers
          ↓
neutral product data utilities
          ↓
Architecture 02 presentation (V1)
          ↓
future architecture/theme presentations
```

## V1 routes

| Route | Purpose |
|---|---|
| `/architecture-02` | Primary application shell: Today and Progress views. |
| `/architecture-02/onboarding` | NDJSON-backed plan setup. |
| `/session` | Existing Graphite focus-session implementation; launched from a Today block. |

`/progress` has been retired so it cannot compete with Architecture 02 as the product route.

## Data boundaries

- Onboarding calls only `POST /api/onboarding/plan`; the route handler persists plans.
- Today reads and creates/updates owned `blocks` rows under RLS. It never creates a second task
  data model.
- Progress reads personal `daily_rollups` only. `web/lib/product/rollups.ts` is intentionally
  presentation-neutral so a later theme can reuse the same calculation and data shape.
- Record Card is rendered as a data-bound preview. Its export affordance is omitted until product
  specifies image, link, PDF, or another format.

## V1 visual direction

Although Architecture 02 remains the V1 route/theme layer, active Wave 1 screens use the one
approved dark Ember Graphite system from `DESIGN.md`: Satoshi, near-black glass surfaces,
hairline borders, cyan for structure/heatmap data, and Ember only for a live focus state. The
old purple Signal Deck prototype CSS is preserved as an exploration but is not loaded by V1.

## Known backend dependency

The `daily_rollups` recompute service is not yet available (#93), so Progress must render its
explicit empty state until the backend supplies rows. No client-side rollup approximation or
sample progress data is permitted.
