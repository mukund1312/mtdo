# Review page frontend build briefs — for Janhwi (Codex)

**Status:** ACTIVE — F1 and F2 are ready to build now
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
backend dependency and is ready today. F2 depends on Phase A, which is contract-locked as of
2026-09-13 (`migrations/0025_review_daily_summary.sql`, `api.md` §3j) — also ready today. F3
onward are **not** ready yet; their row below says so explicitly and will be updated (not silently
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

## F3 onward — not contract-locked yet, do not start

| Phase | Depends on backend | Status |
|---|---|---|
| F3 — Consistency heatmap (effort-score coloring, replaces `ProgressDeck`'s current raw-minutes heatmap) | Backend Phase B | not started |
| F4 — Time behavior + session quality | Backend Phase C | not started |
| F5 — Study Profile panel | Backend Phase D | not started |
| F6 — Insights card | Backend Phase E | not started |
| F7 (stretch) — Effort Terrain toggle | F3 | not started, optional |

This table is the single source of truth for "is it safe to start yet" — when a backend phase
locks, this row gets updated with the RPC name and `api.md` section, the same way F2's row above
was updated today. Building ahead of a locked row here reproduces the exact problem
`wave1-frontend-briefs.md` was written to prevent (an ambiguous/early brief producing silently-wrong
output).
