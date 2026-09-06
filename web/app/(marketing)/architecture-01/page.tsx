"use client";

import { useState } from "react";
import "./prototype.css";

type View = "today" | "plan" | "progress" | "rooms" | "vault";

const tasks = [
  { time: "09:30", title: "Solve Two Sum", note: "Hash maps · 45 min", state: "Now" },
  { time: "11:15", title: "Review collision handling", note: "DSA notes · 20 min", state: "Next" },
  { time: "19:00", title: "Room sprint: SQL joins", note: "3 people expected", state: "Later" },
];

export default function ArchitectureOnePage() {
  const [view, setView] = useState<View>("today");
  const [atlasOpen, setAtlasOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const changeView = (next: View) => {
    setView(next);
    setAtlasOpen(false);
    setTaskOpen(false);
  };

  if (focusOpen) {
    return (
      <main className="a01-focus">
        <div className="a01-focus-grain" />
        <header className="a01-focus-head">
          <button className="a01-plain-button" onClick={() => setFocusOpen(false)}>
            ← Return to the day
          </button>
          <span>Session 01 · Personal focus</span>
          <button className="a01-plain-button" onClick={() => setTutorOpen(!tutorOpen)}>
            Ask guide ↗
          </button>
        </header>
        <section className="a01-focus-center" aria-live="polite">
          <p className="a01-kicker">ONE THING AT A TIME</p>
          <h1>Solve<br />Two Sum.</h1>
          <p className="a01-focus-intention">Find the simplest valid solution before trying to optimise it.</p>
          <button className="a01-timer" onClick={() => setRunning(!running)} aria-label="Toggle focus timer">
            <span className="a01-timer-dot">{running ? "Ⅱ" : "▶"}</span>
            <strong>{running ? "44:27" : "45:00"}</strong>
            <small>{running ? "Session in motion" : "Begin when ready"}</small>
          </button>
        </section>
        <footer className="a01-focus-foot">
          <span>Hash maps</span><span>•</span><span>45 minute container</span><span>•</span><span>Notes ready</span>
        </footer>
        {tutorOpen && <TutorNote onClose={() => setTutorOpen(false)} />}
      </main>
    );
  }

  return (
    <main className="a01-shell">
      <div className="a01-prototype-label">MTDO / ARCHITECTURE 01 — THE DAILY ROUTE</div>
      <header className="a01-header">
        <button className="a01-mark" onClick={() => setAtlasOpen(!atlasOpen)} aria-expanded={atlasOpen}>
          <span className="a01-mark-sun">✳</span><span>mtdo</span><i>atlas</i>
        </button>
        <div className="a01-date"><b>Tuesday</b><span>06 September 2026</span></div>
        <button className="a01-focus-button" onClick={() => setFocusOpen(true)}>Enter focus <span>→</span></button>
      </header>

      {atlasOpen && (
        <nav className="a01-atlas" aria-label="Main navigation">
          <p>THE ATLAS</p>
          {(["today", "plan", "progress", "rooms", "vault"] as View[]).map((item, index) => (
            <button key={item} onClick={() => changeView(item)} className={view === item ? "is-active" : ""}>
              <span>0{index + 1}</span>{item}
            </button>
          ))}
          <div className="a01-atlas-footer">Settings · Help · Profile</div>
        </nav>
      )}

      {view === "today" && (
        <section className="a01-day" aria-label="Today">
          <aside className="a01-spine">
            <span className="a01-spine-top">TODAY’S LINE</span>
            <span className="a01-spine-date">06</span>
            <div className="a01-spine-rule" />
            <span className="a01-spine-month">SEP</span>
            <p>Three deliberate<br />places to be.</p>
          </aside>

          <div className="a01-day-main">
            <div className="a01-greeting">
              <p className="a01-kicker">YOUR DAY, HELD LIGHTLY</p>
              <h1>Good morning,<br /><em>Arun.</em></h1>
              <p>You do not need to finish everything. You need to begin the right thing.</p>
            </div>
            <button className="a01-task-ticket" onClick={() => setTaskOpen(true)}>
              <span className="a01-ticket-edge">NOW</span>
              <span className="a01-ticket-copy"><small>09:30 · DSA / PROBLEM SOLVING</small><strong>Solve Two Sum</strong><i>Find one clean approach. The rest of the day can wait.</i></span>
              <span className="a01-ticket-arrow">↗</span>
            </button>
            <div className="a01-day-lower">
              <section className="a01-promise">
                <span className="a01-kicker">THE PROMISE</span>
                <p>One focused session is enough to keep your route alive.</p>
                <div><b>04</b><span>days of showing up</span></div>
              </section>
              <section className="a01-need">
                <span className="a01-kicker">NEEDS A LOOK</span>
                <button onClick={() => changeView("plan")}><b>01</b><span>task slipped from yesterday</span><i>→</i></button>
                <button onClick={() => changeView("rooms")}><b>19:00</b><span>SQL room sprint begins</span><i>→</i></button>
              </section>
            </div>
          </div>

          <aside className="a01-route">
            <div className="a01-route-head"><span>THE ROUTE</span><button onClick={() => changeView("plan")}>Open plan ↗</button></div>
            {tasks.map((task, index) => (
              <button key={task.title} className={`a01-route-item ${index === 0 ? "is-now" : ""}`} onClick={() => index === 0 ? setTaskOpen(true) : changeView("plan")}>
                <time>{task.time}</time><span className="a01-route-dot" /><div><b>{task.title}</b><small>{task.note}</small></div><em>{task.state}</em>
              </button>
            ))}
            <p className="a01-route-end">Day closes<br />when you do.</p>
          </aside>
        </section>
      )}

      {view === "plan" && <PlanView onTask={() => setTaskOpen(true)} onFocus={() => setFocusOpen(true)} />}
      {view === "progress" && <ProgressView />}
      {view === "rooms" && <RoomsView onFocus={() => setFocusOpen(true)} />}
      {view === "vault" && <VaultView onTutor={() => setTutorOpen(true)} />}

      <button className="a01-guide-pebble" onClick={() => setTutorOpen(!tutorOpen)} aria-label="Open learning guide">✦<span>Guide</span></button>
      {taskOpen && <TaskSheet onClose={() => setTaskOpen(false)} onFocus={() => setFocusOpen(true)} onTutor={() => setTutorOpen(true)} />}
      {tutorOpen && <TutorNote onClose={() => setTutorOpen(false)} />}
    </main>
  );
}

function TaskSheet({ onClose, onFocus, onTutor }: { onClose: () => void; onFocus: () => void; onTutor: () => void }) {
  return <aside className="a01-task-sheet" role="dialog" aria-modal="true" aria-label="Task details">
    <button className="a01-close" onClick={onClose}>Close ×</button>
    <p className="a01-kicker">09:30 · DSA / PROBLEM SOLVING</p>
    <h2>Solve Two Sum</h2>
    <p className="a01-sheet-lede">A small problem with a useful habit inside it: identify the lookup you wish you had, then make it.</p>
    <dl><div><dt>Session</dt><dd>45 minutes</dd></div><div><dt>Place</dt><dd>Today’s first step</dd></div><div><dt>Outcome</dt><dd>Explain the tradeoff</dd></div></dl>
    <div className="a01-sheet-actions"><button className="a01-solid" onClick={onFocus}>Enter focus →</button><button className="a01-outline" onClick={onTutor}>Ask the guide</button></div>
    <p className="a01-sheet-foot">Linked note: <u>Hash maps, in plain language</u></p>
  </aside>;
}

function TutorNote({ onClose }: { onClose: () => void }) {
  return <aside className="a01-tutor-note" role="dialog" aria-label="Learning guide">
    <button className="a01-close" onClick={onClose}>×</button>
    <p className="a01-kicker">A NOTE FROM YOUR GUIDE</p>
    <h2>Before you write code</h2>
    <p>If you had already seen the first number you need, where would you keep it so it can answer you instantly?</p>
    <button className="a01-outline">Write a thought…</button>
  </aside>;
}

function PlanView({ onTask, onFocus }: { onTask: () => void; onFocus: () => void }) {
  return <section className="a01-secondary"><p className="a01-kicker">PLAN / THIS WEEK</p><div className="a01-secondary-heading"><h1>A route, not a pile.</h1><button className="a01-solid" onClick={onFocus}>Focus the next step →</button></div><div className="a01-plan-grid"><section><span>MONDAY</span><button><i>Done</i> Arrays: foundations</button><button><i>Done</i> Review two-pointer patterns</button></section><section className="is-today"><span>TUESDAY · TODAY</span><button onClick={onTask}><i>Now</i> Solve Two Sum <b>↗</b></button><button><i>Next</i> Review collision handling</button></section><section><span>WEDNESDAY</span><button><i>Ready</i> Valid Anagram</button><button><i>Ready</i> Hash map drills</button></section></div><p className="a01-caption">List, Board, and Schedule are modes of this route—not separate products.</p></section>;
}

function ProgressView() {
  const cells = Array.from({ length: 35 }, (_, index) => index);
  return <section className="a01-secondary"><p className="a01-kicker">PROGRESS / SEPTEMBER</p><div className="a01-secondary-heading"><h1>The record<br />is yours.</h1><p>A history for noticing what helps—not another score to chase.</p></div><div className="a01-progress-layout"><div className="a01-heatmap">{cells.map((cell) => <span className={`is-${cell % 8 === 0 ? "bright" : cell % 3 === 0 ? "warm" : "quiet"}`} key={cell} />)}</div><section className="a01-progress-note"><b>04</b><p>consecutive days with a real session</p><small>Best rhythm: mornings before 10</small></section></div></section>;
}

function RoomsView({ onFocus }: { onFocus: () => void }) {
  return <section className="a01-secondary"><p className="a01-kicker">ROOMS / SHARED COMMITMENT</p><div className="a01-secondary-heading"><h1>Not alone,<br />not ranked.</h1><p>Friends are here to make the promise easier to keep.</p></div><div className="a01-room-card"><div><span>SQL STUDY ROUTE</span><h2>Three people meet at 19:00</h2><p>Shared aim: become comfortable with joins before Friday’s practice interview.</p></div><button className="a01-solid" onClick={onFocus}>Join the sprint →</button></div></section>;
}

function VaultView({ onTutor }: { onTutor: () => void }) {
  return <section className="a01-secondary"><p className="a01-kicker">VAULT / RETRIEVAL, NOT STORAGE</p><div className="a01-secondary-heading"><h1>Things worth<br />keeping close.</h1><button className="a01-outline" onClick={onTutor}>Ask guide about this</button></div><div className="a01-vault-list"><button><span>01</span><b>Hash maps, in plain language</b><em>Linked to today</em></button><button><span>02</span><b>SQL joins: a visual mental model</b><em>Room note</em></button><button><span>03</span><b>Questions I missed in mock one</b><em>Private</em></button></div></section>;
}
