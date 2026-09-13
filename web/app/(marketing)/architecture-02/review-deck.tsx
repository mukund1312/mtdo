"use client";

import { useState } from "react";

import { ReviewSideNav } from "./review-side-nav";
import { ReviewQuote } from "./review-quote";
import { ReviewRings } from "./review-rings";
import { ReviewTodaySignal } from "./review-today-signal";
import { ReviewInsights } from "./review-insights";
import { ReviewFocusDistribution } from "./review-focus-distribution";
import { ReviewConsistencyHeatmap } from "./review-consistency-heatmap";
import { ReviewSessionQuality } from "./review-session-quality";
import { ReviewPlanVsReality } from "./review-plan-vs-reality";
import { ReviewGoalBalance } from "./review-goal-balance";
import { ReviewStudyProfile } from "./review-study-profile";
import { ProgressDeck } from "./progress-deck";

import { useDailySummary } from "./use-daily-summary";
import { useMomentum } from "./use-momentum";
import { useTimePatterns } from "./use-time-patterns";
import { useConsistency } from "./use-consistency";
import { useWeeklySnapshot } from "./use-weekly-snapshot";
import { useStudyProfile } from "./use-study-profile";

type ReviewRange = "today" | "week" | "month" | "6weeks" | "year";

const RANGES: Array<{ id: ReviewRange; label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "6weeks", label: "6 Weeks" },
  { id: "year", label: "Year" },
];

function todayLabel(): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date());
}

export function ReviewDeck() {
  const [range, setRange] = useState<ReviewRange>("today");

  // Every fetch lives here, once, shared by whichever cards read it -- never
  // one RPC call per card. See each use-*.ts hook's own header for which
  // cards share it.
  const daily = useDailySummary();
  const momentum = useMomentum();
  const timePatterns = useTimePatterns();
  const consistency = useConsistency();
  const weekly = useWeeklySnapshot();
  const studyProfile = useStudyProfile();

  return (
    <div className="a02-review-layout">
      <ReviewSideNav />
      <div className="a02-review-main">
        <section className="a02-review-shell" aria-labelledby="review-title">
          <header className="a02-view-head a02-review-head">
            <div>
              <span className="a02-eyebrow">REVIEW / TODAY</span>
              <h1 className="a02-review-title" id="review-title">MAKE EFFORT<br /><em>LEGIBLE.</em></h1>
              <p>Track. Understand. Improve. Repeat.</p>
            </div>
            <div className="a02-review-head-right">
              <div className="a02-review-date-nav">
                <button type="button" aria-label="Previous day" disabled>‹</button>
                <b>{todayLabel()}</b>
                <button type="button" aria-label="Next day" disabled>›</button>
              </div>
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
            </div>
          </header>
          <ReviewQuote />
        </section>

        {range === "today" ? (
          <>
            <ReviewRings daily={daily} momentum={momentum} />

            <div className="a02-signal-row">
              <ReviewTodaySignal {...daily} />
              <ReviewInsights {...studyProfile} />
              <ReviewFocusDistribution {...timePatterns} />
            </div>

            <ReviewConsistencyHeatmap {...consistency} />

            <div className="a02-bottom-row">
              <ReviewSessionQuality {...timePatterns} />
              <ReviewPlanVsReality {...weekly} />
              <ReviewGoalBalance {...weekly} />
            </div>

            <ReviewStudyProfile {...studyProfile} />

            {/* Not in the reference mock's screenshot, but ProgressDeck is
                the ONLY place in the app that renders (a) the six-week
                consistency heatmap + Record Card export dialog (real,
                tested functionality -- e2e/onboarding.spec.ts's "Review
                shows an honest empty heatmap and view-only Record Card")
                and (b) the weekly engine's accept/reject proposal UI, which
                it mounts internally (WeeklyReviewPanel). Kept mounted below
                the fold rather than silently cutting off reachability to
                real, working functionality -- flagged to the user directly,
                not buried. Do not also import WeeklyReviewPanel directly
                here -- ProgressDeck already renders it, and a second mount
                would duplicate it on the page. */}
            <ProgressDeck />
          </>
        ) : (
          <section className="a02-review a02-review-coming-soon" aria-live="polite">
            <div className="a02-product-state">
              <p>Coming soon</p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
