// Types for the deterministic weekly engine (Phase 7).
//
// These mirror `weekly_performance()`'s jsonb output byte for byte
// (migrations/0021, schema `mtdo.weekly_performance.v1`). The RPC is typed
// `Json` by the Supabase generator because its return type is jsonb, so this
// file plus `asWeeklyPerformance()` below is the narrowing layer every caller
// -- including the Review deck's frontend -- should go through instead of
// casting.
//
// THE ONE RULE THAT MATTERS WHEN READING THESE. Every rate field is
// `number | null`, and null means UNCOMPUTABLE, never zero:
//   completion_rate  null <=> nothing was picked in this category that week
//   pace_ratio       null <=> no completed task had both an estimate and a
//                             real focus session
//   pick_rate        null <=> the menu offered nothing
// "Picked nothing" and "picked everything and finished none of it" are
// different facts about a person. Coalescing a null to 0 collapses them and
// makes the engine propose cutting the load of a category the user simply
// never opened. Do not `?? 0` these.

export type ChangeSignal = "struggling" | "coasting" | "avoided";

/** What the classifier can conclude about one category over the trailing two weeks. */
export type Classification = ChangeSignal | "on_track" | "insufficient_data";

export interface CategoryPerformance {
  category_id: string;
  name: string;
  label: string;
  sort_order: number;
  min_blocks: number;
  score_weight: number;
  /** `array_length(plan_categories.days, 1)` -- a COUNT of day-lists per week, not weekdays (api.md §3b). */
  days_per_week: number;
  /** The raw column. null = the user has never set an explicit target. */
  weekly_target_blocks: number | null;
  /** Resolved pace: `weekly_target_blocks ?? days_per_week`, floored at 1. The baseline every proposal moves. */
  current_target: number;
  category_created_at: string;
  /** False when the category was created during (or after) the week under review -- a partial week is not evidence. */
  existed_before_week: boolean;

  picked_count: number;
  done_count: number;
  completion_rate: number | null;

  estimated_minutes: number;
  actual_minutes: number;
  /** Actual minutes over only the tasks that count toward pace (see paced_task_count). */
  paced_actual_minutes: number;
  /** Done tasks that had BOTH a non-null estimate and at least one settled focus session. */
  paced_task_count: number;
  /** Ratio of sums: paced_actual_minutes / estimated_minutes. The classifier reads this one. */
  pace_ratio: number | null;
  /** Mean of per-task ratios. Reported for display; deliberately NOT what the classifier reads. */
  pace_ratio_mean: number | null;

  menu_offered_count: number;
  menu_picked_count: number;
  skipped_count: number;
  pick_rate: number | null;

  regressed_count: number;
  stale_open_count: number;
  postponement_count: number;
  backlog_count: number;
  sessions_completed: number;
  study_days: number;
}

export interface PlanPerformance {
  picked_count: number;
  done_count: number;
  completion_rate: number | null;
  estimated_minutes: number;
  actual_minutes: number;
  paced_actual_minutes: number;
  paced_task_count: number;
  pace_ratio: number | null;
  menu_offered_count: number;
  menu_picked_count: number;
  pick_rate: number | null;
  regressed_count: number;
  stale_open_count: number;
  postponement_count: number;
  backlog_count: number;
  sessions_completed: number;
  study_days: number;
  /** Port of core.py's compute_daily_score() at week granularity. */
  score: number;
  /** Sum of score_weight over categories that were actually picked from. */
  score_max: number;
}

export interface WeeklyPerformance {
  schema_version: string;
  plan_id: string;
  iso_week: string;
  week_start: string;
  week_end: string;
  timezone: string;
  planning_mode: string;
  computed_at: string;
  plan: PlanPerformance;
  categories: CategoryPerformance[];
}

export const WEEKLY_PERFORMANCE_SCHEMA = "mtdo.weekly_performance.v1";

/** What the rules engine proposes. Maps 1:1 onto a `weekly_plan_changes` row. */
export interface ProposedChange {
  change_type: "weekly_target_blocks" | "flag_question";
  target_category_id: string;
  /** null for a flag_question, which carries no numbers by constraint. */
  old_value: number | null;
  new_value: number | null;
  /** Plain, specific, built from real computed numbers. Never model-generated. */
  reason: string;
  signal: ChangeSignal;
}

export interface CategoryOutcome {
  category_id: string;
  label: string;
  classification: Classification;
  /** Set when an increase was withheld because the plan had a low-completion week. */
  suppressed?: "low_completion_week" | "capped_to_no_change";
}

export interface WeeklyProposal {
  changes: ProposedChange[];
  outcomes: CategoryOutcome[];
  /** True when the plan's own completion that week was under the floor, so no increase was allowed anywhere. */
  increasesSuppressed: boolean;
}

export class WeeklyPerformanceError extends Error {}

/**
 * Narrow the RPC's `Json` return into a `WeeklyPerformance`.
 *
 * Deliberately shallow: this guards against the shapes that actually occur --
 * a null from a failed call, an error object, or a future schema version --
 * rather than re-validating every numeric field the database just computed
 * under constraints. `parse.ts`'s exhaustive validation exists because that
 * data comes from a language model; this data comes from our own SQL.
 */
export function asWeeklyPerformance(value: unknown): WeeklyPerformance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WeeklyPerformanceError("weekly_performance() returned no object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== WEEKLY_PERFORMANCE_SCHEMA) {
    throw new WeeklyPerformanceError(
      `Unexpected weekly_performance schema ${String(obj.schema_version)}; expected ${WEEKLY_PERFORMANCE_SCHEMA}.`,
    );
  }
  if (!Array.isArray(obj.categories) || !obj.plan || typeof obj.plan !== "object") {
    throw new WeeklyPerformanceError("weekly_performance() returned a malformed body.");
  }
  return value as unknown as WeeklyPerformance;
}
