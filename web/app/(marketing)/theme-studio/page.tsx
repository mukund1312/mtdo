"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./theme-studio.css";
import "./chronicle-preview.css";
import "./signal-preview.css";
import "./live-preview.css";
import "./theme-checkout.css";
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
  const [checkoutTheme, setCheckoutTheme] = useState<Theme | null>(null);
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

  const enterTheme = (theme: Theme) => {
    if (theme.id === "a02") {
      applyTheme(theme);
      return;
    }
    setCheckoutTheme(theme);
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
    {checkoutTheme && <ThemeCheckout theme={checkoutTheme} onClose={() => setCheckoutTheme(null)} onApply={() => applyTheme(checkoutTheme)} />}
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

function ThemeCheckout({ theme, onClose, onApply }: { theme: Theme; onClose: () => void; onApply: () => void }) {
  const [method, setMethod] = useState("Card");

  return createPortal(<section className={`ts-payment-backdrop pay-${theme.className}`} role="dialog" aria-modal="true" aria-labelledby="checkout-title">
    <form className="ts-payment-modal" onSubmit={(event) => { event.preventDefault(); onApply(); }}>
      <header><span>SECURE CHECKOUT · THEME {theme.number}</span><button type="button" onClick={onClose} aria-label="Close payment window">×</button></header>
      <div className="ts-payment-theme"><div className="ts-payment-swatch"><b>{theme.number}</b><i /></div><div><small>SELECTED THEME</small><h2 id="checkout-title">{theme.name}</h2><p>{theme.description}</p></div></div>
      <div className="ts-payment-price"><div><small>THEME ACCESS</small><b>One-time theme unlock</b></div><strong>$12.00</strong></div>
      <fieldset className="ts-payment-methods"><legend>PAYMENT METHOD</legend><div>{["Card", "Wallet", "UPI"].map((option) => <button type="button" className={method === option ? "active" : ""} onClick={() => setMethod(option)} key={option}><i>{option === "Card" ? "▣" : option === "Wallet" ? "◒" : "₹"}</i>{option}</button>)}</div></fieldset>
      <p className="ts-payment-billing">$12.00 charged once. No subscription or automatic renewal. Theme applies immediately after confirmation.</p>
      <button className="ts-payment-submit" type="submit">Pay &amp; Apply Theme <i>↗</i></button>
      <footer><span>⌁ Secure checkout · encrypted payment</span><button type="button" onClick={onClose}>Cancel</button></footer>
    </form>
  </section>, document.body);
}
