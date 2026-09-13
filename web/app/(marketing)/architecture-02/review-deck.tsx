"use client";

import { useState } from "react";

import { ProgressDeck } from "./progress-deck";
import { ReviewRings } from "./review-rings";

type ReviewRange = "today" | "week" | "month" | "6weeks" | "year";

const RANGES: Array<{ id: ReviewRange; label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "6weeks", label: "6 Weeks" },
  { id: "year", label: "Year" },
];

export function ReviewDeck() {
  const [range, setRange] = useState<ReviewRange>("today");

  return (
    <>
      <section className="a02-review-shell" aria-labelledby="review-title">
        <header className="a02-view-head">
          <div>
            <span className="a02-eyebrow">REVIEW / TODAY</span>
            <h1 className="a02-review-title" id="review-title">MAKE EFFORT<br /><em>LEGIBLE.</em></h1>
            <p>Track. Understand. Improve. Repeat.</p>
          </div>
        </header>

        <div className="a02-review-range" aria-label="Review range">
          {RANGES.map(({ id, label }) => (
            <button
              aria-pressed={range === id}
              className={range === id ? "is-active" : undefined}
              key={id}
              onClick={() => setRange(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {range === "today" ? (
        <>
          <ReviewRings />
          <ProgressDeck />
        </>
      ) : (
        <section className="a02-review a02-review-coming-soon" aria-live="polite">
          <div className="a02-product-state">
            <p>Coming soon</p>
          </div>
        </section>
      )}
    </>
  );
}
