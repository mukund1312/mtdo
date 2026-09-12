"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmberMorph, type EmberMorphTrigger } from "@/components/EmberMorph";
import { createClient } from "@/lib/supabase/client";
import { recordEvent } from "@/lib/analytics/record-event";
import { buildCoachingContent, type CategoryMeta, type CoachingFields } from "@/lib/coaching/build-coaching-content";
import { SignalDeckListenProvider } from "@/app/(marketing)/architecture-02/listen-state";
import { FocusMusicDock } from "./focus-music";
import { SessionSetup, buildBreakPlan, formatMmSs, validateBreakPlan, type BreakPlan } from "./session-setup";
import styles from "./session.module.css";

type FocusSession = {
  id: string;
  started_at: string;
  planned_duration_s: number;
  // migrations/0023 (api.md §3h) -- SELECT-able by the owner, writable only
  // through pause_session/resume_session/extend_session/start_session. A
  // paused session is still state = 'running'; there is no 'paused' state.
  paused_at: string | null;
  total_paused_s: number;
  extended_s: number;
  break_plan: BreakPlan | null;
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

type SessionPhase = "ready" | "starting" | "active" | "awaiting-outcome" | "exiting";
type PauseReason = "manual" | "break";
// What to say while awaiting-outcome resolves the notice line -- "complete"
// covers both the explicit End Session button and a natural-expiry
// "Finished" answer (both land the block on Done).
type SettleKind = "complete" | "abandon" | "leftover";

const DEFAULT_DURATION_S = 50 * 60;
const DEFAULT_BREAK_LENGTH_S = 5 * 60;
// "the last 5 minutes of a running session" -- founder's own wording.
const EXTEND_WINDOW_S = 5 * 60;
const EXTEND_OPTIONS_MIN = [5, 10, 15] as const;

// Shown only if a RUNNING session is restored after a reload/tab-close that
// happens to carry no linked block (a pre-existing session from before Focus
// became linked-task-only, or an unlinked session started some other way).
// Honest, not a stand-in task, since there genuinely isn't one to describe.
const UNLINKED_TASK = {
  eyebrow: "Focus session",
  title: "Open focus",
  detail: "This session isn't linked to a specific task. Stay with one clear question for the full block.",
};

// Server owns time; client renders it. api.md §3h's exact formula -- a
// paused session's elapsed is frozen by construction (the two subtractions
// grow at the same rate while paused_at is set), so no separate "stop the
// interval" branch is needed.
function computeFocusElapsedS(s: Pick<FocusSession, "started_at" | "total_paused_s" | "paused_at">) {
  const raw =
    (Date.now() - Date.parse(s.started_at)) / 1000 -
    s.total_paused_s -
    (s.paused_at ? (Date.now() - Date.parse(s.paused_at)) / 1000 : 0);
  return Math.max(0, raw);
}

// settle_block_outcome() APPENDS dated paragraphs to blocks.notes, never
// overwrites (api.md §3h) -- after a few sessions on the same task that
// field holds several paragraphs, which reads badly as a one-line detail.
// Render only the most recent one; the rest is history available elsewhere.
function lastNoteParagraph(notes: string | null): string | null {
  if (!notes) return null;
  const parts = notes
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
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
  const [isSettling, setIsSettling] = useState(false);
  const [linkedBlock, setLinkedBlock] = useState<LinkedBlock | null>(null);
  const [isLinkedBlockLoading, setIsLinkedBlockLoading] = useState(true);
  const [isRunningSessionLoading, setIsRunningSessionLoading] = useState(true);
  // Whether the "no linked block -> back to the deck" redirect has already
  // been decided, so the effect below fires at most once (PR #162's own
  // pattern for its now-retired auto-start effect, repurposed here).
  const redirectDecidedRef = useRef(false);
  const lastSettleKind = useRef<SettleKind | null>(null);

  // Pre-start setup (deliverable 1/2): p_planned_duration_s always took any
  // value 1..86400, and break_plan is frozen at start_session() and never
  // mutable afterwards (api.md §3h) -- both MUST be chosen before the RPC
  // fires, which is why a linked-task setup step still exists even after
  // PR #162 removed the old *generic, duplicate* pre-session surface. See
  // PROGRESS.md's Focus Mode frontend entry for the full reconciliation.
  const [durationS, setDurationS] = useState(DEFAULT_DURATION_S);
  const [breakCount, setBreakCount] = useState(0);
  const [breakLengthS, setBreakLengthS] = useState(DEFAULT_BREAK_LENGTH_S);

  // Breaks are pauses with a reason tag, not a second mechanic (api.md §3h).
  // pauseReason is this CLIENT's own knowledge of why it called
  // pause_session -- the server only persists paused_at, not the reason, so
  // a session restored after a reload always falls back to "manual" (below).
  const [pauseReason, setPauseReason] = useState<PauseReason | null>(null);
  const [activeBreakIndex, setActiveBreakIndex] = useState<number | null>(null);
  const [breakRemainingS, setBreakRemainingS] = useState(0);
  const firedBreaksRef = useRef<Set<number>>(new Set());

  const [extendPromptState, setExtendPromptState] = useState<"hidden" | "shown" | "declined">("hidden");
  const expiryHandledRef = useRef(false);

  const [outcomeMode, setOutcomeMode] = useState<"choice" | "leftover">("choice");
  const [leftoverNote, setLeftoverNote] = useState("");

  const isPaused = Boolean(session?.paused_at);
  // Server truth (paused_at) always wins over the client's own memory of
  // why -- a reload loses pauseReason but never loses whether the session
  // is actually paused, so this never mis-reports paused state itself.
  const displayPauseReason: PauseReason | null = isPaused ? (pauseReason ?? "manual") : null;

  const task = linkedBlock
    ? {
        eyebrow: "Today · linked block",
        title: linkedBlock.text,
        detail: lastNoteParagraph(linkedBlock.notes) || "Stay with this one task until you have a clear next step.",
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

  const restoreSession = useCallback((running: FocusSession) => {
    setSession(running);
    setElapsedS(computeFocusElapsedS(running));
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
  // of silently creating a second local timer. Selects the 0023 columns too
  // (api.md §3h's explicit flag) -- omitting them would make a restored
  // timer over-count every pause taken before the reload.
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
      if (!error && data) restoreSession(data as unknown as FocusSession);
      setIsRunningSessionLoading(false);
    }

    void findRunningSession();
    return () => {
      cancelled = true;
    };
  }, [restoreSession]);

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

  // PR #162's fix, preserved: Focus is entered only from a concrete task.
  // Once loading settles, a request that resolved no linked block (no
  // blockId at all, or one that failed to resolve under RLS) bounces back to
  // the deck instead of rendering the old generic "Open focus" landing
  // screen. This does NOT fire when a running session was already restored
  // above (phase is "active" by then, not "ready").
  useEffect(() => {
    if (isLinkedBlockLoading || isRunningSessionLoading || phase !== "ready" || redirectDecidedRef.current) return;
    const hasRequestedBlock = Boolean(new URLSearchParams(window.location.search).get("blockId"));
    if (!hasRequestedBlock || !linkedBlock) {
      redirectDecidedRef.current = true;
      window.location.replace("/architecture-02");
    }
  }, [isLinkedBlockLoading, isRunningSessionLoading, linkedBlock, phase]);

  // Silent, auto-fired break pause -- the tick loop below marks the index
  // fired before calling this, so a transient RPC failure just means this
  // break never re-fires (rare; logged, not surfaced as a user-facing error
  // since the user did nothing wrong).
  const startBreak = useCallback(
    async (index: number) => {
      if (!session) return;
      const supabase = createClient();
      const { data, error } = await supabase.rpc("pause_session", { p_id: session.id, p_reason: "break" });
      if (error || !data) {
        console.error("[session] could not start scheduled break:", error);
        return;
      }
      setSession(data as unknown as FocusSession);
      setPauseReason("break");
      setActiveBreakIndex(index);
    },
    [session],
  );

  // Silent auto-resume when a break's own duration_s elapses.
  const endBreak = useCallback(async () => {
    if (!session) return;
    const supabase = createClient();
    const { data, error } = await supabase.rpc("resume_session", { p_id: session.id });
    if (error || !data) {
      console.error("[session] could not end scheduled break:", error);
      return;
    }
    setSession(data as unknown as FocusSession);
    setPauseReason(null);
    setActiveBreakIndex(null);
    setBreakRemainingS(0);
  }, [session]);

  // Natural expiry (deliverable 5): the session closes first
  // (complete_session, no p_block_outcome), THEN the "did you finish"
  // question is asked -- api.md §3h's decision table, row 4. Two calls on
  // purpose; the answer doesn't exist yet when the timer hits zero.
  const handleNaturalExpiry = useCallback(async () => {
    if (!session) return;
    const supabase = createClient();
    const { error } = await supabase.rpc("complete_session", { p_id: session.id });
    if (error) {
      console.error("[session] natural expiry complete_session failed, will retry:", error);
      expiryHandledRef.current = false;
      return;
    }
    setPhase("awaiting-outcome");
  }, [session]);

  // The screen owns this display-only client tick, plus (0023) break
  // auto-fire/auto-resume, the extend prompt threshold, and natural expiry
  // detection -- all driven off the same server-authoritative fields.
  useEffect(() => {
    if (!session || phase !== "active") return;

    const tick = () => {
      const nowElapsed = computeFocusElapsedS(session);
      setElapsedS(nowElapsed);

      if (session.paused_at) {
        if (pauseReason === "break" && activeBreakIndex !== null && session.break_plan) {
          const entry = session.break_plan.breaks[activeBreakIndex];
          if (entry) {
            const pausedFor = (Date.now() - Date.parse(session.paused_at)) / 1000;
            const left = Math.max(0, entry.duration_s - pausedFor);
            setBreakRemainingS(left);
            if (left <= 0) void endBreak();
          }
        }
        return;
      }

      // Not paused: is a scheduled break due? at_s is FOCUS seconds, so a
      // manual pause earlier already slid this along with the user.
      const breaks = session.break_plan?.breaks;
      if (breaks) {
        const dueIndex = breaks.findIndex((entry, i) => !firedBreaksRef.current.has(i) && nowElapsed >= entry.at_s);
        if (dueIndex !== -1) {
          firedBreaksRef.current.add(dueIndex);
          void startBreak(dueIndex);
          return;
        }
      }

      const remaining = session.planned_duration_s - nowElapsed;

      if (remaining <= EXTEND_WINDOW_S && remaining > 0 && extendPromptState === "hidden") {
        setExtendPromptState("shown");
      }

      if (remaining <= 0 && !expiryHandledRef.current) {
        expiryHandledRef.current = true;
        setExtendPromptState("hidden");
        void handleNaturalExpiry();
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [phase, session, pauseReason, activeBreakIndex, extendPromptState, startBreak, endBreak, handleNaturalExpiry]);

  const startSession = useCallback(async () => {
    if (phase !== "ready") return;
    // Do not create a session while a task passed from Architecture 02 is
    // still being resolved under RLS, or before we know whether a running
    // session already exists.
    if (isLinkedBlockLoading || isRunningSessionLoading) return;
    if (new URLSearchParams(window.location.search).get("blockId") && !linkedBlock) {
      setNotice("Loading the selected task. Try Begin focus again in a moment.");
      return;
    }

    const breakError = validateBreakPlan(durationS, breakCount, breakLengthS);
    if (breakError) {
      setNotice(breakError);
      return;
    }
    const breakPlan = buildBreakPlan(durationS, breakCount, breakLengthS);

    setNotice(null);
    setOriginRect(startButtonRef.current?.getBoundingClientRect() ?? null);
    setPhase("starting");

    const supabase = createClient();
    // p_block_id/p_break_plan omitted, not passed as null: the generated RPC
    // arg types are optional-from-DEFAULT but not unioned with null -- the
    // type generator infers optionality from DEFAULT presence but doesn't
    // union with null even when the SQL body genuinely accepts it
    // (migrations/0004, api.md §3's note). Omitting the key hits that same
    // SQL default with no runtime difference from passing null explicitly.
    const { data, error } = await supabase.rpc("start_session", {
      p_planned_duration_s: durationS,
      ...(linkedBlock ? { p_block_id: linkedBlock.id } : {}),
      ...(breakPlan ? { p_break_plan: breakPlan } : {}),
    });

    if (error || !data) {
      // If a prior live session exists, keep this single Focus surface live
      // by resuming the server-authoritative session instead of rendering a
      // conflict prompt (PR #162's simplification, preserved) -- the
      // duration/break plan just picked is discarded in favor of whatever
      // that existing session already committed to, which is the correct
      // call: it is the one actually running.
      if (isAlreadyRunningError(error)) {
        const { data: running } = await supabase
          .from("focus_sessions")
          .select("id, started_at, planned_duration_s, paused_at, total_paused_s, extended_s, break_plan")
          .eq("state", "running")
          .maybeSingle();
        if (running) {
          restoreSession(running as unknown as FocusSession);
          return;
        }
      }
      setNotice(messageFrom(error));
      setPhase("ready");
      return;
    }

    restoreSession(data as unknown as FocusSession);
    if (linkedBlock) {
      // This convenience state is client-writable by design. It must not
      // block a valid session if a transient update failure occurs.
      const { error: blockError } = await supabase
        .from("blocks")
        .update({ claimed: true, status: "in_progress" })
        .eq("id", linkedBlock.id);
      if (blockError) console.error("[session] could not mark linked block in progress:", blockError);
    }
  }, [breakCount, breakLengthS, durationS, isLinkedBlockLoading, isRunningSessionLoading, linkedBlock, phase, restoreSession]);

  // Manual "Pause" button (deliverable 3).
  const pauseSession = useCallback(async () => {
    if (!session || isSettling) return;
    setIsSettling(true);
    setNotice(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("pause_session", { p_id: session.id, p_reason: "manual" });
    setIsSettling(false);
    if (error || !data) {
      setNotice(messageFrom(error));
      return;
    }
    setSession(data as unknown as FocusSession);
    setPauseReason("manual");
  }, [session, isSettling]);

  // Manual "Resume" button -- also doubles as "Resume now" / skip-break,
  // since resuming from a break is the identical RPC call.
  const resumeSession = useCallback(async () => {
    if (!session || isSettling) return;
    setIsSettling(true);
    setNotice(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("resume_session", { p_id: session.id });
    setIsSettling(false);
    if (error || !data) {
      setNotice(messageFrom(error));
      return;
    }
    setSession(data as unknown as FocusSession);
    setPauseReason(null);
    setActiveBreakIndex(null);
    setBreakRemainingS(0);
  }, [session, isSettling]);

  // "End session" (deliverable 3): one atomic call, block -> done.
  const endSession = useCallback(async () => {
    if (!session || isSettling) return;
    setIsSettling(true);
    setNotice(null);
    const supabase = createClient();
    const { error } = await supabase.rpc("complete_session", { p_id: session.id, p_block_outcome: "done" });
    if (error) {
      setNotice(messageFrom(error));
      setIsSettling(false);
      return;
    }
    lastSettleKind.current = "complete";
    setPhase("exiting");
  }, [session, isSettling]);

  // "Leave early" (deliverable 3): reuses abandon_session -- "left early" is
  // exactly what abandoning already means, block -> in_progress, no note.
  const leaveEarly = useCallback(async () => {
    if (!session || isSettling) return;
    setIsSettling(true);
    setNotice(null);
    const supabase = createClient();
    const { error } = await supabase.rpc("abandon_session", { p_id: session.id, p_block_outcome: "in_progress" });
    if (error) {
      setNotice(messageFrom(error));
      setIsSettling(false);
      return;
    }
    lastSettleKind.current = "abandon";
    setPhase("exiting");
  }, [session, isSettling]);

  // "Do you need more time?" (deliverable 4).
  const extendSession = useCallback(
    async (minutes: number) => {
      if (!session || isSettling) return;
      setIsSettling(true);
      setNotice(null);
      const supabase = createClient();
      const { data, error } = await supabase.rpc("extend_session", {
        p_id: session.id,
        p_additional_s: minutes * 60,
      });
      setIsSettling(false);
      if (error || !data) {
        setNotice(messageFrom(error));
        return;
      }
      setSession(data as unknown as FocusSession);
      // Hidden, not declined -- the new, later deadline can re-trigger this
      // prompt again once its own last-5-minutes window arrives.
      setExtendPromptState("hidden");
    },
    [session, isSettling],
  );

  const declineExtend = useCallback(() => setExtendPromptState("declined"), []);

  // Post-expiry "did you finish, or is something left?" (deliverable 5).
  const answerFinished = useCallback(async () => {
    if (!session || isSettling) return;
    setIsSettling(true);
    setNotice(null);
    const supabase = createClient();
    const { error } = await supabase.rpc("settle_block_outcome", { p_session_id: session.id, p_outcome: "done" });
    setIsSettling(false);
    if (error) {
      setNotice(messageFrom(error));
      return;
    }
    lastSettleKind.current = "complete";
    setPhase("exiting");
  }, [session, isSettling]);

  const answerLeftover = useCallback(async () => {
    if (!session || isSettling) return;
    const trimmed = leftoverNote.trim();
    if (!trimmed) {
      setNotice("Say what's left before saving.");
      return;
    }
    setIsSettling(true);
    setNotice(null);
    const supabase = createClient();
    const { error } = await supabase.rpc("settle_block_outcome", {
      p_session_id: session.id,
      p_outcome: "in_progress",
      p_leftover_note: trimmed,
    });
    setIsSettling(false);
    if (error) {
      setNotice(messageFrom(error));
      return;
    }
    lastSettleKind.current = "leftover";
    setPhase("exiting");
  }, [session, isSettling, leftoverNote]);

  const finishExit = useCallback(() => {
    setSession(null);
    setElapsedS(0);
    setOriginRect(null);
    setIsSettling(false);
    // Do not return to a Focus surface after a session ends -- the settled
    // session (and, on the leftover-note path, the block's note) is already
    // persisted by the RPCs above. PR #162's redirect, preserved: the
    // Kanban board's own state is the source of truth for what happened,
    // not a notice on a page the user is about to leave.
    window.location.replace("/architecture-02");
  }, []);

  const trigger: EmberMorphTrigger =
    phase === "exiting" && session
      ? {
          phase: "exiting",
          sessionId: session.id,
          plannedDurationS: session.planned_duration_s,
          elapsedS,
        }
      : (phase === "active" || phase === "awaiting-outcome") && session
        ? {
            phase: "active",
            sessionId: session.id,
            plannedDurationS: session.planned_duration_s,
            // Frozen at the cap once we're past natural expiry -- there is
            // no distinct EmberMorph phase for "time's up, awaiting an
            // answer" (deliberately not changing its contract), so this
            // still maps to "active" with the ring simply held at 100%.
            elapsedS: phase === "awaiting-outcome" ? session.planned_duration_s : elapsedS,
            originRect: phase === "awaiting-outcome" ? null : originRect,
          }
        : { phase: "idle" };

  // Loading gate (PR #162): a brief, unavoidable async window before we know
  // whether there's a running session to restore or a linked block to set
  // up for. Nothing meaningful to configure yet, so no setup UI here.
  if (isLinkedBlockLoading || isRunningSessionLoading) {
    return (
      <main className={styles.page} aria-live="polite">
        <div className={styles.preparing}>
          <p>Preparing your focus session…</p>
        </div>
      </main>
    );
  }

  // Ready/starting with no active session yet: the linked-task setup screen
  // (deliverables 1/2) -- or, for the sliver of a frame before the redirect
  // effect above fires, the same loading treatment. This never renders for
  // a truly unlinked visit; PR #162's redirect-to-deck still owns that case.
  if ((phase === "ready" || phase === "starting") && !session) {
    if (!linkedBlock) {
      return (
        <main className={styles.page} aria-live="polite">
          <div className={styles.preparing}>
            <p>Preparing your focus session…</p>
          </div>
        </main>
      );
    }
    return (
      <SignalDeckListenProvider>
        <main className={styles.page}>
          <section className={styles.readyShell} aria-labelledby="session-title">
            <p className={styles.cardEyebrow}>{task.eyebrow}</p>
            <h1 id="session-title">{task.title}</h1>
            <p className={styles.intro}>
              Set your time, add breaks if you want them, and go. Your timer and coach stay with
              the work, so there is nothing to manage once you begin.
            </p>

            <SessionSetup
              durationS={durationS}
              onDurationChange={setDurationS}
              breakCount={breakCount}
              onBreakCountChange={setBreakCount}
              breakLengthS={breakLengthS}
              onBreakLengthChange={setBreakLengthS}
              disabled={phase === "starting"}
            />

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
            {notice && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}
          </section>
        </main>
      </SignalDeckListenProvider>
    );
  }

  return (
    <SignalDeckListenProvider>
      <main className={styles.page}>
        <EmberMorph trigger={trigger} onExitComplete={finishExit}>
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

              {phase === "active" && (
                <>
                  {displayPauseReason === "break" && (
                    <div className={styles.breakBanner} role="status">
                      <p>
                        <strong>On a break.</strong> Back in <span className="num">{formatMmSs(breakRemainingS)}</span>.
                      </p>
                      <button type="button" onClick={() => void resumeSession()} disabled={isSettling}>
                        Resume now
                      </button>
                    </div>
                  )}

                  {extendPromptState === "shown" && (
                    <div className={styles.extendPrompt} role="status">
                      <p>Do you need more time to finish this task?</p>
                      <div className={styles.extendActions}>
                        {EXTEND_OPTIONS_MIN.map((minutes) => (
                          <button
                            key={minutes}
                            type="button"
                            className={minutes === 10 ? styles.extendPrimary : undefined}
                            onClick={() => void extendSession(minutes)}
                            disabled={isSettling}
                          >
                            +{minutes} min
                          </button>
                        ))}
                        <button
                          type="button"
                          className={styles.extendDecline}
                          onClick={declineExtend}
                          disabled={isSettling}
                        >
                          No, I&apos;m good
                        </button>
                      </div>
                    </div>
                  )}

                  <div className={styles.sessionActions}>
                    <button
                      className={styles.pauseButton}
                      type="button"
                      onClick={() => void (isPaused ? resumeSession() : pauseSession())}
                      disabled={isSettling || displayPauseReason === "break"}
                    >
                      {isPaused ? "Resume" : "Pause"}
                    </button>
                    <button
                      className={styles.completeButton}
                      type="button"
                      onClick={() => void endSession()}
                      disabled={isSettling}
                    >
                      {isSettling ? "Saving…" : "End session"}
                    </button>
                    <button
                      className={styles.abandonButton}
                      type="button"
                      onClick={() => void leaveEarly()}
                      disabled={isSettling}
                    >
                      Leave early
                    </button>
                  </div>
                </>
              )}

              {phase === "awaiting-outcome" && (
                <div className={styles.outcomeCard}>
                  {outcomeMode === "choice" ? (
                    <>
                      <p className={styles.outcomeQuestion}>Time&apos;s up. Did you finish, or is something left?</p>
                      <div className={styles.sessionActions}>
                        <button
                          className={styles.completeButton}
                          type="button"
                          onClick={() => void answerFinished()}
                          disabled={isSettling}
                        >
                          {isSettling ? "Saving…" : "Finished"}
                        </button>
                        <button
                          className={styles.abandonButton}
                          type="button"
                          onClick={() => setOutcomeMode("leftover")}
                          disabled={isSettling}
                        >
                          Something&apos;s left
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className={styles.leftoverLabel} htmlFor="leftover-note">
                        What&apos;s left?
                      </label>
                      <textarea
                        id="leftover-note"
                        className={styles.leftoverInput}
                        value={leftoverNote}
                        onChange={(event) => setLeftoverNote(event.target.value)}
                        rows={3}
                        maxLength={2000}
                        placeholder="e.g. still need the left-join case"
                      />
                      <div className={styles.sessionActions}>
                        <button
                          className={styles.completeButton}
                          type="button"
                          onClick={() => void answerLeftover()}
                          disabled={isSettling}
                        >
                          {isSettling ? "Saving…" : "Save & leave it in progress"}
                        </button>
                        <button
                          className={styles.abandonButton}
                          type="button"
                          onClick={() => setOutcomeMode("choice")}
                          disabled={isSettling}
                        >
                          Back
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {notice && (
                <p className={styles.focusNotice} role="status">
                  {notice}
                </p>
              )}
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

          <FocusMusicDock />
        </EmberMorph>
      </main>
    </SignalDeckListenProvider>
  );
}
