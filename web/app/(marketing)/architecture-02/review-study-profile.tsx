"use client";

import { DURATION_LABELS, WEEKDAY_NAMES, formatHour } from "./review-time-behavior";
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

function Trait({
  label,
  value,
  sampleNote,
  confidence,
}: {
  label: string;
  value: string | null;
  sampleNote: string;
  confidence: string;
}) {
  return (
    <div className="a02-trait">
      <span className="a02-trait-label">{label}</span>
      {value === null ? (
        <p className="a02-trait-empty">Not enough {sampleNote} yet</p>
      ) : (
        <>
          <b className="a02-trait-value">{value}</b>
          <Confidence level={confidence} />
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
          sampleNote="days"
          confidence={p.focus.confidence}
        />
        <Trait
          label="Execution"
          value={p.execution.avg_percentage == null ? null : `${p.execution.avg_percentage}%`}
          sampleNote="days"
          confidence={p.execution.confidence}
        />
        <Trait
          label="Planning accuracy"
          value={p.planning.avg_completion_rate == null ? null : `${Math.round(p.planning.avg_completion_rate * 100)}%`}
          sampleNote="weeks"
          confidence={p.planning.confidence}
        />
        <Trait
          label="Best study window"
          value={p.best_study_window == null ? null : formatHour(p.best_study_window.hour)}
          sampleNote="sessions"
          confidence={p.best_study_window == null ? "insufficient_data" : "medium"}
        />
        <Trait
          label="Best day"
          value={p.best_weekday == null ? null : WEEKDAY_NAMES[p.best_weekday.weekday] ?? null}
          sampleNote="sessions"
          confidence={p.best_weekday == null ? "insufficient_data" : "medium"}
        />
        <Trait
          label="Ideal session length"
          value={p.ideal_session_length == null ? null : DURATION_LABELS[p.ideal_session_length.bucket] ?? p.ideal_session_length.bucket}
          sampleNote="sessions"
          confidence={p.ideal_session_length == null ? "insufficient_data" : "medium"}
        />
      </div>

      <div className="a02-subject-grid">
        <div className="a02-subject-card a02-subject-card--strong">
          <span>Strongest subject</span>
          {p.strongest_subject ? (
            <>
              <b>{p.strongest_subject.label}</b>
              <p>{Math.round(p.strongest_subject.completion_rate * 100)}% completion</p>
              <Confidence level={p.strongest_subject.confidence} />
            </>
          ) : (
            <p className="a02-trait-empty">Not enough subjects yet</p>
          )}
        </div>
        <div className="a02-subject-card a02-subject-card--weak">
          <span>Weakest subject</span>
          {p.weakest_subject ? (
            <>
              <b>{p.weakest_subject.label}</b>
              <p>{Math.round(p.weakest_subject.completion_rate * 100)}% completion</p>
              <Confidence level={p.weakest_subject.confidence} />
            </>
          ) : (
            <p className="a02-trait-empty">Not enough subjects yet</p>
          )}
        </div>
        <div className="a02-subject-card a02-subject-card--avoided">
          <span>Most avoided</span>
          {p.most_avoided_subject ? (
            <>
              <b>{p.most_avoided_subject.label}</b>
              <p>{Math.round(p.most_avoided_subject.postponement_rate * 100)}% postponed</p>
              <Confidence level={p.most_avoided_subject.confidence} />
            </>
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
