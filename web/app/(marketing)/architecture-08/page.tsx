"use client";

import { useState } from "react";
import "./rose-studio.css";

type View = "today" | "work" | "calendar" | "rhythm";

export default function ArchitectureEightPage() {
  const [view, setView] = useState<View>("today");
  const [detail, setDetail] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [focus, setFocus] = useState(false);
  const [profile, setProfile] = useState(false);

  if (focus) return <FocusRoom onExit={() => setFocus(false)} />;

  return <main className="a08-shell">
    <div className="a08-petal a08-petal-one" /><div className="a08-petal a08-petal-two" /><div className="a08-grain" />
    <header className="a08-masthead">
      <button className="a08-wordmark" onClick={() => setView("today")}><i>m</i><span>mtdo</span><small>the personal<br />studio</small></button>
      <nav aria-label="Main navigation">{(["today", "work", "calendar", "rhythm"] as View[]).map((item) => <button key={item} onClick={() => setView(item)} className={view === item ? "active" : ""}>{item}</button>)}</nav>
      <div className="a08-mast-actions"><button className="a08-search" onClick={() => setAssistant(true)}>⌕ <span>Find anything</span><kbd>⌘ K</kbd></button><button className="a08-avatar" onClick={() => setProfile(!profile)}>AR</button></div>
    </header>
    {profile && <ProfileMenu onClose={() => setProfile(false)} />}
    <div className="a08-edition">VOLUME 08 <i /> SEPTEMBER 2026 <i /> A PERSONAL EDITION</div>

    {view === "today" && <Today onDetail={() => setDetail(true)} onFocus={() => setFocus(true)} onAssistant={() => setAssistant(true)} />}
    {view === "work" && <Work onDetail={() => setDetail(true)} />}
    {view === "calendar" && <Calendar onDetail={() => setDetail(true)} />}
    {view === "rhythm" && <Rhythm />}

    <button className="a08-concierge" onClick={() => setAssistant(true)}><b>✦</b><span>studio<br />concierge</span></button>
    {detail && <TaskDetail onClose={() => setDetail(false)} onFocus={() => { setDetail(false); setFocus(true); }} />}
    {assistant && <Concierge onClose={() => setAssistant(false)} onFocus={() => { setAssistant(false); setFocus(true); }} />}
  </main>;
}

function Today({ onDetail, onFocus, onAssistant }: { onDetail: () => void; onFocus: () => void; onAssistant: () => void }) {
  return <section className="a08-today">
    <header className="a08-cover"><p>Tuesday / 06 September</p><h1>A day with<br /><em>intention.</em></h1><span>Not more to do. Just the right things, in the right light.</span><button onClick={onFocus}>Enter focus room <i>↗</i></button><div className="a08-cover-number">06</div></header>
    <section className="a08-feature" onClick={onDetail} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onDetail(); }}>
      <div className="a08-feature-shape"><i /><i /><i /><b>09<br /><small>30</small></b></div>
      <div className="a08-feature-copy"><p>THE LEAD PIECE / FOCUS</p><h2>Make the difficult<br />part <em>beautiful.</em></h2><span>Algorithms · Two Sum · 45 min</span><button>Read the brief <i>→</i></button></div>
      <aside><span>YOUR ENERGY</span><b>unhurried</b><i /><small>2 of 4 intentions complete</small></aside>
    </section>
    <section className="a08-notes">
      <header><span>AROUND THE STUDIO</span><button onClick={onDetail}>See all work <i>→</i></button></header>
      <button className="a08-note a08-note-paper" onClick={onDetail}><i>12:00</i><b>Data<br />systems</b><span>Lecture / East Hall</span><em>↗</em></button>
      <button className="a08-note a08-note-rose" onClick={onDetail}><i>16:30</i><b>Portfolio<br />sprint</b><span>Deep work / solo</span><em>↗</em></button>
      <button className="a08-note a08-note-ink" onClick={onAssistant}><i>19:00</i><b>Study<br />together</b><span>SQL room / 3 people</span><em>↗</em></button>
    </section>
    <footer className="a08-quote"><span>AN OPEN NOTE</span><p>“A good day is one that leaves a little space around itself.”</p><button onClick={onAssistant}>Ask for a fresh perspective <i>✦</i></button></footer>
  </section>;
}

function Work({ onDetail }: { onDetail: () => void }) {
  const work = [["01", "Algorithms", "Two Sum", "An explanation in your own words", "today", "plum"], ["02", "Data systems", "Relational joins", "Lecture + one review note", "today", "rose"], ["03", "Portfolio", "Case-study rhythm", "Compose the first section", "tomorrow", "sand"], ["04", "Career", "Design fellowship", "Save three references", "this week", "ink"]];
  return <section className="a08-work"><header className="a08-section-intro"><p>THE WORK IN PROGRESS</p><h1>Where your<br /><em>attention</em> lives.</h1><button>+ Start a new thread</button></header><div className="a08-work-layout"><aside><span>FILTER BY FEELING</span><button className="active">Everything <i>12</i></button><button>Ready to begin <i>04</i></button><button>Needs a decision <i>02</i></button><button>Quietly waiting <i>06</i></button><footer><b>THE STUDIO RULE</b><p>Keep only one “next thing” in every thread.</p></footer></aside><section className="a08-work-list"><header><span>THREAD</span><span>NEXT MOVE</span><span>WHEN</span></header>{work.map(([n, title, task, desc, when, tone]) => <button key={title} onClick={onDetail}><i className={tone}>{n}</i><div><b>{title}</b><small>{task}</small></div><p>{desc}</p><span>{when}</span><em>↗</em></button>)}</section></div></section>;
}

function Calendar({ onDetail }: { onDetail: () => void }) {
  const days = ["MON / 05", "TUE / 06", "WED / 07", "THU / 08", "FRI / 09"];
  return <section className="a08-calendar"><header className="a08-section-intro"><p>THIS WEEK, COMPOSED</p><h1>Time is a<br /><em>material.</em></h1><div><button>←</button><b>05 — 09 SEP</b><button>→</button></div></header><div className="a08-calendar-wrap"><aside>{["08", "10", "12", "14", "16", "18", "20"].map((time) => <span key={time}>{time}<small>:00</small></span>)}</aside><div className="a08-days">{days.map((day, dayIndex) => <section key={day} className={dayIndex === 1 ? "today" : ""}><header>{day}</header>{dayIndex === 1 && <button className="a08-event plum" onClick={onDetail}><small>09:30</small><b>Two Sum</b><span>focus piece</span></button>}{dayIndex === 1 && <button className="a08-event paper noon" onClick={onDetail}><small>12:00</small><b>Data systems</b><span>lecture</span></button>}{dayIndex === 1 && <button className="a08-event rose late" onClick={onDetail}><small>16:30</small><b>Portfolio sprint</b><span>deep work</span></button>}{dayIndex === 3 && <button className="a08-event ink evening" onClick={onDetail}><small>19:00</small><b>SQL room</b><span>study group</span></button>}</section>)}</div></div><footer className="a08-calendar-note"><b>SPACE LEFT IN THE WEEK</b><p>Three unplanned evenings. Keep one completely clear.</p><button>Protect the space ↗</button></footer></section>;
}

function Rhythm() {
  const cells = Array.from({ length: 49 }, (_, n) => n);
  return <section className="a08-rhythm"><header className="a08-section-intro"><p>THE RHYTHM YOU KEEP</p><h1>Evidence, not<br /><em>pressure.</em></h1><button>Export my month ↗</button></header><div className="a08-rhythm-layout"><section className="a08-heatmap"><header><span>FOCUS HOURS / LAST 7 WEEKS</span><i>soft <b /> deep</i></header><div>{cells.map((cell) => <i className={`v${(cell * 3 + 1) % 5}`} key={cell} />)}</div><footer><p>Most nourishing pattern</p><b>Late mornings, with one generous break.</b></footer></section><section className="a08-rhythm-stat"><span>THIS MONTH</span><b>18<span>h</span></b><p>of protected attention.</p><i>↑ 24% <small>from August</small></i></section><section className="a08-rhythm-letter"><i>NOTE TO SELF</i><p>You return more easily when the next step is already waiting.</p><span>— a pattern, not a productivity score</span></section></div></section>;
}

function TaskDetail({ onClose, onFocus }: { onClose: () => void; onFocus: () => void }) {
  return <aside className="a08-detail" role="dialog" aria-modal="true" aria-label="Task brief"><header><span>FOCUS PIECE / 01</span><button onClick={onClose}>×</button></header><main><p>ALGORITHMS · DUE TODAY</p><h2>Two<br /><em>Sum.</em></h2><span>Find an approach that replaces the second search with a remembered answer.</span><section><div><i>45</i><span>minutes<br />reserved</span></div><div><i>01</i><span>proof of<br />understanding</span></div></section><article><b>THE NEXT SMALL MOVE</b><p>Write down what you would need to remember from each earlier number.</p></article><button onClick={onFocus}>Begin this piece <i>→</i></button></main><footer><button>♡ Save for later</button><button>⋯</button></footer></aside>;
}

function Concierge({ onClose, onFocus }: { onClose: () => void; onFocus: () => void }) {
  return <aside className="a08-concierge-panel" role="dialog" aria-label="Studio concierge"><header><span><i>✦</i> STUDIO CONCIERGE</span><button onClick={onClose}>×</button></header><main><p>WHAT WOULD FEEL USEFUL?</p><h2>Let&apos;s make<br />the next move<br /><em>lighter.</em></h2><button onClick={onFocus}>Help me begin Two Sum <i>→</i></button><button>Arrange my afternoon <i>→</i></button><button>Turn this thought into a task <i>→</i></button></main><footer><span>Ask anything…</span><kbd>↵</kbd></footer></aside>;
}

function ProfileMenu({ onClose }: { onClose: () => void }) {
  return <section className="a08-profile"><button onClick={onClose}>×</button><span>ARUN RAO</span><b>Personal edition</b><a>Profile</a><a>Appearance</a><a>Settings</a></section>;
}

function FocusRoom({ onExit }: { onExit: () => void }) {
  const [active, setActive] = useState(false);
  return <main className="a08-focus"><div className="a08-focus-orb" /><header><button onClick={onExit}>← Return to studio</button><span>MTDO / ONE QUIET HOUR</span><button>Ambient / Soft rain</button></header><section><p>ONE PIECE AT A TIME</p><h1>Two<br /><em>Sum.</em></h1><span>You already know enough to begin.</span><button className={active ? "a08-timer active" : "a08-timer"} onClick={() => setActive(!active)}><small>{active ? "PAUSE" : "BEGIN"}</small><b>{active ? "44:27" : "45:00"}</b><i>{active ? "your room is held" : "a small start counts"}</i></button></section><footer><button>Notes</button><i /> <button>Ask softly ✦</button><i /> <button>Leave room</button></footer></main>;
}
