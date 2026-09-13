"use client";

import { MetricRing } from "./MetricRing";

interface DailyScoreProps {
  score: number;
  streak: number;
  activeDaysRate: number;
}

function momentumLabel(score: number): string {
  if (score >= 70) return "Good Momentum";
  if (score >= 40) return "Building Momentum";
  if (score >= 15) return "Low Momentum";
  return "Just Getting Started";
}

export function DailyScore({ score, streak, activeDaysRate }: DailyScoreProps) {
  return (
    <section className="rd-card rd-daily-score-card" aria-label="Daily score">
      <div>
        <div className="rd-daily-score-title">DAILY SCORE</div>
        <MetricRing percent={score} size={100} strokeWidth={8} color="#b7ff56">
          <span style={{ fontSize: 22, fontWeight: 800 }}>{score}</span>
          <span style={{ fontSize: 11, color: "var(--rd-text-muted)" }}>/ 100</span>
        </MetricRing>
      </div>
      <div>
        <div className="rd-daily-score-headline">{momentumLabel(score)}</div>
        <p className="rd-daily-score-caption">
          {streak} days current streak · {activeDaysRate}% active over the last 42 days.
        </p>
      </div>
    </section>
  );
}
