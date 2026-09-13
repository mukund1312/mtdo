// review_insights() (Phase E of docs/designs/mtdo-web-review-study-profile-plan.md):
// deterministic, structured findings built from study_profile()'s own output.
//
// WHY THIS IS TYPESCRIPT, NOT A NEW SQL RPC. Same architectural split the
// weekly engine already uses (api.md sec3g): raw/derived metrics live in
// Postgres (weekly_performance(), study_profile()), business-rule evaluation
// over already-computed numbers lives in TS (web/lib/planning/classify.ts,
// propose.ts). study_profile() already IS the composed data; this file adds
// no new metric, no new query -- it is pure functions over its output,
// exactly like classifyCategory() is pure functions over weekly_performance().
//
// NO AI ANYWHERE IN THIS FILE, deliberately, matching decisions.md
// 2026-09-11's standing rule for the weekly engine: metrics and the rules
// built on them stay deterministic. An AI layer that turns these structured
// findings into prose is a later, separate, explicitly-opted-into phase
// (the plan's own Phase 15 concept) -- not something this file backs into.
//
// Every insight requires its underlying field to have cleared
// study_profile()'s own confidence gate -- an insight built from a
// "insufficient_data" field would just be the exact mistake the whole
// backend side of this plan exists to prevent, moved one layer up.

import {
  AVOIDANCE_NOTICE_MIN,
  CONSISTENCY_DIP_MAX,
  PLANNING_OVERCOMMIT_MAX,
  STRONG_SUBJECT_MIN,
} from "./insight-thresholds";
import type { StudyProfile, StudyProfileOk } from "./types";

export type InsightSeverity = "positive" | "notice" | "info";

export interface Insight {
  type:
    | "planning_overcommitment"
    | "subject_avoidance"
    | "strong_subject"
    | "ideal_session_length"
    | "best_study_window"
    | "consistency_dip";
  severity: InsightSeverity;
  text: string;
  /** The exact fields the insight was built from -- an audit trail, not for display. */
  evidence: Record<string, unknown>;
}

/**
 * Build every insight that fires for this profile. Order is the display
 * order: notices before positives before plain info, so the thing most
 * worth a user's attention reads first.
 *
 * status !== "ok" (no active plan) always returns []. There is nothing to
 * observe about a goal that does not exist yet.
 */
export function buildReviewInsights(profile: StudyProfile): Insight[] {
  if (profile.status !== "ok") return [];
  const p: StudyProfileOk = profile;
  const insights: Insight[] = [];

  if (
    p.planning.confidence !== "insufficient_data" &&
    p.planning.avg_completion_rate !== null &&
    p.planning.avg_completion_rate < PLANNING_OVERCOMMIT_MAX
  ) {
    insights.push({
      type: "planning_overcommitment",
      severity: "notice",
      text: `You completed ${Math.round(p.planning.avg_completion_rate * 100)}% of what you planned over the last ${p.planning.weeks_sampled} weeks.`,
      evidence: {
        avg_completion_rate: p.planning.avg_completion_rate,
        weeks_sampled: p.planning.weeks_sampled,
        confidence: p.planning.confidence,
      },
    });
  }

  if (
    p.most_avoided_subject !== null &&
    p.most_avoided_subject.confidence !== "insufficient_data" &&
    p.most_avoided_subject.postponement_rate >= AVOIDANCE_NOTICE_MIN
  ) {
    const subject = p.most_avoided_subject;
    insights.push({
      type: "subject_avoidance",
      severity: "notice",
      text: `${subject.label} gets postponed more than the rest -- ${Math.round(subject.postponement_rate * 100)}% of the time.`,
      evidence: {
        category_id: subject.category_id,
        postponement_rate: subject.postponement_rate,
        sample_size: subject.sample_size,
      },
    });
  }

  if (
    p.strongest_subject !== null &&
    p.strongest_subject.confidence !== "insufficient_data" &&
    p.strongest_subject.completion_rate >= STRONG_SUBJECT_MIN
  ) {
    const subject = p.strongest_subject;
    insights.push({
      type: "strong_subject",
      severity: "positive",
      text: `${subject.label} is where you're strongest -- ${Math.round(subject.completion_rate * 100)}% completion.`,
      evidence: {
        category_id: subject.category_id,
        completion_rate: subject.completion_rate,
        sample_size: subject.sample_size,
      },
    });
  }

  // best_study_window/ideal_session_length are already gated by
  // review_time_patterns()'s own min_sample_size (0028) -- non-null here
  // already means the sample was real; no second gate needed.
  if (p.ideal_session_length !== null) {
    insights.push({
      type: "ideal_session_length",
      severity: "info",
      text: `Your strongest sessions tend to run ${p.ideal_session_length.bucket}.`,
      evidence: {
        bucket: p.ideal_session_length.bucket,
        sample_size: p.ideal_session_length.sample_size,
      },
    });
  }

  if (p.best_study_window !== null) {
    const hour = String(p.best_study_window.hour).padStart(2, "0");
    insights.push({
      type: "best_study_window",
      severity: "info",
      text: `You focus best starting around ${hour}:00.`,
      evidence: {
        hour: p.best_study_window.hour,
        sample_size: p.best_study_window.sample_size,
      },
    });
  }

  if (p.consistency.active_days_rate < CONSISTENCY_DIP_MAX) {
    insights.push({
      type: "consistency_dip",
      severity: "notice",
      text: `You've shown up on ${Math.round(p.consistency.active_days_rate * 100)}% of the last ${p.consistency.window_days} days.`,
      evidence: {
        active_days_rate: p.consistency.active_days_rate,
        window_days: p.consistency.window_days,
      },
    });
  }

  return insights;
}
