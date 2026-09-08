"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { PLANNING_MODE_DETAILS, PLANNING_MODES, PLANNING_MODE_STORAGE_KEY, isPlanningMode, type PlanningMode } from "./planning-mode";

type SelectorState = "loading" | "ready" | "error";

export function PlanningModeSelector({ disabled = false, onChange }: { disabled?: boolean; onChange?: (mode: PlanningMode) => void }) {
  const labelId = useId();
  const [mode, setMode] = useState<PlanningMode>("dynamic_weekly");
  const [state, setState] = useState<SelectorState>("loading");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(PLANNING_MODE_STORAGE_KEY);
        if (isPlanningMode(saved)) setMode(saved);
        setState("ready");
      } catch {
        // There is no backend planning_mode field in the current contract.
        // Let the user use the in-memory preference if browser storage is unavailable.
        setState("error");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const choose = (next: PlanningMode) => {
    if (disabled || state === "loading") return;
    setMode(next);
    try {
      window.localStorage.setItem(PLANNING_MODE_STORAGE_KEY, next);
      setState("ready");
    } catch {
      setState("error");
    }
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
