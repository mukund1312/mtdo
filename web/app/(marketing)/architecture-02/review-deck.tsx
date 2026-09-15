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
import { WeeklyReviewPanel } from "./weekly-review";

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
  const [sideNav, setSideNav] = useState("Overview");

  // Every fetch lives here, once, shared by whichever cards read it -- never
  // one RPC call per card. See each use-*.ts hook's own header for which
  // cards share it.
  const daily = useDailySummary();
  const momentum = useMomentum();
  const timePatterns = useTimePatterns();
  const consistency = useConsistency();
  const weekly = useWeeklySnapshot();
  const studyProfile = useStudyProfile();

  // A route exists (has_active_plan) but zero active days have ever been
  // recorded -- the "brand-new account" empty state from the reference
  // design, distinct from "no_active_plan" (no route configured at all,
  // handled separately by each card's own early-return).
  const isFreshRoute =
    momentum.state === "ready" && momentum.momentum?.status === "ok" && momentum.momentum.active_days_rate === 0;

  return (
    <div className="a02-review-layout">
      <ReviewSideNav active={sideNav} onSelect={setSideNav} />
      <div className="a02-review-main">
        <section className="a02-review-shell" aria-labelledby="review-title">
          <header className="a02-view-head a02-review-head">
            <div>
              <span className="a02-eyebrow">REVIEW / TODAY</span>
              <h1 className="a02-review-title" id="review-title">MAKE EFFORT<br /><em>LEGIBLE.</em></h1>
              <p>Track. Understand. Improve. Repeat.</p>
              {isFreshRoute && (
                <p className="a02-review-first-time">
                  Your effort history starts today. Complete your first focus session to begin building your study profile.
                </p>
              )}
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

        {sideNav === "Deep Dive" ? (
          // Deep Dive: the Study Profile, moved out of the Today flow per
          // the audit -- it's a standing behavioral profile, not a "what
          // happened today" observation, so it doesn't belong stacked under
          // the Today dashboard's 11 core blocks.
          <ReviewStudyProfile {...studyProfile} />
        ) : range === "today" ? (
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
          </>
        ) : range === "week" ? (
          // Week: the weekly engine's real numbers and accept/reject
          // proposal review -- previously mounted unconditionally under
          // Today via ProgressDeck; now lives where it's actually scoped.
          <WeeklyReviewPanel />
        ) : range === "6weeks" ? (
          // 6 Weeks: the 42-day consistency pulse + Record Card export --
          // previously mounted unconditionally under Today; same component,
          // now only rendered when this scope is actually selected.
          <ProgressDeck />
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
