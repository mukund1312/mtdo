"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { asReviewDailySummary, type ReviewDailySummary } from "@/lib/review/types";

// F2 of docs/designs/review-frontend-briefs.md. Reads review_daily_summary()
// (migrations/0025, api.md sec3j) and renders it as three rings -- never
// re-derives a percentage client-side. `null` on any field means "no basis
// to compute this," not zero, and is rendered as such, not as a fake 0%.

type RingKind = "focus" | "execute" | "progress";

const RING_META: Record<RingKind, { label: string; subtitle: string; empty: string }> = {
  focus: { label: "FOCUS", subtitle: "Deep work time", empty: "No target set yet" },
  execute: { label: "EXECUTE", subtitle: "Tasks completed", empty: "Nothing planned today" },
  progress: { label: "PROGRESS", subtitle: "Goal advancement", empty: "No category picked this week" },
};

// The three a02-scoped hues (signal-deck.css) closest to the reference mock's
// pink/lime/blue, reusing the product's own existing palette rather than a
// disconnected token set -- see docs/designs/mtdo-web-review-study-profile-plan.md
// sec6 for why Progress is --cobalt (a new, non-purple addition) rather than
// the already-present --ultra.
const RING_COLOR: Record<RingKind, string> = {
  focus: "var(--coral)",
  execute: "var(--acid)",
  progress: "var(--cobalt)",
};

export function ReviewRings() {
  const [summary, setSummary] = useState<ReviewDailySummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const { data, error } = await supabase.rpc("review_daily_summary", {});
    if (error) {
      console.error("[review] failed to load daily summary:", error);
      setState("error");
      return;
    }
    try {
      setSummary(asReviewDailySummary(data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed daily summary:", parseError);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Today&apos;s rings are unavailable.</b>
        <p>We could not read your daily review. Your data is unchanged.</p>
        <button type="button" onClick={() => void load()}>Try again ↗</button>
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

  return (
    <section className="a02-review-rings" aria-label="Today's rings">
      <Ring
        kind="focus"
        loading={state === "loading"}
        percentage={ok?.focus.percentage ?? null}
        value={ok ? `${ok.focus.focus_minutes} / ${ok.focus.target_minutes ?? "—"} min` : undefined}
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
        percentage={ok?.execute.percentage ?? null}
        value={ok ? `${ok.execute.tasks_done} / ${ok.execute.tasks_picked} tasks` : undefined}
        detail={ok ? [`score ${ok.execute.score} / ${ok.execute.score_max}`] : []}
      />
      <Ring
        kind="progress"
        loading={state === "loading"}
        percentage={ok?.progress.percentage ?? null}
        value={ok ? `${ok.progress.week_score} / ${ok.progress.week_score_max} pts` : undefined}
        detail={ok ? [`this week's goal so far`] : []}
      />
    </section>
  );
}

function Ring({
  kind,
  percentage,
  value,
  detail,
  loading,
}: {
  kind: RingKind;
  percentage: number | null;
  value?: string;
  detail: string[];
  loading: boolean;
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
      <span className="a02-ring-subtitle">{meta.subtitle}</span>
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
