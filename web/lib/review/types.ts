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
  /** Real session_paused ledger events today (migrations/0032) -- "interruptions", not a session count. */
  pause_count: number;
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
  /** Real task_regressed ledger events today (migrations/0032) -- the closest tracked signal to "rescheduled"; this schema has no reschedule event at all. */
  regressed_count: number;
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
// (migrations/0027, schema mtdo.review_consistency.v1). Same narrowing
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

// ---------------------------------------------------------------------------
// review_time_patterns() -- when you work best, and what session length
// works (migrations/0028, schema mtdo.review_time_patterns.v1).
//
// SCOPE: session_completion_rate is a SESSION outcome (completed vs
// abandoned), never a task/Execute rate -- do not read it alongside
// ExecuteRing.percentage as if they were the same number (api.md sec3l).
//
// best_hour/best_weekday/best_duration_bucket are null unless a bucket has
// at least min_sample_size sessions. Never infer a "best" from fewer.

export interface TimeBucket {
  session_count: number;
  completed_session_count: number;
  session_completion_rate: number | null;
  avg_focus_minutes: number | null;
  total_focus_minutes?: number;
}

export interface HourBucket extends TimeBucket {
  hour: number; // 0-23
  total_focus_minutes: number;
}

/** isodow: 1 = Monday .. 7 = Sunday, same vocabulary iso_week_start() uses. */
export interface WeekdayBucket extends TimeBucket {
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  total_focus_minutes: number;
}

export type DurationBucketLabel = "<15m" | "15-30m" | "30-45m" | "45-60m" | "60-90m" | "90m+";

export interface DurationBucket {
  bucket: DurationBucketLabel;
  session_count: number;
  completed_session_count: number;
  session_completion_rate: number | null;
  avg_focus_minutes: number | null;
}

export interface BestHour {
  hour: number;
  sample_size: number;
  session_completion_rate: number | null;
}

export interface BestWeekday {
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  sample_size: number;
  session_completion_rate: number | null;
}

export interface BestDurationBucket {
  bucket: DurationBucketLabel;
  sample_size: number;
  session_completion_rate: number | null;
}

export interface ReviewTimePatterns {
  schema_version: "mtdo.review_time_patterns.v1";
  from: string;
  to: string;
  timezone: string;
  computed_at: string;
  min_sample_size: number;
  hourly: HourBucket[];
  weekday: WeekdayBucket[];
  duration_buckets: DurationBucket[];
  /** null unless some hour has >= min_sample_size sessions. */
  best_hour: BestHour | null;
  best_weekday: BestWeekday | null;
  best_duration_bucket: BestDurationBucket | null;
}

export const REVIEW_TIME_PATTERNS_SCHEMA = "mtdo.review_time_patterns.v1";

export class ReviewTimePatternsError extends Error {}

export function asReviewTimePatterns(value: unknown): ReviewTimePatterns {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewTimePatternsError("review_time_patterns() returned no object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== REVIEW_TIME_PATTERNS_SCHEMA) {
    throw new ReviewTimePatternsError(
      `Unexpected review_time_patterns schema ${String(obj.schema_version)}; expected ${REVIEW_TIME_PATTERNS_SCHEMA}.`,
    );
  }
  if (!Array.isArray(obj.hourly) || !Array.isArray(obj.weekday) || !Array.isArray(obj.duration_buckets)) {
    throw new ReviewTimePatternsError("review_time_patterns() returned a malformed body.");
  }
  return value as unknown as ReviewTimePatterns;
}

// ---------------------------------------------------------------------------
// review_momentum() -- a SMOOTHED score across recent weeks, not a raw
// streak (migrations/0029, schema mtdo.review_momentum.v1). Pure composition
// over review_consistency() -- see that RPC's own doc comment above.

export interface ReviewMomentumOk {
  schema_version: "mtdo.review_momentum.v1";
  from: string;
  to: string;
  window_days: number;
  timezone: string;
  computed_at: string;
  status: "ok";
  metric_version: "momentum_v1";
  momentum_score: number;
  /** Only real if the active-day run reaches all the way to today; otherwise 0. */
  current_streak: number;
  longest_streak: number;
  active_days_rate: number;
}

export interface ReviewMomentumNoPlan {
  schema_version: "mtdo.review_momentum.v1";
  from: string;
  to: string;
  window_days: number;
  timezone: string;
  computed_at: string;
  status: "no_active_plan";
  metric_version: "momentum_v1";
  momentum_score: null;
  current_streak: null;
  longest_streak: null;
  active_days_rate: null;
}

export type ReviewMomentum = ReviewMomentumOk | ReviewMomentumNoPlan;

export const REVIEW_MOMENTUM_SCHEMA = "mtdo.review_momentum.v1";

export class ReviewMomentumError extends Error {}

export function asReviewMomentum(value: unknown): ReviewMomentum {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewMomentumError("review_momentum() returned no object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== REVIEW_MOMENTUM_SCHEMA) {
    throw new ReviewMomentumError(
      `Unexpected review_momentum schema ${String(obj.schema_version)}; expected ${REVIEW_MOMENTUM_SCHEMA}.`,
    );
  }
  if (obj.status !== "ok" && obj.status !== "no_active_plan") {
    throw new ReviewMomentumError(`Unexpected review_momentum status ${String(obj.status)}.`);
  }
  return value as unknown as ReviewMomentum;
}

// ---------------------------------------------------------------------------
// study_profile() -- the composed learner profile (migrations/0031, schema
// mtdo.study_profile.v1). PURE COMPOSITION over review_consistency()/
// review_time_patterns()/review_momentum()/weekly_performance() -- no field
// here is a second implementation of a formula those already define.
//
// Every aggregate this function actually computes (focus/execution/planning/
// the three subject fields) carries confidence: "insufficient_data" | "low" |
// "medium" | "high", from the shared study_profile_confidence() gate. A field
// below its own minimum sample is null with confidence "insufficient_data" --
// never a value inferred from too little evidence. best_study_window/
// best_weekday/ideal_session_length are BestHour/BestWeekday/
// BestDurationBucket pass-throughs from ReviewTimePatterns (already gated by
// review_time_patterns()'s own min_sample_size).

export interface StudyProfileAggregate {
  metric_version: "study_profile_v1";
  avg_percentage: number | null;
  sample_size: number;
  window_days: number;
  confidence: "insufficient_data" | "low" | "medium" | "high";
}

export interface StudyProfilePlanning {
  metric_version: "study_profile_v1";
  avg_completion_rate: number | null;
  /** Independent of avg_completion_rate's gate -- a plan can clear one and not the other. */
  avg_pace_ratio: number | null;
  weeks_sampled: number;
  confidence: "insufficient_data" | "low" | "medium" | "high";
}

export interface StudyProfileConsistency {
  metric_version: "momentum_v1";
  active_days_rate: number;
  momentum_score: number;
  current_streak: number;
  longest_streak: number;
  window_days: number;
}

export interface StudyProfileSubject {
  category_id: string;
  name: string;
  label: string;
  completion_rate: number;
  sample_size: number;
  confidence: "insufficient_data" | "low" | "medium" | "high";
}

export interface StudyProfileAvoidedSubject {
  category_id: string;
  name: string;
  label: string;
  /** Always > 0 -- most_avoided_subject is null rather than surfacing a category with a real rate of 0. */
  postponement_rate: number;
  sample_size: number;
  confidence: "insufficient_data" | "low" | "medium" | "high";
}

export interface StudyProfileOk {
  schema_version: "mtdo.study_profile.v1";
  computed_at: string;
  from: string;
  to: string;
  window_days: number;
  timezone: string;
  plan_id: string;
  status: "ok";
  focus: StudyProfileAggregate;
  execution: StudyProfileAggregate;
  consistency: StudyProfileConsistency;
  planning: StudyProfilePlanning;
  best_study_window: BestHour | null;
  best_weekday: BestWeekday | null;
  ideal_session_length: BestDurationBucket | null;
  strongest_subject: StudyProfileSubject | null;
  weakest_subject: StudyProfileSubject | null;
  most_avoided_subject: StudyProfileAvoidedSubject | null;
}

export interface StudyProfileNoPlan {
  schema_version: "mtdo.study_profile.v1";
  computed_at: string;
  from: string;
  to: string;
  window_days: number;
  timezone: string;
  status: "no_active_plan";
  focus: null;
  execution: null;
  consistency: null;
  planning: null;
  best_study_window: null;
  best_weekday: null;
  ideal_session_length: null;
  strongest_subject: null;
  weakest_subject: null;
  most_avoided_subject: null;
}

export type StudyProfile = StudyProfileOk | StudyProfileNoPlan;

export const STUDY_PROFILE_SCHEMA = "mtdo.study_profile.v1";

export class StudyProfileError extends Error {}

export function asStudyProfile(value: unknown): StudyProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StudyProfileError("study_profile() returned no object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== STUDY_PROFILE_SCHEMA) {
    throw new StudyProfileError(
      `Unexpected study_profile schema ${String(obj.schema_version)}; expected ${STUDY_PROFILE_SCHEMA}.`,
    );
  }
  if (obj.status !== "ok" && obj.status !== "no_active_plan") {
    throw new StudyProfileError(`Unexpected study_profile status ${String(obj.status)}.`);
  }
  return value as unknown as StudyProfile;
}
