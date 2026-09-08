"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { PLANNING_MODE_DETAILS, PLANNING_MODES, PLANNING_MODE_STORAGE_KEY, isPlanningMode, type PlanningMode } from "./planning-mode";

type SelectorState = "loading" | "ready" | "error";

export function PlanningModeSelector({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean;
  onChange?: (mode: PlanningMode) => void;
  /** Controlled mode: when set, this is the source of truth (a real
   * plans.planning_mode value the caller already loaded/is saving --
   * Settings, migrations/0017) and localStorage is never touched. Omitted
   * (uncontrolled): the original behavior for onboarding, where there is no
   * plan row yet to read/write against -- the component owns its own value,
   * persisted to localStorage as a draft the caller reads via `onChange`
   * and includes in the eventual plan-creation payload. */
  value?: PlanningMode;
}) {
  const labelId = useId();
  const controlled = value !== undefined;
  const [internalMode, setInternalMode] = useState<PlanningMode>("dynamic_weekly");
  const [state, setState] = useState<SelectorState>(controlled ? "ready" : "loading");
  const mode = controlled ? value : internalMode;

  useEffect(() => {
    if (controlled) return;
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(PLANNING_MODE_STORAGE_KEY);
        if (isPlanningMode(saved)) setInternalMode(saved);
        setState("ready");
      } catch {
        // No local draft available -- the in-memory default still works,
        // it just won't survive a refresh.
        setState("error");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [controlled]);

  const choose = (next: PlanningMode) => {
    if (disabled || (!controlled && state === "loading")) return;
    if (!controlled) {
      setInternalMode(next);
      try {
        window.localStorage.setItem(PLANNING_MODE_STORAGE_KEY, next);
        setState("ready");
      } catch {
        setState("error");
      }
    }
    // Controlled mode: the caller owns saving (and its own loading/error
    // state around this component) -- this call is the entire write path.
    onChange?.(next);
  };

  const moveWithKey = (event: KeyboardEvent<HTMLButtonElement>, current: PlanningMode) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const currentIndex = PLANNING_MODES.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? PLANNING_MODES.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + PLANNING_MODES.length) % PLANNING_MODES.length;
    const next = PLANNING_MODES[nextIndex]!;
    choose(next);
    document.getElementById(`${labelId}-${next}`)?.focus();
  };

  return <section className="a02-planning-mode" aria-labelledby={labelId} aria-busy={state === "loading"}>
    <div className="a02-planning-mode-head"><span id={labelId}>PLANNING MODE</span><i>{state === "loading" ? "Loading…" : `Current: ${PLANNING_MODE_DETAILS[mode].label}`}</i></div>
    <div className="a02-planning-mode-options" role="radiogroup" aria-labelledby={labelId} aria-describedby={`${labelId}-help`}>
      {PLANNING_MODES.map((option) => {
        const detail = PLANNING_MODE_DETAILS[option];
        const selected = option === mode;
        return <button id={`${labelId}-${option}`} key={option} type="button" role="radio" aria-checked={selected} className={selected ? "is-selected" : ""} disabled={disabled || state === "loading"} onClick={() => choose(option)} onKeyDown={(event) => moveWithKey(event, option)}><b>{detail.label}</b><span>{detail.description}</span><small>{detail.note}</small></button>;
      })}
    </div>
    <p id={`${labelId}-help`} className={state === "error" ? "is-error" : ""}>{state === "error" ? "Saved only in this browser until planning-mode sync is available." : "This sets how you want MTDO to frame your route."}</p>
  </section>;
}
