"use client";

// Pre-start duration + break configuration. Split out of page.tsx so the
// ready-screen setup UI (a distinct concern from the live-session controls
// in focus-controls.tsx) doesn't grow page.tsx into one unreadable file.
//
// break_plan shape is frozen by api.md §3h and never mutable after
// start_session(): { breaks: [{ at_s, duration_s }, ...] }, at_s measured in
// FOCUS seconds (not wall clock). The RPC itself validates and rejects a bad
// plan with 22023 -- validateBreakPlan() below exists so the user sees a
// readable inline message before the round trip, not just a surfaced
// Postgres error after clicking Begin focus.

import { useId } from "react";
import styles from "./session.module.css";

export type BreakPlan = { breaks: { at_s: number; duration_s: number }[] };

export const MIN_DURATION_S = 5;
// 86400 is the RPC's own hard ceiling (api.md §3h); 4 hours is a realistic
// upper bound for one focus block -- the ceiling exists to stop a fat-fingered
// value, not to invite an actual 24-hour "session".
export const MAX_DURATION_S = 4 * 60 * 60;
export const MAX_BREAKS = 6;

export function formatMmSs(totalSeconds: number) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Evenly spaces `count` breaks of `lengthS` each across `durationS` FOCUS
 * seconds of work -- the same shape as api.md §3h's own worked example
 * (45min work + 2x5min breaks -> breaks at 15:00 and 30:00, i.e. thirds).
 * Returns undefined for "no breaks" so callers can omit p_break_plan
 * entirely rather than sending an empty-but-present object.
 */
export function buildBreakPlan(durationS: number, count: number, lengthS: number): BreakPlan | undefined {
  if (count <= 0 || lengthS <= 0) return undefined;
  const segments = count + 1;
  const breaks: { at_s: number; duration_s: number }[] = [];
  let prev = 0;
  for (let i = 1; i <= count; i += 1) {
    let at = Math.round((durationS * i) / segments);
    at = Math.max(at, prev + 1);
    at = Math.min(at, durationS - 1);
    breaks.push({ at_s: at, duration_s: Math.round(lengthS) });
    prev = at;
  }
  return { breaks };
}

/** Mirrors start_session's own break-plan checks (api.md §3h) so a bad
 * configuration reads as a plain sentence here instead of a 22023 after the
 * round trip. Returns null when the plan is fine to send (or there is none). */
export function validateBreakPlan(durationS: number, count: number, lengthS: number): string | null {
  if (count <= 0) return null;
  if (count > MAX_BREAKS) return `Use at most ${MAX_BREAKS} breaks in one session.`;
  if (lengthS <= 0) return "Each break needs a length above zero.";
  // Every break needs a distinct whole second inside (0, durationS) -- the
  // RPC rejects non-increasing at_s values, and evenly-spacing count breaks
  // across too short a duration collides them at the same rounded second.
  if (durationS - 1 < count) {
    return "This session is too short for that many breaks. Lengthen the session or use fewer breaks.";
  }
  if (count * lengthS >= durationS) {
    return "Break time adds up to as long as the session itself. Shorten the breaks or lengthen the session.";
  }
  return null;
}

function MmSsInput({
  id,
  label,
  totalSeconds,
  onChange,
  disabled,
  minTotal = 0,
}: {
  id: string;
  label: string;
  totalSeconds: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
  minTotal?: number;
}) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const commit = (nextMinutes: number, nextSeconds: number) => {
    const total = Math.max(minTotal, Math.round(nextMinutes) * 60 + Math.round(nextSeconds));
    onChange(total);
  };
  return (
    <div className={styles.mmssField}>
      <span className={styles.mmssLabel}>{label}</span>
      <div className={styles.mmssInputs}>
        <input
          id={`${id}-min`}
          type="number"
          inputMode="numeric"
          min={0}
          max={Math.floor(MAX_DURATION_S / 60)}
          value={minutes}
          disabled={disabled}
          aria-label={`${label}, minutes`}
          onChange={(event) => commit(Number(event.target.value) || 0, seconds)}
        />
        <span aria-hidden="true">:</span>
        <input
          id={`${id}-sec`}
          type="number"
          inputMode="numeric"
          min={0}
          max={59}
          value={seconds}
          disabled={disabled}
          aria-label={`${label}, seconds`}
          onChange={(event) => commit(minutes, Number(event.target.value) || 0)}
        />
      </div>
    </div>
  );
}

export function SessionSetup({
  durationS,
  onDurationChange,
  breakCount,
  onBreakCountChange,
  breakLengthS,
  onBreakLengthChange,
  disabled,
}: {
  durationS: number;
  onDurationChange: (s: number) => void;
  breakCount: number;
  onBreakCountChange: (n: number) => void;
  breakLengthS: number;
  onBreakLengthChange: (s: number) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  const plan = buildBreakPlan(durationS, breakCount, breakLengthS);
  const error = validateBreakPlan(durationS, breakCount, breakLengthS);

  return (
    <div className={styles.setup}>
      <MmSsInput
        id={`${baseId}-duration`}
        label="Session length"
        totalSeconds={durationS}
        minTotal={MIN_DURATION_S}
        onChange={onDurationChange}
        disabled={disabled}
      />

      <div className={styles.breakSetup}>
        <span className={styles.mmssLabel}>Breaks</span>
        <div className={styles.breakStepper}>
          <button
            type="button"
            aria-label="Fewer breaks"
            disabled={disabled || breakCount <= 0}
            onClick={() => onBreakCountChange(Math.max(0, breakCount - 1))}
          >
            −
          </button>
          <span className={`${styles.breakCount} num`} aria-live="polite">
            {breakCount}
          </span>
          <button
            type="button"
            aria-label="More breaks"
            disabled={disabled || breakCount >= MAX_BREAKS}
            onClick={() => onBreakCountChange(Math.min(MAX_BREAKS, breakCount + 1))}
          >
            +
          </button>
        </div>
        {breakCount > 0 && (
          <MmSsInput
            id={`${baseId}-break-length`}
            label="Length each"
            totalSeconds={breakLengthS}
            minTotal={1}
            onChange={onBreakLengthChange}
            disabled={disabled}
          />
        )}
      </div>

      {breakCount > 0 && plan && !error && (
        <p className={styles.breakPreview}>
          Breaks at {plan.breaks.map((b) => formatMmSs(b.at_s)).join(", ")} ({formatMmSs(breakLengthS)} each)
        </p>
      )}
      {error && (
        <p className={styles.setupError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
