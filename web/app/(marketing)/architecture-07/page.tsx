"use client";

import { useState } from "react";
import "./kage.css";
import "./focus-room.css";

type Chapter = "today" | "missions" | "schedule" | "archive";

export default function ArchitectureSevenPage() {
  const [chapter, setChapter] = useState<Chapter>("today");
  const [task, setTask] = useState(false);
  const [sensei, setSensei] = useState(false);
  const [focus, setFocus] = useState(false);
  if (focus) return <FocusSpread onLeave={() => setFocus(false)} />;

  return <main className="a07-shell">
    <div className="a07-paper-noise" />
    <header className="a07-topbar">
      <button className="a07-mark" onClick={() => setChapter("today")} aria-label="Go to chapter one"><b>MT</b><span>mtdo</span><i>STUDY<br />MANGA</i></button>
      <nav aria-label="Manga chapters">{(["today", "missions", "schedule", "archive"] as Chapter[]).map((item, index) => <button className={chapter === item ? "active" : ""} onClick={() => setChapter(item)} key={item}><i>CH.{String(index + 1).padStart(2, "0")}</i>{item}</button>)}</nav>
      <div className="a07-tools"><button onClick={() => setSensei(true)}>ASK SENSEI <b>✦</b></button><span>AR</span></div>
    </header>
    <div className="a07-ribbon"><span>MTDO — YOUR PERSONAL STUDY MANGA</span><b>◆</b><span>ISSUE 07 / TUESDAY, 06 SEPTEMBER</span><b>◆</b><span>THE NEXT PAGE IS YOURS</span></div>
    {chapter === "today" && <Today onTask={() => setTask(true)} onFocus={() => setFocus(true)} onSensei={() => setSensei(true)} />}
    {chapter === "missions" && <Missions onTask={() => setTask(true)} />}
    {chapter === "schedule" && <Schedule onTask={() => setTask(true)} />}
    {chapter === "archive" && <Archive />}
    <button className="a07-floating-sensei" onClick={() => setSensei(true)}><i>✦</i><span>Need a<br />hint?</span></button>
    {task && <MissionSheet onClose={() => setTask(false)} onFocus={() => { setTask(false); setFocus(true); }} onSensei={() => setSensei(true)} />}
    {sensei && <SenseiPanel onClose={() => setSensei(false)} onFocus={() => { setSensei(false); setFocus(true); }} />}
  </main>;
}

function Today({ onTask, onFocus, onSensei }: { onTask: () => void; onFocus: () => void; onSensei: () => void }) {
  return <section className="a07-today">
    <section className="a07-title-page"><p>CHAPTER ONE / A GOOD PLACE TO BEGIN</p><h1>MAKE<br />TODAY<br /><em>MOVE.</em></h1><span>One meaningful scene at a time.</span><button onClick={onFocus}>Start the opening scene <i>→</i></button><div className="a07-issue">07<small>SEPT<br />2026</small></div></section>
    <section className="a07-lead-panel" role="button" tabIndex={0} onClick={onTask} onKeyDown={(event) => { if (event.key === "Enter") onTask(); }}>
      <div className="a07-panel-caption">PAGE 01 / THE MAIN QUEST</div><div className="a07-halftone" /><div className="a07-hero-figure"><i /><i /><i /><i /><b>AR</b></div><div className="a07-lead-copy"><span>09:30 — FOCUS</span><h2>Two<br /><em>Sum.</em></h2><p>Turn the hard question into one small move.</p><button>Open mission <i>↗</i></button></div><div className="a07-boom">GO!</div><div className="a07-lead-footer"><span>45 MIN</span><i /> <span>ALGORITHMS</span><i /> <span>READY WHEN YOU ARE</span></div>
    </section>
    <section className="a07-side-page"><header><span>YOUR<br />CHARACTER<br />SHEET</span><b>01</b></header><div className="a07-mini-portrait"><i /><i /><i /><b>AR</b></div><p><strong>Arun Rao</strong><small>Level 04 — steady learner</small></p><div className="a07-energy"><span>ENERGY</span><i /><b>calm &amp; ready</b></div><button onClick={onSensei}>Change your status ↗</button></section>
    <section className="a07-scenes"><header><p>THE REST OF THE ISSUE</p><h2>Three scenes<br /><em>waiting in the wings.</em></h2></header><button className="a07-scene-card a07-scene-cream" onClick={onTask}><span>SCENE 02</span><b>Data<br />systems</b><small>12:00 / EAST HALL</small><i>LECTURE</i></button><button className="a07-scene-card a07-scene-red" onClick={onTask}><span>SCENE 03</span><b>Portfolio<br />sprint</b><small>16:30 / DEEP WORK</small><i>MAKE</i></button><button className="a07-scene-card a07-scene-black" onClick={onSensei}><span>SCENE 04</span><b>SQL study<br />room</b><small>19:00 / WITH FRIENDS</small><i>TOGETHER</i></button></section>
    <footer className="a07-end-card"><b>THE NARRATOR SAYS:</b><p>“Momentum is built in panels, not all at once.”</p><button onClick={onSensei}>Ask Sensei what to do next <i>✦</i></button></footer>
  </section>;
}

function Missions({ onTask }: { onTask: () => void }) {
  const missions = [["01", "Algorithms", "Two Sum", "Focus / 45 min", "NOW", "red"], ["02", "Data systems", "Relational joins", "Lecture / 12:00", "TODAY", "cream"], ["03", "Portfolio", "Case-study sprint", "Make / 16:30", "TODAY", "purple"], ["04", "Career", "Design fellowship", "Collect / this week", "LATER", "grey"]];
  return <section className="a07-missions"><header className="a07-page-header"><div><p>CHAPTER TWO / MISSION BOARD</p><h1>Your next<br /><em>four moves.</em></h1></div><button>+ Write a mission</button></header><section className="a07-mission-list"><header><span>NO.</span><span>MISSION</span><span>THE NEXT PANEL</span><span>STATE</span></header>{missions.map(([no, arc, title, next, state, tone]) => <button onClick={onTask} key={arc}><i className={tone}>{no}</i><div><b>{arc}</b><small>{title}</small></div><p>{next}</p><em>{state}</em><strong>↗</strong></button>)}</section><section className="a07-mission-foot"><div><span>WHAT MAKES A MISSION?</span><p>A clear next panel, one reason to care, and an ending you can recognize.</p></div><b>4<br /><small>active<br />missions</small></b></section></section>;
}

function Schedule({ onTask }: { onTask: () => void }) {
  const days = ["MON 05", "TUE 06", "WED 07", "THU 08", "FRI 09"];
  return <section className="a07-schedule"><header className="a07-page-header"><div><p>CHAPTER THREE / TIME SPREAD</p><h1>Give the day<br /><em>some panels.</em></h1></div><div className="a07-date-switch"><button>←</button><b>05 — 09 SEPT</b><button>→</button></div></header><section className="a07-calendar"><aside>{["08", "10", "12", "14", "16", "18", "20"].map((time) => <span key={time}>{time}:00</span>)}</aside><div>{days.map((day, index) => <section className={index === 1 ? "today" : ""} key={day}><header>{day}</header>{index === 1 && <button className="a07-timebox red" onClick={onTask}><i>09:30</i><b>Two Sum</b><span>FOCUS</span></button>}{index === 1 && <button className="a07-timebox cream mid" onClick={onTask}><i>12:00</i><b>Data systems</b><span>CLASS</span></button>}{index === 1 && <button className="a07-timebox purple later" onClick={onTask}><i>16:30</i><b>Portfolio</b><span>MAKE</span></button>}{index === 3 && <button className="a07-timebox black evening" onClick={onTask}><i>19:00</i><b>SQL room</b><span>TOGETHER</span></button>}</section>)}</div></section><footer><p><b>DIRECTOR&apos;S NOTE</b> Three open evenings remain. Save one for a plot twist.</p><button>Protect some quiet time ↗</button></footer></section>;
}

function Archive() {
  const cells = Array.from({ length: 42 }, (_, index) => index);
  return <section className="a07-archive"><header className="a07-page-header"><div><p>CHAPTER FOUR / THE BACK PAGES</p><h1>Look how far<br /><em>the story goes.</em></h1></div><button>Save this issue ↗</button></header><div className="a07-archive-grid"><section className="a07-heat"><header><b>STUDY PANELS / LAST 6 WEEKS</b><span>quiet <i /> intense</span></header><div>{cells.map((cell) => <i className={`v${(cell * 7 + 2) % 5}`} key={cell} />)}</div><footer><span>YOUR FAVOURITE PATTERN</span><b>Late mornings + a first small win.</b></footer></section><section className="a07-streak"><span>RETURN STREAK</span><b>04</b><p>days you chose the next panel.</p></section><section className="a07-quote-panel"><span>FROM YESTERDAY&apos;S MARGIN</span><p>“I stopped trying to solve it all at once.”</p><small>Algorithms / 21:14</small></section></div></section>;
}

function MissionSheet({ onClose, onFocus, onSensei }: { onClose: () => void; onFocus: () => void; onSensei: () => void }) {
  return <section className="a07-mission-sheet" role="dialog" aria-label="Mission detail"><header><span>MISSION FILE / 01</span><button onClick={onClose}>×</button></header><main><aside><i>FOCUS<br />QUEST</i><b>01</b></aside><div><p>ALGORITHMS / OPENING SCENE</p><h2>Two<br /><em>Sum.</em></h2><span>The goal is not to be fast. The goal is to notice what an earlier number can become.</span><section><div><b>45</b><span>minutes<br />reserved</span></div><div><b>01</b><span>idea to<br />explain</span></div></section><article><i>THE FIRST LINE OF THE SCENE</i><p>“What would I need to remember from every number I have already seen?”</p></article><footer><button onClick={onFocus}>Enter focus <i>→</i></button><button onClick={onSensei}>Ask Sensei ✦</button></footer></div></main></section>;
}

function SenseiPanel({ onClose, onFocus }: { onClose: () => void; onFocus: () => void }) {
  return <aside className="a07-sensei" role="dialog" aria-label="Ask Sensei"><header><span>THE SENSEI&apos;S CORNER</span><button onClick={onClose}>×</button></header><div className="a07-sensei-figure"><i /><i /><i /><b>✦</b></div><main><p>A SMALL NUDGE, NOT A SPOILER</p><h2>Start with<br /><em>what you know.</em></h2><article>For Two Sum: If a number is missing its partner, what could you leave behind so you recognize that partner later?</article><button onClick={onFocus}>Take this into focus <i>→</i></button></main><footer><span>Ask another question…</span><kbd>↵</kbd></footer></aside>;
}

function FocusSpread({ onLeave }: { onLeave: () => void }) {
  const [playing, setPlaying] = useState(false);
  return <main className="a07-focus"><div className="a07-focus-rays" /><header><button onClick={onLeave}>← Close the book</button><span>CHAPTER ONE / FOCUS SPREAD</span><button>♬ Lo-fi rain</button></header><section><p>ONE QUIET PANEL</p><h1>Two<br /><em>Sum.</em></h1><span>What needs to be remembered?</span><button onClick={() => setPlaying(!playing)} className={playing ? "a07-clock playing" : "a07-clock"}><i>{playing ? "PAUSE" : "BEGIN"}</i><b>{playing ? "44:27" : "45:00"}</b><small>{playing ? "the scene is moving" : "turn the first page"}</small></button></section><footer><button>Margin notes</button><i>◆</i><button>Ask Sensei ✦</button><i>◆</i><button>Leave focus</button></footer></main>;
}
