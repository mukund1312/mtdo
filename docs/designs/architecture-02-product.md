# Architecture 02 — product wiring

Architecture 02 (Signal Deck) remains the free product's established visual
direction. This work intentionally preserves its shell, navigation, typography,
palette, panel geometry, and interaction vocabulary. The implementation replaces
only the prototype data inside its existing **Work** and **Review** decks.

## Today / Work deck

- Source: the authenticated user's `blocks` rows for the UTC date returned by
  `new Date().toISOString().slice(0, 10)`, ordered by `position`.
- The existing **+ New signal** control is functional: it reads the user's
  active plan and its categories, then inserts a real block for today under
  the existing RLS policy. The user chooses its name, optional context,
  category, and initial `backlog`/`todo`/`in_progress`/`done` state.
- Columns map exactly to the table's valid values: `backlog`, `todo`,
  `in_progress`, and `done`. The UI labels are Backlog, Todo, In progress,
  and Done.
- Blocks are moved between lanes with drag-and-drop; no per-card status
  dropdown remains. Moving a block updates `status` and `claimed` directly
  under existing RLS.
  Entering `done` appends `task_completed` with the required `block_id`; moving
  a completed block back appends `task_regressed` with that same shape.
- Opening a task uses the existing Signal Deck task lens. Launching focus routes
  to `/session?blockId=<id>`.
- The session screen fetches that owned block, passes its ID to
  `start_session`, and marks it `in_progress` only after the session exists.
  Its visual presentation is otherwise unchanged.
- Loading, empty, request-error, and in-progress/claimed states are explicit;
  there are no sample task rows in the Work deck.

## Hydration

The root layout no longer renders an `html.no-js` class and immediately removes
it with an inline script. That pre-hydration mutation made the server's
`class="no-js"` disagree with the browser's empty class list. No current
surface uses reveal-gated `.rv` content, so removing the unused mechanism
eliminates the warning without changing rendered product UI.

## Review / Progress deck

- Source: authenticated user's personal (`room_id is null`) `daily_rollups`
  rows over the last 42 UTC dates. It is read-only in the client.
- Heat cells use only `focus_seconds`; their visual buckets are 0, under 30m,
  30m, 60m, and 120m+. Hover/accessible labels expose the actual minute count.
- Summary and seven-day bars are direct sums/values from the returned rollups;
  no consistency score, progress percentage, fabricated streak, or fallback
  activity is rendered.
- The Record Card is a 9:16 on-screen milestone preview using the same returned
  values. Export is intentionally not implemented: its format (image, PDF,
  shareable link, or another format) has not been decided by the product owner.
- Loading, empty, and request-error states remain visible rather than being
  hidden by synthetic heatmap cells.

## Tests

`web/app/(marketing)/architecture-02/product-data.test.ts` verifies UTC window
generation, honest focus-time heat buckets, and duration formatting. Run with:

```bash
cd web
npm run test
```

GitHub Actions runs this suite alongside type-checking, linting, and the web
production build.
