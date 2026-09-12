"use client";

import { useCallback, useEffect, useState } from "react";

export const DOCK_STYLE_STORAGE_KEY = "mtdo-dock-style";
const DOCK_STYLE_EVENT = "mtdo-dock-style-change";

export const DOCK_STYLES = ["fan", "orbit", "rail", "inline", "wheel"] as const;
export type DockStyle = (typeof DOCK_STYLES)[number];

export const DOCK_STYLE_DETAILS: Record<DockStyle, { name: string; description: string }> = {
  fan: { name: "Fan Menu", description: "A compact Menu control opens into a curved fan." },
  orbit: { name: "Orbit Menu", description: "Navigation expands as a spatial orbital constellation." },
  rail: { name: "Horizontal Rail", description: "Destinations emerge into one clean rail above Menu." },
  inline: { name: "Inline Launcher", description: "Navigation opens sideways on Menu’s own baseline." },
  wheel: { name: "Navigation Wheel", description: "A full-screen directional wheel for fast navigation." },
};

export function isDockStyle(value: string | null): value is DockStyle {
  return value !== null && (DOCK_STYLES as readonly string[]).includes(value);
}

function readDockStyle(): DockStyle {
  try {
    const stored = window.localStorage.getItem(DOCK_STYLE_STORAGE_KEY);
    return isDockStyle(stored) ? stored : "fan";
  } catch {
    return "fan";
  }
}

export function saveDockStyle(style: DockStyle) {
  try {
    window.localStorage.setItem(DOCK_STYLE_STORAGE_KEY, style);
    window.dispatchEvent(new CustomEvent<DockStyle>(DOCK_STYLE_EVENT, { detail: style }));
  } catch {
    // The live in-memory state still changes when storage is unavailable.
  }
}

/** Device-level preference hook shared by Settings and the actual dock. */
export function useDockStyle(): [DockStyle, (style: DockStyle) => void] {
  const [style, setStyle] = useState<DockStyle>("fan");

  useEffect(() => {
    const timer = window.setTimeout(() => setStyle(readDockStyle()), 0);
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (isDockStyle(detail)) setStyle(detail);
      else setStyle(readDockStyle());
    };
    window.addEventListener(DOCK_STYLE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(DOCK_STYLE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const choose = useCallback((next: DockStyle) => {
    setStyle(next);
    saveDockStyle(next);
  }, []);

  return [style, choose];
}
