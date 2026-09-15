"use client";

import { useMemo, useState } from "react";

import type { ConsistencyDay } from "@/lib/review/types";

import type { UseConsistencyResult } from "./use-consistency";
import { ReviewEffortTerrain3D } from "./review-effort-terrain-3d";

// "CONSISTENCY — LAST 365 DAYS" from the reference mock: a real GitHub-style
// calendar grid (columns = weeks, rows = Mon..Sun), colored by
// review_consistency()'s server-computed Effort Score (migrations/0026/0027)
// -- never raw minutes. level:null (no active plan that day) renders as the
// existing hatched pattern, distinct from a real level:0.
//
// "Terrain" is a secondary view of the SAME per-day data as a real 3D grid
// (react-three-fiber -- see review-effort-terrain-3d.tsx), ported from the
// /architecture-02/review-demo reference route once the R3F/drei dependency
// was already in package.json. Heatmap stays the default view.

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function buildWeeks(days: ConsistencyDay[]): (ConsistencyDay | null)[][] {
  if (days.length === 0) return [];
  const first = new Date(`${days[0]!.date}T00:00:00Z`);
  const firstWeekday = (first.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const padded: (ConsistencyDay | null)[] = [...Array(firstWeekday).fill(null), ...days];
  const weeks: (ConsistencyDay | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
  return weeks;
}

function monthLabelFor(week: (ConsistencyDay | null)[], previousMonth: number | null): number | null {
  const firstReal = week.find((d) => d !== null);
  if (!firstReal) return null;
  const month = new Date(`${firstReal.date}T00:00:00Z`).getUTCMonth();
  return month !== previousMonth ? month : null;
}

export function ReviewConsistencyHeatmap({ consistency, state, reload }: UseConsistencyResult) {
  const [view, setView] = useState<"heatmap" | "terrain">("heatmap");

  const days = useMemo(() => consistency?.days ?? [], [consistency]);
  const weeks = useMemo(() => buildWeeks(days), [days]);

  const activeDayCount = days.filter((d) => d.level !== null && d.level > 0).length;
  const activeDaysRate = days.length > 0 ? activeDayCount / days.length : 0;

  const { longestStreak, currentStreak } = useMemo(() => {
    let longest = 0;
    let running = 0;
    let current = 0;
    for (const d of days) {
      const active = d.level !== null && d.level > 0;
      running = active ? running + 1 : 0;
      longest = Math.max(longest, running);
    }
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i]!;
      if (d.level !== null && d.level > 0) current += 1;
      else break;
    }
    return { longestStreak: longest, currentStreak: current };
  }, [days]);

  // review_consistency()'s window always ends today -- see use-consistency.ts.
  const todayDate = days.at(-1)?.date ?? null;

  // Client-side only, from the SAME days[] the heatmap already renders --
  // not a new RPC field. "—" (not a fabricated 0%) when there's no prior
  // week to compare against yet.
  const vsLastWeek = useMemo(() => {
    if (days.length < 14) return null;
    const countActive = (slice: ConsistencyDay[]) => slice.filter((d) => d.level !== null && d.level > 0).length;
    const last7 = countActive(days.slice(-7));
    const prior7 = countActive(days.slice(-14, -7));
    if (prior7 === 0) return last7 === 0 ? null : 100;
    return Math.round(((last7 - prior7) / prior7) * 100);
  }, [days]);

  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Consistency is unavailable.</b>
        <p>We could not read your recorded activity. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  return (
    <section className="a02-consistency" aria-label="Consistency, last 365 days">
      <header>
        <b>CONSISTENCY — LAST 365 DAYS</b>
        <div className="a02-view-toggle">
          <button type="button" aria-pressed={view === "heatmap"} className={view === "heatmap" ? "is-active" : undefined} onClick={() => setView("heatmap")}>Heatmap</button>
          <button type="button" aria-pressed={view === "terrain"} className={view === "terrain" ? "is-active" : undefined} onClick={() => setView("terrain")}>Terrain</button>
        </div>
      </header>

      {view === "heatmap" ? (
        <div className="a02-year-grid" aria-busy={state === "loading"}>
          <div className="a02-year-grid-months">
            {weeks.map((week, i) => {
              const label = monthLabelFor(week, i > 0 ? monthOfWeek(weeks[i - 1]!) : null);
              return <span key={i}>{label !== null ? MONTH_LABELS[label] : ""}</span>;
            })}
          </div>
          <div className="a02-year-grid-body">
            <div className="a02-year-grid-weekdays">
              {WEEKDAY_LABELS.map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className="a02-year-grid-weeks">
              {weeks.map((week, wi) => (
                <div className="a02-year-grid-week" key={wi}>
                  {week.map((day, di) => {
                    if (!day) return <i key={di} className="is-empty" aria-hidden="true" />;
                    const isToday = day.date === todayDate;
                    const isActive = day.level !== null && day.level > 0;
                    const levelClass = day.level === null ? "level-none" : `level-${day.level}`;
                    const title = isToday
                      ? isActive
                        ? `${day.date} · effort ${day.effort_score}`
                        : "Today · Your journey starts here"
                      : isActive
                        ? `${day.date} · effort ${day.effort_score}${
                            day.focus_percentage != null ? ` · focus ${day.focus_percentage}%` : ""
                          }${day.execute_percentage != null ? ` · execute ${day.execute_percentage}%` : ""}`
                        : `${day.date} · No activity`;
                    return (
                      <i
                        key={di}
                        className={`${levelClass}${isToday ? " is-today" : ""}`}
                        title={title}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="a02-year-grid-legend">
            <span>Less</span>
            <i className="level-none" /><i className="level-1" /><i className="level-2" /><i className="level-3" /><i className="level-4" />
            <span>More</span>
          </div>
        </div>
      ) : (
        <ReviewEffortTerrain3D days={days} />
      )}

      <div className="a02-consistency-stats">
        <div><b>{Math.round(activeDaysRate * 100)}%</b><span>Active days</span></div>
        <div><b>{longestStreak} days</b><span>Longest streak</span></div>
        <div><b>{currentStreak} days</b><span>Current streak</span></div>
        <div><b>{vsLastWeek === null ? "—" : `${vsLastWeek >= 0 ? "+" : ""}${vsLastWeek}%`}</b><span>vs last week</span></div>
      </div>
    </section>
  );
}

function monthOfWeek(week: (ConsistencyDay | null)[]): number | null {
  const firstReal = week.find((d) => d !== null);
  return firstReal ? new Date(`${firstReal.date}T00:00:00Z`).getUTCMonth() : null;
}
