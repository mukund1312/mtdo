"use client";

import { useCallback, useEffect, useState } from "react";

export const FOCUS_CLOCK_STORAGE_KEY = "mtdo-focus-clock-visible";
const FOCUS_CLOCK_EVENT = "mtdo-focus-clock-change";

function readFocusClockPreference() {
  try {
    // The clock is useful by default, but every device can opt out without
    // involving session data or a second account-preferences backend.
    return window.localStorage.getItem(FOCUS_CLOCK_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveFocusClockPreference(visible: boolean) {
  try {
    window.localStorage.setItem(FOCUS_CLOCK_STORAGE_KEY, String(visible));
    window.dispatchEvent(new CustomEvent<boolean>(FOCUS_CLOCK_EVENT, { detail: visible }));
  } catch {
    // The calling component still updates its in-memory state.
  }
}

/** Device-level Focus preference shared by Settings and the live session. */
export function useFocusClockPreference(): [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const update = (event?: Event) => {
      const detail = event && "detail" in event ? (event as CustomEvent<unknown>).detail : undefined;
      setVisible(typeof detail === "boolean" ? detail : readFocusClockPreference());
    };
    const timer = window.setTimeout(update, 0);
    window.addEventListener(FOCUS_CLOCK_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(FOCUS_CLOCK_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  const choose = useCallback((next: boolean) => {
    setVisible(next);
    saveFocusClockPreference(next);
  }, []);

  return [visible, choose];
}
