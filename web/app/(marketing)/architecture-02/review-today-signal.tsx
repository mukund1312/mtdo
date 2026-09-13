"use client";

import type { UseDailySummaryResult } from "./use-daily-summary";

// "TODAY'S SIGNAL" card from the reference mock. Reuses the SAME
// review_daily_summary() fetch ReviewRings already makes (see
// use-daily-summary.ts) -- no second RPC call for this card.

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="a02-signal-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function ReviewTodaySignal({ summary, state, reload }: UseDailySummaryResult) {
  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Today&apos;s signal is unavailable.</b>
        <p>We could not read your daily review. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  if (state === "ready" && summary?.status === "no_active_plan") {
    return (
      <section className="a02-signal-empty" aria-live="polite">
        <header><b>TODAY&apos;S SIGNAL</b></header>
        <p>Set up your route first, then return here for its first useful piece.</p>
      </section>
    );
  }

  if (state === "loading") {
    return (
      <section className="a02-signal-card" aria-busy="true">
        <header><b>TODAY&apos;S SIGNAL</b></header>
        <p className="a02-trait-empty">Reading your day.</p>
      </section>
    );
  }

  const s = summary?.status === "ok" ? summary : null;
  if (!s) return null;

  const averageSession = s.focus.session_count > 0 ? s.focus.focus_minutes / s.focus.session_count : null;

  return (
    <section className="a02-signal-card" aria-label="Today&apos;s signal">
      <header><b>TODAY&apos;S SIGNAL</b></header>
      <div className="a02-signal-rows">
        <Row label="Focus time" value={`${s.focus.focus_minutes}m`} />
        <Row label="Tasks completed" value={`${s.execute.tasks_done} / ${s.execute.tasks_picked}`} />
        <Row label="Sessions" value={String(s.focus.session_count)} />
        <Row label="Average session" value={averageSession == null ? "—" : `${Math.round(averageSession)}m`} />
        <Row label="Longest session" value={`${s.focus.longest_session_minutes}m`} />
        <Row label="Interruptions" value={String(s.focus.pause_count)} />
        <Row label="Tasks rescheduled" value={String(s.execute.regressed_count)} />
      </div>
    </section>
  );
}
