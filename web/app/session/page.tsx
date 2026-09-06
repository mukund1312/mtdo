"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EmberMorph, type EmberMorphTrigger } from "@/components/EmberMorph";
import { createClient } from "@/lib/supabase/client";
import styles from "./session.module.css";

type FocusSession = {
  id: string;
  started_at: string;
  planned_duration_s: number;
};

type SessionPhase = "ready" | "starting" | "active" | "exiting";

const DEFAULT_DURATION_S = 50 * 60;
const TASK = {
  eyebrow: "Today · Week 2",
  title: "Make joins feel obvious",
  detail: "Work through the three queries below without looking at the answer first.",
};

function secondsSince(startedAt: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function messageFrom(error: { message?: string } | null) {
  if (!error) return "Something interrupted the session. Try again.";
  if (error.message?.includes("55006") || error.message?.includes("already running")) {
    return "A session is already running. Resume it or end it before starting another.";
  }
  return error.message ?? "Something interrupted the session. Try again.";
}

export default function SessionPage() {
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<SessionPhase>("ready");
  const [session, setSession] = useState<FocusSession | null>(null);
  const [elapsedS, setElapsedS] = useState(0);
  const [originRect, setOriginRect] = useState<DOMRectReadOnly | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSettling, setIsSettling] = useState(false);

  const resume = useCallback((running: FocusSession) => {
    setSession(running);
    setElapsedS(secondsSince(running.started_at));
    setPhase("active");
    setNotice(null);
  }, []);

  // A tab can close mid-session. Restore that server-authoritative row instead
  // of silently creating a second local timer.
  useEffect(() => {
    let cancelled = false;

    async function findRunningSession() {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("focus_sessions")
        .select("id, started_at, planned_duration_s")
        .eq("state", "running")
        .maybeSingle();
      if (!cancelled && !error && data) resume(data as FocusSession);
    }

    void findRunningSession();
    return () => {
      cancelled = true;
    };
  }, [resume]);

  // The screen owns this display-only client tick. The server's started_at is
  // the source of truth; EmberMorph merely receives the resulting number.
  useEffect(() => {
    if (!session || phase !== "active") return;
    const update = () => setElapsedS(secondsSince(session.started_at));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [phase, session]);

  const startSession = useCallback(async () => {
    if (phase !== "ready") return;
    setNotice(null);
    setOriginRect(startButtonRef.current?.getBoundingClientRect() ?? null);
    setPhase("starting");

    const supabase = createClient();
    const { data, error } = await supabase.rpc("start_session", {
      p_block_id: null,
      p_planned_duration_s: DEFAULT_DURATION_S,
    });

    if (error || !data) {
      // 55006 is a recovery state, not a generic failure: find the row the
      // server refused to replace and offer its real clock back to the user.
      if (error?.message?.includes("55006") || error?.message?.includes("already running")) {
        const { data: running } = await supabase
          .from("focus_sessions")
          .select("id, started_at, planned_duration_s")
          .eq("state", "running")
          .maybeSingle();
        if (running) {
          resume(running as FocusSession);
          return;
        }
      }
      setNotice(messageFrom(error));
      setPhase("ready");
      return;
    }

    resume(data as FocusSession);
  }, [phase, resume]);

  const settleSession = useCallback(
    async (kind: "complete" | "abandon") => {
      if (!session || isSettling || phase !== "active") return;
      setIsSettling(true);
      setNotice(null);

      const supabase = createClient();
      const { error } = await supabase.rpc(
        kind === "complete" ? "complete_session" : "abandon_session",
        { p_id: session.id },
      );

      if (error) {
        setNotice(messageFrom(error));
        setIsSettling(false);
        return;
      }

      setPhase("exiting");
    },
    [isSettling, phase, session],
  );

  const finishExit = useCallback(() => {
    setSession(null);
    setElapsedS(0);
    setOriginRect(null);
    setIsSettling(false);
    setPhase("ready");
    setNotice("Session saved. Name one thing that moved before you leave it.");
  }, []);

  const trigger: EmberMorphTrigger =
    phase === "exiting" && session
      ? {
          phase: "exiting",
          sessionId: session.id,
          plannedDurationS: session.planned_duration_s,
          elapsedS,
        }
      : phase === "active" && session
        ? {
            phase: "active",
            sessionId: session.id,
            plannedDurationS: session.planned_duration_s,
            elapsedS,
            originRect,
          }
        : { phase: "idle" };

  return (
    <main className={styles.page}>
      <section className={styles.readyShell} aria-labelledby="session-title">
        <p className={styles.kicker}>Focus session</p>
        <h1 id="session-title">One thing. A little further.</h1>
        <p className={styles.intro}>
          Start a 50-minute block. Your timer and coach stay with the work, so there is nothing to
          manage once you begin.
        </p>

        <div className={styles.readyCard}>
          <div>
            <p className={styles.cardEyebrow}>{TASK.eyebrow}</p>
            <h2>{TASK.title}</h2>
            <p>{TASK.detail}</p>
          </div>
          <span className={`${styles.duration} num`}>50:00</span>
        </div>

        <button
          ref={startButtonRef}
          className={styles.startButton}
          type="button"
          onClick={() => void startSession()}
          disabled={phase === "starting"}
        >
          <span aria-hidden="true">{phase === "starting" ? "…" : "→"}</span>
          {phase === "starting" ? "Starting session" : "Begin focus"}
        </button>
        {notice && <p className={styles.notice} role="status">{notice}</p>}
      </section>

      <EmberMorph trigger={trigger} onExitComplete={finishExit}>
        <div className={styles.focusLayout}>
          <section className={styles.taskPanel} aria-labelledby="focus-task-title">
            <p className={styles.cardEyebrow}>{TASK.eyebrow}</p>
            <h1 id="focus-task-title">{TASK.title}</h1>
            <p>{TASK.detail}</p>

            <ol className={styles.steps}>
              <li>
                <span>01</span>
                Sketch the two tables and decide what belongs in the join condition.
              </li>
              <li>
                <span>02</span>
                Write an inner join, then explain exactly which rows it excludes.
              </li>
              <li>
                <span>03</span>
                Change it to a left join and check the null side deliberately.
              </li>
            </ol>

            <div className={styles.sessionActions}>
              <button
                className={styles.completeButton}
                type="button"
                onClick={() => void settleSession("complete")}
                disabled={isSettling || phase !== "active"}
              >
                {isSettling ? "Saving…" : "Finish session"}
              </button>
              <button
                className={styles.abandonButton}
                type="button"
                onClick={() => void settleSession("abandon")}
                disabled={isSettling || phase !== "active"}
              >
                End early
              </button>
            </div>
            {notice && <p className={styles.focusNotice} role="status">{notice}</p>}
          </section>

          <aside className={styles.coachRail} aria-labelledby="coach-title">
            <div className={styles.coachHead}>
              <span className={styles.coachMark} aria-hidden="true">↗</span>
              <div>
                <p className={styles.cardEyebrow}>Your coach</p>
                <h2 id="coach-title">Stay with the question.</h2>
              </div>
            </div>
            <p className={styles.coachCopy}>
              If a join feels slippery, say which table is allowed to lose rows. The answer usually
              appears before the syntax does.
            </p>
            <div className={styles.coachPrompt}>
              <span>Try next</span>
              <p>What changes if an order has no matching customer?</p>
            </div>
            <button className={styles.askButton} type="button">
              Ask for a nudge <span aria-hidden="true">↗</span>
            </button>
          </aside>
        </div>
      </EmberMorph>
    </main>
  );
}
