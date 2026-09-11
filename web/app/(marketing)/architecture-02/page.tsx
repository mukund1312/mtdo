"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SignalDeckAccountControl } from "./account-control";
import { CalendarDeck } from "./calendar-deck";
import { GoalsDeck } from "./goals-deck";
import { ListenDeck } from "./listen-deck";
import { SignalDeckListenProvider, useSignalDeckListen } from "./listen-state";
import { fetchProfileTimezone } from "./profile-timezone";
import { formatDuration, utcDateRange, utcToday } from "./product-data";
import { ProgressDeck } from "./progress-deck";
import { SignalDeckConfirmedWelcome } from "./signal-deck-confirmed-welcome";
import { SignalDeckWalkthrough } from "./signal-deck-walkthrough";
import { computeStreaks } from "./streak";
import { isBlockStatus, TodayDeck, type BlockStatus, type TodayBlock } from "./today-deck";
import { SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY } from "./walkthrough-data";
import "./signal-deck.css";
import "./route-entry.css";
import "./product-deck.css";
import "./signal-deck-walkthrough.css";
import "./account-control.css";
import "./listen-deck.css";
import "./listen-deck-polish.css";
import "./goals-deck.css";
import "./kanban-metadata.css";
import "./calendar-deck.css";
import "./fixed-layer-safety.css";
import "./weekly-review.css";

type Deck = "home" | "work" | "goals" | "calendar" | "review" | "listen";

function isDeck(value: string | null): value is Deck {
  return value === "home" || value === "work" || value === "goals" || value === "calendar" || value === "review" || value === "listen";
}

export default function ArchitectureTwoPage() {
  // Suspense must stay outermost -- ArchitectureTwoDeck's useSearchParams()
  // requires it for static prerendering (PR #133's fix; this branch was cut
  // before that landed, so its own version of this file dropped the
  // boundary entirely -- merging it as-is would have silently reintroduced
  // the prerender crash). SignalDeckListenProvider nests inside, same as any
  // other context provider would.
  return (
    <Suspense fallback={null}>
      <SignalDeckListenProvider>
        <ArchitectureTwoDeck />
      </SignalDeckListenProvider>
    </Suspense>
  );
}

function ArchitectureTwoDeck() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const authState = searchParams.get("auth");
  const [deck, setDeck] = useState<Deck>("home");
  const [lensOpen, setLensOpen] = useState(false);
  const [activeBlock, setActiveBlock] = useState<TodayBlock | null>(null);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [confirmedWelcomeOpen, setConfirmedWelcomeOpen] = useState(false);
  const [confirmedWalkthrough, setConfirmedWalkthrough] = useState(false);
  const [welcomeName, setWelcomeName] = useState<string | null>(null);

  // Onboarding finishes on the real Today board. Keep the deck itself stateful
  // (rather than turning each dock tab into a route), while allowing a direct
  // handoff from a successfully persisted plan.
  useEffect(() => {
    const requestedDeck = searchParams.get("deck");
    if (!isDeck(requestedDeck)) return;
    const timer = window.setTimeout(() => setDeck(requestedDeck), 0);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

  // The callback is the only route that sets `auth=confirmed`. Remove the
  // transient URL signal once the welcome state is open, so refreshes and
  // returning password logins never replay this new-account journey.
  useEffect(() => {
    if (authState !== "confirmed") return;
    const timer = window.setTimeout(() => {
      setConfirmedWelcomeOpen(true);
      router.replace("/architecture-02");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [authState, router]);

  useEffect(() => {
    if (authState) return;
    // A ?deck handoff (onboarding/Manual Setup/Import all finish this way)
    // is a deliberate landing on a specific deck -- the walkthrough's own
    // first step forces deck back to "home" on open (SignalDeckWalkthrough's
    // onDeckChange effect), which would silently undo the handoff for any
    // first-time visitor who reaches this page without having dismissed the
    // tour on an earlier visit. The handoff wins; the tour is still one
    // click away via "? Guide".
    if (isDeck(searchParams.get("deck"))) return;
    try {
      if (!window.localStorage.getItem(SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY)) {
        const timer = window.setTimeout(() => setWalkthroughOpen(true), 0);
        return () => window.clearTimeout(timer);
      }
    } catch {
      // Storage is only a convenience. A blocked storage API must not stop the deck.
    }
  }, [authState, searchParams]);

  useEffect(() => {
    const openWithShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey ||
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)) return;
      event.preventDefault();
      setWalkthroughOpen(true);
    };
    window.addEventListener("keydown", openWithShortcut);
    return () => window.removeEventListener("keydown", openWithShortcut);
  }, []);

  const dismissWalkthrough = () => {
    try {
      window.localStorage.setItem(SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY, "seen");
    } catch {
      // A user can still dismiss the guide when browser storage is unavailable.
    }
    setWalkthroughOpen(false);
  };

  const finishConfirmedJourney = () => {
    try {
      window.localStorage.setItem(SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY, "seen");
    } catch {
      // Route setup must remain available if storage is blocked.
    }
    setWalkthroughOpen(false);
    setConfirmedWalkthrough(false);
    router.push("/architecture-02/onboarding");
  };

  const beginConfirmedGuide = (name: string | null) => {
    setWelcomeName(name);
    setConfirmedWelcomeOpen(false);
    setConfirmedWalkthrough(true);
    setWalkthroughOpen(true);
  };

  const recoverConfirmation = () => {
    setConfirmedWelcomeOpen(false);
    router.replace("/architecture-02?auth=login");
  };

  const openBlock = (block: TodayBlock | null) => {
    setActiveBlock(block);
    setLensOpen(true);
  };

  const beginActiveBlock = () => {
    // No fake local timer to fall back to (see the removed FocusChamber) --
    // /session is the one real focus screen, linked-block or not.
    if (activeBlock) {
      router.push(`/session?blockId=${encodeURIComponent(activeBlock.id)}`);
      return;
    }
    router.push("/session");
  };

  return (
    <main className="a02-shell">
      <div className="a02-grid-glow" />
      <div className="a02-prototype-tag">MTDO / ARCHITECTURE 02 — SIGNAL DECK</div>
      <header className="a02-topline">
        <button className="a02-wordmark" onClick={() => setDeck("home")} aria-label="Open signal deck">mtdo<span>◒</span></button>
        <LiveReadout />
        <div className="a02-top-actions">
          <SignalDeckAccountControl />
          <button className="a02-guide-trigger" onClick={() => setWalkthroughOpen(true)} aria-keyshortcuts="?">? Guide</button>
        </div>
      </header>

      {deck === "home" && <HomeDeck onTask={openBlock} onCalendar={() => setDeck("calendar")} onReview={() => setDeck("review")} onWork={() => setDeck("work")} />}
      {deck === "work" && <TodayDeck onOpenBlock={openBlock} />}
      {deck === "goals" && <GoalsDeck />}
      {deck === "calendar" && <CalendarDeck />}
      {deck === "review" && <ProgressDeck />}
      {deck === "listen" && <ListenDeck />}

      <AudioTransport onOpenListen={() => setDeck("listen")} />
      <DeckDock active={deck} onChange={setDeck} onMore={() => router.push("/architecture-02/settings")} />
      {lensOpen && <ObjectLens block={activeBlock} onClose={() => setLensOpen(false)} onFocus={beginActiveBlock} />}
      {confirmedWelcomeOpen && <SignalDeckConfirmedWelcome onBeginGuide={beginConfirmedGuide} onRecover={recoverConfirmation} onSkipToOnboarding={finishConfirmedJourney} />}
      {walkthroughOpen && <SignalDeckWalkthrough
        completionLabel={confirmedWalkthrough ? "Set up my route ↗" : undefined}
        greeting={confirmedWalkthrough ? welcomeName ?? "there" : null}
        onDeckChange={setDeck}
        onDismiss={confirmedWalkthrough ? finishConfirmedJourney : dismissWalkthrough}
        onFinish={confirmedWalkthrough ? finishConfirmedJourney : undefined}
        skipLabel={confirmedWalkthrough ? "Skip to route setup" : undefined}
      />}
    </main>
  );
}

type HomeBlock = { id: string; position: number; status: BlockStatus; text: string };
type RunningSession = { id: string; plannedDurationS: number; startedAt: string };
type HomeState = "loading" | "ready" | "error";

function nextHomeBlock(blocks: HomeBlock[]): HomeBlock | null {
  return (
    blocks.find((block) => block.status === "in_progress") ??
    blocks.find((block) => block.status === "todo") ??
    blocks.find((block) => block.status === "backlog") ??
    null
  );
}

function secondsSince(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// Streak window: matches ProgressDeck's own 6-week heatmap so "longest" means
// the same thing on both screens, not two different definitions of "window."
const HOME_STREAK_WINDOW_DAYS = 42;
const HOME_SESSION_MINUTES = 50; // matches session/page.tsx's DEFAULT_DURATION_S

function HomeDeck({
  onCalendar,
  onReview,
  onTask,
  onWork,
}: {
  onCalendar: () => void;
  onReview: () => void;
  onTask: (block: TodayBlock | null) => void;
  onWork: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<HomeState>("loading");
  const [goalLine, setGoalLine] = useState<string | null>(null);
  const [blocksToday, setBlocksToday] = useState<HomeBlock[]>([]);
  const [running, setRunning] = useState<RunningSession | null>(null);
  const [todayFocusSeconds, setTodayFocusSeconds] = useState(0);
  const [streaks, setStreaks] = useState({ current: 0, longest: 0 });
  const [last7FocusSeconds, setLast7FocusSeconds] = useState<number[]>([]);
  // Value itself is unused -- setTick just forces a re-render every second
  // so heroDetail's secondsSince(running.startedAt) recomputes live.
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setState("loading");
    const supabase = createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setState("error");
      return;
    }

    const timezone = await fetchProfileTimezone(supabase, user.id);
    const today = utcToday(timezone);
    const windowDates = utcDateRange(HOME_STREAK_WINDOW_DAYS, today);

    const [
      { data: activePlan, error: planError },
      { data: blocksData, error: blocksError },
      { data: runningData, error: runningError },
      { data: rollupsData, error: rollupsError },
    ] = await Promise.all([
      supabase.from("plans").select("goal_line").eq("user_id", user.id).eq("is_active", true).maybeSingle(),
      supabase.from("blocks").select("id, status, position, text").eq("user_id", user.id).eq("date", today).order("position"),
      supabase.from("focus_sessions").select("id, planned_duration_s, started_at").eq("state", "running").maybeSingle(),
      supabase
        .from("daily_rollups")
        .select("blocks_done, date, focus_seconds")
        .eq("user_id", user.id)
        .is("room_id", null)
        .gte("date", windowDates[0]!)
        .lte("date", windowDates.at(-1)!),
    ]);

    if (planError || blocksError || runningError || rollupsError) {
      console.error("[home] failed to load signal deck:", planError ?? blocksError ?? runningError ?? rollupsError);
      setState("error");
      return;
    }

    setGoalLine(activePlan?.goal_line ?? null);
    setBlocksToday((blocksData ?? []).flatMap((block) => (isBlockStatus(block.status) ? [{ ...block, status: block.status }] : [])));
    setRunning(
      runningData
        ? { id: runningData.id, plannedDurationS: runningData.planned_duration_s, startedAt: runningData.started_at }
        : null,
    );
    const rollups = rollupsData ?? [];
    const rollupByDate = new Map(rollups.map((rollup) => [rollup.date, rollup]));
    setTodayFocusSeconds(rollupByDate.get(today)?.focus_seconds ?? 0);
    setStreaks(computeStreaks(rollups, today, HOME_STREAK_WINDOW_DAYS));
    setLast7FocusSeconds(windowDates.slice(-7).map((date) => rollupByDate.get(date)?.focus_seconds ?? 0));
    setState("ready");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [running]);

  const next = useMemo(() => nextHomeBlock(blocksToday), [blocksToday]);
  const doneCount = useMemo(() => blocksToday.filter((block) => block.status === "done").length, [blocksToday]);
  const remaining = blocksToday.length - doneCount;

  const beginFocus = () => {
    if (running) {
      router.push("/session");
      return;
    }
    router.push(next ? `/session?blockId=${encodeURIComponent(next.id)}` : "/session");
  };

  const openNextInLens = () => {
    if (!next) {
      onTask(null);
      return;
    }
    // ObjectLens never reads category/priority/estimate (or claimed/elapsed_seconds/notes,
    // already synthesized below before migrations/0018 existed) -- Home's own
    // lightweight query intentionally doesn't fetch fields nothing here displays.
    onTask({ category_id: "", category_label: null, claimed: false, elapsed_seconds: 0, estimated_minutes: null, id: next.id, notes: null, position: next.position, priority: "medium", status: next.status, text: next.text });
  };

  const loading = state === "loading";
  const heroLabel = running ? "IN MOTION" : next ? "ACTIVE VECTOR" : "NO TASK QUEUED";
  const heroTitle = running ? "Resume session" : next ? next.text : "Nothing queued";
  const heroDetail = running
    ? `${formatClock(secondsSince(running.startedAt))} elapsed`
    : next
      ? `${HOME_SESSION_MINUTES}:00 / ready to launch`
      : "Add a task from Today to begin.";

  return (
    <section className="a02-home" aria-label="Signal deck home">
      <section className="a02-home-intro">
        <span className="a02-eyebrow">TODAY’S SIGNAL</span>
        <h1>
          Build
          <br />
          <em>momentum.</em>
        </h1>
        <p>{loading ? "Reading your route." : goalLine ?? "No active route yet -- set one up to get real signal here."}</p>
        <a className="a02-route-setup" href="/architecture-02/onboarding">
          Set up your route <i>↗</i>
        </a>
      </section>
      <button className="a02-focus-node" onClick={beginFocus} disabled={loading}>
        <span className="a02-node-orbit a02-o1" />
        <span className="a02-node-orbit a02-o2" />
        <span className="a02-node-core">▶</span>
        <div>
          <small>{heroLabel}</small>
          <strong>{loading ? "…" : heroTitle}</strong>
          <em>{loading ? "" : heroDetail}</em>
        </div>
        <b>
          {running ? "RESUME" : "START"}
          <br />
          FOCUS ↗
        </b>
      </button>
      <section className="a02-signal-stack">
        <button className="a02-signal-card a02-card-route" onClick={openNextInLens} disabled={loading}>
          <span>01 / TASK SIGNAL</span>
          <b>{loading ? "…" : next ? next.text : "All clear"}</b>
          <p>{loading ? "" : next ? "Open its details." : "No queued task for today."}</p>
          <i>OPEN LENS ↗</i>
        </button>
        <button className="a02-signal-card a02-card-room" onClick={onWork} disabled={loading}>
          <span>02 / TODAY’S LOAD</span>
          <strong>
            {loading ? "…" : doneCount}
            <span>/{loading ? "…" : blocksToday.length}</span>
          </strong>
          <p>{loading ? "Reading today's board." : blocksToday.length === 0 ? "Nothing scheduled today." : "Blocks completed today."}</p>
        </button>
        <button className="a02-signal-card a02-card-time" onClick={onCalendar} disabled={loading}>
          <span>03 / TIME FIELD</span>
          <strong>{loading ? "…" : remaining}</strong>
          <p>{loading ? "" : remaining === 1 ? "block left today" : "blocks left today"}</p>
          <i>VIEW AGENDA ↗</i>
        </button>
        <button className="a02-signal-card a02-card-proof" onClick={onReview} disabled={loading}>
          <span>04 / PROOF LOOP</span>
          <div className="a02-proof-bars">
            {(loading ? Array<number>(7).fill(0) : last7FocusSeconds).map((seconds, index) => (
              <i
                key={index}
                style={{ height: loading ? "8%" : `${seconds === 0 ? 4 : Math.max(15, Math.round((seconds / Math.max(...last7FocusSeconds, 1)) * 100))}%` }}
              />
            ))}
          </div>
          <b>{loading ? "…" : `${streaks.current}-day streak`}</b>
          <p>{loading ? "" : `${formatDuration(todayFocusSeconds)} focused today · longest ${streaks.longest} days`}</p>
        </button>
      </section>
      {state === "error" && (
        <p className="a02-product-note" role="alert">
          Home is unavailable. We could not load your signal deck. <button type="button" onClick={() => void load()}>Try again ↗</button>
        </p>
      )}
    </section>
  );
}

function LiveReadout() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setNow(new Date()), 0);
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, []);

  if (!now) {
    return (
      <div className="a02-live-readout">
        <span className="a02-live-pip" /> <i>{"///"}</i> PERSONAL ROUTE
      </div>
    );
  }

  const day = new Intl.DateTimeFormat("en", { weekday: "long" }).format(now).toUpperCase();
  const date = new Intl.DateTimeFormat("en", { day: "2-digit", month: "short" }).format(now).toUpperCase();
  const time = new Intl.DateTimeFormat("en", { hour: "2-digit", hour12: false, minute: "2-digit" }).format(now);

  return (
    <div className="a02-live-readout">
      <span className="a02-live-pip" /> {day} / {date} / {time} <i>{"///"}</i> PERSONAL ROUTE
    </div>
  );
}

function DeckDock({ active, onChange, onMore }: { active: Deck; onChange: (next: Deck) => void; onMore: () => void }) {
  const items: [Deck, string, string][] = [["home", "◉", "Deck"], ["work", "▦", "Kanban"], ["goals", "◎", "Goals"], ["calendar", "⌗", "Time"], ["review", "◌", "Review"], ["listen", "♫", "Listen"]];
  return <nav className="a02-dock" aria-label="Signal deck navigation">{items.map(([id, icon, label]) => <button key={id} className={active === id ? "is-active" : ""} onClick={() => onChange(id)}><i>{icon}</i><span>{label}</span></button>)}<button className="a02-dock-more" onClick={onMore}><i>···</i><span>More</span></button></nav>;
}

function AudioTransport({ onOpenListen }: { onOpenListen: () => void }) {
  const listen = useSignalDeckListen();
  const musicTrack = listen.currentTrack;
  const radioStation = listen.selectedStation;
  const isRadio = listen.mode === "radio";
  const active = isRadio ? listen.radioPlayback === "playing" : listen.musicPlaying;
  const title = isRadio ? radioStation?.id ?? "Radio ready" : musicTrack?.title ?? "Listening studio";
  const detail = isRadio ? radioStation?.genre ?? "11 stations / UI preview" : musicTrack ? `${musicTrack.artist} / UI preview` : "Music + Radio / UI preview";
  const toggle = () => isRadio ? listen.toggleRadio() : listen.toggleMusic();
  return <div className="a02-audio"><button onClick={toggle} aria-label={active ? "Pause listening preview" : "Play listening preview"} disabled={!musicTrack && !radioStation}>{active ? "Ⅱ" : "▶"}</button><div className={active ? "a02-wave is-playing" : "a02-wave"}>{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div><span><b>{title}</b><small>{detail}</small></span><button className="a02-audio-expand" onClick={onOpenListen} aria-label="Open Listen">↗</button></div>;
}

function ObjectLens({ block, onClose, onFocus }: { block: TodayBlock | null; onClose: () => void; onFocus: () => void }) {
  const title = block?.text ?? "No task selected";
  const detail = block?.notes?.trim() || "Open a task from Today to see its details here.";
  return <section className="a02-lens" role="dialog" aria-modal="true" aria-label="Task lens"><button className="a02-lens-close" onClick={onClose}>ESC / close ×</button><div className="a02-lens-orbit"><i /><i /><i /><b>01</b></div><div className="a02-lens-copy"><span className="a02-eyebrow">TASK OBJECT / {block?.status === "in_progress" ? "IN MOTION" : "READY"}</span><h2>{title}</h2><p>{detail}</p><div className="a02-lens-meta"><span>{block?.status.replace("_", " ") ?? "No task"}</span><span>{block?.elapsed_seconds ? `${Math.max(1, Math.round(block.elapsed_seconds / 60))} MIN` : "FOCUS"}</span><span>TODAY</span></div><div><button className="a02-lens-go" onClick={onFocus}>Launch focus →</button></div></div></section>;
}
