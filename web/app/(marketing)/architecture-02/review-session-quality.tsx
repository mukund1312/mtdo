"use client";

import { DURATION_LABELS } from "./review-time-formatters";
import type { UseTimePatternsResult } from "./use-time-patterns";
import { sessionQualityEligibility } from "@/lib/review/eligibility";

// "SESSION QUALITY" from the reference mock. Shares the SAME
// review_time_patterns() fetch as ReviewFocusDistribution -- see
// use-time-patterns.ts.
//
// Audit finding (2026-09-14): with 1 session in its bucket, the old code
// rendered that bucket as a 100%-wide bar with "100%" completion next to
// it -- a single observation presented with the same visual confidence as
// a real distribution. Below SESSION_QUALITY_MIN_SESSIONS, the bars/
// percentages are suppressed in favor of an honest "not enough sessions
// yet" message; the real session count is still shown as a fact.

export function ReviewSessionQuality({ patterns, state, reload }: UseTimePatternsResult) {
  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Session quality is unavailable.</b>
        <p>We could not read your sessions. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  const loading = state === "loading";
  const buckets = patterns?.duration_buckets ?? [];
  const maxCount = Math.max(1, ...buckets.map((d) => d.session_count));
  const totalSessions = buckets.reduce((n, d) => n + d.session_count, 0);
  const completedSessions = buckets.reduce((n, d) => n + d.completed_session_count, 0);
  // duration_buckets carries avg_focus_minutes per bucket, not a sum -- an
  // overall weighted average is the count-weighted mean of those bucket
  // averages, not a re-derivation of any per-session data.
  const weightedMinutes = buckets.reduce((n, d) => n + (d.avg_focus_minutes ?? 0) * d.session_count, 0);
  const averageMinutes = totalSessions > 0 ? weightedMinutes / totalSessions : null;
  const longestBucket = [...buckets].reverse().find((d) => d.session_count > 0);
  const completionRate = totalSessions > 0 ? completedSessions / totalSessions : null;
  const eligibility = sessionQualityEligibility(totalSessions);

  return (
    <section className="a02-session-quality" aria-label="Session quality">
      <header><b>SESSION QUALITY</b></header>
      {eligibility.state === "insufficient" ? (
        <p className="a02-trait-empty">
          {eligibility.sampleSize} session{eligibility.sampleSize === 1 ? "" : "s"} recorded. Not enough sessions yet
          to identify a reliable session-length pattern.
        </p>
      ) : (
        <div className="a02-duration-bars" aria-label="Session length distribution">
          {buckets.map((d) => (
            <div className="a02-duration-row" key={d.bucket}>
              <span>{DURATION_LABELS[d.bucket] ?? d.bucket}</span>
              <i style={{ width: loading ? "6%" : `${Math.max(3, (d.session_count / maxCount) * 100)}%` }} />
              <b>{loading ? "" : totalSessions > 0 ? `${Math.round((d.session_count / totalSessions) * 100)}%` : "0%"}</b>
            </div>
          ))}
        </div>
      )}
      <div className="a02-session-quality-stats">
        <div><b>{loading || averageMinutes == null ? "—" : `${Math.round(averageMinutes)}m`}</b><span>Average</span></div>
        <div><b>{loading || !longestBucket ? "—" : (DURATION_LABELS[longestBucket.bucket] ?? longestBucket.bucket)}</b><span>Longest</span></div>
        <div><b>{loading || completionRate == null ? "—" : `${Math.round(completionRate * 100)}%`}</b><span>Completion</span></div>
      </div>
      {eligibility.state !== "insufficient" && (
        <p className="a02-time-window-stat">
          {loading
            ? "Reading your sessions."
            : patterns?.best_duration_bucket
              ? `Your strongest sessions are around ${DURATION_LABELS[patterns.best_duration_bucket.bucket] ?? patterns.best_duration_bucket.bucket}.`
              : "Complete a few sessions to understand your ideal session length."}
        </p>
      )}
    </section>
  );
}
