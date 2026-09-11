// Test fixtures for the weekly engine. Not imported by any production code.
//
// The defaults describe a healthy, unremarkable week, so each test sets only
// the one or two fields it is actually about -- which is what makes a
// boundary test readable as "completion is exactly 0.5" rather than as a
// thirty-field object literal.

import type { CategoryPerformance, PlanPerformance, WeeklyPerformance } from "./types";

export function category(overrides: Partial<CategoryPerformance> = {}): CategoryPerformance {
  return {
    category_id: "cat-1",
    name: "dsa",
    label: "DSA",
    sort_order: 0,
    min_blocks: 1,
    score_weight: 40,
    days_per_week: 4,
    weekly_target_blocks: null,
    current_target: 4,
    category_created_at: "2026-01-01T00:00:00+00:00",
    existed_before_week: true,
    picked_count: 4,
    done_count: 3,
    completion_rate: 0.75,
    estimated_minutes: 120,
    actual_minutes: 120,
    paced_actual_minutes: 120,
    paced_task_count: 3,
    pace_ratio: 1.0,
    pace_ratio_mean: 1.0,
    menu_offered_count: 6,
    menu_picked_count: 4,
    skipped_count: 2,
    pick_rate: 0.6667,
    regressed_count: 0,
    stale_open_count: 0,
    postponement_count: 0,
    backlog_count: 1,
    sessions_completed: 3,
    study_days: 3,
    ...overrides,
  };
}

export function plan(overrides: Partial<PlanPerformance> = {}): PlanPerformance {
  return {
    picked_count: 10,
    done_count: 7,
    completion_rate: 0.7,
    estimated_minutes: 300,
    actual_minutes: 300,
    paced_actual_minutes: 300,
    paced_task_count: 7,
    pace_ratio: 1.0,
    menu_offered_count: 15,
    menu_picked_count: 10,
    pick_rate: 0.6667,
    regressed_count: 0,
    stale_open_count: 0,
    postponement_count: 0,
    backlog_count: 3,
    sessions_completed: 7,
    study_days: 4,
    score: 70,
    score_max: 100,
    ...overrides,
  };
}

export function week(
  isoWeek: string,
  categories: CategoryPerformance[],
  planOverrides: Partial<PlanPerformance> = {},
): WeeklyPerformance {
  return {
    schema_version: "mtdo.weekly_performance.v1",
    plan_id: "plan-1",
    iso_week: isoWeek,
    week_start: "2026-08-31",
    week_end: "2026-09-06",
    timezone: "UTC",
    planning_mode: "dynamic_weekly",
    computed_at: "2026-09-07T00:00:00+00:00",
    plan: plan(planOverrides),
    categories,
  };
}
