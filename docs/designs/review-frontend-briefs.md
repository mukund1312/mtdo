# Review page frontend build briefs — for Janhwi (Codex)

**Status:** ACTIVE — F1, F2, F3, and F4 are ready to build now
**Owner:** Janhwi builds, Mukund (Claude Code) keeps this doc current before announcing a phase
"contract locked" — same rule `wave1-frontend-briefs.md` and `mtdo-web-dev-split-plan.md` §3 already
use.
**Related:** `docs/designs/mtdo-web-review-study-profile-plan.md` (the full phase plan, both sides),
`docs/designs/review-visual-spec.md` (colors/ring/heatmap treatment), `docs/architecture/api.md`
§3j (the `review_daily_summary()` contract), `DESIGN.md` ("Review page ring tokens" under §Color),
`web/lib/review/types.ts`.

**House rule, restated from `wave1-frontend-briefs.md`:** every screen below builds against
`DESIGN.md` — no new visual system, no color/typography/motion decision not already in `DESIGN.md`
or `review-visual-spec.md`. If something genuinely isn't covered, that's a question back to Mukund
before building, not a judgment call mid-build.

**Do not start a phase's screens before this doc says its backend contract is locked.** F1 has no
backend dependency and is ready today. F2 depends on Phase A (`migrations/0025_review_daily_summary.sql`,
`api.md` §3j) and F3 depends on Phase B (`migrations/0027_review_consistency.sql`, `api.md` §3k) —
both contract-locked as of 2026-09-13, both ready today. F4 onward are **not** ready yet; their row
below says so explicitly and will be updated (not silently
assumed) when their backend phase locks.

---

## Where this fits in the existing app — read this before touching anything

The Review destination **already exists and already renders something real** — this is not a new
route. `web/app/(marketing)/architecture-02/page.tsx` (the Signal Deck shell — despite the
directory being named "marketing", this is the real V1 product, `decisions.md` 2026-09-07) has:

```ts
type Deck = "home" | "work" | "goals" | "calendar" | "review" | "listen";
// ...
{deck === "review" && <ProgressDeck />}
```

`ProgressDeck` (`progress-deck.tsx`, sibling file) currently renders the Wave-1 heatmap plus an
embedded `WeeklyReviewPanel` (`weekly-review.tsx` — the weekly-engine review UI, already shipped,
separate from this work). **Both of those are live, working product surfaces. Nothing in this
wave deletes or breaks them until their specific replacement phase says so** (Phase B/F3 replaces
the heatmap's coloring; nothing here touches `WeeklyReviewPanel` at all). The plan doc's own
Verification section is explicit: a phase that replaces a live surface must say so, not merge as if
purely additive.

**The pattern every "deck" component already uses** (`progress-deck.tsx`, `weekly-review.tsx`) —
follow it exactly, don't invent a new one:
- `"use client"` component, `createClient()` from `@/lib/supabase/client`.
- `supabase.auth.getUser()` to get the user, then a query or `supabase.rpc("<name>", {...})` call
  inside a `useCallback` `load()`, called from `useEffect`.
- An explicit `state: "loading" | "ready" | "error"` (or richer union where a phase needs it —
  see F2's `insufficient_data`/`no_active_plan` states below).
- RPC results narrowed through the typed helper, never cast — `asWeeklyPerformance()` is the
  existing example; F2 uses `asReviewDailySummary()` (`web/lib/review/types.ts`) the same way.

---

## F1 — Review page shell (ready now, no backend dependency)

**Goal:** give the Review destination its own header/identity and a range selector, **without**
regressing the heatmap or weekly review panel that already live there.

**What to build:**
1. New file `web/app/(marketing)/architecture-02/review-deck.tsx`, exporting `ReviewDeck`.
2. Header, per `review-visual-spec.md`: small uppercase "REVIEW / TODAY" eyebrow line, then the
   two-line headline "MAKE EFFORT" / "LEGIBLE." (LEGIBLE. in the `--accent` cyan-white gradient
   clip already defined in `DESIGN.md`'s Gradients section — do not invent a new gradient), then
   a muted one-liner "Track. Understand. Improve. Repeat."
3. A compact segmented range selector: `Today | Week | Month | 6 Weeks | Year`, local component
   state (`useState<"today" | "week" | "month" | "6weeks" | "year">("today")`), no URL param needed
   yet (page.tsx already owns `?deck=` — don't add a second query-param system for this).
4. **Body, for now:** regardless of which range tab is selected, render the **existing**
   `<ProgressDeck />` unchanged below the new header/selector. F2 replaces the `"today"` tab's body
   with real content; every other tab shows a plain "Coming soon" placeholder card (small, muted,
   centered) until its phase locks — never a fake chart.
5. In `page.tsx`, change `{deck === "review" && <ProgressDeck />}` to
   `{deck === "review" && <ReviewDeck />}`. `ProgressDeck` itself is untouched (still imported and
   rendered, now from inside `ReviewDeck`).

**States:** none new beyond what `ProgressDeck` already handles — this phase is pure shell/chrome.

**Explicitly not this phase:** rings, real per-range content, heatmap recoloring, any RPC call.

---

## F2 — Rings (ready now, backend Phase A locked 2026-09-13)

**Depends on:** `review_daily_summary()` (`migrations/0025`, `api.md` §3j) — merged, tested
(131/131 in `supabase/tests/run.sh`), typed in `web/lib/review/types.ts`.

**Goal:** the "Today" tab of `ReviewDeck` (built in F1) shows the three real rings — Focus,
Execute, Progress — replacing its placeholder.

**Data contract — use exactly this, do not re-derive any percentage client-side:**

```ts
import { createClient } from "@/lib/supabase/client";
import { asReviewDailySummary, type ReviewDailySummary } from "@/lib/review/types";

const { data, error } = await supabase.rpc("review_daily_summary", {});
// p_date defaults to "today" in the caller's own profile timezone -- do not
// pass a client-computed date unless the user explicitly picks a past day.
if (error) { /* -> "error" state */ }
const summary: ReviewDailySummary = asReviewDailySummary(data);
```

`summary.status` is `"ok"` or `"no_active_plan"` — **branch on this before reading any ring.**
When `"no_active_plan"`, `focus`/`execute`/`progress` are all `null` — render an empty state in the
same voice `today-deck.tsx` already uses for the equivalent case (its `hasActiveRoute` check,
`CurriculumMenu`'s empty copy): "Set up your route first, then return here for its first useful
piece." Don't invent new wording for the same real-world state.

When `status === "ok"`, each of `summary.focus` / `summary.execute` / `summary.progress` has its
own `percentage: number | null`. **`null` means "no basis to compute this," not zero** — render an
explicit "no target set yet" (Focus) / "nothing planned today" (Execute) / "no category picked
this week" (Progress) state on that one ring, never a fake `0%`. This is not an edge case to
handle later — it will be the common state for a fresh account and must look intentional, not
broken.

**Ring build, per `review-visual-spec.md` §Rings:**
- Three rings side by side (stack on mobile per `DESIGN.md`'s existing responsive rules — nothing
  Review-specific needed there).
- Colors: `var(--review-focus)` / `var(--review-execute)` / `var(--review-progress)` (`DESIGN.md`
  §Color, "Review page ring tokens" — these three tokens exist now, do not use raw hex).
- Thick stroke, rounded caps, dark inactive track (reuse the existing card surface token for the
  track, not pure black), percentage large and centered, raw value below it
  (`{focus_minutes} / {target_minutes} min`, `{tasks_done} / {tasks_picked} tasks`,
  `{week_score} / {week_score_max}` — use the field names from `types.ts` verbatim, don't rename),
  label + one-line subtitle below that (`FOCUS` / "Deep work time", `EXECUTE` / "Tasks completed",
  `PROGRESS` / "Goal advancement").
- Entrance animation: 0 → actual value once, ~700–900ms ease-out, **must** respect
  `prefers-reduced-motion` (render at final value, no animation, if set — this is a blocking
  accessibility requirement per `DESIGN.md`'s existing rule, not new for Review).
- Hover/focus reveals a small detail tooltip: Focus → session_count/completed_sessions/
  longest_session_minutes; Execute → tasks_done/tasks_picked/score/score_max; Progress →
  week_score/week_score_max. Keyboard-accessible (tab to the ring, tooltip shows on focus too, not
  hover-only).

**States:** `loading` (skeleton rings, no numbers) → `ready` (real data, per the null-handling
above) → `error` (RPC failed — small inline message, does not take down the rest of the page) →
implicitly, `no_active_plan` is a `ready` state, not an error state.

**Explicitly not this phase:** Week/Month/6 Weeks/Year tab content (still "Coming soon" from F1),
the heatmap recoloring (F3, needs Phase B), any insight/recommendation text (F6, needs Phase E).

---

## F3 — Consistency heatmap (ready now, backend Phase B locked 2026-09-13)

**Depends on:** `review_consistency()` (`migrations/0027`, `api.md` §3k) — merged, tested (156/156),
typed in `web/lib/review/types.ts` (`ReviewConsistency`/`asReviewConsistency()`).

**Goal:** replace `ProgressDeck`'s existing heatmap coloring (currently `heatLevel(focus_seconds)`
from `product-data.ts`, raw minutes) with the server-computed Effort Score. **This changes a live
surface — call it out explicitly in your PR description, don't merge it as if purely additive.**

**What exists today, exactly (mirror this, don't redesign it):**
- `progress-deck.tsx`'s heatmap renders one `<i className={`level-${n}`} title="…" aria-label="…" />`
  per day, `n` from `heatLevel()` in `product-data.ts`, over a fixed `WINDOW_DAYS = 42` window built
  by `utcDateRange()`.
- CSS levels `level-0`…`level-4` already exist (check `progress-deck` or its `.css` sibling for the
  current color ramp) — for this phase, **only the color values change** (cyan ramp → the lime ramp
  `review-visual-spec.md` §Consistency heatmap specifies, i.e. levels 1–4 ramping toward
  `var(--review-execute)`, level 0 the existing dark surface token), the cell/grid markup and
  accessibility attributes (`title`, `aria-label`) stay structurally the same shape.

**The actual change:**
1. Replace the `daily_rollups` query + client-side `heatLevel()` call with one
   `supabase.rpc("review_consistency", { p_start: windowDates[0], p_end: windowDates.at(-1) })`,
   narrowed through `asReviewConsistency()`. Do not compute `level` client-side anymore — use the
   `level` field the RPC already returns per day (`null` is a real state, see below).
2. **Wire the window to F1's range selector** rather than the hardcoded 42 days: Week → 7 days,
   Month → ~30, 6 Weeks → 42 (today's existing default), Year → 365. `review_consistency` caps at
   400 days server-side, so Year is safe as-is.
3. **`level: null`** (a day before the user had any active plan — see `api.md` §3k) renders
   distinctly from `level: 0` (a real, active-plan-but-empty day) — e.g. a slightly different cell
   treatment (lower opacity, or a subtle diagonal-hatch background) rather than identical styling.
   Don't collapse these to the same visual — that's exactly the null-vs-zero distinction the whole
   backend side of this plan is built around.
4. Hover/focus tooltip (keyboard-accessible, same as the existing `title`/`aria-label` pattern):
   date, `effort_score`, and the day's `focus_percentage`/`execute_percentage`/`progress_percentage`
   — each rendered as "—" or "not enough data" when `null`, never `0%`.
5. Summary row under the grid (active-day %, current streak, longest streak) — **resolved by
   Phase C, F4 below**: `streak.ts`'s `computeStreaks()` is a client-side approximation
   (`blocks_done > 0`, its own header admits it's not the terminal app's stricter "100% of that
   day's blocks" definition) that `review_momentum()` now replaces with a real server-computed
   `current_streak`/`longest_streak` (and a smoothed `momentum_score` on top). If F3 ships before
   F4, keep `computeStreaks()` running for this summary row as an interim measure; F4 retires it.

**Explicitly not this phase:** the Terrain toggle (F7, stretch, optional, heatmap stays default),
Week/Month/Year tab content *beyond the heatmap itself* (Time Behavior/Session Quality/Study
Profile/Insights are F4–F6, still locked).

---

## F4 — Time behavior + Session quality + Momentum (ready now, backend Phase C locked 2026-09-13)

**Depends on:** `review_time_patterns()` and `review_momentum()` (`migrations/0028`/`0029`,
`api.md` §3l/§3m) — merged, tested (188/188 full suite), typed in `web/lib/review/types.ts`.

**Goal:** three related sections, all sourced from these two RPCs:

1. **"When you work best"** — call
   `supabase.rpc("review_time_patterns", { p_start, p_end })` (window from F1's range selector),
   narrow with `asReviewTimePatterns()`. Chart `hourly` as a bar/area chart in `--accent` (cyan) per
   `review-visual-spec.md` §Time-of-day/session-quality — this section is "observed behavior," not
   an achievement. Show `best_hour` prominently (e.g. "Best start time 08:00") **only when it is
   non-null** — when null, render "Not enough sessions yet to identify a pattern" (this is the
   `insufficient_data` state `review-visual-spec.md` already calls for; it will be the common state
   for a new account, not an edge case to bolt on later). Same treatment for `best_weekday`.
2. **Session quality** — `duration_buckets` as the `<15m/15-30m/30-45m/45-60m/60-90m/90m+`
   distribution bars, `best_duration_bucket` as the "sweet spot" callout, same null-vs-insufficient
   handling as above. **Do not label `session_completion_rate` as "completion rate" in a way that
   could be confused with Execute's task completion** — call it "session completion" or similar in
   the UI copy; they are genuinely different numbers (`api.md` §3l).
3. **Momentum** — replaces `streak.ts`'s `computeStreaks()` (client-side, `blocks_done > 0`
   approximation) with `supabase.rpc("review_momentum", { p_window_days: 42 })` /
   `asReviewMomentum()`. Show `momentum_score` as the headline number (not a raw streak count —
   the founder's brief is explicit that a smoothed number that dips gently reads healthier than one
   that resets to zero), with `current_streak`/`longest_streak` as supporting stats underneath.
   Branch on `status`: `"no_active_plan"` uses the same empty-state copy as F2's rings
   ("Set up your route first…").

**States:** `loading` → `ready` (including the `insufficient_data` sub-states per bucket, which are
real, common states) → `error`.

**Explicitly not this phase:** Study Profile panel (F5, needs Phase D), Insights card (F6, needs
Phase E).

---

## F5 onward — not contract-locked yet, do not start

| Phase | Depends on backend | Status |
|---|---|---|
| F5 — Study Profile panel | Backend Phase D | not started |
| F6 — Insights card | Backend Phase E | not started |
| F7 (stretch) — Effort Terrain toggle | F3 | not started, optional |

This table is the single source of truth for "is it safe to start yet" — when a backend phase
locks, this row gets updated with the RPC name and `api.md` section, the same way F2/F3/F4's rows
above were updated. Building ahead of a locked row here reproduces the exact problem
`wave1-frontend-briefs.md` was written to prevent (an ambiguous/early brief producing silently-wrong
output).
