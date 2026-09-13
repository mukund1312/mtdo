import { describe, expect, it } from "vitest";
import { buildReviewInsights } from "./insights";
import type { StudyProfileOk, StudyProfileSubject, StudyProfileAvoidedSubject } from "./types";

// Boundary correctness is the whole game for a rules engine (same rationale
// as web/lib/planning/classify.test.ts): every threshold is tested AT the
// value and one step either side of it.

function baseProfile(overrides: Partial<StudyProfileOk> = {}): StudyProfileOk {
  return {
    schema_version: "mtdo.study_profile.v1",
    computed_at: "2026-09-14T00:00:00Z",
    from: "2026-08-03",
    to: "2026-09-14",
    window_days: 42,
    timezone: "UTC",
    plan_id: "plan-1",
    status: "ok",
    focus: { metric_version: "study_profile_v1", avg_percentage: null, sample_size: 0, window_days: 42, confidence: "insufficient_data" },
    execution: { metric_version: "study_profile_v1", avg_percentage: null, sample_size: 0, window_days: 42, confidence: "insufficient_data" },
    consistency: { metric_version: "momentum_v1", active_days_rate: 0.8, momentum_score: 70, current_streak: 3, longest_streak: 10, window_days: 42 },
    planning: { metric_version: "study_profile_v1", avg_completion_rate: null, avg_pace_ratio: null, weeks_sampled: 0, confidence: "insufficient_data" },
    best_study_window: null,
    best_weekday: null,
    ideal_session_length: null,
    strongest_subject: null,
    weakest_subject: null,
    most_avoided_subject: null,
    ...overrides,
  };
}

function subject(overrides: Partial<StudyProfileSubject> = {}): StudyProfileSubject {
  return { category_id: "cat-1", name: "backend", label: "Backend", completion_rate: 0.9, sample_size: 8, confidence: "medium", ...overrides };
}

function avoided(overrides: Partial<StudyProfileAvoidedSubject> = {}): StudyProfileAvoidedSubject {
  return { category_id: "cat-2", name: "system_design", label: "System Design", postponement_rate: 0.4, sample_size: 6, confidence: "medium", ...overrides };
}

describe("buildReviewInsights — no active plan", () => {
  it("returns no insights at all", () => {
    expect(buildReviewInsights({ schema_version: "mtdo.study_profile.v1", computed_at: "x", from: "x", to: "x", window_days: 42, timezone: "UTC", status: "no_active_plan", focus: null, execution: null, consistency: null, planning: null, best_study_window: null, best_weekday: null, ideal_session_length: null, strongest_subject: null, weakest_subject: null, most_avoided_subject: null })).toEqual([]);
  });
});

describe("buildReviewInsights — planning_overcommitment", () => {
  it("fires under half completion", () => {
    const p = baseProfile({ planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.33, avg_pace_ratio: null, weeks_sampled: 4, confidence: "medium" } });
    expect(buildReviewInsights(p).some((i) => i.type === "planning_overcommitment")).toBe(true);
  });

  it("does NOT fire at exactly 0.5", () => {
    const p = baseProfile({ planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.5, avg_pace_ratio: null, weeks_sampled: 4, confidence: "medium" } });
    expect(buildReviewInsights(p).some((i) => i.type === "planning_overcommitment")).toBe(false);
  });

  it("fires just below 0.5", () => {
    const p = baseProfile({ planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.4999, avg_pace_ratio: null, weeks_sampled: 4, confidence: "medium" } });
    expect(buildReviewInsights(p).some((i) => i.type === "planning_overcommitment")).toBe(true);
  });

  it("does NOT fire when confidence is insufficient_data, even below the threshold", () => {
    const p = baseProfile({ planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.1, avg_pace_ratio: null, weeks_sampled: 1, confidence: "insufficient_data" } });
    expect(buildReviewInsights(p).some((i) => i.type === "planning_overcommitment")).toBe(false);
  });
});

describe("buildReviewInsights — subject_avoidance", () => {
  it("fires at or above 0.3 postponement", () => {
    const p = baseProfile({ most_avoided_subject: avoided({ postponement_rate: 0.3 }) });
    expect(buildReviewInsights(p).some((i) => i.type === "subject_avoidance")).toBe(true);
  });

  it("does NOT fire just below 0.3", () => {
    const p = baseProfile({ most_avoided_subject: avoided({ postponement_rate: 0.2999 }) });
    expect(buildReviewInsights(p).some((i) => i.type === "subject_avoidance")).toBe(false);
  });

  it("does NOT fire when most_avoided_subject is null (nothing is being avoided)", () => {
    const p = baseProfile({ most_avoided_subject: null });
    expect(buildReviewInsights(p).some((i) => i.type === "subject_avoidance")).toBe(false);
  });

  it("does NOT fire when confidence is insufficient_data", () => {
    const p = baseProfile({ most_avoided_subject: avoided({ postponement_rate: 0.9, confidence: "insufficient_data" }) });
    expect(buildReviewInsights(p).some((i) => i.type === "subject_avoidance")).toBe(false);
  });

  it("names the subject and rounds the percentage into the text", () => {
    const p = baseProfile({ most_avoided_subject: avoided({ label: "DSA", postponement_rate: 0.4 }) });
    const insight = buildReviewInsights(p).find((i) => i.type === "subject_avoidance");
    expect(insight?.text).toContain("DSA");
    expect(insight?.text).toContain("40%");
  });
});

describe("buildReviewInsights — strong_subject", () => {
  it("fires at or above 0.85 completion", () => {
    const p = baseProfile({ strongest_subject: subject({ completion_rate: 0.85 }) });
    expect(buildReviewInsights(p).some((i) => i.type === "strong_subject")).toBe(true);
  });

  it("does NOT fire just below 0.85", () => {
    const p = baseProfile({ strongest_subject: subject({ completion_rate: 0.8499 }) });
    expect(buildReviewInsights(p).some((i) => i.type === "strong_subject")).toBe(false);
  });

  it("does NOT fire when strongest_subject is null", () => {
    const p = baseProfile({ strongest_subject: null });
    expect(buildReviewInsights(p).some((i) => i.type === "strong_subject")).toBe(false);
  });
});

describe("buildReviewInsights — ideal_session_length and best_study_window", () => {
  it("fires whenever review_time_patterns() already cleared its own sample gate (non-null)", () => {
    const p = baseProfile({
      ideal_session_length: { bucket: "30-45m", sample_size: 12, session_completion_rate: 0.8 },
      best_study_window: { hour: 8, sample_size: 10, session_completion_rate: 0.75 },
    });
    const insights = buildReviewInsights(p);
    expect(insights.some((i) => i.type === "ideal_session_length")).toBe(true);
    expect(insights.some((i) => i.type === "best_study_window")).toBe(true);
  });

  it("does NOT fire when null (review_time_patterns() found insufficient data)", () => {
    const p = baseProfile({ ideal_session_length: null, best_study_window: null });
    const insights = buildReviewInsights(p);
    expect(insights.some((i) => i.type === "ideal_session_length")).toBe(false);
    expect(insights.some((i) => i.type === "best_study_window")).toBe(false);
  });
});

describe("buildReviewInsights — consistency_dip", () => {
  it("fires under 0.3 active_days_rate", () => {
    const p = baseProfile({ consistency: { metric_version: "momentum_v1", active_days_rate: 0.2, momentum_score: 20, current_streak: 0, longest_streak: 2, window_days: 42 } });
    expect(buildReviewInsights(p).some((i) => i.type === "consistency_dip")).toBe(true);
  });

  it("does NOT fire at exactly 0.3", () => {
    const p = baseProfile({ consistency: { metric_version: "momentum_v1", active_days_rate: 0.3, momentum_score: 30, current_streak: 1, longest_streak: 3, window_days: 42 } });
    expect(buildReviewInsights(p).some((i) => i.type === "consistency_dip")).toBe(false);
  });
});

describe("buildReviewInsights — ordering", () => {
  it("orders notices before positives before info", () => {
    const p = baseProfile({
      planning: { metric_version: "study_profile_v1", avg_completion_rate: 0.1, avg_pace_ratio: null, weeks_sampled: 3, confidence: "medium" },
      strongest_subject: subject({ completion_rate: 0.95 }),
      ideal_session_length: { bucket: "30-45m", sample_size: 12, session_completion_rate: 0.8 },
    });
    const types = buildReviewInsights(p).map((i) => i.severity);
    expect(types).toEqual(["notice", "positive", "info"]);
  });
});
