"use client";

import { Moon, Sun } from "lucide-react";

import { THEMES, type Theme, useTheme } from "./theme-preference";

import "./theme-chooser.css";

const DETAILS: Record<Theme, { description: string; icon: typeof Moon; label: string }> = {
  dark: { label: "Dark", description: "Midnight / Signal Deck", icon: Moon },
  light: { label: "Light", description: "Daylight / Signal Deck", icon: Sun },
};

export function ThemeChooser() {
  const [theme, choose] = useTheme();

  return <section className="a02-theme-choice" aria-labelledby="theme-title">
    <header>
      <span className="a02-eyebrow">APPEARANCE</span>
      <b id="theme-title">Theme</b>
    </header>
    <p>Choose how MTDO looks on this device.</p>
    <div className="a02-theme-options" role="radiogroup" aria-labelledby="theme-title">
      {THEMES.map((option) => {
        const detail = DETAILS[option];
        const Icon = detail.icon;
        const selected = option === theme;
        return <button key={option} type="button" role="radio" aria-checked={selected} className={selected ? "is-selected" : ""} onClick={() => choose(option)}>
          <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
          <span><b>{detail.label}</b><small>{detail.description}</small></span>
          <i>{selected ? "Selected" : "Choose"}</i>
        </button>;
      })}
    </div>
  </section>;
}
