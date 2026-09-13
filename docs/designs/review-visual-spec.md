# Review page — visual spec (companion to `mtdo-web-review-study-profile-plan.md`)

**Status:** DRAFT — condensed from the founder's reference mock; scoped to the Review page only.
**Governs:** `web/app/(app)/review/**` only. `DESIGN.md` remains the whole-product source of truth;
this doc is an addendum for one page, per §6 of the review/study-profile plan.

This is a condensed, repo-grounded version of the reference mock — it drops sections that don't
apply here (there is no separate "subject gets a permanent color" system yet, no assessments, no
GitHub-3D-terrain-as-default). Anything not covered here inherits `DESIGN.md` unchanged: background,
grid, card borders, spacing, type (Satoshi), motion rules.

## New tokens (Review-page scoped only — do not use elsewhere)

```css
--review-focus:     /* pink/coral, close to reference #FF4F78–#F2386B, contrast-checked vs #0B0B0C */
--review-execute:   /* acid lime, close to reference #C8FF45–#AEEE49 */
--review-progress:  /* violet, close to reference #A05BFF–#8D63FF */
```

`--accent` (cyan) keeps its existing whole-product meaning and is reused here for **observed
behavioral data** (time-of-day charts, session-length bars, plan-vs-actual's "actual" bar) — not a
new token, the existing one, doing the job the reference mock assigned to cyan.

`--live` (ember) is **not** reused for any ring or chart in Review. Its one meaning across the
product stays "this is happening right now" (an active focus session), per `DESIGN.md`.

`--success` / `--warning` / `--danger` (existing tokens) mark direction of change (↑12% good vs.
↑20% reschedules bad) — reuse these, don't invent a second green/red pair.

## Rings (Phase A / F2)

- Thick stroke, rounded caps, dark inactive track (existing surface color, not pure black),
  subtle glow on the active arc. Not a thin Material-style progress ring.
- Center: percentage, large. Below: the raw value (`103 / 120 min`). Below that: label + one-line
  subtitle (`FOCUS` / `Deep work time`).
- Entrance animation: 0 → actual value, ~700–900ms ease-out, once per page load, not repeating.
  Respect `prefers-reduced-motion` — render at final value with no animation.
- Hover/focus: brighten the active stroke slightly, reveal a detail tooltip (session count,
  longest/average session) — do not enlarge the ring itself.

## Consistency heatmap (Phase B / F3)

- GitHub-shaped grid, five intensity levels, but colored by **effort score** (server-computed,
  Phase B), never raw minutes.
- Level 0 uses the existing dark surface token, not a new "empty" color. Levels 1–4 ramp toward
  `--review-execute` (lime) rather than GitHub's green, per the reference mock.
- Hover/focus (keyboard-accessible): date, effort score, and the day's three ring values.
- Summary row under the grid (active-day %, current streak, longest streak, momentum) reads as
  part of the same card, not separate KPI tiles.

## Time-of-day / session-quality charts (Phase C / F4)

- Bar/area charts in `--accent` (cyan) — this section is "observed behavior," matching the plan's
  semantic split (cyan = measured, not achieved/planned).
- Every chart must render its `insufficient_data` state distinctly from a real zero (per the plan's
  §4 Phase C rule) — e.g. a muted placeholder bar shape with "not enough sessions yet," not an
  empty chart that reads as "zero happened."

## Plan vs. reality (existing weekly-engine data, new UI)

- Planned bar: a muted violet/lavender tone (intent), actual bar: `--accent` cyan (observed) —
  matches the plan's stated rule "purple/violet = intent, cyan = observed, lime = successful
  result," applied consistently rather than per-chart ad hoc choices.

## Insights card (Phase E / F6)

- Small `--review-execute` (lime) or `--accent` (cyan) signal glyph per line, not a chatbot avatar
  — this stays a data-driven list, not a conversational surface.
- Bold the concrete numbers/times inside each sentence (`35–50 minutes`, `08:00–10:00`); body text
  stays the existing muted-text token.

## Deliberately deferred / not part of this doc

- **Per-subject/category permanent color coding** (reference mock §16) — needs a stable
  subject→color mapping this project doesn't have today (categories are user-configured, unbounded
  in count and name). Revisit once Study Profile (Phase D) ships and it's clear how many distinct
  categories real users actually have.
- **Effort Terrain (3D)** — optional stretch (F7), heatmap is and stays the default view.
- **Left secondary nav** (Overview/Deep Dive/Time Analysis/…) from the reference mock — Signal
  Deck's existing nav model doesn't have a per-page secondary rail anywhere else in the product;
  introducing one for Review only is a bigger nav-architecture change than this wave should make
  silently. If wanted, raise it as its own small decision before F1, not assumed here.
