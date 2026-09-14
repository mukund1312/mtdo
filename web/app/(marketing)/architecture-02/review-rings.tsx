"use client";

import type { UseDailySummaryResult } from "./use-daily-summary";
import type { UseMomentumResult } from "./use-momentum";

// F2 of docs/designs/review-frontend-briefs.md, extended to match the
// reference mock exactly: Focus/Execute/Progress rings plus a fourth
// "DAILY SCORE" card (review_momentum()'s smoothed score, not a new metric).
// Presentational -- the fetches live in ReviewDeck (use-daily-summary.ts,
// use-momentum.ts) and are shared with ReviewTodaySignal.
//
// COLOR REVERSAL, disclosed: Progress now uses --ultra (purple), matching
// the reference mock exactly. --ultra already exists and is used elsewhere
// in this exact file (signal-deck.css) -- this is not a new color, and
// reverses this plan's earlier "no purple" call, made before the mock's
// exact-match instruction. See docs/designs/mtdo-web-review-study-profile-plan.md.

type RingKind = "focus" | "execute" | "progress";

const RING_META: Record<RingKind, { label: string; subtitle: string; empty: string; emptySubtitle: string }> = {
  focus: { label: "FOCUS", subtitle: "Deep work time", empty: "0 / 120 min", emptySubtitle: "Start your first session" },
  execute: { label: "EXECUTE", subtitle: "Tasks completed", empty: "No tasks yet", emptySubtitle: "Add a task to begin" },
  progress: { label: "PROGRESS", subtitle: "Goal advancement", empty: "0 / 100 xp", emptySubtitle: "Progress appears here" },
};

const RING_COLOR: Record<RingKind, string> = {
  focus: "var(--coral)",
  execute: "var(--acid)",
  progress: "var(--ultra)",
};

export function ReviewRings({
  daily,
  momentum,
}: {
  daily: UseDailySummaryResult;
  momentum: UseMomentumResult;
}) {
  const { summary, state } = daily;

  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Today&apos;s rings are unavailable.</b>
        <p>We could not read your daily review. Your data is unchanged.</p>
        <button type="button" onClick={daily.reload}>Try again ↗</button>
      </section>
    );
  }

  if (state === "ready" && summary?.status === "no_active_plan") {
    return (
      <section className="a02-review-rings-empty" aria-live="polite">
        <p>Set up your route first, then return here for its first useful piece.</p>
      </section>
    );
  }

  const ok = state === "ready" && summary?.status === "ok" ? summary : null;
  // A fresh route with zero tasks picked today is a real, honest "no tasks"
  // -- distinct from percentage:0 (tasks picked but none done yet), which
  // still renders as a real 0% ring per the no-fabrication rule elsewhere
  // in this file.
  const noTasksToday = ok != null && ok.execute.tasks_picked === 0;

  return (
    <section className="a02-review-rings" aria-label="Today&apos;s rings">
      <Ring
        kind="focus"
        loading={state === "loading"}
        percentage={ok?.focus.percentage ?? null}
        value={ok ? `${ok.focus.focus_minutes} / ${ok.focus.target_minutes ?? "—"} min` : undefined}
        subtitleOverride={ok && ok.focus.session_count === 0 ? RING_META.focus.emptySubtitle : undefined}
        detail={
          ok
            ? [
                `${ok.focus.session_count} session${ok.focus.session_count === 1 ? "" : "s"}`,
                `${ok.focus.completed_sessions} completed`,
                `${ok.focus.longest_session_minutes}m longest`,
              ]
            : []
        }
      />
      <Ring
        kind="execute"
        loading={state === "loading"}
        percentage={noTasksToday ? null : (ok?.execute.percentage ?? null)}
        value={ok ? (noTasksToday ? "No tasks yet" : `${ok.execute.tasks_done} / ${ok.execute.tasks_picked} tasks`) : undefined}
        subtitleOverride={noTasksToday ? RING_META.execute.emptySubtitle : undefined}
        detail={ok && !noTasksToday ? [`score ${ok.execute.score} / ${ok.execute.score_max}`] : []}
      />
      <Ring
        kind="progress"
        loading={state === "loading"}
        percentage={ok?.progress.percentage ?? null}
        value={ok ? `${ok.progress.week_score} / ${ok.progress.week_score_max} pts` : undefined}
        subtitleOverride={ok && ok.progress.week_score_max === 0 ? RING_META.progress.emptySubtitle : undefined}
        detail={ok && ok.progress.week_score_max > 0 ? [`this week's goal so far`] : []}
      />
      <DailyScore momentum={momentum} />
    </section>
  );
}

function DailyScore({ momentum }: { momentum: UseMomentumResult }) {
  const { momentum: m, state } = momentum;
  const loading = state === "loading";
  const ok = state === "ready" && m?.status === "ok" ? m : null;
  // A real 0 momentum score with zero active days ever recorded reads as
  // "no score yet" rather than a poor score -- distinct from a real 0 on
  // an account with some history but a currently-cold streak.
  const isFreshAccount = ok != null && ok.momentum_score === 0 && ok.active_days_rate === 0;
  const score = ok != null && !isFreshAccount ? ok.momentum_score : null;
  const circumference = 2 * Math.PI * 50;
  const offset = loading || score == null ? circumference : circumference * (1 - Math.min(100, score) / 100);

  const label =
    score == null
      ? null
      : score >= 75
        ? "Good Momentum"
        : score >= 50
          ? "Building Momentum"
          : score >= 25
            ? "Low Momentum"
            : "Just Getting Started";

  return (
    <article className="a02-daily-score" tabIndex={0}>
      <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
        <circle cx="60" cy="60" r="50" className="a02-ring-track" />
        <circle
          cx="60"
          cy="60"
          r="50"
          className="a02-ring-arc"
          style={{ stroke: "var(--acid)", strokeDasharray: circumference, strokeDashoffset: offset }}
        />
      </svg>
      <div className="a02-daily-score-body">
        <b>{loading ? "···" : score ?? "—"}</b>
        <span>/ 100</span>
      </div>
      <div className="a02-daily-score-copy">
        <b>{loading ? "" : label ?? "No score yet"}</b>
        {!loading && (isFreshAccount || !ok) && (
          <p>Your daily score appears after your first study session.</p>
        )}
        {ok && !isFreshAccount && (
          <p>
            {ok.current_streak} day{ok.current_streak === 1 ? "" : "s"} current streak ·{" "}
            {Math.round(ok.active_days_rate * 100)}% active over the last {ok.window_days} days.
          </p>
        )}
      </div>
    </article>
  );
}

function Ring({
  kind,
  percentage,
  value,
  detail,
  loading,
  subtitleOverride,
}: {
  kind: RingKind;
  percentage: number | null;
  value?: string;
  detail: string[];
  loading: boolean;
  subtitleOverride?: string;
}) {
  const meta = RING_META[kind];
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const clamped = percentage == null ? 0 : Math.max(0, Math.min(100, percentage));
  const offset = loading ? circumference : circumference * (1 - clamped / 100);

  return (
    <article className={`a02-ring a02-ring--${kind}`} tabIndex={0}>
      <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
        <circle cx="60" cy="60" r={radius} className="a02-ring-track" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          className="a02-ring-arc"
          style={{
            stroke: RING_COLOR[kind],
            strokeDasharray: circumference,
            strokeDashoffset: offset,
          }}
        />
      </svg>
      <div className="a02-ring-body">
        <b className="a02-ring-pct">{loading ? "···" : percentage == null ? "—" : `${Math.round(percentage)}%`}</b>
        <span className="a02-ring-value">{loading ? "" : value ?? meta.empty}</span>
      </div>
      <span className="a02-ring-label">{meta.label}</span>
      <span className="a02-ring-subtitle">{subtitleOverride ?? meta.subtitle}</span>
      {!loading && detail.length > 0 && (
        <div className="a02-ring-tooltip" role="tooltip">
          {detail.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
    </article>
  );
}
