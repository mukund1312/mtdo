"use client";

import { useState } from "react";

import type { ReviewDemoDay } from "@/data/review-demo-data";
import { goalBalance } from "@/lib/review-demo/analytics";

const SUBJECTS: Array<{ key: "backend" | "dsa" | "sql" | "systemDesign"; label: string; color: string }> = [
  { key: "backend", label: "Backend", color: "#8b5cf6" },
  { key: "dsa", label: "DSA", color: "#3dd9ff" },
  { key: "sql", label: "SQL", color: "#3dd9ff" },
  { key: "systemDesign", label: "System Design", color: "#3dd9ff" },
];

export function SubjectBalance({ days }: { days: ReviewDemoDay[] }) {
  const [mode, setMode] = useState<"time" | "tasks">("time");
  const { actual, planned } = goalBalance(days);

  return (
    <section className="rd-card" aria-label="Goal and subject balance">
      <div className="rd-goal-head">
        <span className="rd-card-title" style={{ padding: 0 }}>GOAL / SUBJECT BALANCE</span>
        <div className="rd-segmented">
          <button type="button" className={mode === "time" ? "is-active" : undefined} onClick={() => setMode("time")}>Time</button>
          <button type="button" className={mode === "tasks" ? "is-active" : undefined} onClick={() => setMode("tasks")}>Tasks</button>
        </div>
      </div>

      <div className="rd-goal-bars">
        {SUBJECTS.map((s) => (
          <div className="rd-goal-bar-row" key={s.key}>
            <span>{s.label}</span>
            <div className="rd-goal-bar-track">
              <div className="rd-goal-bar-fill" style={{ width: `${actual[s.key]}%`, background: s.color }} />
            </div>
            <b>{actual[s.key]}%</b>
          </div>
        ))}
      </div>

      <table className="rd-goal-table">
        <thead>
          <tr>
            <th></th>
            <th>Planned</th>
            <th>Actual</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {SUBJECTS.map((s) => {
            const delta = actual[s.key] - planned[s.key];
            return (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td>{planned[s.key]}%</td>
                <td>{actual[s.key]}%</td>
                <td className={delta >= 0 ? "positive" : "negative"}>{delta >= 0 ? "+" : ""}{delta}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
