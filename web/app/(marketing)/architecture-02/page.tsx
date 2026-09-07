"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SignalDeckAccountControl } from "./account-control";
import { ProgressDeck } from "./progress-deck";
import { SignalDeckConfirmedWelcome } from "./signal-deck-confirmed-welcome";
import { SignalDeckWalkthrough } from "./signal-deck-walkthrough";
import { TodayDeck, type TodayBlock } from "./today-deck";
import { SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY } from "./walkthrough-data";
import "./signal-deck.css";
import "./route-entry.css";
import "./product-deck.css";
import "./signal-deck-walkthrough.css";
import "./account-control.css";

type Deck = "home" | "work" | "calendar" | "review";

function isDeck(value: string | null): value is Deck {
  return value === "home" || value === "work" || value === "calendar" || value === "review";
}

export default function ArchitectureTwoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const authState = searchParams.get("auth");
  const [deck, setDeck] = useState<Deck>("home");
  const [lensOpen, setLensOpen] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [playing, setPlaying] = useState(true);
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
    try {
      if (!window.localStorage.getItem(SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY)) {
        const timer = window.setTimeout(() => setWalkthroughOpen(true), 0);
        return () => window.clearTimeout(timer);
      }
    } catch {
      // Storage is only a convenience. A blocked storage API must not stop the deck.
    }
  }, [authState]);

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
    if (activeBlock) {
      router.push(`/session?blockId=${encodeURIComponent(activeBlock.id)}`);
      return;
    }
    setFocusOpen(true);
  };

  if (focusOpen) {
    return <FocusChamber onExit={() => setFocusOpen(false)} />;
  }

  return (
    <main className="a02-shell">
      <div className="a02-grid-glow" />
      <div className="a02-prototype-tag">MTDO / ARCHITECTURE 02 — SIGNAL DECK</div>
      <header className="a02-topline">
        <button className="a02-wordmark" onClick={() => setDeck("home")} aria-label="Open signal deck">mtdo<span>◒</span></button>
        <div className="a02-live-readout"><span className="a02-live-pip" /> TUESDAY / 06 SEP / 09:24 <i>{"///"}</i> PERSONAL ROUTE</div>
        <div className="a02-top-actions">
          <SignalDeckAccountControl />
          <button className="a02-guide-trigger" onClick={() => setWalkthroughOpen(true)} aria-keyshortcuts="?">? Guide</button>
          <button className="a02-command" onClick={() => setTutorOpen(true)}>⌘ &nbsp; Ask anything <kbd>space</kbd></button>
        </div>
      </header>

      {deck === "home" && <HomeDeck onTask={() => openBlock(null)} onFocus={() => setFocusOpen(true)} onCalendar={() => setDeck("calendar")} onReview={() => setDeck("review")} />}
      {deck === "work" && <TodayDeck onOpenBlock={openBlock} />}
      {deck === "calendar" && <CalendarDeck onTask={() => openBlock(null)} />}
      {deck === "review" && <ProgressDeck />}

      <button className={`a02-beacon ${tutorOpen ? "is-active" : ""}`} onClick={() => setTutorOpen(true)} aria-label="Open tutor copilot"><span>✦</span><i>CO-PILOT</i></button>
      <AudioTransport playing={playing} onToggle={() => setPlaying(!playing)} />
      <DeckDock active={deck} onChange={setDeck} />
      {lensOpen && <ObjectLens block={activeBlock} onClose={() => setLensOpen(false)} onFocus={beginActiveBlock} onTutor={() => setTutorOpen(true)} />}
      {tutorOpen && <TutorConsole onClose={() => setTutorOpen(false)} />}
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

function HomeDeck({ onTask, onFocus, onCalendar, onReview }: { onTask: () => void; onFocus: () => void; onCalendar: () => void; onReview: () => void }) {
  return <section className="a02-home" aria-label="Signal deck home">
    <section className="a02-home-intro">
      <span className="a02-eyebrow">TODAY’S SIGNAL</span>
      <h1>Build<br /><em>momentum.</em></h1>
      <p>One clean session moves the route forward. The rest is noise.</p>
      <a className="a02-route-setup" href="/architecture-02/onboarding">Set up your route <i>↗</i></a>
    </section>
    <button className="a02-focus-node" onClick={onFocus}>
      <span className="a02-node-orbit a02-o1" /><span className="a02-node-orbit a02-o2" /><span className="a02-node-core">▶</span>
      <div><small>ACTIVE VECTOR</small><strong>Two Sum</strong><em>45:00 / ready to launch</em></div><b>START<br />FOCUS ↗</b>
    </button>
    <section className="a02-signal-stack">
      <button className="a02-signal-card a02-card-route" onClick={onTask}><span>01 / TASK SIGNAL</span><b>Two Sum</b><p>Find the lookup you wish you had.</p><i>OPEN LENS ↗</i></button>
      <button className="a02-signal-card a02-card-room"><span>02 / ROOM PULSE</span><div className="a02-people"><i>AK</i><i>JM</i><i>+1</i></div><b>3 learners live</b><p>SQL route resumes at 19:00</p></button>
      <button className="a02-signal-card a02-card-time" onClick={onCalendar}><span>03 / TIME FIELD</span><strong>3<span>h</span> 20<span>m</span></strong><p>Open space left today</p><i>VIEW AGENDA ↗</i></button>
      <button className="a02-signal-card a02-card-proof" onClick={onReview}><span>04 / PROOF LOOP</span><div className="a02-proof-bars"><i /><i /><i /><i /><i /><i /><i /></div><b>4-day signal</b><p>Your rhythm strengthens before 10 AM.</p></button>
    </section>
  </section>;
}

function CalendarDeck({ onTask }: { onTask: () => void }) {
  const hours = ["08", "09", "10", "11", "12", "13", "14", "15", "16"];
  return <section className="a02-calendar"><div className="a02-view-head"><div><span className="a02-eyebrow">TIME FIELD / TUESDAY 06</span><h1>Give time<br /><em>a shape.</em></h1></div><div className="a02-date-switch"><button>‹</button><b>SEP 06</b><button>›</button></div></div><div className="a02-time-map"><aside>{hours.map((hour) => <span key={hour}>{hour}:00</span>)}</aside><div className="a02-time-lines">{hours.map((hour) => <i key={hour} />)}<button className="a02-calendar-event event-dsa" onClick={onTask}><small>09:30 — 10:15</small><b>Two Sum</b><span>Focus block · DSA</span></button><button className="a02-calendar-event event-review"><small>11:15 — 11:35</small><b>Collision handling</b><span>Review</span></button><button className="a02-calendar-event event-room"><small>19:00 — 20:00</small><b>SQL room sprint</b><span>3 members expected</span></button></div><aside className="a02-unscheduled"><span>UNSCHEDULED / 02</span><button>Valid Anagram <i>+</i></button><button>System design: cache <i>+</i></button></aside></div></section>;
}

function DeckDock({ active, onChange }: { active: Deck; onChange: (next: Deck) => void }) {
  const items: [Deck, string, string][] = [["home", "◉", "Deck"], ["work", "▦", "Work"], ["calendar", "⌗", "Time"], ["review", "◌", "Review"]];
  return <nav className="a02-dock" aria-label="Signal deck navigation">{items.map(([id, icon, label]) => <button key={id} className={active === id ? "is-active" : ""} onClick={() => onChange(id)}><i>{icon}</i><span>{label}</span></button>)}<button className="a02-dock-more"><i>···</i><span>More</span></button></nav>;
}

function AudioTransport({ playing, onToggle }: { playing: boolean; onToggle: () => void }) {
  return <div className="a02-audio"><button onClick={onToggle} aria-label="Toggle audio">{playing ? "Ⅱ" : "▶"}</button><div className={playing ? "a02-wave is-playing" : "a02-wave"}>{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div><span><b>Deep work radio</b><small>Focus noise / 01</small></span><button className="a02-audio-expand">↗</button></div>;
}

function ObjectLens({ block, onClose, onFocus, onTutor }: { block: TodayBlock | null; onClose: () => void; onFocus: () => void; onTutor: () => void }) {
  const title = block?.text ?? "Two Sum";
  const detail = block?.notes?.trim() || "Find the simplest lookup that turns a pair search into one pass.";
  return <section className="a02-lens" role="dialog" aria-modal="true" aria-label="Task lens"><button className="a02-lens-close" onClick={onClose}>ESC / close ×</button><div className="a02-lens-orbit"><i /><i /><i /><b>01</b></div><div className="a02-lens-copy"><span className="a02-eyebrow">TASK OBJECT / {block?.status === "in_progress" ? "IN MOTION" : "READY"}</span><h2>{title}</h2><p>{detail}</p><div className="a02-lens-meta"><span>{block?.status.replace("_", " ") ?? "DSA"}</span><span>{block?.elapsed_seconds ? `${Math.max(1, Math.round(block.elapsed_seconds / 60))} MIN` : "FOCUS"}</span><span>TODAY</span></div><div><button className="a02-lens-go" onClick={onFocus}>Launch focus →</button><button className="a02-lens-ask" onClick={onTutor}>Ask co-pilot</button></div></div><aside className="a02-lens-side"><span>COACHING SIGNAL</span><p>Before you begin, name the one question this block needs to answer.</p><button onClick={onTutor}>Open thought prompt ↗</button></aside></section>;
}

function TutorConsole({ onClose }: { onClose: () => void }) {
  return <section className="a02-tutor" role="dialog" aria-label="Tutor copilot"><header><div><span className="a02-live-pip" /> CO-PILOT ONLINE</div><button onClick={onClose}>×</button></header><div className="a02-tutor-stream"><p className="a02-tutor-context">CONTEXT RECEIVED / TWO SUM / DSA</p><article><i>YOU</i><p>I keep thinking of two loops. Is that wrong?</p></article><article className="a02-tutor-response"><i>CO-PILOT</i><p>It is a sound starting point. Before replacing it, name the repeated question the inner loop asks. Could an earlier answer be saved?</p></article></div><div className="a02-tutor-input"><button>+</button><span>Reply with a thought…</span><kbd>↵</kbd></div></section>;
}

function FocusChamber({ onExit }: { onExit: () => void }) {
  const [running, setRunning] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  return <main className="a02-focus"><div className="a02-focus-stars" /><header><button onClick={onExit}>× EXIT FIELD</button><span>MTDO / FOCUS PROTOCOL 01</span><button onClick={() => setTutorOpen(true)}>CO-PILOT ✦</button></header><section className="a02-focus-main"><div className="a02-focus-status"><i className={running ? "is-running" : ""} /> DSA / TASK IN MOTION</div><h1>Two<br /><em>Sum.</em></h1><p>One question. One clean answer.</p><button className="a02-focus-clock" onClick={() => setRunning(!running)}><span>{running ? "PAUSE" : "BEGIN"}</span><strong>{running ? "44:27" : "45:00"}</strong><i>{running ? "signal stable" : "tap to launch"}</i></button></section><footer><span>NOTES READY</span><i>◆</i><span>DEEP WORK RADIO</span><i>◆</i><span>GUIDANCE AVAILABLE</span></footer>{tutorOpen && <TutorConsole onClose={() => setTutorOpen(false)} />}</main>;
}
