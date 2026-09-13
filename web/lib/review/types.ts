// Types for the Review page's daily rings (Phase A of
// docs/designs/mtdo-web-review-study-profile-plan.md).
//
// Mirrors `review_daily_summary()`'s jsonb output byte for byte
// (migrations/0025, schema `mtdo.review_daily_summary.v1`). Same precedent as
// `web/lib/planning/types.ts`'s `WeeklyPerformance`/`asWeeklyPerformance()`:
// the RPC is typed `Json` by the Supabase generator, so this file is the one
// narrowing layer every caller -- including the Review page's frontend --
// goes through instead of casting.
//
// THE ONE RULE THAT MATTERS WHEN READING THESE, same as weekly_performance():
// every `percentage` and `target_minutes` field is `number | null`, and null
// means "no basis to compute this," never zero:
//   focus.target_minutes    null <=> none of today's picked blocks carry an
//                                    estimate (V1 deliberately does not
//                                    invent a daily focus-minutes target --
//                                    see migrations/0025's header)
//   focus.percentage        null <=> same reason -- nothing to divide by
//   execute.percentage      null <=> nothing was picked today at all
//   progress.percentage     null <=> the current week's score_max is 0 (no
//                                    category was picked from this week)
// Do not `?? 0` any of these -- "nothing planned" and "planned and failed"
// are different facts and collapsing them makes the ring lie.

export interface FocusRing {
  metric_version: "focus_v1";
  focus_minutes: number;
  /** Sum of estimated_minutes over today's picked blocks that have one set. Null = no basis, not zero. */
  target_minutes: number | null;
  percentage: number | null;
  session_count: number;
  completed_sessions: number;
  longest_session_minutes: number;
}

export interface ExecuteRing {
  metric_version: "execute_v1";
  tasks_done: number;
  tasks_picked: number;
  /** Raw done/picked ratio. Can differ from score/score_max when today's categories carry unequal score_weight -- by design. */
  percentage: number | null;
  /** Sum of picked blocks' category score_weight, weighted by done-ness. */
  score: number;
  score_max: number;
}

export interface ProgressRing {
  metric_version: "progress_v1";
  /** Equal to weekly_performance(plan_id, iso_week).plan.score for the week containing this date -- not a second formula. */
  week_score: number;
  week_score_max: number;
  percentage: number | null;
}

export interface ReviewDailySummaryOk {
  schema_version: "mtdo.review_daily_summary.v1";
  date: string;
  timezone: string;
  plan_id: string;
  iso_week: string;
  computed_at: string;
  status: "ok";
  focus: FocusRing;
  execute: ExecuteRing;
  progress: ProgressRing;
}

export interface ReviewDailySummaryNoPlan {
  schema_version: "mtdo.review_daily_summary.v1";
  date: string;
  timezone: string;
  computed_at: string;
  status: "no_active_plan";
  focus: null;
  execute: null;
  progress: null;
}

/** The full union. Always check `status` before reading `focus`/`execute`/`progress`. */
export type ReviewDailySummary = ReviewDailySummaryOk | ReviewDailySummaryNoPlan;

export const REVIEW_DAILY_SUMMARY_SCHEMA = "mtdo.review_daily_summary.v1";

export class ReviewDailySummaryError extends Error {}

/**
 * Narrow the RPC's `Json` return into a `ReviewDailySummary`.
 *
 * Deliberately shallow, same reasoning as `asWeeklyPerformance()`: this
 * guards against the shapes that actually occur (null, an error object, a
 * future schema version) rather than re-validating every field the database
 * just computed under constraints.
 */
export function asReviewDailySummary(value: unknown): ReviewDailySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewDailySummaryError("review_daily_summary() returned no object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== REVIEW_DAILY_SUMMARY_SCHEMA) {
    throw new ReviewDailySummaryError(
      `Unexpected review_daily_summary schema ${String(obj.schema_version)}; expected ${REVIEW_DAILY_SUMMARY_SCHEMA}.`,
    );
  }
  if (obj.status !== "ok" && obj.status !== "no_active_plan") {
    throw new ReviewDailySummaryError(`Unexpected review_daily_summary status ${String(obj.status)}.`);
  }
  if (obj.status === "ok" && (!obj.focus || !obj.execute || !obj.progress)) {
    throw new ReviewDailySummaryError("review_daily_summary() reported status ok but a ring is missing.");
  }
  return value as unknown as ReviewDailySummary;
}

// ---------------------------------------------------------------------------
// review_consistency() -- the Effort Score behind the Consistency heatmap
// (migrations/0026, schema mtdo.review_consistency.v1). Same narrowing
// precedent as above.
//
// THE ONE RULE THAT MATTERS: `effort_score`/`level` are `null` ONLY when the
// user has no active plan at all ("no goal to measure this day against").
// Whenever an active plan exists, a day with nothing computable is a REAL
// `0` -- the heatmap's emptiest real level, not a missing-data state. Do not
// render `0` and `null` the same way.

export interface ConsistencyDay {
  date: string;
  focus_percentage: number | null;
  execute_percentage: number | null;
  /** Plan-scoped by necessity -- null for any ISO week the CURRENT active plan has no block in, even if a since-retired plan was active that week. See api.md sec3k. */
  progress_percentage: number | null;
  /** null only when the caller has no active plan at all. A real 0 otherwise. */
  effort_score: number | null;
  /** least(4, floor(effort_score / 20)) -- 0-4. Same null rule as effort_score. */
  level: 0 | 1 | 2 | 3 | 4 | null;
}

export interface ReviewConsistency {
  schema_version: "mtdo.review_consistency.v1";
  from: string;
  to: string;
  timezone: string;
  /** The caller's current active plan, or null if they have none -- not necessarily the plan that was active on every day below. */
  plan_id: string | null;
  computed_at: string;
  metric_version: "effort_v1";
  days: ConsistencyDay[];
}

export const REVIEW_CONSISTENCY_SCHEMA = "mtdo.review_consistency.v1";

export class ReviewConsistencyError extends Error {}

export function asReviewConsistency(value: unknown): ReviewConsistency {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewConsistencyError("review_consistency() returned no object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== REVIEW_CONSISTENCY_SCHEMA) {
    throw new ReviewConsistencyError(
      `Unexpected review_consistency schema ${String(obj.schema_version)}; expected ${REVIEW_CONSISTENCY_SCHEMA}.`,
    );
  }
  if (!Array.isArray(obj.days)) {
    throw new ReviewConsistencyError("review_consistency() returned a malformed body -- days is not an array.");
  }
  return value as unknown as ReviewConsistency;
}
