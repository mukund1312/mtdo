"use client";

import { useMemo, useState } from "react";

import type { ConsistencyDay } from "@/lib/review/types";

import type { UseConsistencyResult } from "./use-consistency";

// "CONSISTENCY — LAST 365 DAYS" from the reference mock: a real GitHub-style
// calendar grid (columns = weeks, rows = Mon..Sun), colored by
// review_consistency()'s server-computed Effort Score (migrations/0026/0027)
// -- never raw minutes. level:null (no active plan that day) renders as the
// existing hatched pattern, distinct from a real level:0.
//
// "Terrain" is a secondary, simplified view of the SAME per-day data (a
// stylized CSS skyline, not a real 3D/WebGL render -- adding a 3D library is
// a dependency decision this file doesn't make unilaterally). Heatmap stays
// the default view.

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
                  {week.map((day, di) =>
                    day ? (
                      <i
                        key={di}
                        className={day.level === null ? "level-none" : `level-${day.level}`}
                        title={`${day.date} · effort ${day.level === null ? "—" : day.effort_score}${
                          day.focus_percentage != null ? ` · focus ${day.focus_percentage}%` : ""
                        }${day.execute_percentage != null ? ` · execute ${day.execute_percentage}%` : ""}`}
                      />
                    ) : (
                      <i key={di} className="is-empty" aria-hidden="true" />
                    ),
                  )}
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
        <ReviewEffortTerrain days={days} />
      )}

      <div className="a02-consistency-stats">
        <div><b>{Math.round(activeDaysRate * 100)}%</b><span>Active days</span></div>
        <div><b>{longestStreak} days</b><span>Longest streak</span></div>
        <div><b>{currentStreak} days</b><span>Current streak</span></div>
      </div>
    </section>
  );
}

function monthOfWeek(week: (ConsistencyDay | null)[]): number | null {
  const firstReal = week.find((d) => d !== null);
  return firstReal ? new Date(`${firstReal.date}T00:00:00Z`).getUTCMonth() : null;
}

/**
 * A stylized CSS "skyline" over the same per-day effort scores -- not a real
 * 3D/WebGL render. Bar height = effort_score, color ramps with level, a
 * subtle skew approximates depth without a new rendering dependency.
 */
function ReviewEffortTerrain({ days }: { days: ConsistencyDay[] }) {
  const [hovered, setHovered] = useState<ConsistencyDay | null>(null);
  return (
    <div className="a02-terrain" onMouseLeave={() => setHovered(null)}>
      <div className="a02-terrain-bars">
        {days.map((d) => (
          <i
            key={d.date}
            className={d.level === null ? "level-none" : `level-${d.level}`}
            style={{ height: `${Math.max(3, d.effort_score ?? 0)}%` }}
            onMouseEnter={() => setHovered(d)}
          />
        ))}
      </div>
      {hovered && (
        <div className="a02-terrain-tooltip">
          <b>{hovered.date}</b>
          <span>Effort {hovered.level === null ? "—" : hovered.effort_score}</span>
          {hovered.focus_percentage != null && <span>Focus {hovered.focus_percentage}%</span>}
          {hovered.execute_percentage != null && <span>Execute {hovered.execute_percentage}%</span>}
        </div>
      )}
    </div>
  );
}
