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

export function ReviewConsistencyHeatmap({ consistency, state, reload, windowDays = 365 }: UseConsistencyResult & { windowDays?: number }) {
  const [view, setView] = useState<"heatmap" | "terrain">("heatmap");

  const days = useMemo(() => consistency?.days ?? [], [consistency]);
  const weeks = useMemo(() => buildWeeks(days), [days]);

  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Consistency is unavailable.</b>
        <p>We could not read your recorded activity. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  if (state === "loading") {
    return (
      <section className="a02-consistency" aria-busy="true" aria-label={`Consistency, last ${windowDays} days`}>
        <header><b>CONSISTENCY — LAST {windowDays} DAYS</b></header>
        <p className="a02-trait-empty">Reading your recorded consistency.</p>
      </section>
    );
  }

  if (!consistency || days.length === 0) {
    return (
      <section className="a02-product-state" aria-live="polite">
        <b>No consistency days are available yet.</b>
        <p>Your recorded activity will appear here once the server has a day to review.</p>
      </section>
    );
  }

  if (consistency.plan_id === null) {
    return (
      <section className="a02-product-state" aria-live="polite">
        <b>No goal route was active in this period.</b>
        <p>Set up your route first, then return here for its first useful consistency signal.</p>
      </section>
    );
  }

  // review_consistency()'s window always ends today -- see use-consistency.ts.
  const todayDate = days.at(-1)?.date ?? null;

  return (
    <section className="a02-consistency" aria-label={`Consistency, last ${windowDays} days`}>
      <header>
        <b>CONSISTENCY — LAST {windowDays} DAYS</b>
        <div className="a02-view-toggle">
          <button type="button" aria-pressed={view === "heatmap"} className={view === "heatmap" ? "is-active" : undefined} onClick={() => setView("heatmap")}>Heatmap</button>
          <button type="button" aria-pressed={view === "terrain"} className={view === "terrain" ? "is-active" : undefined} onClick={() => setView("terrain")}>Terrain</button>
        </div>
      </header>

      {view === "heatmap" ? (
        <div className="a02-year-grid">
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
    </section>
  );
}

function monthOfWeek(week: (ConsistencyDay | null)[]): number | null {
  const firstReal = week.find((d) => d !== null);
  return firstReal ? new Date(`${firstReal.date}T00:00:00Z`).getUTCMonth() : null;
}
