"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmberMorph, type EmberMorphTrigger } from "@/components/EmberMorph";
import { createClient } from "@/lib/supabase/client";
import { recordEvent } from "@/lib/analytics/record-event";
import { buildCoachingContent, type CategoryMeta, type CoachingFields } from "@/lib/coaching/build-coaching-content";
import "../(marketing)/architecture-02/signal-deck.css";
import styles from "./session.module.css";

type FocusSession = {
  id: string;
  started_at: string;
  planned_duration_s: number;
};

type LinkedBlock = {
  coaching: CoachingFields | null;
  id: string;
  notes: string | null;
  // A to-one embed via blocks_category_fk (the only FK from blocks to
  // plan_categories) -- PostgREST returns a single object, not an array,
  // for the many-to-one direction this query walks.
  plan_categories: CategoryMeta | null;
  text: string;
};

type SessionPhase = "ready" | "starting" | "active" | "exiting";
type NoticeKind = "success" | "warning";

const DEFAULT_DURATION_S = 50 * 60;
// Shown when a session was started without a linked block (Home's generic
// "Start focus" -- see architecture-02/page.tsx) -- honest, not a stand-in
// task, since there genuinely isn't one to describe here.
const UNLINKED_TASK = {
  eyebrow: "Focus session",
  title: "Open focus",
  detail: "This session isn't linked to a specific task. Stay with one clear question for the full block.",
};

function secondsSince(startedAt: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

// PostgREST puts the SQLSTATE in `error.code`, not in the message text -- the
// migration's actual RAISE message ("start_session: a session is already
// running") contains no digits, so a message-only "55006" check can never
// match and silently relies on the substring fallback alone. Checked first
// here; the substring check stays only as a defensive fallback.
function isAlreadyRunningError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return error.code === "55006" || (error.message?.includes("already running") ?? false);
}

function messageFrom(error: { code?: string; message?: string } | null) {
  if (!error) return "Something interrupted the session. Try again.";
  if (isAlreadyRunningError(error)) {
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
  const [noticeKind, setNoticeKind] = useState<NoticeKind>("warning");
  const [isSettling, setIsSettling] = useState(false);
  // Set only on a genuine 55006 conflict from startSession -- a running
  // session the server found that this attempt didn't create. Per the
  // documented recovery contract (schema.md, api.md §3), the client must
  // offer resume-or-discard here, never auto-resume into whatever the server
  // happens to be holding.
  const [pendingConflict, setPendingConflict] = useState<FocusSession | null>(null);
  const [linkedBlock, setLinkedBlock] = useState<LinkedBlock | null>(null);
  const [isLinkedBlockLoading, setIsLinkedBlockLoading] = useState(true);
  const lastSettleKind = useRef<"complete" | "abandon" | null>(null);
  const task = linkedBlock
    ? {
        eyebrow: "Today · linked block",
        title: linkedBlock.text,
        detail: linkedBlock.notes?.trim() || "Stay with this one task until you have a clear next step.",
      }
    : UNLINKED_TASK;
  // buildCoachingContent's own three-tier merge already falls all the way
  // to the fully generic library when both arguments are null/undefined --
  // an unlinked session still gets real (if generic) coaching, not an empty
  // rail.
  const coaching = useMemo(
    () => buildCoachingContent(linkedBlock?.coaching ?? null, linkedBlock?.plan_categories ?? null),
    [linkedBlock],
  );

  const resume = useCallback((running: FocusSession) => {
    setSession(running);
    setElapsedS(secondsSince(running.started_at));
    setPhase("active");
    setNotice(null);
  }, []);

  // screen_opened (schema.md §4): fires on mount, not per render -- note the
  // empty dependency array is deliberate. This is a fire-and-forget ledger
  // append (safe here, unlike the Route Handler's serverless teardown risk --
  // the browser tab stays alive); recordEvent() already swallows its own
  // errors so this effect body never needs to. In local dev, React 18 Strict
  // Mode double-invokes mount effects, so two rows land per visit -- that's
  // a dev-only artifact of Strict Mode, not this effect; production fires
  // once per real mount.
  useEffect(() => {
    void recordEvent(createClient(), "screen_opened", { screen: "session" });
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

  // Today hands the selected block across in the URL. The block is fetched
  // under the user's RLS scope rather than trusting a title supplied by the
  // browser, then passed to start_session as the server-authoritative link.
  useEffect(() => {
    const linkedBlockId = new URLSearchParams(window.location.search).get("blockId");
    let cancelled = false;
    if (!linkedBlockId) {
      const clearLoading = window.setTimeout(() => {
        if (!cancelled) setIsLinkedBlockLoading(false);
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(clearLoading);
      };
    }
    // Keep a non-null local for the async closure below; TypeScript does not
    // retain the URLSearchParams narrowing across that closure boundary.
    const requestedBlockId: string = linkedBlockId;
    async function loadLinkedBlock() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from("blocks")
        .select("id, text, notes, coaching, plan_categories(coaching_framework, topic_type)")
        .eq("id", requestedBlockId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!error && data) setLinkedBlock(data as unknown as LinkedBlock);
      setIsLinkedBlockLoading(false);
    }

    void loadLinkedBlock();
    return () => {
      cancelled = true;
    };
  }, []);

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
    // Do not create an unlinked generic session while a task passed from
    // Architecture 02 is still being resolved under RLS.
    if (isLinkedBlockLoading) return;
    if (new URLSearchParams(window.location.search).get("blockId") && !linkedBlock) {
      setNoticeKind("warning");
      setNotice("Loading the selected task. Try Begin focus again in a moment.");
      return;
    }
    setNotice(null);
    setPendingConflict(null);
    setOriginRect(startButtonRef.current?.getBoundingClientRect() ?? null);
    setPhase("starting");

    const supabase = createClient();
    // p_block_id omitted, not passed as null: the generated RPC arg type is
    // `string | undefined` (optional, from the SQL DEFAULT), not
    // `string | null` -- the type generator infers optionality from DEFAULT
    // presence but doesn't union with null even when the SQL body genuinely
    // accepts it (migrations/0004). Omitting the key hits that same SQL
    // default (NULL) with no runtime difference from passing null explicitly.
    const { data, error } = await supabase.rpc("start_session", {
      p_planned_duration_s: DEFAULT_DURATION_S,
      ...(linkedBlock ? { p_block_id: linkedBlock.id } : {}),
    });

    if (error || !data) {
      // 55006 is a recovery state, not a generic failure -- but it is a real
      // conflict, not this attempt's own session, so the server's row is
      // surfaced as a resume-or-discard choice rather than entered silently
      // (schema.md / api.md §3: "must offer resume-or-discard, calling
      // abandon_session() before starting a new one").
      if (isAlreadyRunningError(error)) {
        const { data: running } = await supabase
          .from("focus_sessions")
          .select("id, started_at, planned_duration_s")
          .eq("state", "running")
          .maybeSingle();
        if (running) {
          setPendingConflict(running as FocusSession);
          setPhase("ready");
          return;
        }
      }
      setNoticeKind("warning");
      setNotice(messageFrom(error));
      setPhase("ready");
      return;
    }

    resume(data as FocusSession);
    if (linkedBlock) {
      // This convenience state is client-writable by design. It must not
      // block a valid session if a transient update failure occurs.
      const { error: blockError } = await supabase
        .from("blocks")
        .update({ claimed: true, status: "in_progress" })
        .eq("id", linkedBlock.id);
      if (blockError) console.error("[session] could not mark linked block in progress:", blockError);
    }
  }, [isLinkedBlockLoading, linkedBlock, phase, resume]);

  const resumeConflict = useCallback(() => {
    if (!pendingConflict) return;
    resume(pendingConflict);
    setPendingConflict(null);
  }, [pendingConflict, resume]);

  const discardConflict = useCallback(async () => {
    if (!pendingConflict || isSettling) return;
    setIsSettling(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("abandon_session", { p_id: pendingConflict.id });
    setIsSettling(false);
    if (error) {
      setNoticeKind("warning");
      setNotice(messageFrom(error));
      return;
    }
    setPendingConflict(null);
    setNotice(null);
  }, [isSettling, pendingConflict]);

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
        setNoticeKind("warning");
        setNotice(messageFrom(error));
        setIsSettling(false);
        return;
      }

      lastSettleKind.current = kind;
      setPhase("exiting");
    },
    [isSettling, phase, session],
  );

  const finishExit = useCallback(() => {
    const kind = lastSettleKind.current;
    lastSettleKind.current = null;
    setSession(null);
    setElapsedS(0);
    setOriginRect(null);
    setIsSettling(false);
    setPhase("ready");
    setNoticeKind("success");
    setNotice(
      kind === "abandon"
        ? "Session ended early. That's fine -- pick it back up whenever you're ready."
        : "Session saved. Name one thing that moved before you leave it.",
    );
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
    <main className={`${styles.page} a02-signal-theme`}>
      <section className={styles.readyShell} aria-labelledby="session-title">
        <p className={styles.kicker}>Focus session</p>
        <h1 id="session-title">One thing. A little further.</h1>
        <p className={styles.intro}>
          Start a 50-minute block. Your timer and coach stay with the work, so there is nothing to
          manage once you begin.
        </p>

        <div className={styles.readyCard}>
          <div>
            <p className={styles.cardEyebrow}>{task.eyebrow}</p>
            <h2>{task.title}</h2>
            <p>{task.detail}</p>
          </div>
          <span className={`${styles.duration} num`}>50:00</span>
        </div>

        {pendingConflict ? (
          <div className={styles.conflictPrompt} role="status">
            <p className={styles.conflictText}>
              A focus session is already running. Resume where you left off, or discard it and
              start fresh?
            </p>
            <div className={styles.sessionActions}>
              <button
                className={styles.startButton}
                type="button"
                onClick={resumeConflict}
                disabled={isSettling}
              >
                Resume it
              </button>
              <button
                className={styles.abandonButton}
                type="button"
                onClick={() => void discardConflict()}
                disabled={isSettling}
              >
                {isSettling ? "Discarding…" : "Discard & start fresh"}
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={startButtonRef}
            className={styles.startButton}
            type="button"
            onClick={() => void startSession()}
            disabled={phase === "starting" || isLinkedBlockLoading}
          >
            <span aria-hidden="true">{phase === "starting" || isLinkedBlockLoading ? "…" : "→"}</span>
            {phase === "starting"
              ? "Starting session"
              : isLinkedBlockLoading
                ? "Loading task"
                : "Begin focus"}
          </button>
        )}
        {notice && (
          <p className={`${styles.notice} ${noticeKind === "success" ? styles.noticeSuccess : ""}`} role="status">
            {notice}
          </p>
        )}
      </section>

      <EmberMorph trigger={trigger} onExitComplete={finishExit} className={styles.signalFocus}>
        <div className={styles.focusLayout}>
          <section className={styles.taskPanel} aria-labelledby="focus-task-title">
            <p className={styles.cardEyebrow}>{task.eyebrow}</p>
            <h1 id="focus-task-title">{task.title}</h1>
            <p>{task.detail}</p>

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
            <p className={styles.coachCopy}>{coaching.focus_on.join(" ")}</p>
            <div className={styles.coachPrompt}>
              <span>Ask yourself</span>
              <p>{coaching.ask_yourself[0]}</p>
            </div>
            <div className={styles.coachPrompt}>
              <span>Watch for</span>
              <p>{coaching.mistakes.join(" · ")}</p>
            </div>
            <div className={styles.coachPrompt}>
              <span>Pro tip</span>
              <p>{coaching.pro_tip}</p>
            </div>
            {coaching.related_topics.length > 0 && (
              <div className={styles.coachPrompt}>
                <span>Related topics</span>
                <p>{coaching.related_topics.join(" · ")}</p>
              </div>
            )}
          </aside>
        </div>
      </EmberMorph>
    </main>
  );
}
