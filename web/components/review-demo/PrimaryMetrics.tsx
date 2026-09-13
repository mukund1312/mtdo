"use client";

import { Flame, CheckCircle2, BarChart3, ArrowUp, ArrowDown } from "lucide-react";

import type { ReviewDemoDay } from "@/data/review-demo-data";

import { MetricRing } from "./MetricRing";
import { DailyScore } from "./DailyScore";

interface PrimaryMetricsProps {
  today: ReviewDemoDay;
  dailyScore: number;
  streak: number;
  activeDaysRate: number;
}

export function PrimaryMetrics({ today, dailyScore, streak, activeDaysRate }: PrimaryMetricsProps) {
  const focusPct = Math.round((today.focusMinutes / today.plannedMinutes) * 100);
  const executePct = Math.round((today.tasksCompleted / today.tasksPlanned) * 100);
  const progressPct = Math.round((today.xp / today.xpTarget) * 100);

  return (
    <div className="rd-primary-row">
      <section className="rd-card rd-rings-card" aria-label="Primary metrics">
        <div className="rd-ring-metric">
          <MetricRing percent={focusPct} color="#ff426d">
            <Flame size={16} color="#ff426d" style={{ marginBottom: 4 }} />
            <span className="rd-ring-pct">{focusPct}%</span>
            <span className="rd-ring-sub">
              {today.focusMinutes} / {today.plannedMinutes} min
            </span>
          </MetricRing>
          <span className="rd-ring-label" style={{ color: "#ff426d" }}>FOCUS</span>
          <span className="rd-ring-caption">Deep work time</span>
          <span className="rd-ring-trend up"><ArrowUp size={12} /> 12%</span>
        </div>

        <div className="rd-ring-metric">
          <MetricRing percent={executePct} color="#b7ff56">
            <CheckCircle2 size={16} color="#b7ff56" style={{ marginBottom: 4 }} />
            <span className="rd-ring-pct">{executePct}%</span>
            <span className="rd-ring-sub">
              {today.tasksCompleted} / {today.tasksPlanned} tasks
            </span>
          </MetricRing>
          <span className="rd-ring-label" style={{ color: "#b7ff56" }}>EXECUTE</span>
          <span className="rd-ring-caption">Tasks completed</span>
          <span className="rd-ring-trend down"><ArrowDown size={12} /> 8%</span>
        </div>

        <div className="rd-ring-metric">
          <MetricRing percent={progressPct} color="#8b5cf6">
            <BarChart3 size={16} color="#8b5cf6" style={{ marginBottom: 4 }} />
            <span className="rd-ring-pct">{progressPct}%</span>
            <span className="rd-ring-sub">
              {today.xp} / {today.xpTarget} xp
            </span>
          </MetricRing>
          <span className="rd-ring-label" style={{ color: "#8b5cf6" }}>PROGRESS</span>
          <span className="rd-ring-caption">Goal advancement</span>
          <span className="rd-ring-trend up"><ArrowUp size={12} /> 6%</span>
        </div>
      </section>

      <DailyScore score={dailyScore} streak={streak} activeDaysRate={activeDaysRate} />
    </div>
  );
}
