"use client";

import { Sparkles } from "lucide-react";

const INSIGHTS: Array<{ text: React.ReactNode }> = [
  { text: <>You work best in sessions between <b>35–50 minutes</b>.</> },
  { text: <>Your first session started 42 minutes later than planned.</> },
  { text: <>You completed 83% of started tasks, but only 57% of planned tasks.</> },
  { text: <>Most productive time: <b>08:00 – 10:00</b></> },
  { text: <>Highest completion rate: <b>Backend</b></> },
  { text: <>Most postponed: <b>DSA</b></> },
];

export function InsightList() {
  return (
    <section className="rd-card" aria-label="Insights">
      <header className="rd-card-title">INSIGHTS</header>
      <ul className="rd-insight-list">
        {INSIGHTS.map((insight, i) => (
          <li key={i}>
            <Sparkles size={14} className="rd-spark" />
            <span>{insight.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
