"use client";

import { useCallback, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "mtdo-theme";
const THEME_EVENT = "mtdo-theme-change";

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.a02Theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
  } catch {
    // The in-memory preference still applies for this visit.
  }
}

/** One device preference shared by Settings and every Signal Deck surface. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const sync = (event?: Event) => {
      const detail = (event as CustomEvent<string> | undefined)?.detail;
      const storedTheme = detail ?? null;
      const next = isTheme(storedTheme) ? storedTheme : readTheme();
      applyTheme(next);
      setTheme(next);
    };
    const timer = window.setTimeout(sync, 0);
    window.addEventListener(THEME_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const choose = useCallback((next: Theme) => {
    setTheme(next);
    saveTheme(next);
  }, []);

  return [theme, choose];
}

/** Applies the preference once at the app boundary, including /session. */
export function SignalDeckThemeProvider({ children }: { children: React.ReactNode }) {
  useTheme();
  return <>{children}</>;
}
