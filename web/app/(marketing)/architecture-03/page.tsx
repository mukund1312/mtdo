"use client";

import { useState } from "react";
import "./chronicle.css";

type Lens = "today" | "flow" | "calendar" | "history";

const moments = [
  { time: "09:30", title: "Two Sum", kind: "FOCUS", color: "cobalt", note: "A clean first pass", width: "wide" },
  { time: "11:15", title: "Collision handling", kind: "REVIEW", color: "lemon", note: "20 minutes", width: "small" },
  { time: "14:00", title: "Open space", kind: "BREATH", color: "mist", note: "Keep it unclaimed", width: "medium" },
  { time: "19:00", title: "SQL room sprint", kind: "TOGETHER", color: "coral", note: "3 people on the line", width: "wide" },
];

export default function ArchitectureThreePage() {
  const [lens, setLens] = useState<Lens>("today");
  const [momentOpen, setMomentOpen] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);

  if (focusOpen) return <BlankRoom onExit={() => setFocusOpen(false)} />;

  return <main className="a03-shell">
    <div className="a03-prototype-tag">MTDO / ARCHITECTURE 03 — CHRONICLE</div>
    <header className="a03-header">
      <button className="a03-logo" onClick={() => setLens("today")}>MT<span>●</span>DO</button>
      <nav className="a03-lenses" aria-label="Application lenses">
        {(["today", "flow", "calendar", "history"] as Lens[]).map((item, index) => <button className={lens === item ? "is-active" : ""} onClick={() => setLens(item)} key={item}><i>0{index + 1}</i>{item}</button>)}
      </nav>
      <div className="a03-header-tools"><button className="a03-sound-chip" onClick={() => setSoundOpen(!soundOpen)}>⌁ Sound</button><button className="a03-avatar">A</button></div>
    </header>
    {soundOpen && <SoundBloom onClose={() => setSoundOpen(false)} />}

    {lens === "today" && <TodayChronicle onOpen={() => setMomentOpen(true)} onFocus={() => setFocusOpen(true)} />}
    {lens === "flow" && <FlowLens onOpen={() => setMomentOpen(true)} />}
    {lens === "calendar" && <CalendarLens onOpen={() => setMomentOpen(true)} />}
    {lens === "history" && <HistoryLens />}

    <button className="a03-question" onClick={() => setTutorOpen(true)}><span>?</span> Ask about this moment <kbd>⌘ K</kbd></button>
    {momentOpen && <MomentExpansion onClose={() => setMomentOpen(false)} onFocus={() => setFocusOpen(true)} onTutor={() => setTutorOpen(true)} />}
    {tutorOpen && <QuestionLayer onClose={() => setTutorOpen(false)} />}
  </main>;
}

function TodayChronicle({ onOpen, onFocus }: { onOpen: () => void; onFocus: () => void }) {
  return <section className="a03-today">
    <div className="a03-today-title"><p>CHAPTER 06 / TUESDAY</p><h1>A day with<br /><em>room to move.</em></h1><span>September 2026</span></div>
    <section className="a03-now-orb"><div className="a03-orb-ring r1" /><div className="a03-orb-ring r2" /><div className="a03-orb-center"><small>RIGHT NOW</small><strong>09:24</strong><i>morning is open</i></div></section>
    <button className="a03-launch-strip" onClick={onFocus}><i>01</i><span>THE NEXT MOMENT</span><b>Begin a 45 minute focus</b><em>Launch ↗</em></button>
    <section className="a03-moment-rail" aria-label="Timeline of today">
      <div className="a03-rail-line" />
      {moments.map((moment, index) => <button onClick={onOpen} key={moment.title} className={`a03-moment ${moment.color} ${moment.width} ${index === 0 ? "is-current" : ""}`}><time>{moment.time}</time><span>{moment.kind}</span><b>{moment.title}</b><small>{moment.note}</small>{index === 0 && <i>↗</i>}</button>)}
    </section>
    <div className="a03-day-foot"><span>04 days kept</span><i /> <span>3h 20m unclaimed</span><i /> <span>1 room gathers tonight</span></div>
  </section>;
}

function FlowLens({ onOpen }: { onOpen: () => void }) {
  return <section className="a03-flow"><div className="a03-lens-title"><p>LENS 02 / FLOW</p><h1>Where things<br /><em>are becoming.</em></h1><span>Drag moments across the current.</span></div><div className="a03-flow-river"><section className="a03-flow-bank bank-a"><header><b>NOT YET</b><i>04</i></header><button onClick={onOpen}>Valid Anagram</button><button onClick={onOpen}>System design: cache</button></section><div className="a03-current"><span>THE CURRENT</span><i /><i /><i /><i /></div><section className="a03-flow-bank bank-b"><header><b>IN MOTION</b><i>01</i></header><button onClick={onOpen} className="a03-flow-live"><small>LIVE / 09:30</small>Two Sum <em>↗</em></button></section><section className="a03-flow-bank bank-c"><header><b>REMEMBERED</b><i>02</i></header><button>Arrays: foundations</button><button>Two pointers</button></section></div><p className="a03-flow-note">There are no “columns.” Work travels through a current.</p></section>;
}

function CalendarLens({ onOpen }: { onOpen: () => void }) {
  const dates = ["MON 05", "TUE 06", "WED 07", "THU 08", "FRI 09"];
  return <section className="a03-calendar"><div className="a03-lens-title"><p>LENS 03 / CALENDAR</p><h1>The week,<br /><em>unfolded.</em></h1><span>Tap a moment to stretch it open.</span></div><div className="a03-week"><aside className="a03-time-ruler"><span>08</span><span>10</span><span>12</span><span>14</span><span>16</span><span>18</span><span>20</span></aside>{dates.map((date, index) => <section className={index === 1 ? "a03-week-day is-today" : "a03-week-day"} key={date}><header>{date}</header>{index === 1 && <button className="a03-week-event ev-focus" onClick={onOpen}><small>09:30</small><b>Two Sum</b></button>}{index === 1 && <button className="a03-week-event ev-review" onClick={onOpen}><small>11:15</small><b>Collision handling</b></button>}{index === 1 && <button className="a03-week-event ev-room" onClick={onOpen}><small>19:00</small><b>SQL room</b></button>}{index === 3 && <button className="a03-week-event ev-focus faint" onClick={onOpen}><small>10:00</small><b>Mock round</b></button>}</section>)}</div></section>;
}

function HistoryLens() {
  const strips = Array.from({ length: 28 }, (_, index) => index);
  return <section className="a03-history"><div className="a03-lens-title"><p>LENS 04 / HISTORY</p><h1>Leave a<br /><em>bright trace.</em></h1><span>Proof that you returned is more useful than a score.</span></div><section className="a03-history-field"><div className="a03-trace"><span>WEEK 36</span><div>{strips.map((strip) => <i className={`t${(strip * 3) % 6}`} key={strip} />)}</div><b>6 h 40 m</b><small>focused time</small></div><div className="a03-history-stats"><article><strong>04</strong><span>days with<br />a real start</span></article><article><strong>08</strong><span>moments<br />completed</span></article><article><strong>03</strong><span>proofs<br />captured</span></article></div><button className="a03-record-card">Make this week a shareable record <span>↗</span></button></section></section>;
}

function MomentExpansion({ onClose, onFocus, onTutor }: { onClose: () => void; onFocus: () => void; onTutor: () => void }) {
  return <section className="a03-moment-expansion" role="dialog" aria-modal="true" aria-label="Moment details"><button className="a03-expansion-close" onClick={onClose}>×</button><div className="a03-expansion-number">01</div><div className="a03-expansion-copy"><span>09:30 / FOCUS / DSA</span><h2>Two Sum</h2><p>Find the shape of the simplest answer before making it fast.</p><div className="a03-expansion-tags"><i>45 MIN</i><i>DAY 04</i><i>HASH MAPS</i></div><button className="a03-begin" onClick={onFocus}>Begin this moment →</button><button className="a03-text-button" onClick={onTutor}>Ask a question first</button></div><aside className="a03-expansion-prompt"><span>COACHING PROMPT</span><p>What answer does the inner loop keep trying to discover?</p><button onClick={onTutor}>Work with Tutor ↗</button></aside></section>;
}

function QuestionLayer({ onClose }: { onClose: () => void }) {
  return <section className="a03-question-layer" role="dialog" aria-label="Tutor question layer"><button className="a03-layer-close" onClick={onClose}>Close ×</button><div className="a03-layer-orb">?</div><div className="a03-layer-copy"><span>YOUR TUTOR / ATTENDING TO THIS MOMENT</span><h2>What are you<br />wondering?</h2><div className="a03-question-input"><p>Could I start with two loops?</p><button>Send ↗</button></div><small>The Tutor begins with a question, not an answer.</small></div><aside><p>CONTEXT</p><b>Two Sum</b><span>DSA / 45 min focus</span></aside></section>;
}

function SoundBloom({ onClose }: { onClose: () => void }) {
  return <section className="a03-sound-bloom"><button onClick={onClose}>×</button><span>SOUND SCENE</span><div className="a03-vinyl">◉</div><b>Soft static</b><small>Deep work radio / playing now</small><div className="a03-sound-controls"><i>‹</i><strong>Ⅱ</strong><i>›</i></div></section>;
}

function BlankRoom({ onExit }: { onExit: () => void }) {
  const [running, setRunning] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  return <main className="a03-blank"><header><button onClick={onExit}>← Leave room</button><span>MTDO / ONE MOMENT ONLY</span><button onClick={() => setTutorOpen(true)}>Ask a question ?</button></header><div className="a03-blank-rule top" /><section className="a03-blank-center"><div className="a03-blank-index">01 / 01</div><h1>Two<br /><em>Sum</em></h1><p>A clean answer begins by naming the repeated question.</p><button onClick={() => setRunning(!running)} className={running ? "a03-big-clock is-running" : "a03-big-clock"}><small>{running ? "PAUSE" : "START"}</small><strong>{running ? "44:27" : "45:00"}</strong><i>{running ? "the room is holding" : "make the room quiet"}</i></button></section><footer><button>Notes <i>0</i></button><span>Focus protocol / 45 minutes</span><button>Sound <i>on</i></button></footer>{tutorOpen && <QuestionLayer onClose={() => setTutorOpen(false)} />}</main>;
}
