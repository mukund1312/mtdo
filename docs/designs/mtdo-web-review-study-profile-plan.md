# mtdo web — Review page & Study Profile system

**Status:** DRAFT — awaiting M/J kickoff
**Created:** 2026-09-13
**Owner:** Mukund Umashankar (backend, Claude Code) + Janhwi (frontend, Codex)
**Related:** `docs/designs/mtdo-web-dev-split-plan.md` (ownership/handoff rules this plan reuses
verbatim — read that first), `docs/designs/mtdo-web-v1-plan.md` (product plan/phases),
`docs/architecture/{schema,api,decisions}.md` (the contracts this plan builds on top of),
`DESIGN.md` (Graphite — visual system of record).
**Worktree:** `feature/mu/UAT-review-study-profile-plan` (this doc was authored here; the actual
implementation branches per phase, per the dev-split doc's branch convention).

---

## 0. What this replaces, and why it's a plan, not a build

The founder pasted a very complete design brief (rings, heatmap-as-effort-score, terrain view,
learner-behavior model, a 15-phase master prompt for a fresh codebase). This doc is that brief
**re-derived against the actual repo**, not transcribed — a generic-greenfield master prompt would
have had Janhwi and me rebuild event ingestion, daily aggregation, and weekly scoring that
**already ship** here. Re-deriving those would burn a large amount of work reproducing what
`activity_events`, `daily_rollups`, and `weekly_performance()` already do, and risk a second,
divergent formula for the same metric — exactly the failure mode `api.md` §3f was written to
prevent ("no metric should have two separate implementations").

**Net effect: this is roughly a 6-phase backend plan, not 22.** Sections 1–2 below are the actual
audit (what exists, mapped onto the brief's data model). Section 3 restates the ownership rules
already governing this project. Sections 4–5 are the phase plans. Section 6 is the one open design
decision, now resolved.

---

## 1. Audit — what the brief asks for that we already have

| Brief concept | Already shipped, as | Where |
|---|---|---|
| Append-only behavioral event ledger | `activity_events` (insert-by-function, immutable, `kind` is a closed vocabulary) | `schema.md` §2, `api.md` §4 |
| Session telemetry (start/pause/resume/complete/abandon, planned vs. actual, pause duration) | `focus_sessions` + `start_session`/`pause_session`/`resume_session`/`extend_session`/`complete_session`/`abandon_session` (Focus Mode, migrations/0023) | `api.md` §3h |
| Daily derived features | `daily_rollups`, written only by `recompute_daily_rollups()` (migrations/0009), scheduled by pg_cron | `api.md` §3a |
| Weekly derived features, versioned & deterministic | `weekly_performance()` (migrations/0021) — completion_rate, pace_ratio, score, per-category breakdown, `null`-vs-`0` discipline | `api.md` §3f |
| Planned vs. actual, plan accuracy | `pace_ratio` (`paced_actual_minutes / estimated_minutes`), already ratio-of-sums not mean-of-ratios | `api.md` §3f |
| Subject/goal balance | `weekly_performance()`'s per-`category` breakdown (categories = the goal/subject hierarchy already) | `api.md` §3f |
| Avoidance / postponement signal | `postponement_count` = `regressed_count` + `stale_open_count`, per category | `api.md` §3f |
| A basic consistency visualization | Progress heatmap (Wave 1, mtdo-bugs #89), inside Architecture 02 / Signal Deck | `decisions.md` 2026-09-07 |
| Deterministic-first philosophy, versioned formulas, AI as an optional consumer of structured output | `weekly_plans.generated_by = 'rules_v1'`, `aiService.reviewWeek()` explicitly not built | `api.md` §3g, `decisions.md` 2026-09-11 |
| "No metric has two implementations" | Already a stated project rule | `api.md` §3f/§3g intro |

**What genuinely does not exist yet** and is the real backlog:

1. A **daily** Focus/Execute/Progress ring — `daily_rollups` has raw daily numbers, but nothing
   normalizes them into the 0–100%-of-target shape the rings need, and there is no "Progress" (goal
   advancement) concept at daily grain at all today — only weekly `score`.
2. An **Effort Score** (the thing the heatmap should color by, not raw minutes) — no formula exists.
3. **Time-of-day and session-length analytics** (best focus window, session sweet spot) — the raw
   data (`focus_sessions.started_at`, pause counts) exists; nothing aggregates it.
4. **Momentum / streak-as-smoothed-score** (not a raw streak counter) — doesn't exist.
5. A **Study Profile** object (one place a user's behavioral traits live, with sample size +
   confidence per trait) — doesn't exist.
6. **Mastery/retention/assessments** — this app has no quiz/assessment concept at all today (it's a
   generic config-driven curriculum of blocks, not DSA-specific). Brief sections 6–10, 16–18 of the
   founder's paste (confidence ratings, error taxonomy, retention curves) are **out of scope for
   this plan** — they need a assessment/outcome data model that doesn't exist and isn't implied by
   anything currently shipped. Flagged as a later, separate plan, not silently absorbed here.
7. **Interventions/recommendations as tracked, measurable objects** (shown/accepted/dismissed +
   before/after outcome) — the weekly engine (`weekly_plan_changes`) tracks *plan* changes and
   their accept/reject state already, but nothing measures whether an accepted change actually
   improved anything afterward.
8. The actual **Review page** UI — nothing beyond the Wave-1 Progress heatmap exists in
   `web/app/(app)`.

Item 6 is the biggest scope cut from the founder's paste. Everything else below is scoped to
1–5, 7 (partial), 8 — a rings + consistency + behavior-pattern Review page, not a full mastery/
retention learning-science platform. That can be a Phase 2 of this plan, proposed once this ships
and is used for a few weeks (same "don't build the next thing before the current one is real"
rule `mtdo-web-v1-plan.md` already uses).

---

## 2. The one non-negotiable principle, restated

**Observation ≠ derived feature ≠ inference ≠ recommendation. Never collapse them into one field.**
This project already lives this rule (`daily_rollups` is derived-never-hand-written per D13;
`weekly_performance()`'s `null`-vs-`0` distinction exists for exactly this reason). Everything new
in this plan follows the same shape:

```
activity_events / focus_sessions       (raw observation — already ledgered)
        ↓
daily_rollups / weekly_performance()   (derived feature — already computed)
        ↓
review_daily_summary() [NEW]           (normalized 0-100 rings + effort score, versioned)
        ↓
study_profile() [NEW]                  (behavioral patterns, each tagged with sample_size + confidence)
        ↓
(future, separate plan) recommendations with tracked outcomes
```

Every new formula gets a version string (`focus_v1`, `effort_v1`, …) in its output, exactly like
`weekly_plans.generated_by = 'rules_v1'` already does — so a formula can change later without
silently reinterpreting old data.

---

## 3. Ownership — unchanged from the existing split

This plan does **not** introduce new rules. It reuses `mtdo-web-dev-split-plan.md` §1 (ownership
table), §3 (contract-lock → design canvas → build), §4 (review/merge authority), §5 (model/token
discipline), §7 (the `web-task` board) exactly as written. New rows for this wave only:

| Surface | Owner |
|---|---|
| `review_daily_summary()`, `study_profile()` RPCs, any new migration, formula docs | **Mukund (Claude Code)** |
| Review page screens (`web/app/(app)/review/...`), ring/heatmap/chart components | **Janhwi (Codex)** |
| Review-page-specific tokens added to `DESIGN.md` (§6 below) | Mukund proposes, **user approves**, Janhwi consumes |

**Web-task board:** file this wave's items under the existing `mukund1312/mtdo-bugs` board with
`web-task` + `wave:review-study-profile`, same as Wave 1/Phase 6/7 items already are. Contract-lock
protocol is unchanged: Janhwi does not start a phase's screen until the corresponding backend PR is
merged and `api.md` is updated to match.

---

## 4. Backend phases (Mukund, Claude Code)

Each phase = one migration + doc update + tests, ends in a "contract locked" announcement, then
stops. Same discipline the existing weekly-engine work already used — do not start phase N+1 before
N is merged and documented.

### Phase A — `review_daily_summary()`: the three rings, at daily grain — **CONTRACT LOCKED, 2026-09-13**

`migrations/0025_review_daily_summary.sql`, `docs/architecture/api.md` §3j, `web/lib/review/types.ts`
(`ReviewDailySummary` + `asReviewDailySummary()`), `supabase/tests/17_review_daily_summary.sql` (25
assertions: the three rings over a normal day, the null-not-zero rule on a quiet day, no-active-plan,
default-date resolution, cross-user isolation). Full suite (`supabase/tests/run.sh`) passes,
131 assertions. **Janhwi can start F2 (Rings) against this contract now.**

- New `security definer stable` RPC, `review_daily_summary(p_date date, p_timezone text default
  null) returns jsonb`, deriving the caller from `auth.uid()` like every other RPC here.
- Reads `daily_rollups` (already the day-attributed, cron-computed source) plus `focus_sessions`
  for the same-day-not-yet-rolled-up gap, same precedent `weekly_performance()` set for the weekly
  case (§3f: read-computed against source tables so a review right after finishing work is never
  stale).
- **FOCUS**: focused minutes / a target. Target source needs a decision — likely
  `weekly_target_blocks` × average block length, or a simple constant until real per-user targets
  exist. Document whichever is chosen and version it (`focus_v1`).
- **EXECUTE**: today's slice of the same completion-rate logic `weekly_performance()` already uses,
  at day grain, weighted by category `score_weight` (reuse, don't reinvent, the weighting
  `weekly_performance()`'s `score` field already does).
- **PROGRESS**: the hardest one, and the brief is explicit it must not just be "tasks done again."
  V1 definition: today's contribution to the *current week's* `weekly_performance().plan.score`
  toward `score_max`, i.e. "how much of this week's goal did today's work satisfy" — reusing the
  existing weekly score rather than inventing a second, competing progress metric. A true
  route/milestone-level progress model is a stronges future version, named as such, not built now.
- Same `null`-vs-`0` discipline as §3f: no completed tasks today ≠ 0% executed, it's "nothing
  planned for today" and must be distinguishable.
- Tests: SQL/RPC tests mirroring `07_per_user_timezone.sql`'s style; cross-user isolation test
  (same mandatory pattern as every prior RPC).

**Contract locked when:** `api.md` gets a new §3j documenting the exact return shape, and
`web/lib/planning/types.ts` (or a new `review/types.ts`) exports the TS mirror + narrowing helper,
matching the `asWeeklyPerformance()` precedent.

### Phase B — Effort Score + Consistency heatmap data

- `effort_score(p_date date)` (or folded into a `review_consistency(p_start date, p_end date)`
  RPC returning one row per day) computing a 0–100 effort score from Phase A's three ring
  percentages plus schedule adherence, each weight documented and versioned (`effort_v1`) —
  **do not port the founder's example weights (40/30/20/10) uninspected**; compute them against
  a couple of weeks of this user's own `daily_rollups` history first and pick weights that don't
  let one dimension dominate, exactly as the founder's own brief (Phase 12) says to.
- Returns intensity levels (0–4) pre-bucketed server-side, not raw scores the frontend has to
  bucket itself — keeps the bucketing rule in one place, matching the "single canonical formula"
  rule.
- Replaces what mtdo-bugs #89's Progress heatmap currently colors by (raw minutes) — this is a
  **migration of an existing, shipped feature**, not a net-new one; flag it as such in the PR so
  review knows a live surface is changing, not just growing.

### Phase C — Time-of-day and session-length analytics

- `review_time_patterns(p_start date, p_end date)`: buckets `focus_sessions` by hour and by
  duration range, returns completion rate / focus efficiency per bucket **only when
  `sample_size >= 5`** (the brief's own minimum-sample rule), else `status: "insufficient_data"`.
- `review_momentum()`: a smoothed score across recent weeks (not a raw streak) — the brief is
  explicit this should degrade gracefully (91 → 88, never 145 → 0), and this project already has
  the philosophical precedent for "don't let one bad signal overreact" in `pace_ratio` using a
  ratio-of-sums instead of a mean.

### Phase D — Study Profile

- `study_profile()`: one RPC that composes A–C plus `weekly_performance()`'s existing category
  breakdown into the profile shape from the brief (§23 of the paste) — best study window, ideal
  session length, strongest/weakest/most-avoided subject, planning accuracy. **Every field carries
  `sample_size`, `window_days`, and a `confidence` tag** — this is the one rule from the brief that
  is completely non-optional; a UI stating "your ideal session is 45 minutes" off 3 sessions is a
  worse product than not saying it.
- No new raw data needed — this phase is pure composition of A/B/C's outputs plus
  `weekly_performance()`. If that turns out false during implementation (some field genuinely can't
  be derived from what exists), that's a stop-and-report moment, not a silent invention — same rule
  the founder's paste states directly ("mark it INSUFFICIENT DATA, don't fake it").

### Phase E — Insights (structured, not prose)

- `review_insights()`: deterministic structured findings (`{type, severity, evidence}` — e.g.
  `planning_overcommitment`, `subject_avoidance`) computed from Study Profile fields crossing
  documented thresholds (same pattern `web/lib/planning/thresholds.ts` + `classify.ts` already use
  for the weekly engine — reuse that module split, don't invent a second rules-engine shape).
- No AI, no prose generation, in this phase — matches `decisions.md` 2026-09-11's standing decision
  that the rules engine stays deterministic and `aiService.reviewWeek()` stays unbuilt until asked
  for explicitly.

### Phase F (optional, only if asked for later) — Interventions with measured outcomes

- Not started as part of this wave. Named here only so its absence is a decision, not an oversight:
  the founder's brief treats this as its own phase (§13/§19), and `weekly_plan_changes` already has
  the accept/reject mechanics this would extend — but "did behavior actually improve after" needs
  a following-week comparison this plan doesn't build yet. Revisit once Phases A–E have shipped and
  been used for a few weeks, same gate discipline as everything else in this project.

---

## 5. Frontend phases (Janhwi, Codex)

Each phase builds only against a backend phase that is already contract-locked (§4). Do not start
a phase's screens before its RPC is merged and `api.md` documents it — this is the existing
handoff rule, not new. Every component ships loading / empty / **insufficient_data** / error states
— `insufficient_data` is new relative to earlier waves and is not optional, since Phase D's whole
point is refusing to state a pattern with too little evidence.

| Frontend phase | Depends on | Builds |
|---|---|---|
| **F1 — Review page shell** | none (can start immediately) | `web/app/(app)/review/` route, header ("REVIEW" / range selector: Today / Week / Month / 6 Weeks / Year — wire the selector now, most ranges render a "coming soon" placeholder until later phases land), reuses Signal Deck nav/Listen bar untouched |
| **F2 — Rings** | Backend Phase A | Focus/Execute/Progress rings, hover detail panel, entrance animation (`prefers-reduced-motion` respected) |
| **F3 — Consistency heatmap (v2)** | Backend Phase B | Replaces #89's raw-minutes heatmap with effort-score coloring; hover shows the day's ring breakdown |
| **F4 — Time behavior + session quality** | Backend Phase C | "When you work best" chart, session-length distribution, momentum number — each showing the insufficient-data state below the sample threshold |
| **F5 — Study Profile panel** | Backend Phase D | The profile summary card, every stat displayed with its sample-size caption (e.g. "based on 18 sessions over 21 days") — never rendered without it |
| **F6 — Insights card** | Backend Phase E | Structured findings rendered as short factual sentences, per the North Star spec's insight-card styling (§ visual spec doc) |
| **F7 (optional, stretch)** | F3 | Effort Terrain as an alternate view toggle on the heatmap — explicitly secondary, heatmap stays the default, per the brief's own instruction |

**Design canvas step** (per the dev-split doc's §3 handoff protocol): draft F1–F3 together as one
canvas before Janhwi starts building, since the rings + heatmap are the page's visual anchor and
should be tuned once, not per-phase. F4–F6 can canvas separately once A–C are locked.

---

## 6. The one open design decision — resolved

The founder's reference mock assigns Focus/Execute/Progress each a distinct hue (pink, lime,
violet) plus cyan for behavioral/observed data. `DESIGN.md`'s Graphite system is deliberately
near-monochrome: one cyan structural accent, ember reserved *only* for "happening right now,"
plus success/warning/danger. Multi-color rings are a real deviation from the shipped design
system, which `CLAUDE.md` requires explicit approval for before building.

**Decision (user-approved, 2026-09-13): extend `DESIGN.md` with a small, Review-page-scoped
palette** rather than either flattening the rings into existing tokens or leaving color
undecided. Concretely, before Janhwi's F2:

1. Mukund proposes 3 new tokens (`--review-focus`, `--review-execute`, `--review-progress`) as a
   `DESIGN.md` addendum — colors close to the reference mock's pink/lime/violet, adjusted only as
   needed for AA contrast against Graphite's `#0B0B0C` background.
2. These tokens are scoped to the Review page's rings/heatmap/charts only — they do not bleed into
   buttons, nav, or any other screen's semantics. `--live` (ember) keeps its existing exclusive
   meaning ("something is happening right now") and is not reused for a ring.
3. The founder's fuller 27-section "North Star Visual Specification" (colors, ring construction,
   card treatment, semantic color rules, responsive behavior) is condensed into a companion doc,
   `docs/designs/review-visual-spec.md`, rather than pasted wholesale into `DESIGN.md` — it's
   scoped to one page, and `DESIGN.md` should stay the whole-product source of truth it already is.
4. Any color choice in that companion doc that visibly fights Graphite's restraint (e.g. treating
   every subject/category as its own permanent hue, §16 of the founder's paste) gets flagged for
   the user rather than built silently — same "flag conflicts, don't guess" rule the master
   prompt itself asked for.

---

## 7. Model guidance

Per the existing token-discipline rule (`mtdo-web-dev-split-plan.md` §5, already in force): Opus
only for the parts of this plan where a wrong call cascades — Phase A's Progress-ring definition,
Phase B's effort-score weighting, Phase D's confidence/sample-size rules. Sonnet for everything
mechanical (RPC plumbing once a formula is decided, tests, docs). Janhwi's Codex briefs stay
closed-form against locked contracts, same as every prior wave.

**This session (Sonnet 5, Claude Code) can execute the backend phases directly** — nothing here
needs a different model than what's already driving this project; escalate to Opus only per-phase,
same rule as always, not for the plan itself.

---

## Verification (do this before calling any phase done)

- Every new RPC has a cross-user isolation test (the same mandatory two-anon-session pattern used
  for every RPC in this project).
- Every rate/percentage field has documented `null`-vs-`0` behavior, checked against a fixture with
  zero activity.
- Every Study Profile field renders its sample size/confidence in the UI — spot check by finding
  one field in F5 with none and treating it as a bug, not a nit.
- The Progress-heatmap migration (Phase B / F3) is called out explicitly in review as "replaces a
  live Wave-1 surface," not merged as if it were purely additive.
