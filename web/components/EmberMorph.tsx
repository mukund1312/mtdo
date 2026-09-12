"use client";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./EmberMorph.module.css";

/**
 * Presentational contract for the focus ritual. Kept free of Supabase and
 * session authority so the real route and the marketing preview can share it.
 * See docs/architecture/api.md §4.1 before changing this shape.
 */
export type EmberMorphTrigger =
  | { phase: "idle" }
  | {
      phase: "active";
      sessionId: string;
      plannedDurationS: number;
      elapsedS: number;
      originRect: DOMRectReadOnly | null;
      status?: "active" | "paused" | "complete";
    }
  | {
      phase: "exiting";
      sessionId: string;
      plannedDurationS: number;
      elapsedS: number;
    };

export interface EmberMorphProps {
  trigger: EmberMorphTrigger;
  children?: ReactNode;
  onExitComplete?: () => void;
  className?: string;
  showClock?: boolean;
}

const BLOOM_EXIT_MS = 420;

function formatClock(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

/**
 * The terminal-flavoured focus shell. It intentionally owns no clock and no
 * database writes: callers update elapsedS and decide when a session settles.
 */
export function EmberMorph({
  trigger,
  children,
  onExitComplete,
  className,
  showClock = true,
}: EmberMorphProps) {
  const reducedMotion = useReducedMotion();
  const exitHandledFor = useRef<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const isIdle = trigger.phase === "idle";
  const isExiting = trigger.phase === "exiting";
  const isActive = trigger.phase === "active";
  const sessionId = isIdle ? null : trigger.sessionId;

  useEffect(() => {
    if (!isExiting || !sessionId || exitHandledFor.current === sessionId) return;

    exitHandledFor.current = sessionId;
    const timeout = window.setTimeout(
      () => onExitComplete?.(),
      reducedMotion ? 0 : BLOOM_EXIT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [isExiting, onExitComplete, reducedMotion, sessionId]);

  useEffect(() => {
    if (!showClock) return;
    const update = () => setNow(new Date());
    update();
    const interval = window.setInterval(update, 30_000);
    return () => window.clearInterval(interval);
  }, [showClock]);

  if (isIdle) return null;

  const plannedDurationS = Math.max(1, trigger.plannedDurationS);
  const elapsedS = Math.max(0, trigger.elapsedS);
  const remainingS = Math.max(0, plannedDurationS - elapsedS);
  const progress = Math.min(1, elapsedS / plannedDurationS);
  const origin = isActive ? trigger.originRect : null;
  const originX = origin ? `${origin.left + origin.width / 2}px` : "50vw";
  const originY = origin ? `${origin.top + origin.height / 2}px` : "50vh";
  const ringCircumference = 2 * Math.PI * 46;
  const ringOffset = ringCircumference * (1 - progress);
  const status = isActive ? trigger.status ?? "active" : "complete";
  const statusLabel = status === "paused" ? "Paused" : status === "complete" ? "Time is up" : "In session";
  const wallClock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now);
  const shellClassName = [
    styles.shell,
    !isExiting && styles.entering,
    isExiting && styles.exiting,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const bloomStyle = {
    "--ember-origin-x": originX,
    "--ember-origin-y": originY,
  } as CSSProperties;

  return (
    <section key={sessionId} className={shellClassName} aria-label="Focus session" style={bloomStyle}>
      <div className={styles.bloom} aria-hidden="true" />
      <div className={styles.grid} aria-hidden="true" />

      <header className={styles.header}>
        <span className={styles.wordmark}>mtdo</span>
        <span className={styles.deckId}>MTDO / ARCHITECTURE 02 — SIGNAL DECK</span>
        <div className={styles.headerStatus}>
          {showClock && <time className={styles.wallClock}>{wallClock}</time>}
          <span className={`${styles.liveStatus} ${status === "paused" ? styles.pausedStatus : ""}`}>
            <span className={styles.liveDot} aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </header>

      <div className={styles.frame}>
        <div className={styles.timerArea}>
          <div className={styles.ringWrap}>
            <svg
              className={styles.ring}
              viewBox="0 0 112 112"
              role="meter"
              aria-label={`${Math.round(progress * 100)}% of focus session elapsed`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <circle className={styles.ringTrack} cx="56" cy="56" r="46" />
              <circle
                className={styles.ringProgress}
                cx="56"
                cy="56"
                r="46"
                style={{
                  strokeDasharray: ringCircumference,
                  strokeDashoffset: ringOffset,
                }}
              />
            </svg>
            <span className={styles.ringMark} aria-hidden="true" />
          </div>
          <div>
            <p className={styles.timerLabel}>Focus remaining</p>
            <p className={`${styles.timer} num`} aria-live="off">
              {formatClock(remainingS)}
            </p>
            <p className={styles.elapsed}>
              <span className="num">{formatClock(elapsedS)}</span> invested
            </p>
          </div>
        </div>

        <div className={styles.content}>{children}</div>
      </div>
    </section>
  );
}
