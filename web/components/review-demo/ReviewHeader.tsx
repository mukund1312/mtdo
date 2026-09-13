"use client";

import { useState, useRef, useLayoutEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const RANGES = ["Today", "Week", "Month", "6 Weeks", "Year"];

export function ReviewHeader() {
  const [range, setRange] = useState("Today");
  const [date, setDate] = useState(new Date("2025-09-13T00:00:00Z"));
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const el = tabRefs.current[range];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [range]);

  const shiftDate = (delta: number) => {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + delta);
    setDate(next);
  };

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);

  return (
    <div className="rd-header-row">
      <div>
        <span className="rd-eyebrow">REVIEW / <b>TODAY</b></span>
        <h1 className="rd-hero">
          MAKE EFFORT
          <br />
          <em>LEGIBLE.</em>
        </h1>
        <p className="rd-subtitle">Track. Understand. Improve. Repeat.</p>
      </div>

      <div className="rd-header-right">
        <div className="rd-date-nav">
          <button type="button" aria-label="Previous day" onClick={() => shiftDate(-1)}>
            <ChevronLeft size={14} />
          </button>
          <b>{dateLabel}</b>
          <button type="button" aria-label="Next day" onClick={() => shiftDate(1)}>
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="rd-range-tabs" role="tablist" aria-label="Review range">
          <div className="rd-range-pill" style={{ left: pill.left, width: pill.width }} />
          {RANGES.map((r) => (
            <button
              key={r}
              ref={(el) => {
                tabRefs.current[r] = el;
              }}
              role="tab"
              aria-selected={range === r}
              className={range === r ? "is-active" : undefined}
              type="button"
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>

        <blockquote className="rd-card rd-quote-card">
          <p>&ldquo;A little progress each day adds up to big results.&rdquo;</p>
        </blockquote>
      </div>
    </div>
  );
}
