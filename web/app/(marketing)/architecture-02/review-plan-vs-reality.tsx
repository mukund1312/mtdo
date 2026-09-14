"use client";

import type { UseWeeklySnapshotResult } from "./use-weekly-snapshot";

// "PLAN VS REALITY" from the reference mock. Reuses weekly_performance()
// outright (api.md sec3f) for the current in-progress ISO week -- planned =
// estimated_minutes, actual = actual_minutes, accuracy = pace_ratio inverted
// (a ratio of sums, never re-derived here). Shares the fetch with
// ReviewGoalBalance -- see use-weekly-snapshot.ts.

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ReviewPlanVsReality({ weekly, state, reload }: UseWeeklySnapshotResult) {
  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Plan vs reality is unavailable.</b>
        <p>We could not read your route&apos;s performance. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  if (state === "no_active_plan") {
    return (
      <section className="a02-plan-vs-reality-empty" aria-live="polite">
        <header><b>PLAN VS REALITY</b></header>
        <p>Set up your route first, then return here for its first useful piece.</p>
      </section>
    );
  }

  const loading = state === "loading";
  // A route exists but this ISO week has no weekly_performance() row yet
  // (e.g. a brand-new route, before its first tracked week) -- planned/
  // actual both fall back to a real 0, not a blanket empty-state message.
  const plan = weekly?.plan;
  const planned = plan?.estimated_minutes ?? 0;
  const actual = plan?.actual_minutes ?? 0;
  const maxMinutes = Math.max(planned, actual, 1);
  // pace_ratio is actual/estimate over paced tasks -- accuracy here is the
  // plan-level mirror of that, expressed as "how close actual landed to
  // planned", capped at 100 (running longer than planned is not "more
  // accurate" than running exactly on time).
  const accuracy = planned > 0 ? Math.min(100, Math.round((1 - Math.abs(actual - planned) / planned) * 100)) : null;

  return (
    <section className="a02-plan-vs-reality" aria-label="Plan vs reality">
      <header><b>PLAN VS REALITY</b></header>
      <div className="a02-pvr-bars">
        <div className="a02-pvr-row">
          <span>Planned</span>
          <i className="a02-pvr-bar a02-pvr-bar--planned" style={{ width: loading ? "40%" : `${Math.max(4, (planned / maxMinutes) * 100)}%` }} />
          <b>{loading ? "···" : formatHours(planned)}</b>
        </div>
        <div className="a02-pvr-row">
          <span>Actual</span>
          <i className="a02-pvr-bar a02-pvr-bar--actual" style={{ width: loading ? "30%" : `${Math.max(4, (actual / maxMinutes) * 100)}%` }} />
          <b>{loading ? "···" : formatHours(actual)}</b>
        </div>
      </div>
      <div className="a02-pvr-accuracy">
        <span>Plan accuracy</span>
        <b>{loading || accuracy === null ? "—" : `${accuracy}%`}</b>
      </div>
      {!loading && planned === 0 && actual === 0 && (
        <p className="a02-time-window-stat">Plan study time to compare intention with execution.</p>
      )}
    </section>
  );
}
