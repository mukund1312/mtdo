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

export function ReviewInsights({ profile, state }: UseStudyProfileResult) {
  // Always renders a card with its header -- a null return here left a
  // visible gap in the 3-column signal row (grid tracks don't collapse
  // around a missing sibling), breaking the row's visual balance whenever
  // there's no active plan. Every sibling card in that row shows its own
  // empty state instead of disappearing; this one now matches.
  const insights = state === "ready" && profile?.status === "ok" ? buildReviewInsights(profile) : [];

  return (
    <section className="a02-insights" aria-label="Insights">
      <header><b>INSIGHTS</b></header>
      {state === "loading" ? (
        <p className="a02-trait-empty">Reading your profile.</p>
      ) : state === "error" ? (
        <p className="a02-trait-empty">We could not read your profile. Nothing has been changed.</p>
      ) : profile?.status === "no_active_plan" ? (
        <p className="a02-trait-empty">Set up your route first, then return here for its first useful piece.</p>
      ) : insights.length === 0 ? (
        <p className="a02-trait-empty">Nothing stands out yet — keep going.</p>
      ) : (
        <ul className="a02-insight-list">
          {insights.map((insight) => (
            <li key={insight.type}>
              <i className={`a02-insight-glyph ${SEVERITY_GLYPH[insight.severity] ?? ""}`} aria-hidden="true">✦</i>
              <span>{insight.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
