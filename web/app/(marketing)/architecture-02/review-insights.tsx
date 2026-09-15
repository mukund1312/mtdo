"use client";

import { buildReviewInsights } from "@/lib/review/insights";

import type { UseStudyProfileResult } from "./use-study-profile";

// F6 of docs/designs/review-frontend-briefs.md: the Insights card. Reads the
// SAME study_profile() result ReviewStudyProfile (F5) already fetched --
// see use-study-profile.ts -- and runs it through buildReviewInsights()
// (Phase E, pure TS, no I/O, no AI). This card has no loading/error state of
// its own: it inherits F5's fetch state entirely.

const SEVERITY_GLYPH: Record<string, string> = {
  positive: "a02-insight-glyph--acid",
  notice: "a02-insight-glyph--aqua",
  info: "a02-insight-glyph--aqua",
};

// Shown for a route with truly zero history -- unlock conditions, not
// analytics. Static copy, not derived from any RPC: nothing here claims to
// be a computed fact about the user's data.
//
// Gated on active_days_rate === 0, NOT insights.length === 0: consistency_dip
// fires for any active_days_rate below CONSISTENCY_DIP_MAX (0.3), which a
// brand-new account's real 0% always clears -- so buildReviewInsights()
// never actually returns [] for the fresh-account case this list exists
// for. Checking insights.length here made this branch dead code in
// practice (caught by comparing an actual "empty" render against the
// original design mock -- the real page always showed the one factual
// consistency insight instead of this guidance).
const UNLOCK_CONDITIONS = [
  "Complete your first focus session to unlock session-quality insights.",
  "Finish a few tasks to learn when you're most productive.",
  "Build 3–5 study days and MTDO will begin identifying your patterns.",
  "Your strongest subjects, weak spots, and consistency trends will appear here.",
];

export function ReviewInsights({ profile, state }: UseStudyProfileResult) {
  // Always renders a card with its header -- a null return here left a
  // visible gap in the 3-column signal row (grid tracks don't collapse
  // around a missing sibling), breaking the row's visual balance whenever
  // there's no active plan. Every sibling card in that row shows its own
  // empty state instead of disappearing; this one now matches.
  const insights = state === "ready" && profile?.status === "ok" ? buildReviewInsights(profile) : [];
  const isEmptyHistory = state === "ready" && profile?.status === "ok" && profile.consistency.active_days_rate === 0;

  return (
    <section className="a02-insights" aria-label="Insights">
      <header><b>INSIGHTS</b></header>
      {state === "loading" ? (
        <p className="a02-trait-empty">Reading your profile.</p>
      ) : state === "error" ? (
        <p className="a02-trait-empty">We could not read your profile. Nothing has been changed.</p>
      ) : profile?.status === "no_active_plan" ? (
        <p className="a02-trait-empty">Set up your route first, then return here for its first useful piece.</p>
      ) : isEmptyHistory || insights.length === 0 ? (
        <ul className="a02-insight-list">
          {UNLOCK_CONDITIONS.map((text) => (
            <li key={text}>
              <i className="a02-insight-glyph a02-insight-glyph--acid" aria-hidden="true">✦</i>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="a02-insight-list">
          {insights.map((insight) => (
            <li key={insight.type} className={insight.earlySignal ? "is-early-signal" : undefined}>
              <i className={`a02-insight-glyph ${SEVERITY_GLYPH[insight.severity] ?? ""}`} aria-hidden="true">✦</i>
              <span>{insight.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
