"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  asReviewMomentum,
  asReviewTimePatterns,
  type ReviewMomentum,
  type ReviewTimePatterns,
} from "@/lib/review/types";

import { fetchProfileTimezone } from "./profile-timezone";
import { utcDateRange, utcToday } from "./product-data";

// F4 of docs/designs/review-frontend-briefs.md: "when you work best",
// session quality, and momentum -- all sourced from review_time_patterns()
// (migrations/0028) and review_momentum() (migrations/0029). Neither RPC's
// percentage/best_* fields are re-derived here; every "insufficient data"
// state below is real, not an edge case bolted on afterward.
//
// SCOPE NOTE, deliberately narrower than an earlier draft of this brief:
// streak.ts's computeStreaks() is used by the Home deck (page.tsx) and
// weekly-review.tsx, not by anything Review-specific -- retiring it there
// would be a materially bigger, riskier change than "add a Momentum card"
// and is out of this phase's charter. This card is new, additive content;
// it does not touch either of those existing call sites.

const WINDOW_DAYS = 42;
export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const DURATION_LABELS: Record<string, string> = {
  "<15m": "< 15m",
  "15-30m": "15–30m",
  "30-45m": "30–45m",
  "45-60m": "45–60m",
  "60-90m": "60–90m",
  "90m+": "90m+",
};

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function ReviewTimeBehavior() {
  const [patterns, setPatterns] = useState<ReviewTimePatterns | null>(null);
  const [momentum, setMomentum] = useState<ReviewMomentum | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const userTimezone = await fetchProfileTimezone(supabase, user.id);
    const windowDates = utcDateRange(WINDOW_DAYS, utcToday(userTimezone));

    const [patternsResult, momentumResult] = await Promise.all([
      supabase.rpc("review_time_patterns", { p_start: windowDates[0]!, p_end: windowDates.at(-1)! }),
      supabase.rpc("review_momentum", { p_window_days: WINDOW_DAYS }),
    ]);

    if (patternsResult.error) {
      console.error("[review] failed to load time patterns:", patternsResult.error);
      setState("error");
      return;
    }
    if (momentumResult.error) {
      console.error("[review] failed to load momentum:", momentumResult.error);
      setState("error");
      return;
    }
    try {
      setPatterns(asReviewTimePatterns(patternsResult.data));
      setMomentum(asReviewMomentum(momentumResult.data));
      setState("ready");
    } catch (parseError) {
      console.error("[review] malformed time-behavior response:", parseError);
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
        <b>Your patterns are unavailable.</b>
        <p>We could not read your time behavior. Nothing has been changed.</p>
        <button type="button" onClick={() => void load()}>Try again ↗</button>
      </section>
    );
  }

  const loading = state === "loading";
  const maxHourCount = Math.max(1, ...(patterns?.hourly.map((h) => h.session_count) ?? [0]));
  const maxDurationCount = Math.max(1, ...(patterns?.duration_buckets.map((d) => d.session_count) ?? [0]));

  return (
    <div className="a02-time-behavior">
      <section className="a02-time-window">
        <header><b>WHEN YOU WORK BEST</b></header>
        <div className="a02-hour-bars" aria-label="Sessions by hour of day">
          {(patterns?.hourly ?? []).map((h) => (
            <i
              key={h.hour}
              style={{ height: loading ? "8%" : `${Math.max(6, (h.session_count / maxHourCount) * 100)}%` }}
              title={`${formatHour(h.hour)} · ${h.session_count} session${h.session_count === 1 ? "" : "s"}${
                h.session_completion_rate == null ? "" : ` · ${Math.round(h.session_completion_rate * 100)}% completed`
              }`}
            />
          ))}
        </div>
        <p className="a02-time-window-stat">
          {loading
            ? "Reading your sessions."
            : patterns?.best_hour
              ? `Best start time ${formatHour(patterns.best_hour.hour)} · ${Math.round((patterns.best_hour.session_completion_rate ?? 0) * 100)}% completion`
              : "Not enough sessions yet to identify a reliable pattern."}
        </p>
        <p className="a02-time-window-stat">
          {loading
            ? ""
            : patterns?.best_weekday
              ? `Best day ${WEEKDAY_NAMES[patterns.best_weekday.weekday]}`
              : "Not enough sessions yet to identify a best day."}
        </p>
      </section>

      <section className="a02-session-quality">
        <header><b>SESSION QUALITY</b></header>
        <div className="a02-duration-bars" aria-label="Session length distribution">
          {(patterns?.duration_buckets ?? []).map((d) => (
            <div className="a02-duration-row" key={d.bucket}>
              <span>{DURATION_LABELS[d.bucket] ?? d.bucket}</span>
              <i style={{ width: loading ? "6%" : `${Math.max(3, (d.session_count / maxDurationCount) * 100)}%` }} />
              <b>{loading ? "" : d.session_count}</b>
            </div>
          ))}
        </div>
        <p className="a02-time-window-stat">
          {loading
            ? "Reading your sessions."
            : patterns?.best_duration_bucket
              ? `Sweet spot ${DURATION_LABELS[patterns.best_duration_bucket.bucket] ?? patterns.best_duration_bucket.bucket}`
              : "Not enough sessions yet to identify a sweet spot."}
        </p>
      </section>

      <section className="a02-momentum">
        <header><b>MOMENTUM</b></header>
        {loading ? (
          <strong className="a02-momentum-score">···</strong>
        ) : momentum?.status === "ok" ? (
          <>
            <strong className="a02-momentum-score">{momentum.momentum_score}</strong>
            <p className="a02-time-window-stat">
              {momentum.current_streak} day{momentum.current_streak === 1 ? "" : "s"} current ·{" "}
              {momentum.longest_streak} longest · {Math.round(momentum.active_days_rate * 100)}% active days
            </p>
          </>
        ) : (
          <p className="a02-time-window-stat">Set up your route first, then return here for its first useful piece.</p>
        )}
      </section>
    </div>
  );
}
