"use client";

import type { ReviewDemoDay } from "@/data/review-demo-data";
import { formatMinutes, planVsRealityWeek } from "@/lib/review-demo/analytics";

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export function PlanReality({ days }: { days: ReviewDemoDay[] }) {
  const { planned, actual, plannedTotal, actualTotal, accuracy } = planVsRealityWeek(days);
  const max = Math.max(...planned, ...actual, 1);

  return (
    <section className="rd-card" aria-label="Plan vs reality">
      <header className="rd-card-title">PLAN VS REALITY</header>
      <div className="rd-pvr-body">
        <div className="rd-pvr-row">
          <span className="rd-pvr-label">Planned</span>
          <div className="rd-pvr-track"><div className="rd-pvr-fill planned" style={{ width: `${Math.min(100, (plannedTotal / (plannedTotal + actualTotal || 1)) * 100 * 1.4)}%` }} /></div>
          <span className="rd-pvr-value">{formatMinutes(plannedTotal)}</span>
        </div>
        <div className="rd-pvr-row">
          <span className="rd-pvr-label">Actual</span>
          <div className="rd-pvr-track"><div className="rd-pvr-fill actual" style={{ width: `${Math.min(100, (actualTotal / (plannedTotal + actualTotal || 1)) * 100 * 1.4)}%` }} /></div>
          <span className="rd-pvr-value">{formatMinutes(actualTotal)}</span>
        </div>

        <div className="rd-pvr-accuracy">
          <span>Plan accuracy</span>
          <b>{accuracy}%</b>
        </div>

        <div className="rd-pvr-days">
          {planned.map((p, i) => (
            <div className="rd-pvr-day-col" key={i}>
              <div className="rd-pvr-day-bar planned" style={{ height: `${(p / max) * 100}%` }} />
              <div className="rd-pvr-day-bar actual" style={{ height: `${(actual[i]! / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="rd-pvr-day-labels">
          {DAY_LABELS.map((d, i) => <span key={i}>{d}</span>)}
        </div>
      </div>
      <p className="rd-card-footer-note">You tend to start 18 minutes later than planned on average.</p>
    </section>
  );
}
