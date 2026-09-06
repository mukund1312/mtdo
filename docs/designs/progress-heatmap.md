# Progress heatmap — #89

## Scope

Progress is the **Progress** view inside `/architecture-02`, the V1 product route. It is a
read-only view over the documented `daily_rollups` table and does not create, modify, or
backfill rollups.

## Data contract

The browser queries only personal rollups (`room_id is null`) for the latest 84 local-calendar
days and selects:

- `date`
- `blocks_done`
- `focus_seconds`
- `sessions_completed`

The rows are already RLS-scoped to the current anonymous/authenticated user. The page never
sends `user_id`, never writes to `daily_rollups`, and does not substitute fabricated activity.

The grid has 12 chronological columns of 7 days. Cell intensity is based first on
`focus_seconds` (25, 50, and 90-minute thresholds), with a low-activity cell for a real
block/session record that has no focus seconds. Its five-step visual ramp is the exact
`DESIGN.md` heatmap ramp:

`rgba(255,255,255,.06)` → `#0E7490` → `#0891B2` → `#06B6D4` → `#22D3EE`.

## Empty-state behaviour

`daily_rollups` currently has no recompute job (tracked as #93). Until that service exists,
the grid intentionally renders as empty and explains why. This makes the UI ready for the
backend without claiming activity that has not been derived from the ledger.

## Record Card

The Record Card export is deliberately **not implemented**. `DESIGN.md` establishes the
artifact's 1080×1920 story-oriented size, but the product has not decided whether export should
be an image, link, or PDF. That decision is required before building its UX or export mechanism.

## Files

- `web/app/(marketing)/architecture-02/progress-deck.tsx` — data load, heatmap calculation,
  totals, Record Card preview, and empty/error states.
- `web/app/(marketing)/architecture-02/v1.css` — Architecture 02 V1 layout and responsive
  Ember Graphite styles.
- `web/lib/product/rollups.ts` — architecture-independent rollup types and calculations for
  future theme implementations.
