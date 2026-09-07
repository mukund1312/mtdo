"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import "./theme-studio.css";
import "./chronicle-preview.css";
import "./signal-preview.css";
import "./live-preview.css";
import "./theme-atmosphere.css";
import "./theme-interaction.css";
import "./theme-gallery-layout.css";
import "./theme-gallery-position.css";

type Theme = {
  id: string;
  number: string;
  name: string;
  route: string;
  category: string;
  description: string;
  philosophy: string;
  bestFor: string;
  className: string;
  notes: string[];
};

const themes: Theme[] = [
  { id: "a01", number: "01", name: "Daily Route", route: "/architecture-01", category: "Editorial warmth", description: "An approachable workspace inspired by modern editorial design, built for everyday planning, organization, and focused work.", philosophy: "A deliberate day feels lighter when its next step is unmistakably clear.", bestFor: "Planning · Daily tasks · Students", className: "daily", notes: ["Editorial", "Warm", "Structured"] },
  { id: "a02", number: "02", name: "Signal Deck", route: "/architecture-02", category: "Chromatic workspace", description: "A vibrant, information-rich workspace designed for people who want energy, clarity, and momentum.", philosophy: "Make the work visible, then give every signal a place to move.", bestFor: "Projects · Collaboration · Creative work", className: "signal", notes: ["Chromatic", "Fast", "Layered"] },
  { id: "a03", number: "03", name: "Chronicle", route: "/architecture-03", category: "Personal archive", description: "A calm, structured environment for capturing ideas, tracking progress, and building a personal knowledge archive.", philosophy: "Small records become a meaningful story when they are easy to return to.", bestFor: "Notes · Research · Long-term projects", className: "chronicle", notes: ["Narrative", "Open", "Reflective"] },
  { id: "a07", number: "04", name: "Manga Study", route: "/architecture-07", category: "Ink studio", description: "An expressive study environment inspired by manga panels, Japanese editorial layouts, and focused visual storytelling.", philosophy: "Turn study into a scene worth entering, without losing clarity or control.", bestFor: "Studying · Reading · Creative work", className: "manga", notes: ["Ink", "Vermillion", "Cinematic"] },
  { id: "a08", number: "05", name: "Personal Studio", route: "/architecture-08", category: "Blush editorial", description: "A refined and personal workspace combining soft editorial aesthetics with modern productivity.", philosophy: "A calm, expressive room can make ambitious routines feel more personal.", bestFor: "Personal planning · Creativity · Lifestyle", className: "rose", notes: ["Soft", "Editorial", "Expressive"] },
];

export default function ThemeStudioPage() {
  const [selectedId, setSelectedId] = useState(() => {
    if (typeof window === "undefined") return "a07";
    const saved = window.localStorage.getItem("mtdo-theme");
    return saved && themes.some((theme) => theme.id === saved) ? saved : "a07";
  });
  const selected = themes.find((theme) => theme.id === selectedId) ?? themes[3]!;

  useEffect(() => {
    document.documentElement.dataset.mtdoTheme = selected.id;
    document.dispatchEvent(new CustomEvent("mtdo-theme-change", { detail: selected.id }));
  }, [selected.id]);

  const selectTheme = (id: string) => {
    setSelectedId(id);
    window.localStorage.setItem("mtdo-theme", id);
  };

  const applyTheme = (theme: Theme) => {
    window.localStorage.setItem("mtdo-theme", theme.id);
    window.location.assign(theme.route);
  };

  // All five themes are free previews (DESIGN.md: no payment UI in Wave 1,
  // decisions.md 2026-09-07: Theme Studio is paused, not a monetized
  // feature). This used to special-case only "a02" (Signal Deck) as free
  // and route every other theme through a checkout modal that displayed a
  // real-looking $12.00 charge, payment-method picker, and "secure
  // checkout" copy while never actually processing a payment -- honest
  // wording in a design doc nobody visiting the site reads doesn't change
  // what a real visitor sees on screen. Removed rather than relabeled: no
  // real monetization decision has been made, so nothing here should look
  // like one has.
  const enterTheme = (theme: Theme) => {
    applyTheme(theme);
  };

  return <main className={`ts-shell theme-${selected.className}`}>
    <ThemeAtmosphere />
    <header className="ts-header"><Link href="/" className="ts-logo"><i>m</i><span>mtdo</span></Link><div><span>THEME STUDIO</span><i /> <span>{themes.length} AVAILABLE WORLDS</span></div><button type="button" onClick={() => window.location.assign(selected.route)}>Open selected ↗</button></header>
    <section className="ts-intro"><div><p>YOUR WORK, IN A DIFFERENT LIGHT</p><h1>Choose the room<br />that fits <em>today.</em></h1></div><p>Every direction is a complete MTDO experience. Select one to preview it instantly, then enter its full workspace when it feels right.</p></section>
    <section className="ts-studio">
      <nav className="ts-gallery" aria-label="Theme gallery"><header><span>THEME GALLERY</span><small>SELECT A WORLD</small></header><div className="ts-theme-row">{themes.map((theme) => <button type="button" className={selected.id === theme.id ? "active" : ""} onClick={() => selectTheme(theme.id)} key={theme.id}><i>{theme.number}</i><div><b>{theme.name}</b><small>{theme.category}</small></div><em>{selected.id === theme.id ? "ACTIVE" : ""}</em></button>)}</div></nav>
      <div className="ts-theme-workbench"><section className="ts-preview-area"><div className="ts-preview-top"><span>LIVE PREVIEW / {selected.number}</span><button type="button" onClick={() => enterTheme(selected)}>Enter full theme <i>↗</i></button></div><Preview theme={selected} /></section><ThemeInformation theme={selected} /></div>
    </section>
    <footer className="ts-footer"><p>Your selection is saved locally on this device.</p><span>SWITCH ANY TIME · NO WORK IS MOVED OR LOST</span></footer>
  </main>;
}

function ThemeAtmosphere() {
  return <div className="ts-atmosphere" aria-hidden="true"><i /><i /><i /></div>;
}

function ThemeInformation({ theme }: { theme: Theme }) {
  return <section className="ts-theme-information" aria-live="polite">
    <header><span>DYNAMIC THEME INFORMATION</span><span className="ts-accent"><i /> ACCENT / {theme.category}</span></header>
    <div className="ts-theme-information-main"><div className="ts-theme-title"><i>{theme.number}</i><div><h2>{theme.name}</h2><p>{theme.category}</p></div></div><p className="ts-theme-description">“{theme.description}”</p><dl><div><dt>DESIGN PHILOSOPHY</dt><dd>{theme.philosophy}</dd></div><div><dt>PERSONALITY</dt><dd>{theme.notes.join(" · ")}</dd></div><div><dt>BEST FOR</dt><dd>{theme.bestFor}</dd></div></dl></div>
  </section>;
}

function Preview({ theme }: { theme: Theme }) {
  return <section className="ts-preview ts-live-preview" aria-label={`${theme.name} live theme preview`}>
    {themes.map((candidate) => <iframe className={candidate.id === theme.id ? "active" : ""} key={candidate.id} src={candidate.route} title={`${candidate.name} live preview`} />)}
    <span>LIVE THEME PREVIEW</span>
  </section>;
}

