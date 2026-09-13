"use client";

import type { UseTimePatternsResult } from "./use-time-patterns";

// "FOCUS TIME DISTRIBUTION" from the reference mock -- the same hourly
// breakdown review_time_patterns() already returns (migrations/0028), over
// the last 42 days (not literally "today" -- a single day's hourly spread
// is too sparse to chart meaningfully; this is "when your focus time tends
// to land", the same data ReviewTimeBehavior's "When you work best" already
// reads, from the SAME shared fetch -- see use-time-patterns.ts).

export function ReviewFocusDistribution({ patterns, state, reload }: UseTimePatternsResult) {
  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Focus distribution is unavailable.</b>
        <p>We could not read your sessions. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  const loading = state === "loading";
  const hourly = patterns?.hourly ?? [];
  const totalMinutes = hourly.reduce((sum, h) => sum + h.total_focus_minutes, 0);
  const maxMinutes = Math.max(1, ...hourly.map((h) => h.total_focus_minutes));
  const peakHour = hourly.reduce((best, h) => (h.total_focus_minutes > (best?.total_focus_minutes ?? -1) ? h : best), hourly[0]);

  const before10 = hourly.filter((h) => h.hour < 10).reduce((n, h) => n + h.completed_session_count, 0);
  const before10Total = hourly.filter((h) => h.hour < 10).reduce((n, h) => n + h.session_count, 0);
  const before10Rate = before10Total > 0 ? before10 / before10Total : null;
  const overallCompleted = hourly.reduce((n, h) => n + h.completed_session_count, 0);
  const overallTotal = hourly.reduce((n, h) => n + h.session_count, 0);
  const overallRate = overallTotal > 0 ? overallCompleted / overallTotal : null;
  const upliftPct =
    before10Rate != null && overallRate != null && overallRate > 0
      ? Math.round(((before10Rate - overallRate) / overallRate) * 100)
      : null;

  return (
    <section className="a02-focus-distribution" aria-label="Focus time distribution">
      <header>
        <b>FOCUS TIME DISTRIBUTION</b>
        <div className="a02-focus-distribution-total">
          <span>Total Focus</span>
          <b>{loading ? "···" : `${Math.round(totalMinutes / 60)}h ${Math.round(totalMinutes % 60)}m`}</b>
        </div>
      </header>
      <div className="a02-hour-bars a02-hour-bars--distribution" aria-hidden="true">
        {hourly.map((h) => (
          <i
            key={h.hour}
            className={peakHour && h.hour === peakHour.hour && h.total_focus_minutes > 0 ? "is-peak" : undefined}
            style={{ height: loading ? "8%" : `${Math.max(4, (h.total_focus_minutes / maxMinutes) * 100)}%` }}
          />
        ))}
      </div>
      <footer className="a02-hour-axis">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}</span>
        ))}
      </footer>
      <p className="a02-time-window-stat">
        {loading
          ? "Reading your sessions."
          : upliftPct !== null && upliftPct > 0
            ? `You are ${upliftPct}% more likely to complete tasks when you start before 10 AM.`
            : "Not enough sessions yet to compare morning starts."}
      </p>
    </section>
  );
}
