"use client";

import { useState } from "react";
import styles from "./SessionCheckIn.module.css";

export type SessionCheckInState = "offered_pending" | "answered" | "declined" | "not_offered";

export type SessionCheckInAnswer =
  | { kind: "answered"; selfDifficulty?: number; selfConfidence?: number; selfHelpLevel?: "none" | "hint" | "walkthrough" | "full_solution" }
  | { kind: "declined" };

export function SessionCheckIn({
  sessionId,
  checkInState,
  onAnswer,
  className,
}: {
  sessionId: string;
  checkInState: SessionCheckInState;
  onAnswer: (answer: SessionCheckInAnswer) => void;
  className?: string;
}) {
  const [selfDifficulty, setSelfDifficulty] = useState<number | undefined>();
  const [selfConfidence, setSelfConfidence] = useState<number | undefined>();
  const [selfHelpLevel, setSelfHelpLevel] = useState<"none" | "hint" | "walkthrough" | "full_solution" | undefined>();

  // Eligibility is settled and recorded by the server. This component only
  // captures an answer for an already-offered prompt.
  if (checkInState !== "offered_pending") return null;

  const hasAnswer = selfDifficulty !== undefined || selfConfidence !== undefined || selfHelpLevel !== undefined;
  const group = `${sessionId}-check-in`;

  return (
    <section className={[styles.card, className].filter(Boolean).join(" ")} aria-labelledby={`${group}-title`}>
      <p className={styles.eyebrow}>Session check-in</p>
      <h2 id={`${group}-title`}>How did that feel?</h2>
      <p className={styles.copy}>Share any part of the session that feels useful. You can also skip it.</p>
      <fieldset className={styles.fieldset}>
        <legend>Difficulty</legend>
        <div className={styles.scale}>{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={selfDifficulty === value ? styles.selected : ""} aria-pressed={selfDifficulty === value} onClick={() => setSelfDifficulty(value)}>{value}</button>)}</div>
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend>Confidence</legend>
        <div className={styles.scale}>{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={selfConfidence === value ? styles.selected : ""} aria-pressed={selfConfidence === value} onClick={() => setSelfConfidence(value)}>{value}</button>)}</div>
      </fieldset>
      <label className={styles.helpLevel}>
        <span>Help used</span>
        <select value={selfHelpLevel ?? ""} onChange={(event) => setSelfHelpLevel((event.target.value || undefined) as typeof selfHelpLevel)}>
          <option value="">Not recorded</option>
          <option value="none">None</option>
          <option value="hint">Hint</option>
          <option value="walkthrough">Walkthrough</option>
          <option value="full_solution">Full solution</option>
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.answer} disabled={!hasAnswer} onClick={() => onAnswer({ kind: "answered", selfDifficulty, selfConfidence, selfHelpLevel })}>Save check-in</button>
        <button type="button" className={styles.decline} onClick={() => onAnswer({ kind: "declined" })}>Skip for now</button>
      </div>
    </section>
  );
}
