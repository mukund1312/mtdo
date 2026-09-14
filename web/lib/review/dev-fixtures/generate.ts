// Deterministic fixture data for the four AnalyticsMaturity tiers. Dev-only
// (see index.ts's NODE_ENV guard) -- exists purely so ?reviewState=empty|
// early|building|mature can be compared instantly instead of onboarding a
// fresh account and manually running real focus sessions each time (see the
// Review page audit's item 46/47).
//
// Every number here is either directly lifted from the reference mock's own
// example values (mature tier) or chosen to be internally consistent with
// this app's real null-vs-zero rules (empty/early/building tiers) -- never
// used outside a dev build, never seen by a real user.

import type { ConsistencyDay } from "@/lib/review/types";
import type { CategoryPerformance } from "@/lib/planning/types";
import type { ReviewFixtureBundle } from "./types";

const TODAY = "2026-09-14";
const PLAN_ID = "fixture-plan";
const TIMEZONE = "UTC";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateRange(days: number, end: string): string[] {
  const out: string[] = [];
  const endDate = new Date(`${end}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** activeDays real activity days, most-recent-first count, scattered across the window. */
function buildConsistencyDays(windowDays: number, activeDays: number, seed: number): ConsistencyDay[] {
  const dates = dateRange(windowDays, TODAY);
  const rand = mulberry32(seed);
  const activeSet = new Set<number>();
  // Bias toward the recent end of the window so "current streak" reads
  // sensibly for early/building tiers.
  while (activeSet.size < Math.min(activeDays, dates.length)) {
    const recentBias = rand() < 0.6 ? dates.length - 1 - Math.floor(rand() * Math.min(14, dates.length)) : Math.floor(rand() * dates.length);
    activeSet.add(Math.max(0, recentBias));
  }
  return dates.map((date, i) => {
    if (!activeSet.has(i)) {
      return { date, focus_percentage: null, execute_percentage: null, progress_percentage: null, effort_score: 0, level: 0 as const };
    }
    const effort = Math.round(20 + rand() * 75);
    return {
      date,
      focus_percentage: Math.round(30 + rand() * 65),
      execute_percentage: Math.round(30 + rand() * 65),
      progress_percentage: Math.round(20 + rand() * 60),
      effort_score: effort,
      level: Math.min(4, Math.floor(effort / 20)) as 0 | 1 | 2 | 3 | 4,
    };
  });
}

function categoryFixture(overrides: Partial<CategoryPerformance>): CategoryPerformance {
  return {
    category_id: "cat-fixture",
    name: "backend",
    label: "Backend",
    sort_order: 0,
    min_blocks: 1,
    score_weight: 1,
    days_per_week: 5,
    weekly_target_blocks: null,
    current_target: 5,
    category_created_at: "2026-01-01T00:00:00Z",
    existed_before_week: true,
    picked_count: 0,
    done_count: 0,
    completion_rate: null,
    estimated_minutes: 0,
    actual_minutes: 0,
    paced_actual_minutes: 0,
    paced_task_count: 0,
    pace_ratio: null,
    pace_ratio_mean: null,
    menu_offered_count: 0,
    menu_picked_count: 0,
    skipped_count: 0,
    pick_rate: null,
    regressed_count: 0,
    stale_open_count: 0,
    postponement_count: 0,
    backlog_count: 0,
    sessions_completed: 0,
    study_days: 0,
    ...overrides,
  };
}

function emptyFixture(): ReviewFixtureBundle {
  return {
    dailySummary: {
      schema_version: "mtdo.review_daily_summary.v1",
      date: TODAY,
      timezone: TIMEZONE,
      plan_id: PLAN_ID,
      iso_week: "2026-W38",
      computed_at: `${TODAY}T12:00:00Z`,
      status: "ok",
      focus: { metric_version: "focus_v1", focus_minutes: 0, target_minutes: 120, percentage: 0, session_count: 0, completed_sessions: 0, longest_session_minutes: 0, pause_count: 0 },
      execute: { metric_version: "execute_v1", tasks_done: 0, tasks_picked: 0, percentage: null, score: 0, score_max: 0, regressed_count: 0 },
      progress: { metric_version: "progress_v1", week_score: 0, week_score_max: 0, percentage: null },
    },
    momentum: {
      schema_version: "mtdo.review_momentum.v1", from: dateRange(42, TODAY)[0]!, to: TODAY, window_days: 42, timezone: TIMEZONE,
      computed_at: `${TODAY}T12:00:00Z`, status: "ok", metric_version: "momentum_v1",
      momentum_score: 0, current_streak: 0, longest_streak: 0, active_days_rate: 0,
    },
    timePatterns: {
      schema_version: "mtdo.review_time_patterns.v1", from: dateRange(42, TODAY)[0]!, to: TODAY, timezone: TIMEZONE,
      computed_at: `${TODAY}T12:00:00Z`, min_sample_size: 5,
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, session_count: 0, completed_session_count: 0, session_completion_rate: null, avg_focus_minutes: null, total_focus_minutes: 0 })),
      weekday: [], duration_buckets: (["<15m", "15-30m", "30-45m", "45-60m", "60-90m", "90m+"] as const).map((bucket) => ({ bucket, session_count: 0, completed_session_count: 0, session_completion_rate: null, avg_focus_minutes: null })),
      best_hour: null, best_weekday: null, best_duration_bucket: null,
    },
    consistency: {
      schema_version: "mtdo.review_consistency.v1", from: dateRange(365, TODAY)[0]!, to: TODAY, timezone: TIMEZONE,
      plan_id: PLAN_ID, computed_at: `${TODAY}T12:00:00Z`, metric_version: "effort_v1",
      days: buildConsistencyDays(365, 0, 1),
    },
    weekly: {
      schema_version: "mtdo.weekly_performance.v1", plan_id: PLAN_ID, iso_week: "2026-W38", week_start: "2026-09-07", week_end: "2026-09-13", timezone: TIMEZONE, planning_mode: "guided", computed_at: `${TODAY}T12:00:00Z`,
      plan: { picked_count: 0, done_count: 0, completion_rate: null, estimated_minutes: 0, actual_minutes: 0, paced_actual_minutes: 0, paced_task_count: 0, pace_ratio: null, menu_offered_count: 0, menu_picked_count: 0, pick_rate: null, regressed_count: 0, stale_open_count: 0, postponement_count: 0, backlog_count: 0, sessions_completed: 0, study_days: 0, score: 0, score_max: 0 },
      categories: [
        categoryFixture({ category_id: "cat-backend", name: "backend", label: "Backend", current_target: 5 }),
        categoryFixture({ category_id: "cat-dsa", name: "dsa", label: "DSA", current_target: 5 }),
        categoryFixture({ category_id: "cat-sql", name: "sql", label: "SQL", current_target: 3 }),
        categoryFixture({ category_id: "cat-sysdesign", name: "system_design", label: "System Design", current_target: 2 }),
      ],
    },
    studyProfile: {
      schema_version: "mtdo.study_profile.v1", computed_at: `${TODAY}T12:00:00Z`, from: dateRange(42, TODAY)[0]!, to: TODAY, window_days: 42, timezone: TIMEZONE, plan_id: PLAN_ID, status: "ok",
      focus: { metric_version: "study_profile_v1", avg_percentage: null, sample_size: 0, window_days: 42, confidence: "insufficient_data" },
      execution: { metric_version: "study_profile_v1", avg_percentage: null, sample_size: 0, window_days: 42, confidence: "insufficient_data" },
      consistency: { metric_version: "momentum_v1", active_days_rate: 0, momentum_score: 0, current_streak: 0, longest_streak: 0, window_days: 42 },
      planning: { metric_version: "study_profile_v1", avg_completion_rate: null, avg_pace_ratio: null, weeks_sampled: 0, confidence: "insufficient_data" },
      best_study_window: null, best_weekday: null, ideal_session_length: null,
      strongest_subject: null, weakest_subject: null, most_avoided_subject: null,
    },
  };
}

function earlyFixture(): ReviewFixtureBundle {
  const base = emptyFixture();
  return {
    ...base,
    dailySummary: {
      ...base.dailySummary, status: "ok",
      focus: { metric_version: "focus_v1", focus_minutes: 38, target_minutes: 120, percentage: 32, session_count: 1, completed_sessions: 1, longest_session_minutes: 38, pause_count: 0 },
      execute: { metric_version: "execute_v1", tasks_done: 1, tasks_picked: 2, percentage: 50, score: 12, score_max: 24, regressed_count: 0 },
      progress: { metric_version: "progress_v1", week_score: 12, week_score_max: 100, percentage: 12 },
    } as typeof base.dailySummary,
    momentum: { ...base.momentum, momentum_score: 8, current_streak: 1, longest_streak: 1, active_days_rate: 1 / 42 } as typeof base.momentum,
    timePatterns: {
      ...base.timePatterns,
      hourly: base.timePatterns.hourly.map((h) => (h.hour === 9 ? { ...h, session_count: 1, completed_session_count: 1, session_completion_rate: 1, avg_focus_minutes: 38, total_focus_minutes: 38 } : h)),
      duration_buckets: base.timePatterns.duration_buckets.map((b) => (b.bucket === "30-45m" ? { ...b, session_count: 1, completed_session_count: 1, session_completion_rate: 1, avg_focus_minutes: 38 } : b)),
    },
    consistency: { ...base.consistency, days: buildConsistencyDays(365, 1, 2) },
    weekly: {
      ...base.weekly,
      plan: { ...base.weekly.plan, picked_count: 2, done_count: 1, completion_rate: 0.5, estimated_minutes: 45, actual_minutes: 38, paced_actual_minutes: 38, paced_task_count: 1, pace_ratio: 0.84, menu_offered_count: 4, menu_picked_count: 2, pick_rate: 0.5, sessions_completed: 1, study_days: 1, score: 12, score_max: 24 },
      categories: base.weekly.categories.map((c, i) => (i === 0 ? { ...c, picked_count: 2, done_count: 1, completion_rate: 0.5, estimated_minutes: 45, actual_minutes: 38, sessions_completed: 1, study_days: 1 } : c)),
    },
    studyProfile: {
      ...base.studyProfile,
      // Every gated field stays insufficient_data -- 1 session is real
      // evidence of nothing yet -- but consistency isn't confidence-gated
      // (it's a raw rate, always shown), so it still needs to match
      // momentum's real active_days_rate rather than staying frozen at 0.
      consistency: { metric_version: "momentum_v1", active_days_rate: 1 / 42, momentum_score: 8, current_streak: 1, longest_streak: 1, window_days: 42 },
    } as typeof base.studyProfile,
  };
}

function buildingFixture(): ReviewFixtureBundle {
  const rand = mulberry32(3);
  const activeDays = 9;
  const days = buildConsistencyDays(365, activeDays, 3);
  const sessionsTotal = 12;
  return {
    dailySummary: {
      schema_version: "mtdo.review_daily_summary.v1", date: TODAY, timezone: TIMEZONE, plan_id: PLAN_ID, iso_week: "2026-W38", computed_at: `${TODAY}T12:00:00Z`, status: "ok",
      focus: { metric_version: "focus_v1", focus_minutes: 41, target_minutes: 90, percentage: 46, session_count: 1, completed_sessions: 1, longest_session_minutes: 41, pause_count: 1 },
      execute: { metric_version: "execute_v1", tasks_done: 2, tasks_picked: 3, percentage: 67, score: 18, score_max: 27, regressed_count: 0 },
      progress: { metric_version: "progress_v1", week_score: 34, week_score_max: 100, percentage: 34 },
    },
    momentum: {
      schema_version: "mtdo.review_momentum.v1", from: dateRange(42, TODAY)[0]!, to: TODAY, window_days: 42, timezone: TIMEZONE, computed_at: `${TODAY}T12:00:00Z`, status: "ok", metric_version: "momentum_v1",
      momentum_score: 29, current_streak: 2, longest_streak: 3, active_days_rate: activeDays / 42,
    },
    timePatterns: {
      schema_version: "mtdo.review_time_patterns.v1", from: dateRange(42, TODAY)[0]!, to: TODAY, timezone: TIMEZONE, computed_at: `${TODAY}T12:00:00Z`, min_sample_size: 5,
      hourly: Array.from({ length: 24 }, (_, hour) => {
        const count = hour >= 8 && hour <= 10 ? Math.round(rand() * 3) : Math.round(rand() * 0.8);
        return { hour, session_count: count, completed_session_count: Math.round(count * 0.7), session_completion_rate: count > 0 ? 0.7 : null, avg_focus_minutes: count > 0 ? 30 + rand() * 15 : null, total_focus_minutes: Math.round(count * 32) };
      }),
      weekday: [],
      duration_buckets: (["<15m", "15-30m", "30-45m", "45-60m", "60-90m", "90m+"] as const).map((bucket, i) => {
        const count = i === 2 ? 6 : Math.round(rand() * 3);
        return { bucket, session_count: count, completed_session_count: Math.round(count * 0.75), session_completion_rate: count > 0 ? 0.75 : null, avg_focus_minutes: count > 0 ? 25 + i * 10 : null };
      }),
      best_hour: { hour: 9, sample_size: 6, session_completion_rate: 0.8 },
      best_weekday: null,
      best_duration_bucket: { bucket: "30-45m", sample_size: 6, session_completion_rate: 0.8 },
    },
    consistency: {
      schema_version: "mtdo.review_consistency.v1", from: dateRange(365, TODAY)[0]!, to: TODAY, timezone: TIMEZONE, plan_id: PLAN_ID, computed_at: `${TODAY}T12:00:00Z`, metric_version: "effort_v1",
      days,
    },
    weekly: {
      schema_version: "mtdo.weekly_performance.v1", plan_id: PLAN_ID, iso_week: "2026-W38", week_start: "2026-09-07", week_end: "2026-09-13", timezone: TIMEZONE, planning_mode: "guided", computed_at: `${TODAY}T12:00:00Z`,
      plan: { picked_count: 9, done_count: 6, completion_rate: 0.67, estimated_minutes: 320, actual_minutes: 260, paced_actual_minutes: 240, paced_task_count: 6, pace_ratio: 0.81, menu_offered_count: 14, menu_picked_count: 9, pick_rate: 0.64, regressed_count: 1, stale_open_count: 1, postponement_count: 1, backlog_count: 2, sessions_completed: sessionsTotal, study_days: activeDays, score: 34, score_max: 60 },
      categories: [
        categoryFixture({ category_id: "cat-backend", name: "backend", label: "Backend", current_target: 5, picked_count: 4, done_count: 3, completion_rate: 0.75, estimated_minutes: 150, actual_minutes: 130, sessions_completed: 5, study_days: 4 }),
        categoryFixture({ category_id: "cat-dsa", name: "dsa", label: "DSA", current_target: 5, picked_count: 3, done_count: 1, completion_rate: 0.33, estimated_minutes: 100, actual_minutes: 70, sessions_completed: 3, study_days: 3 }),
        categoryFixture({ category_id: "cat-sql", name: "sql", label: "SQL", current_target: 3, picked_count: 2, done_count: 2, completion_rate: 1, estimated_minutes: 70, actual_minutes: 60, sessions_completed: 4, study_days: 2 }),
        categoryFixture({ category_id: "cat-sysdesign", name: "system_design", label: "System Design", current_target: 2 }),
      ],
    },
    studyProfile: {
      schema_version: "mtdo.study_profile.v1", computed_at: `${TODAY}T12:00:00Z`, from: dateRange(42, TODAY)[0]!, to: TODAY, window_days: 42, timezone: TIMEZONE, plan_id: PLAN_ID, status: "ok",
      focus: { metric_version: "study_profile_v1", avg_percentage: 44, sample_size: sessionsTotal, window_days: 42, confidence: "low" },
      execution: { metric_version: "study_profile_v1", avg_percentage: 61, sample_size: 9, window_days: 42, confidence: "low" },
      consistency: { metric_version: "momentum_v1", active_days_rate: activeDays / 42, momentum_score: 29, current_streak: 2, longest_streak: 3, window_days: 42 },
      planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.44, avg_pace_ratio: 0.81, weeks_sampled: 2, confidence: "low" },
      best_study_window: { hour: 9, sample_size: 6, session_completion_rate: 0.8 },
      best_weekday: null,
      ideal_session_length: { bucket: "30-45m", sample_size: 6, session_completion_rate: 0.8 },
      strongest_subject: { category_id: "cat-sql", name: "sql", label: "SQL", completion_rate: 1, sample_size: 6, confidence: "low" },
      weakest_subject: { category_id: "cat-dsa", name: "dsa", label: "DSA", completion_rate: 0.33, sample_size: 5, confidence: "low" },
      most_avoided_subject: { category_id: "cat-sysdesign", name: "system_design", label: "System Design", postponement_rate: 0.4, sample_size: 5, confidence: "low" },
    },
  };
}

function matureFixture(): ReviewFixtureBundle {
  // Same headline numbers as the reference mock / the /review-demo route's
  // "today" values -- see review-demo-data.ts's forcedToday block.
  const days = buildConsistencyDays(365, 268, 4); // ~73% active days
  return {
    dailySummary: {
      schema_version: "mtdo.review_daily_summary.v1", date: TODAY, timezone: TIMEZONE, plan_id: PLAN_ID, iso_week: "2026-W38", computed_at: `${TODAY}T12:00:00Z`, status: "ok",
      focus: { metric_version: "focus_v1", focus_minutes: 103, target_minutes: 120, percentage: 86, session_count: 3, completed_sessions: 3, longest_session_minutes: 47, pause_count: 4 },
      execute: { metric_version: "execute_v1", tasks_done: 5, tasks_picked: 7, percentage: 71, score: 34, score_max: 48, regressed_count: 2 },
      progress: { metric_version: "progress_v1", week_score: 68, week_score_max: 100, percentage: 68 },
    },
    momentum: {
      schema_version: "mtdo.review_momentum.v1", from: dateRange(42, TODAY)[0]!, to: TODAY, window_days: 42, timezone: TIMEZONE, computed_at: `${TODAY}T12:00:00Z`, status: "ok", metric_version: "momentum_v1",
      momentum_score: 71, current_streak: 8, longest_streak: 26, active_days_rate: 0.55,
    },
    timePatterns: {
      schema_version: "mtdo.review_time_patterns.v1", from: dateRange(42, TODAY)[0]!, to: TODAY, timezone: TIMEZONE, computed_at: `${TODAY}T12:00:00Z`, min_sample_size: 5,
      hourly: [2, 1, 2, 3, 2, 3, 8, 16, 28, 42, 38, 29, 20, 15, 11, 13, 12, 20, 23, 10, 8, 7, 5, 2].map((m, hour) => ({ hour, session_count: Math.max(1, Math.round(m / 10)), completed_session_count: Math.max(1, Math.round((m / 10) * 0.83)), session_completion_rate: 0.83, avg_focus_minutes: m, total_focus_minutes: m })),
      weekday: [],
      duration_buckets: [
        { bucket: "<15m" as const, session_count: 12, completed_session_count: 10, session_completion_rate: 0.83, avg_focus_minutes: 11 },
        { bucket: "15-30m" as const, session_count: 22, completed_session_count: 19, session_completion_rate: 0.86, avg_focus_minutes: 23 },
        { bucket: "30-45m" as const, session_count: 34, completed_session_count: 31, session_completion_rate: 0.91, avg_focus_minutes: 38 },
        { bucket: "45-60m" as const, session_count: 20, completed_session_count: 17, session_completion_rate: 0.85, avg_focus_minutes: 52 },
        { bucket: "60-90m" as const, session_count: 9, completed_session_count: 6, session_completion_rate: 0.67, avg_focus_minutes: 71 },
        { bucket: "90m+" as const, session_count: 3, completed_session_count: 1, session_completion_rate: 0.33, avg_focus_minutes: 96 },
      ],
      best_hour: { hour: 9, sample_size: 42, session_completion_rate: 0.91 },
      best_weekday: { weekday: 2, sample_size: 38, session_completion_rate: 0.88 },
      best_duration_bucket: { bucket: "30-45m", sample_size: 34, session_completion_rate: 0.91 },
    },
    consistency: {
      schema_version: "mtdo.review_consistency.v1", from: dateRange(365, TODAY)[0]!, to: TODAY, timezone: TIMEZONE, plan_id: PLAN_ID, computed_at: `${TODAY}T12:00:00Z`, metric_version: "effort_v1",
      days,
    },
    weekly: {
      schema_version: "mtdo.weekly_performance.v1", plan_id: PLAN_ID, iso_week: "2026-W38", week_start: "2026-09-07", week_end: "2026-09-13", timezone: TIMEZONE, planning_mode: "guided", computed_at: `${TODAY}T12:00:00Z`,
      plan: { picked_count: 28, done_count: 20, completion_rate: 0.71, estimated_minutes: 750, actual_minutes: 652, paced_actual_minutes: 620, paced_task_count: 18, pace_ratio: 0.87, menu_offered_count: 40, menu_picked_count: 28, pick_rate: 0.7, regressed_count: 2, stale_open_count: 1, postponement_count: 3, backlog_count: 4, sessions_completed: 44, study_days: 23, score: 68, score_max: 100 },
      categories: [
        categoryFixture({ category_id: "cat-backend", name: "backend", label: "Backend", current_target: 5, picked_count: 11, done_count: 8, completion_rate: 0.73, estimated_minutes: 240, actual_minutes: 248, sessions_completed: 16, study_days: 9 }),
        categoryFixture({ category_id: "cat-dsa", name: "dsa", label: "DSA", current_target: 5, picked_count: 9, done_count: 6, completion_rate: 0.67, estimated_minutes: 200, actual_minutes: 202, sessions_completed: 13, study_days: 8 }),
        categoryFixture({ category_id: "cat-sql", name: "sql", label: "SQL", current_target: 3, picked_count: 5, done_count: 4, completion_rate: 0.8, estimated_minutes: 110, actual_minutes: 111, sessions_completed: 8, study_days: 4 }),
        categoryFixture({ category_id: "cat-sysdesign", name: "system_design", label: "System Design", current_target: 2, picked_count: 3, done_count: 2, completion_rate: 0.67, estimated_minutes: 100, actual_minutes: 91, sessions_completed: 7, study_days: 2 }),
      ],
    },
    studyProfile: {
      schema_version: "mtdo.study_profile.v1", computed_at: `${TODAY}T12:00:00Z`, from: dateRange(42, TODAY)[0]!, to: TODAY, window_days: 42, timezone: TIMEZONE, plan_id: PLAN_ID, status: "ok",
      focus: { metric_version: "study_profile_v1", avg_percentage: 74, sample_size: 44, window_days: 42, confidence: "high" },
      execution: { metric_version: "study_profile_v1", avg_percentage: 71, sample_size: 28, window_days: 42, confidence: "high" },
      consistency: { metric_version: "momentum_v1", active_days_rate: 0.55, momentum_score: 71, current_streak: 8, longest_streak: 26, window_days: 42 },
      planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.57, avg_pace_ratio: 0.87, weeks_sampled: 6, confidence: "high" },
      best_study_window: { hour: 9, sample_size: 42, session_completion_rate: 0.91 },
      best_weekday: { weekday: 2, sample_size: 38, session_completion_rate: 0.88 },
      ideal_session_length: { bucket: "30-45m", sample_size: 34, session_completion_rate: 0.91 },
      strongest_subject: { category_id: "cat-backend", name: "backend", label: "Backend", completion_rate: 0.73, sample_size: 11, confidence: "high" },
      weakest_subject: { category_id: "cat-sysdesign", name: "system_design", label: "System Design", completion_rate: 0.67, sample_size: 3, confidence: "medium" },
      most_avoided_subject: { category_id: "cat-dsa", name: "dsa", label: "DSA", postponement_rate: 0.31, sample_size: 9, confidence: "high" },
    },
  };
}

export function buildReviewFixture(maturity: "empty" | "early" | "building" | "mature"): ReviewFixtureBundle {
  switch (maturity) {
    case "empty": return emptyFixture();
    case "early": return earlyFixture();
    case "building": return buildingFixture();
    case "mature": return matureFixture();
  }
}
