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
  showTimer?: boolean;
  onTimerVisibilityChange?: (visible: boolean) => void;
  showSandglass?: boolean;
  onSandglassVisibilityChange?: (visible: boolean) => void;
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
  showTimer = true,
  onTimerVisibilityChange,
  showSandglass = false,
  onSandglassVisibilityChange,
}: EmberMorphProps) {
  const reducedMotion = useReducedMotion();
  const exitHandledFor = useRef<string | null>(null);

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
  const timerExpired = status === "complete" && remainingS === 0;

  return (
    <section key={sessionId} className={shellClassName} aria-label="Focus session" style={bloomStyle}>
      <div className={styles.bloom} aria-hidden="true" />
      <div className={styles.grid} aria-hidden="true" />

      <header className={styles.header}>
        <span className={styles.wordmark}>mtdo</span>
        <span className={styles.deckId}>MTDO / ARCHITECTURE 02 — SIGNAL DECK</span>
        <div className={styles.headerStatus}>
          {onTimerVisibilityChange && (
            <button
              className={styles.timerToggle}
              type="button"
              aria-pressed={showTimer}
              onClick={() => onTimerVisibilityChange(!showTimer)}
            >
              Timer {showTimer ? "on" : "off"}
            </button>
          )}
          {onSandglassVisibilityChange && (
            <button
              className={styles.sandglassToggle}
              type="button"
              aria-pressed={showSandglass}
              onClick={() => onSandglassVisibilityChange(!showSandglass)}
            >
              Sandglass {showSandglass ? "on" : "off"}
            </button>
          )}
          <span className={`${styles.liveStatus} ${status === "paused" ? styles.pausedStatus : ""}`}>
            <span className={styles.liveDot} aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </header>

        <div className={`${styles.frame} ${!showTimer && !showSandglass ? styles.timerHidden : ""}`}>
        {(showTimer || showSandglass) && <div className={styles.timerArea}>
          {showTimer && <>
          <div className={styles.timerReadout}>
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
          </>}
          {showSandglass && <Sandglass progress={progress} complete={timerExpired} />}
        </div>}

        <div className={styles.content}>{children}</div>
      </div>
    </section>
  );
}

function Sandglass({ progress, complete }: { progress: number; complete: boolean }) {
  const filled = Math.max(0, Math.min(1, progress));
  return (
    <div className={`${styles.sandglass} ${complete ? styles.sandglassComplete : ""}`} role="img" aria-label={complete ? "Focus sandglass complete" : "Focus sandglass in progress"}>
      <svg viewBox="0 0 62 96" aria-hidden="true">
        <path className={styles.sandglassFrame} d="M12 7H50M12 89H50M15 8C15 30 24 39 31 48C38 57 47 66 47 88M47 8C47 30 38 39 31 48C24 57 15 66 15 88" />
        <path className={styles.sandTop} d="M17 11H45L31 43Z" style={{ transform: `scaleY(${1 - filled})` }} />
        <path className={styles.sandBottom} d="M31 53L45 85H17Z" style={{ transform: `scaleY(${filled})` }} />
        <circle className={styles.sandDrop} cx="31" cy="49" r="1.8" />
      </svg>
    </div>
  );
}
