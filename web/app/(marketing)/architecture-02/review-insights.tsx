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
  // Inherits F5's state entirely -- no separate spinner/error card for the
  // same underlying fetch.
  if (state !== "ready" || !profile || profile.status !== "ok") return null;

  const insights = buildReviewInsights(profile);

  return (
    <section className="a02-insights" aria-label="Insights">
      <header><b>YOUR SIGNAL</b></header>
      {insights.length === 0 ? (
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
