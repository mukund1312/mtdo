"use client";

import type { ReactNode } from "react";

import { DURATION_LABELS, WEEKDAY_NAMES, formatHour } from "./review-time-formatters";
import type { UseStudyProfileResult } from "./use-study-profile";

// F5 of docs/designs/review-frontend-briefs.md: the Study Profile panel.
// Every field on focus/execution/planning and every subject is
// INDEPENDENTLY nullable -- this is not one loading/ready toggle for the
// whole card, each trait renders its own "not enough data yet" state when
// its value is null, alongside other traits that ARE ready, on the same
// load.
//
// Presentational only, as of F6: the study_profile() fetch lives in
// useStudyProfile() (ReviewDeck owns the call), shared with ReviewInsights
// so the RPC is never called twice for one page load.

const CONFIDENCE_LABEL: Record<string, string> = {
  insufficient_data: "not enough data",
  low: "low confidence",
  medium: "medium confidence",
  high: "high confidence",
};

function Confidence({ level }: { level: string }) {
  return <i className={`a02-confidence a02-confidence--${level}`}>{CONFIDENCE_LABEL[level] ?? level}</i>;
}

function EvidenceDisclosure({
  sampleSize,
  sampleUnit,
  windowDays,
  confidence,
  evidence,
  coverage,
}: {
  sampleSize: number;
  sampleUnit: string;
  windowDays: number;
  confidence?: string;
  /** Reserved for a future server-provided evidence detail. */
  evidence?: ReactNode;
  /** Reserved for a future server-provided coverage detail. */
  coverage?: ReactNode;
}) {
  return (
    <p className="a02-trait-evidence">
      Based on {sampleSize} {sampleUnit} in the last {windowDays} days
      {confidence ? <> · <Confidence level={confidence} /></> : null}
      {evidence ? <> · {evidence}</> : null}
      {coverage ? <> · {coverage}</> : null}
    </p>
  );
}

function Trait({
  label,
  value,
  emptyNote,
  sampleSize,
  sampleUnit,
  windowDays,
  confidence,
}: {
  label: string;
  value: string | null;
  emptyNote: string;
  sampleSize: number | null;
  sampleUnit: string;
  windowDays: number;
  confidence?: string;
}) {
  const insufficient = value === null || confidence === "insufficient_data";

  return (
    <div className="a02-trait">
      <span className="a02-trait-label">{label}</span>
      {insufficient ? (
        <p className="a02-trait-empty">Not enough {emptyNote} yet</p>
      ) : (
        <>
          <b className="a02-trait-value">{value}</b>
          {sampleSize !== null && (
            <EvidenceDisclosure
              confidence={confidence}
              sampleSize={sampleSize}
              sampleUnit={sampleUnit}
              windowDays={windowDays}
            />
          )}
        </>
      )}
    </div>
  );
}

export function ReviewStudyProfile({ profile, state, reload }: UseStudyProfileResult) {
  if (state === "error") {
    return (
      <section className="a02-product-state" role="alert">
        <b>Your study profile is unavailable.</b>
        <p>We could not read your profile. Nothing has been changed.</p>
        <button type="button" onClick={reload}>Try again ↗</button>
      </section>
    );
  }

  if (state === "ready" && profile?.status === "no_active_plan") {
    return (
      <section className="a02-study-profile-empty" aria-live="polite">
        <p>Set up your route first, then return here for its first useful piece.</p>
      </section>
    );
  }

  if (state === "loading") {
    return (
      <section className="a02-study-profile" aria-busy="true">
        <header><b>STUDY PROFILE</b></header>
        <p className="a02-trait-empty">Reading your profile.</p>
      </section>
    );
  }

  const p = profile?.status === "ok" ? profile : null;
  if (!p) return null;

  return (
    <section className="a02-study-profile" aria-label="Study profile">
      <header><b>STUDY PROFILE</b><span>last {p.window_days} days</span></header>

      <div className="a02-trait-grid">
        <Trait
          label="Focus endurance"
          value={p.focus.avg_percentage == null ? null : `${p.focus.avg_percentage}%`}
          emptyNote="days"
          sampleSize={p.focus.sample_size}
          sampleUnit="days"
          windowDays={p.focus.window_days}
          confidence={p.focus.confidence}
        />
        <Trait
          label="Execution"
          value={p.execution.avg_percentage == null ? null : `${p.execution.avg_percentage}%`}
          emptyNote="days"
          sampleSize={p.execution.sample_size}
          sampleUnit="days"
          windowDays={p.execution.window_days}
          confidence={p.execution.confidence}
        />
        <Trait
          label="Planning accuracy"
          value={p.planning.avg_completion_rate == null ? null : `${Math.round(p.planning.avg_completion_rate * 100)}%`}
          emptyNote="weeks"
          sampleSize={p.planning.weeks_sampled}
          sampleUnit="weeks"
          windowDays={p.window_days}
          confidence={p.planning.confidence}
        />
        <Trait
          label="Best study window"
          value={p.best_study_window == null ? null : formatHour(p.best_study_window.hour)}
          emptyNote="sessions"
          sampleSize={p.best_study_window?.sample_size ?? null}
          sampleUnit="sessions"
          windowDays={p.window_days}
        />
        <Trait
          label="Best day"
          value={p.best_weekday == null ? null : WEEKDAY_NAMES[p.best_weekday.weekday] ?? null}
          emptyNote="sessions"
          sampleSize={p.best_weekday?.sample_size ?? null}
          sampleUnit="sessions"
          windowDays={p.window_days}
        />
        <Trait
          label="Ideal session length"
          value={p.ideal_session_length == null ? null : DURATION_LABELS[p.ideal_session_length.bucket] ?? p.ideal_session_length.bucket}
          emptyNote="sessions"
          sampleSize={p.ideal_session_length?.sample_size ?? null}
          sampleUnit="sessions"
          windowDays={p.window_days}
        />
      </div>

      <div className="a02-subject-grid">
        <div className="a02-subject-card a02-subject-card--strong">
          <span>Strongest subject</span>
          {p.strongest_subject && p.strongest_subject.confidence !== "insufficient_data" ? (
            <>
              <b>{p.strongest_subject.label}</b>
              <p>{Math.round(p.strongest_subject.completion_rate * 100)}% completion</p>
              <EvidenceDisclosure confidence={p.strongest_subject.confidence} sampleSize={p.strongest_subject.sample_size} sampleUnit="observations" windowDays={p.window_days} />
            </>
          ) : p.strongest_subject ? (
            <p className="a02-trait-empty">Not enough observations yet</p>
          ) : (
            <p className="a02-trait-empty">Not enough subjects yet</p>
          )}
        </div>
        <div className="a02-subject-card a02-subject-card--weak">
          <span>Weakest subject</span>
          {p.weakest_subject && p.weakest_subject.confidence !== "insufficient_data" ? (
            <>
              <b>{p.weakest_subject.label}</b>
              <p>{Math.round(p.weakest_subject.completion_rate * 100)}% completion</p>
              <EvidenceDisclosure confidence={p.weakest_subject.confidence} sampleSize={p.weakest_subject.sample_size} sampleUnit="observations" windowDays={p.window_days} />
            </>
          ) : p.weakest_subject ? (
            <p className="a02-trait-empty">Not enough observations yet</p>
          ) : (
            <p className="a02-trait-empty">Not enough subjects yet</p>
          )}
        </div>
        <div className="a02-subject-card a02-subject-card--avoided">
          <span>Most avoided</span>
          {p.most_avoided_subject && p.most_avoided_subject.confidence !== "insufficient_data" ? (
            <>
              <b>{p.most_avoided_subject.label}</b>
              <p>{Math.round(p.most_avoided_subject.postponement_rate * 100)}% postponed</p>
              <EvidenceDisclosure confidence={p.most_avoided_subject.confidence} sampleSize={p.most_avoided_subject.sample_size} sampleUnit="observations" windowDays={p.window_days} />
            </>
          ) : p.most_avoided_subject ? (
            <p className="a02-trait-empty">Not enough observations yet</p>
          ) : (
            // A null here is a genuinely good state -- nothing is being
            // avoided -- not an error or an empty placeholder.
            <p className="a02-trait-empty a02-trait-empty--good">Nothing you&apos;re avoiding right now</p>
          )}
        </div>
      </div>
    </section>
  );
}
