"use client";

import type { ReviewDemoDay } from "@/data/review-demo-data";
import { sessionQualityBuckets, sessionStats } from "@/lib/review-demo/analytics";

export function SessionQuality({ days }: { days: ReviewDemoDay[] }) {
  const buckets = sessionQualityBuckets(days);
  const stats = sessionStats(days);
  const max = Math.max(...buckets.map((b) => b.pct), 1);
  const longestLabel = buckets.reduce((a, b) => (b.pct > a.pct ? b : a), buckets[0]!).label;

  return (
    <section className="rd-card" aria-label="Session quality">
      <header className="rd-card-title">SESSION QUALITY</header>
      <div className="rd-session-quality-body">
        {buckets.map((b) => (
          <div className="rd-sq-row" key={b.label}>
            <span>{b.label}</span>
            <div className="rd-sq-bar-track">
              <div className="rd-sq-bar-fill" style={{ width: `${(b.pct / max) * 100}%` }} />
            </div>
            <b>{b.pct}%</b>
          </div>
        ))}
      </div>
      <div className="rd-stat-trio">
        <div><b>{stats.averageMinutes}m</b><span>Average</span></div>
        <div><b>{stats.longestMinutes}m</b><span>Longest</span></div>
        <div><b>{stats.completionPct}%</b><span>Completion</span></div>
      </div>
      <p className="rd-card-footer-note">
        Your strongest sessions are around {longestLabel}. Sessions &gt; 70 minutes tend to be less effective.
      </p>
    </section>
  );
}
