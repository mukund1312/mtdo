"use client";

import { useMemo, useState } from "react";

import type { ReviewDemoDay } from "@/data/review-demo-data";
import { activeDaysStats, heatmapLevel } from "@/lib/review-demo/analytics";

import { EffortTerrain } from "./EffortTerrain";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function buildWeeks(days: ReviewDemoDay[]): (ReviewDemoDay | null)[][] {
  if (days.length === 0) return [];
  const first = new Date(`${days[0]!.date}T00:00:00Z`);
  const firstWeekday = (first.getUTCDay() + 6) % 7;
  const padded: (ReviewDemoDay | null)[] = [...Array(firstWeekday).fill(null), ...days];
  const weeks: (ReviewDemoDay | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
  return weeks;
}

function monthOf(week: (ReviewDemoDay | null)[]): number | null {
  const real = week.find((d) => d !== null);
  return real ? new Date(`${real.date}T00:00:00Z`).getUTCMonth() : null;
}

export function ConsistencyHeatmap({ days }: { days: ReviewDemoDay[] }) {
  const [view, setView] = useState<"heatmap" | "terrain">("heatmap");
  const [hovered, setHovered] = useState<ReviewDemoDay | null>(null);
  const weeks = useMemo(() => buildWeeks(days), [days]);
  const stats = useMemo(() => activeDaysStats(days), [days]);

  return (
    <section className="rd-card rd-consistency-card" aria-label="Consistency, last 365 days">
      <div className="rd-consistency-head">
        <span className="rd-card-title" style={{ padding: 0 }}>CONSISTENCY — LAST 365 DAYS</span>
        <div className="rd-view-toggle">
          <button type="button" className={view === "heatmap" ? "is-active" : undefined} onClick={() => setView("heatmap")}>Heatmap</button>
          <button type="button" className={view === "terrain" ? "is-active" : undefined} onClick={() => setView("terrain")}>Terrain</button>
        </div>
      </div>

      {view === "heatmap" ? (
        <>
          <div className="rd-heat-months">
            {weeks.map((week, i) => {
              const m = monthOf(week);
              const prevM = i > 0 ? monthOf(weeks[i - 1]!) : null;
              return <span key={i}>{m !== null && m !== prevM ? MONTH_LABELS[m] : ""}</span>;
            })}
          </div>
          <div className="rd-heat-body">
            <div className="rd-heat-weekdays">
              {WEEKDAY_LABELS.map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className="rd-heat-weeks">
              {weeks.map((week, wi) => (
                <div className="rd-heat-week" key={wi}>
                  {week.map((day, di) =>
                    day ? (
                      <i
                        key={di}
                        className={`rd-heat-cell level-${heatmapLevel(day.effortScore)}`}
                        onMouseEnter={() => setHovered(day)}
                        onMouseLeave={() => setHovered(null)}
                        title={`${day.date} · effort ${day.effortScore}`}
                      />
                    ) : (
                      <i key={di} className="rd-heat-cell" style={{ opacity: 0 }} aria-hidden="true" />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="rd-heat-legend">
            <span>Less</span>
            <i className="rd-heat-cell level-0" /><i className="rd-heat-cell level-1" /><i className="rd-heat-cell level-2" /><i className="rd-heat-cell level-3" /><i className="rd-heat-cell level-4" /><i className="rd-heat-cell level-5" />
            <span>More</span>
          </div>
          {hovered && (
            <div className="rd-terrain-tooltip" style={{ position: "static", marginTop: 10, width: "fit-content" }}>
              <b>{hovered.date}</b>
              <span>Focus: {hovered.focusMinutes} min</span><br />
              <span>Tasks: {hovered.tasksCompleted}</span><br />
              <span>Effort score: {hovered.effortScore}</span>
            </div>
          )}
        </>
      ) : (
        <EffortTerrain days={days} />
      )}

      <div className="rd-consistency-stats">
        <div><b>{stats.activeDaysRate}%</b><span>Active days</span></div>
        <div><b>{stats.longestStreak} days</b><span>Longest streak</span></div>
        <div><b>{stats.currentStreak} days</b><span>Current streak</span></div>
        <div><b>{stats.vsLastWeek >= 0 ? "+" : ""}{stats.vsLastWeek}%</b><span>vs last week</span></div>
      </div>
    </section>
  );
}
