"use client";

import { BarChart3, Clock3, Headphones, Layers3, LayoutPanelTop, Settings2, Target, type LucideIcon } from "lucide-react";

import { DOCK_STYLES, DOCK_STYLE_DETAILS, type DockStyle, useDockStyle } from "./dock-preference";

import "./dock-style-chooser.css";

const PREVIEW_ITEMS: Array<{ icon: LucideIcon; label: string }> = [
  { icon: Layers3, label: "Deck" },
  { icon: LayoutPanelTop, label: "Kanban" },
  { icon: Target, label: "Goals" },
  { icon: Clock3, label: "Time" },
  { icon: BarChart3, label: "Review" },
  { icon: Headphones, label: "Listen" },
  { icon: Settings2, label: "Settings" },
];

function DockPreview({ style }: { style: DockStyle }) {
  return <div className={`a02-dock-preview a02-dock-preview--${style}`} aria-hidden="true">
    <div className="a02-dock-preview-items">
      {PREVIEW_ITEMS.map(({ icon: Icon, label }) => <span key={label}><i><Icon size={14} strokeWidth={2} /></i><small>{label}</small></span>)}
    </div>
    <b>☰ <em>Menu</em></b>
  </div>;
}

/** Actual device preference control. Its previews use the same five style IDs
 * consumed by the live Architecture 02 dock; selecting a card writes once and
 * the dock updates through the shared preference event without a reload. */
export function DockStyleChooser() {
  const [selected, choose] = useDockStyle();

  return <section className="a02-dock-style" aria-labelledby="dock-style-title">
    <header>
      <div>
        <span className="a02-eyebrow">APPEARANCE</span>
        <b id="dock-style-title">Dock style</b>
      </div>
      <i>Current: {DOCK_STYLE_DETAILS[selected].name}</i>
    </header>
    <p>Choose how Signal Deck navigation opens and behaves on this device.</p>
    <div className="a02-dock-style-grid" role="radiogroup" aria-labelledby="dock-style-title">
      {DOCK_STYLES.map((style) => {
        const detail = DOCK_STYLE_DETAILS[style];
        const isSelected = selected === style;
        return <button
          key={style}
          type="button"
          role="radio"
          aria-checked={isSelected}
          className={isSelected ? "is-selected" : ""}
          onClick={() => choose(style)}
        >
          <DockPreview style={style} />
          <span><b>{detail.name}</b><small>{detail.description}</small></span>
          <i>{isSelected ? "✓ Selected" : "Choose"}</i>
        </button>;
      })}
    </div>
    <p className="a02-settings-note">Your choice is saved locally on this device and applies to every Signal Deck screen that shows navigation.</p>
  </section>;
}
