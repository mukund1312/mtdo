"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmberMorph, type EmberMorphTrigger } from "@/components/EmberMorph";
import { createClient } from "@/lib/supabase/client";
import { recordEvent } from "@/lib/analytics/record-event";
import { buildCoachingContent, type CategoryMeta, type CoachingFields } from "@/lib/coaching/build-coaching-content";
import { useFocusClockPreference } from "@/lib/preferences/focus-clock";
import styles from "./session.module.css";

type FocusSession = {
  break_plan: { breaks: ScheduledBreak[] } | null;
  extended_s: number;
  id: string;
  paused_at: string | null;
  started_at: string;
  planned_duration_s: number;
  total_paused_s: number;
};

type ScheduledBreak = { at_s: number; duration_s: number };

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

type SessionPhase = "ready" | "starting" | "active" | "outcome" | "exiting";
const EXTENSION_PROMPT_AT_S = 5 * 60;
const BREAK_STORAGE_PREFIX = "mtdo:focus-breaks:";
// Shown when a session was started without a linked block (Home's generic
// "Start focus" -- see architecture-02/page.tsx) -- honest, not a stand-in
// task, since there genuinely isn't one to describe here.
const UNLINKED_TASK = {
  eyebrow: "Focus session",
  title: "Open focus",
  detail: "This session isn't linked to a specific task. Stay with one clear question for the full block.",
};

function focusSeconds(session: FocusSession, now = Date.now()) {
  const wallSeconds = Math.max(0, Math.floor((now - new Date(session.started_at).getTime()) / 1000));
  const openPauseSeconds = session.paused_at
    ? Math.max(0, Math.floor((now - new Date(session.paused_at).getTime()) / 1000))
    : 0;
  return Math.max(0, wallSeconds - session.total_paused_s - openPauseSeconds);
}

function asFocusSession(value: unknown): FocusSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<FocusSession>;
  if (!session.id || !session.started_at || !session.planned_duration_s) return null;
  const rawPlan = session.break_plan;
  const breaks = rawPlan && typeof rawPlan === "object" && Array.isArray((rawPlan as { breaks?: unknown }).breaks)
    ? (rawPlan as { breaks: unknown[] }).breaks.filter(
        (item): item is ScheduledBreak =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as ScheduledBreak).at_s === "number" &&
          typeof (item as ScheduledBreak).duration_s === "number",
      )
    : [];
  return {
    id: session.id,
    started_at: session.started_at,
    planned_duration_s: session.planned_duration_s,
    paused_at: session.paused_at ?? null,
    total_paused_s: session.total_paused_s ?? 0,
    extended_s: session.extended_s ?? 0,
    break_plan: breaks.length > 0 ? { breaks } : null,
  };
}

function latestNote(notes: string | null) {
  return notes?.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? null;
}

function breakPlanFor(durationMinutes: number, breakCount: number, breakMinutes: number) {
  if (breakCount === 0) return { breaks: [] as ScheduledBreak[] };
  const durationS = durationMinutes * 60;
  const breakS = breakMinutes * 60;
  const intervalS = Math.floor(durationS / (breakCount + 1));
  if (durationMinutes < 1 || durationMinutes > 1440 || breakCount < 0 || breakCount > 24 || breakMinutes < 1 || intervalS < 1) {
    return null;
  }
  if (durationS + breakCount * breakS > 86400) return null;
  return { breaks: Array.from({ length: breakCount }, (_, index) => ({ at_s: intervalS * (index + 1), duration_s: breakS })) };
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
  const [showFocusClock] = useFocusClockPreference();
  const [phase, setPhase] = useState<SessionPhase>("ready");
  const [session, setSession] = useState<FocusSession | null>(null);
  const [elapsedS, setElapsedS] = useState(0);
  const [durationMinutes, setDurationMinutes] = useState(50);
  const [breakCount, setBreakCount] = useState(0);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [breakEndsAt, setBreakEndsAt] = useState<number | null>(null);
  const [takenBreaks, setTakenBreaks] = useState<number[]>([]);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [extensionMinutes, setExtensionMinutes] = useState(10);
  const [outcomeNeedsNote, setOutcomeNeedsNote] = useState(false);
  const [leftoverNote, setLeftoverNote] = useState("");
  const originRect = null;
  const [notice, setNotice] = useState<string | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const [linkedBlock, setLinkedBlock] = useState<LinkedBlock | null>(null);
  const [isLinkedBlockLoading, setIsLinkedBlockLoading] = useState(true);
  const [isRunningSessionLoading, setIsRunningSessionLoading] = useState(true);
  const breakStarting = useRef<number | null>(null);
  const expirySettling = useRef<string | null>(null);
  const extensionPromptedFor = useRef<number | null>(null);
  const task = linkedBlock
    ? {
        eyebrow: "Today · linked block",
        title: linkedBlock.text,
        detail: latestNote(linkedBlock.notes) || "Stay with this one task until you have a clear next step.",
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
    const restored = asFocusSession(running);
    if (!restored) return;
    setSession(restored);
    setElapsedS(focusSeconds(restored));
    try {
      const stored = window.sessionStorage.getItem(`${BREAK_STORAGE_PREFIX}${restored.id}`);
      const indices = stored ? JSON.parse(stored) : [];
      setTakenBreaks(Array.isArray(indices) ? indices.filter((value): value is number => typeof value === "number") : []);
    } catch {
      setTakenBreaks([]);
    }
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
        .select("id, started_at, planned_duration_s, paused_at, total_paused_s, extended_s, break_plan")
        .eq("state", "running")
        .maybeSingle();
      if (cancelled) return;
      if (!error && data) resume(data as FocusSession);
      setIsRunningSessionLoading(false);
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
      if (!user) {
        if (!cancelled) setIsLinkedBlockLoading(false);
        return;
      }
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

  // The server owns the session clock. The display tick uses its server-stamped
  // start plus accumulated/open pause time, so paused seconds never become
  // focus seconds after a refresh or a long backgrounded tab.
  useEffect(() => {
    if (!session || phase !== "active") return;
    const update = () => setElapsedS(focusSeconds(session));
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
      setNotice("Loading the selected task. Try Begin focus again in a moment.");
      return;
    }
    setNotice(null);
    const plan = breakPlanFor(durationMinutes, breakCount, breakMinutes);
    if (!plan) {
      setNotice("Choose a focus duration and a valid break schedule.");
      return;
    }
    setPhase("starting");

    const supabase = createClient();
    // p_block_id omitted, not passed as null: the generated RPC arg type is
    // `string | undefined` (optional, from the SQL DEFAULT), not
    // `string | null` -- the type generator infers optionality from DEFAULT
    // presence but doesn't union with null even when the SQL body genuinely
    // accepts it (migrations/0004). Omitting the key hits that same SQL
    // default (NULL) with no runtime difference from passing null explicitly.
    const { data, error } = await supabase.rpc("start_session", {
      p_planned_duration_s: durationMinutes * 60,
      p_break_plan: plan,
      ...(linkedBlock ? { p_block_id: linkedBlock.id } : {}),
    });

    if (error || !data) {
      // If a prior live session exists, keep this single Focus surface live
      // by resuming the server-authoritative session instead of rendering a
      // second recovery landing screen.
      if (isAlreadyRunningError(error)) {
        const { data: running } = await supabase
          .from("focus_sessions")
          .select("id, started_at, planned_duration_s, paused_at, total_paused_s, extended_s, break_plan")
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
    if (linkedBlock) {
      // This convenience state is client-writable by design. It must not
      // block a valid session if a transient update failure occurs.
      const { error: blockError } = await supabase
        .from("blocks")
        .update({ claimed: true, status: "in_progress" })
        .eq("id", linkedBlock.id);
      if (blockError) console.error("[session] could not mark linked block in progress:", blockError);
    }
  }, [breakCount, breakMinutes, durationMinutes, isLinkedBlockLoading, linkedBlock, phase, resume]);

  // Focus remains task-scoped. A direct /session visit has no owned block to
  // settle back to Kanban, so return it to Signal Deck rather than presenting
  // the retired generic Focus start surface.
  useEffect(() => {
    if (isLinkedBlockLoading || isRunningSessionLoading || phase !== "ready") return;
    if (!linkedBlock) window.location.replace("/architecture-02");
  }, [isLinkedBlockLoading, isRunningSessionLoading, linkedBlock, phase]);

  const settleSession = useCallback(
    async (kind: "complete" | "abandon", blockOutcome?: "done" | "in_progress") => {
      if (!session || isSettling || (phase !== "active" && phase !== "outcome")) return;
      setIsSettling(true);
      setNotice(null);

      const supabase = createClient();
      const { error } = await supabase.rpc(
        kind === "complete" ? "complete_session" : "abandon_session",
        { p_id: session.id, ...(blockOutcome && linkedBlock ? { p_block_outcome: blockOutcome } : {}) },
      );

      if (error) {
        setNotice(messageFrom(error));
        setIsSettling(false);
        return;
      }

      setPhase("exiting");
    },
    [isSettling, linkedBlock, phase, session],
  );

  const updateSessionFromRpc = useCallback((data: unknown) => {
    const next = asFocusSession(data);
    if (!next) return false;
    setSession(next);
    setElapsedS(focusSeconds(next));
    return true;
  }, []);

  const pauseSession = useCallback(async (reason: "manual" | "break") => {
    if (!session || isSettling || session.paused_at) return false;
    setIsSettling(true);
    setNotice(null);
    const { data, error } = await createClient().rpc("pause_session", { p_id: session.id, p_reason: reason });
    setIsSettling(false);
    if (error || !updateSessionFromRpc(data)) {
      setNotice(messageFrom(error));
      return false;
    }
    setNotice(reason === "break" ? "Scheduled break in progress." : "Session paused. Your focus time is held.");
    return true;
  }, [isSettling, session, updateSessionFromRpc]);

  const resumeSession = useCallback(async () => {
    if (!session || isSettling || !session.paused_at) return;
    setIsSettling(true);
    setNotice(null);
    const { data, error } = await createClient().rpc("resume_session", { p_id: session.id });
    setIsSettling(false);
    if (error || !updateSessionFromRpc(data)) {
      setNotice(messageFrom(error));
      return;
    }
    setBreakEndsAt(null);
    setNotice(null);
  }, [isSettling, session, updateSessionFromRpc]);

  const extendSession = useCallback(async () => {
    if (!session || isSettling || extensionMinutes < 1 || extensionMinutes > 1440) return;
    setIsSettling(true);
    setNotice(null);
    const { data, error } = await createClient().rpc("extend_session", {
      p_id: session.id,
      p_additional_s: extensionMinutes * 60,
    });
    setIsSettling(false);
    if (error || !updateSessionFromRpc(data)) {
      setNotice(messageFrom(error));
      return;
    }
    extensionPromptedFor.current = null;
    setExtensionOpen(false);
  }, [extensionMinutes, isSettling, session, updateSessionFromRpc]);

  const resolveExpiryOutcome = useCallback(async (outcome: "done" | "in_progress") => {
    if (!session || isSettling) return;
    if (outcome === "in_progress" && !leftoverNote.trim()) {
      setNotice("Add a short note about what remains before returning the task to In progress.");
      return;
    }
    setIsSettling(true);
    setNotice(null);
    const { error } = await createClient().rpc("settle_block_outcome", {
      p_session_id: session.id,
      p_outcome: outcome,
      ...(outcome === "in_progress" ? { p_leftover_note: leftoverNote.trim() } : {}),
    });
    if (error) {
      setIsSettling(false);
      setNotice(messageFrom(error));
      return;
    }
    setPhase("exiting");
  }, [isSettling, leftoverNote, session]);

  // A planned break is a persisted schedule plus the same pause mechanic the
  // user invokes manually. The schedule is measured in focus seconds, so a
  // manual pause cannot consume a future break.
  useEffect(() => {
    if (!session || phase !== "active" || session.paused_at || breakStarting.current !== null) return;
    const breaks = session.break_plan?.breaks ?? [];
    const nextIndex = breaks.findIndex((item, index) => elapsedS >= item.at_s && !takenBreaks.includes(index));
    if (nextIndex < 0) return;
    breakStarting.current = nextIndex;
    const breakItem = breaks[nextIndex];
    if (!breakItem) return;
    void (async () => {
      try {
        const didPause = await pauseSession("break");
        if (!didPause) return;
        setTakenBreaks((current) => {
          const next = current.includes(nextIndex) ? current : [...current, nextIndex];
          try { window.sessionStorage.setItem(`${BREAK_STORAGE_PREFIX}${session.id}`, JSON.stringify(next)); } catch { /* convenience only */ }
          return next;
        });
        setBreakEndsAt(Date.now() + breakItem.duration_s * 1000);
      } finally {
        breakStarting.current = null;
      }
    })();
  }, [elapsedS, pauseSession, phase, session, takenBreaks]);

  useEffect(() => {
    if (!breakEndsAt || !session?.paused_at || phase !== "active") return;
    const tick = () => {
      if (Date.now() >= breakEndsAt) void resumeSession();
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [breakEndsAt, phase, resumeSession, session?.paused_at]);

  useEffect(() => {
    if (!session || phase !== "active" || session.paused_at) return;
    const remaining = session.planned_duration_s - elapsedS;
    if (remaining > 0 && remaining <= EXTENSION_PROMPT_AT_S && extensionPromptedFor.current !== session.planned_duration_s) {
      extensionPromptedFor.current = session.planned_duration_s;
      setExtensionOpen(true);
    }
  }, [elapsedS, phase, session]);

  useEffect(() => {
    if (!session || phase !== "active" || session.paused_at || elapsedS < session.planned_duration_s || expirySettling.current === session.id) return;
    expirySettling.current = session.id;
    setIsSettling(true);
    setExtensionOpen(false);
    void (async () => {
      const { error } = await createClient().rpc("complete_session", { p_id: session.id });
      if (error) {
        expirySettling.current = null;
        setIsSettling(false);
        setNotice(messageFrom(error));
        return;
      }
      setIsSettling(false);
      setPhase(linkedBlock ? "outcome" : "exiting");
    })();
  }, [elapsedS, linkedBlock, phase, session]);

  const finishExit = useCallback(() => {
    setSession(null);
    setElapsedS(0);
    setIsSettling(false);
    // Do not return to the retired pre-session surface after a session ends.
    // The settled session is already persisted by the RPC above.
    window.location.replace("/architecture-02?deck=work");
  }, []);

  const trigger: EmberMorphTrigger =
    phase === "exiting" && session
      ? {
          phase: "exiting",
          sessionId: session.id,
          plannedDurationS: session.planned_duration_s,
          elapsedS,
        }
      : (phase === "active" || phase === "outcome") && session
        ? {
            phase: "active",
            sessionId: session.id,
            plannedDurationS: session.planned_duration_s,
            elapsedS,
            originRect,
            status: phase === "outcome" ? "complete" : session.paused_at ? "paused" : "active",
          }
        : { phase: "idle" };

  if (phase === "ready" && !isLinkedBlockLoading && !isRunningSessionLoading && linkedBlock) {
    const plan = breakPlanFor(durationMinutes, breakCount, breakMinutes);
    return (
      <main className={styles.page}>
        <section className={styles.setup} aria-labelledby="focus-setup-title">
          <p className={styles.cardEyebrow}>Focus setup</p>
          <h1 id="focus-setup-title">{linkedBlock.text}</h1>
          <p>Set the time you have and any breaks you want protected before the timer begins.</p>
          <div className={styles.setupFields}>
            <label>
              <span>Focus minutes</span>
              <input aria-label="Focus minutes" type="number" min={1} max={1440} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} />
            </label>
            <label>
              <span>Planned breaks</span>
              <input aria-label="Planned breaks" type="number" min={0} max={24} value={breakCount} onChange={(event) => setBreakCount(Number(event.target.value))} />
            </label>
            <label>
              <span>Minutes per break</span>
              <input aria-label="Minutes per break" type="number" min={1} max={240} disabled={breakCount === 0} value={breakMinutes} onChange={(event) => setBreakMinutes(Number(event.target.value))} />
            </label>
          </div>
          {breakCount > 0 && plan && <p className={styles.setupSummary}>{plan.breaks.map((item, index) => `Break ${index + 1} after ${Math.round(item.at_s / 60)}m · ${Math.round(item.duration_s / 60)}m`).join("  /  ")}</p>}
          {!plan && <p className={styles.focusNotice} role="alert">Choose a valid duration and break schedule.</p>}
          <div className={styles.sessionActions}>
            <button className={styles.completeButton} type="button" onClick={() => void startSession()} disabled={!plan}>
              Begin focus
            </button>
            <button className={styles.abandonButton} type="button" onClick={() => window.location.replace("/architecture-02?deck=work")}>
              Back to Kanban
            </button>
          </div>
          {notice && <p className={styles.focusNotice} role="status">{notice}</p>}
        </section>
      </main>
    );
  }

  if (phase !== "active" && phase !== "outcome" && phase !== "exiting") {
    return (
      <main className={styles.page} aria-live="polite">
        <div className={styles.preparing}>
          <p>{notice ?? "Preparing your focus session…"}</p>
          {notice && (
            <div className={styles.preparingActions}>
              <button
                className={styles.completeButton}
                type="button"
                onClick={() => {
                  setNotice(null);
                  void startSession();
                }}
              >
                Try again
              </button>
              <button className={styles.abandonButton} type="button" onClick={() => window.location.replace("/architecture-02")}>
                Back to deck
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <EmberMorph trigger={trigger} onExitComplete={finishExit} showClock={showFocusClock}>
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

            {phase === "outcome" ? (
              <div className={styles.outcomePanel} role="region" aria-label="Session outcome">
                <p className={styles.cardEyebrow}>Time is up</p>
                <h2>Did you complete this task?</h2>
                {!outcomeNeedsNote ? (
                  <div className={styles.sessionActions}>
                    <button className={styles.completeButton} type="button" disabled={isSettling} onClick={() => void resolveExpiryOutcome("done")}>
                      {isSettling ? "Saving…" : "I finished"}
                    </button>
                    <button className={styles.abandonButton} type="button" disabled={isSettling} onClick={() => setOutcomeNeedsNote(true)}>
                      Something&apos;s left
                    </button>
                  </div>
                ) : (
                  <>
                    <label className={styles.leftoverField}>
                      <span>What is left for the next session?</span>
                      <textarea value={leftoverNote} onChange={(event) => setLeftoverNote(event.target.value)} maxLength={2000} placeholder="Leave a clear next step…" />
                    </label>
                    <div className={styles.sessionActions}>
                      <button className={styles.completeButton} type="button" disabled={isSettling || !leftoverNote.trim()} onClick={() => void resolveExpiryOutcome("in_progress")}>
                        {isSettling ? "Saving…" : "Keep in progress"}
                      </button>
                      <button className={styles.abandonButton} type="button" disabled={isSettling} onClick={() => setOutcomeNeedsNote(false)}>Back</button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className={styles.sessionActions}>
                <button
                  className={styles.pauseButton}
                  type="button"
                  onClick={() => void (session?.paused_at ? resumeSession() : pauseSession("manual"))}
                  disabled={isSettling || phase !== "active"}
                >
                  {session?.paused_at ? "Resume session" : "Pause session"}
                </button>
                <button
                  className={styles.completeButton}
                  type="button"
                  onClick={() => void settleSession("complete", "done")}
                  disabled={isSettling || phase !== "active"}
                >
                  {isSettling ? "Saving…" : "End session"}
                </button>
                <button
                  className={styles.abandonButton}
                  type="button"
                  onClick={() => void settleSession("abandon", "in_progress")}
                  disabled={isSettling || phase !== "active"}
                >
                  Leave early
                </button>
              </div>
            )}
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
        {extensionOpen && phase === "active" && !session?.paused_at && (
          <div className={styles.extensionDialog} role="dialog" aria-modal="true" aria-labelledby="extension-title">
            <div>
              <p className={styles.cardEyebrow}>Five minutes remaining</p>
              <h2 id="extension-title">Do you need more time to finish?</h2>
              <label className={styles.extensionField}>
                <span>Add minutes</span>
                <input aria-label="Additional focus minutes" type="number" min={1} max={1440} value={extensionMinutes} onChange={(event) => setExtensionMinutes(Number(event.target.value))} />
              </label>
              <div className={styles.sessionActions}>
                <button className={styles.completeButton} type="button" disabled={isSettling || extensionMinutes < 1} onClick={() => void extendSession()}>
                  {isSettling ? "Saving…" : "Add time"}
                </button>
                <button className={styles.abandonButton} type="button" disabled={isSettling} onClick={() => setExtensionOpen(false)}>No, continue</button>
              </div>
            </div>
          </div>
        )}
      </EmberMorph>
    </main>
  );
}
