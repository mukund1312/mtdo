"use client";

import { Clock3, CheckCircle2, Timer, Gauge, Flame, AlertTriangle, RefreshCw } from "lucide-react";

import type { ReviewDemoDay } from "@/data/review-demo-data";
import { formatMinutes } from "@/lib/review-demo/analytics";

export function TodaysSignal({ today }: { today: ReviewDemoDay }) {
  const avgSession = today.sessions.length > 0 ? Math.round(today.focusMinutes / today.sessions.length) : 0;
  const longest = today.sessions.length > 0 ? Math.max(...today.sessions.map((s) => s.minutes)) : 0;

  const rows: Array<[React.ReactNode, string, string]> = [
    [<Clock3 key="i" size={13} />, "Focus time", formatMinutes(today.focusMinutes)],
    [<CheckCircle2 key="i" size={13} />, "Tasks completed", `${today.tasksCompleted} / ${today.tasksPlanned}`],
    [<Timer key="i" size={13} />, "Sessions", String(today.sessions.length)],
    [<Gauge key="i" size={13} />, "Average session", `${avgSession}m`],
    [<Flame key="i" size={13} />, "Longest session", `${longest}m`],
    [<AlertTriangle key="i" size={13} />, "Interruptions", String(today.interruptions)],
    [<RefreshCw key="i" size={13} />, "Tasks rescheduled", String(today.rescheduled)],
  ];

  return (
    <section className="rd-card" aria-label="Today's signal">
      <header className="rd-card-title">TODAY&apos;S SIGNAL</header>
      <div className="rd-signal-rows">
        {rows.map(([icon, label, value]) => (
          <div className="rd-signal-row-item" key={label}>
            <span>{icon}{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </section>
  );
}
