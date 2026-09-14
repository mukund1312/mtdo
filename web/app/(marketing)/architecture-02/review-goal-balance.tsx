"use client";

import { useState } from "react";

import type { CategoryPerformance } from "@/lib/planning/types";

import type { UseWeeklySnapshotResult } from "./use-weekly-snapshot";

// "GOAL / SUBJECT BALANCE" from the reference mock. Shares
// weekly_performance() with ReviewPlanVsReality (use-weekly-snapshot.ts).
// "Planned" allocation is each category's resolved current_target as a
// share of the sum of all categories' targets -- the same resolved-target
// number the weekly engine itself uses as its own baseline (api.md sec3f),
// not a new metric. "Actual" is real time or real tasks, by toggle.

const SUBJECT_COLORS = ["--ultra", "--coral", "--aqua", "--cobalt", "--acid"];

function actualValue(c: CategoryPerformance, mode: "time" | "tasks"): number {
  return mode === "time" ? c.actual_minutes : c.done_count;
}

export function ReviewGoalBalance({ weekly, state, reload }: UseWeeklySnapshotResult) {
  const [mode, setMode] = useState<"time" | "tasks">("time");

  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Goal balance is unavailable.</b>
        <p>We could not read your route&apos;s categories. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  if (state === "no_active_plan") {
    return (
      <section className="a02-goal-balance-empty" aria-live="polite">
        <header><b>GOAL / SUBJECT BALANCE</b></header>
        <p>Set up your route first, then return here for its first useful piece.</p>
      </section>
    );
  }

  const loading = state === "loading";
  const categories = weekly?.categories ?? [];

  // A route exists but this week has no tracked categories yet -- distinct
  // from "no route at all" above. No categories to show planned/actual
  // splits for, so this points at the real place to add them rather than
  // fabricating a category list.
  if (!loading && categories.length === 0) {
    return (
      <section className="a02-goal-balance-empty" aria-live="polite">
        <header><b>GOAL / SUBJECT BALANCE</b></header>
        <p>No subjects yet.</p>
        <p>Add goals to track where your study time goes.</p>
        <a className="a02-goal-balance-cta" href="/architecture-02?deck=goals">Set up goals →</a>
      </section>
    );
  }
  const totalTarget = categories.reduce((n, c) => n + c.current_target, 0);
  const totalActual = categories.reduce((n, c) => n + actualValue(c, mode), 0);

  const rows = categories
    .map((c) => ({
      c,
      plannedPct: totalTarget > 0 ? (c.current_target / totalTarget) * 100 : 0,
      actualPct: totalActual > 0 ? (actualValue(c, mode) / totalActual) * 100 : 0,
    }))
    .sort((a, b) => b.actualPct - a.actualPct);

  return (
    <section className="a02-goal-balance" aria-label="Goal and subject balance">
      <header>
        <b>GOAL / SUBJECT BALANCE</b>
        <div className="a02-view-toggle">
          <button type="button" aria-pressed={mode === "time"} className={mode === "time" ? "is-active" : undefined} onClick={() => setMode("time")}>Time</button>
          <button type="button" aria-pressed={mode === "tasks"} className={mode === "tasks" ? "is-active" : undefined} onClick={() => setMode("tasks")}>Tasks</button>
        </div>
      </header>

      <div className="a02-goal-balance-bars">
        {rows.map(({ c, actualPct }, i) => (
          <div className="a02-goal-balance-row" key={c.category_id}>
            <span>{c.label}</span>
            <i style={{ width: loading ? "20%" : `${Math.max(2, actualPct)}%`, background: `var(${SUBJECT_COLORS[i % SUBJECT_COLORS.length]})` }} />
            <b>{loading ? "" : `${Math.round(actualPct)}%`}</b>
          </div>
        ))}
      </div>

      <table className="a02-goal-balance-table">
        <thead>
          <tr><th></th><th>Planned</th><th>Actual</th><th>Δ</th></tr>
        </thead>
        <tbody>
          {rows.map(({ c, plannedPct, actualPct }) => {
            const delta = Math.round(actualPct - plannedPct);
            return (
              <tr key={c.category_id}>
                <td>{c.label}</td>
                <td>{Math.round(plannedPct)}%</td>
                <td>{Math.round(actualPct)}%</td>
                <td className={delta > 0 ? "is-positive" : delta < 0 ? "is-negative" : undefined}>
                  {delta > 0 ? `+${delta}%` : `${delta}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
